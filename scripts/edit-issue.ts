#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env
/**
 * scripts/edit-issue.ts — web-jam-tools#685
 *
 * Guarded CLI over `gh issue edit`. hooks/block-raw-gh-write.sh denies the
 * raw form on both agent surfaces; this is the only route to it.
 *
 * Every `gh issue edit` flag (`--add-label`, `--remove-label`, `--body`,
 * `--milestone`, ...) passes through verbatim after `--repo`/`--issue`/
 * `--dry-run` are pulled out — this CLI does not re-invent that flag surface.
 * The empty-body and credential-literal guards bind all four verbs (§4 of
 * the design document): every remaining argument value is scanned for a
 * credential-shaped literal, and a `--body`/`--body-file` value specifically
 * is also checked for emptiness.
 *
 * `--author "<tool — model>"` is consumed here and never passed to gh
 * (web-jam-tools#1205). When the edit replaces the body it is required,
 * roster-checked, and the new body ends with one `🤖 Authored by` footer
 * naming the editing model in place of any earlier one.
 *
 * `--priority`, `--type`, and `--parent` are consumed here too: they use the
 * issue-creation library's native-field mutations, then read each value back
 * before reporting success.
 */
import { checkAuthorOnRoster, withFooter } from "../hooks/lib/authored_by_footer.ts";
import { checkDesignBody } from "../src/shared/design_body.ts";
import {
  addSubIssueMutation,
  issueTypeMutation,
  isValidIssueNodeId,
  normalizeRepo,
  type ParsedIssueRef,
  parseIssueRef,
  PRIORITY_FIELD_ID,
  PRIORITY_MAP,
  priorityMutation,
  VALID_ISSUE_TYPES,
} from "../src/create-issue/lib.ts";
import {
  resolveSigningAuthor,
  type RunningModelOptions,
} from "../src/shared/codex_running_model.ts";
import { checkIssueCitations, checkNoCredentialLiteral, checkNotEmpty } from "./gh-write/guard.ts";
import { type RunCmd, runWithRetry } from "./gh-write/gh_runner.ts";

export interface Options {
  repo?: string;
  issue?: number;
  dryRun: boolean;
  author?: string;
  priority?: string;
  priorityError?: string;
  type?: string;
  typeError?: string;
  parent?: string;
  parentError?: string;
  rest: string[];
}

function consumeFlagValue(
  args: string[],
  index: number,
  flag: string,
): { matched: boolean; value?: string; nextIndex: number } {
  const arg = args[index];
  if (arg === flag) return { matched: true, value: args[index + 1] ?? "", nextIndex: index + 1 };
  if (arg.startsWith(`${flag}=`)) {
    return { matched: true, value: arg.slice(flag.length + 1), nextIndex: index };
  }
  return { matched: false, nextIndex: index };
}

export function parseArgs(args: string[]): Options {
  const opts: Options = { dryRun: false, rest: [] };
  const bodyValues = new Set(
    findBodyFlags(args).filter((flag) => flag.span === 2)
      .map((flag) => flag.index + 1),
  );
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo") opts.repo = args[++i];
    else if (arg === "--issue") opts.issue = Number(args[++i]);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (!bodyValues.has(i) && (arg === "--priority" || arg.startsWith("--priority="))) {
      const parsed = consumeFlagValue(args, i, "--priority");
      i = parsed.nextIndex;
      if (opts.priority !== undefined) opts.priorityError = "--priority is given more than once.";
      else opts.priority = parsed.value;
    } else if (!bodyValues.has(i) && (arg === "--type" || arg.startsWith("--type="))) {
      const parsed = consumeFlagValue(args, i, "--type");
      i = parsed.nextIndex;
      if (opts.type !== undefined) opts.typeError = "--type is given more than once.";
      else opts.type = parsed.value;
    } else if (!bodyValues.has(i) && (arg === "--parent" || arg.startsWith("--parent="))) {
      const parsed = consumeFlagValue(args, i, "--parent");
      i = parsed.nextIndex;
      if (opts.parent !== undefined) opts.parentError = "--parent is given more than once.";
      else opts.parent = parsed.value;
    } else if (arg === "--author") opts.author = args[++i] ?? "";
    else if (arg.startsWith("--author=")) opts.author = arg.slice("--author=".length);
    else opts.rest.push(arg);
  }
  return opts;
}

export interface BodyFlag {
  kind: "text" | "file";
  /** Position of the flag in the argument list. */
  index: number;
  /** How many arguments the flag and its value take up (1 or 2). */
  span: number;
  /** The body text or the file path; undefined when the flag is last with no value. */
  value: string | undefined;
}

/**
 * Every body-replacing flag in `rest`, in every form `gh issue edit` accepts:
 * `--body <t>`, `--body=<t>`, `-b <t>`, `-b=<t>`, `-b<t>`, and the same five
 * for `--body-file` / `-F`. A value that follows a spaced flag is skipped, so
 * a body whose text is itself `-b` is not read as a second flag.
 */
export function findBodyFlags(rest: string[]): BodyFlag[] {
  const found: BodyFlag[] = [];
  const attached = (arg: string, short: string) =>
    arg.startsWith(`${short}=`) ? arg.slice(short.length + 1) : arg.slice(short.length);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--body" || arg === "-b") {
      found.push({ kind: "text", index: i, span: 2, value: rest[i + 1] });
      i++;
    } else if (arg === "--body-file" || arg === "-F") {
      found.push({ kind: "file", index: i, span: 2, value: rest[i + 1] });
      i++;
    } else if (arg.startsWith("--body=")) {
      found.push({ kind: "text", index: i, span: 1, value: arg.slice("--body=".length) });
    } else if (arg.startsWith("--body-file=")) {
      found.push({ kind: "file", index: i, span: 1, value: arg.slice("--body-file=".length) });
    } else if (arg.startsWith("-b") && !arg.startsWith("--")) {
      found.push({ kind: "text", index: i, span: 1, value: attached(arg, "-b") });
    } else if (arg.startsWith("-F") && !arg.startsWith("--")) {
      found.push({ kind: "file", index: i, span: 1, value: attached(arg, "-F") });
    }
  }
  return found;
}

export interface Deps {
  signing?: RunningModelOptions;
  readFileText: (path: string) => Promise<string>;
  runCmd: RunCmd;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides the roster probe script path (tests only). */
  probeScriptPath?: string;
}

const USAGE =
  "usage: edit-issue --repo <owner/repo> --issue <n> [--priority Urgent|High|Medium|Low] [--type Task|Bug|Feature|Epic] [--parent <n|owner/repo#n>] [--author <tool — model>] [gh issue edit flags...] [--dry-run]\n  Outside Codex, --author is required whenever the body is replaced (--body, -b, --body-file or -F, in any form). Codex looks up the running model.";

type CmdCall = (cmd: string[]) => ReturnType<typeof runWithRetry>;

/** Resolve an issue's GraphQL node ID via REST and enforce the shared ID check. */
async function resolveIssueNodeId(
  call: CmdCall,
  repoFull: string,
  issueNum: number,
): Promise<string> {
  const node = await call([
    "gh",
    "api",
    `repos/${repoFull}/issues/${issueNum}`,
    "--jq",
    ".node_id",
  ]);
  const nodeId = node.stdout.trim();
  if (node.code !== 0 || !isValidIssueNodeId(nodeId)) {
    throw new Error("could not resolve the issue node ID");
  }
  return nodeId;
}

/** Execute a GraphQL query/mutation and verify exit code, JSON response, and requested data key. */
async function runGraphql(
  call: CmdCall,
  query: string,
  dataKey: string,
  label: string,
): Promise<Record<string, unknown>> {
  const res = await call(["gh", "api", "graphql", "-f", `query=${query}`]);
  if (res.code !== 0) throw new Error(`${label} call failed`);
  const parsed = JSON.parse(res.stdout);
  if (parsed?.errors?.length || !parsed?.data?.[dataKey]) {
    throw new Error(`${label} call did not confirm success`);
  }
  return parsed.data as Record<string, unknown>;
}

/** Set the native Priority field and refuse success until REST confirms the requested level. */
async function setPriority(opts: Options, deps: Deps): Promise<void> {
  const target = `${opts.repo}#${opts.issue}`;
  const context = `Priority ${opts.priority} for ${target}`;
  const endpoint = `repos/${opts.repo}/issues/${opts.issue}`;
  const call: CmdCall = (cmd) => runWithRetry(deps.runCmd, cmd, { sleep: deps.sleep });
  try {
    const nodeId = await resolveIssueNodeId(call, opts.repo!, opts.issue!);
    const spec = PRIORITY_MAP[opts.priority!.toLowerCase()];
    await runGraphql(
      call,
      priorityMutation(nodeId, spec.node_id),
      "updateIssueFieldValue",
      "field",
    );
  } catch (error) {
    throw new Error(
      `Failed to set ${context}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let fields;
  try {
    const read = await call(["gh", "api", endpoint, "--jq", ".issue_field_values"]);
    if (read.code !== 0) throw new Error("read-back failed");
    fields = JSON.parse(read.stdout);
    if (!Array.isArray(fields)) throw new Error("read-back is not an array of fields");
  } catch {
    throw new Error(`${context} is unverified: could not read back the native Priority.`);
  }
  const field = fields.find((value) =>
    value && (value.issue_field_id === PRIORITY_FIELD_ID || value.issue_field_name === "Priority")
  );
  const actual = field?.single_select_option?.name ?? "none";
  if (actual !== opts.priority) {
    throw new Error(`${target}: Priority mismatch: expected "${opts.priority}", got "${actual}".`);
  }
  console.log(`set ${target} Priority to ${actual}; read-back verified`);
}

/** Set the native issue type via `updateIssue` and refuse success until REST confirms it. */
async function setType(opts: Options, deps: Deps): Promise<void> {
  const target = `${opts.repo}#${opts.issue}`;
  const context = `Type ${opts.type} for ${target}`;
  const endpoint = `repos/${opts.repo}/issues/${opts.issue}`;
  const call: CmdCall = (cmd) => runWithRetry(deps.runCmd, cmd, { sleep: deps.sleep });
  const [owner, repoName] = opts.repo!.split("/");
  try {
    const nodeId = await resolveIssueNodeId(call, opts.repo!, opts.issue!);
    const typeQuery = `
      query GetIssueTypes {
        repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repoName)}) {
          issueTypes(first: 25) {
            nodes { id name }
          }
        }
      }
    `;
    const data = await runGraphql(call, typeQuery, "repository", "issue types");
    const repository = data.repository as {
      issueTypes?: { nodes?: Array<{ id?: string; name?: string }> };
    };
    const nodes = repository?.issueTypes?.nodes;
    const matched = Array.isArray(nodes)
      ? nodes.find((tn) => tn?.name === opts.type && typeof tn?.id === "string" && tn.id.length > 0)
      : undefined;
    if (!matched?.id) {
      throw new Error(`issue type "${opts.type}" is not available in ${opts.repo}`);
    }
    await runGraphql(call, issueTypeMutation(nodeId, matched.id), "updateIssue", "type");
  } catch (error) {
    throw new Error(
      `Failed to set ${context}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsedType: { name?: string } | null;
  try {
    const read = await call(["gh", "api", endpoint, "--jq", ".type"]);
    if (read.code !== 0) throw new Error("read-back failed");
    parsedType = JSON.parse(read.stdout);
    if (parsedType !== null && (typeof parsedType !== "object" || Array.isArray(parsedType))) {
      throw new Error("unexpected type payload");
    }
  } catch {
    throw new Error(`${context} is unverified: could not read back the native Type.`);
  }
  const actual = parsedType?.name ?? "none";
  if (actual !== opts.type) {
    throw new Error(`${target}: Type mismatch: expected "${opts.type}", got "${actual}".`);
  }
  console.log(`set ${target} Type to ${actual}; read-back verified`);
}

/** Link `opts.issue` under `parentRef` via `addSubIssue` and refuse success until REST confirms it. */
async function setParent(opts: Options, parentRef: ParsedIssueRef, deps: Deps): Promise<void> {
  const target = `${opts.repo}#${opts.issue}`;
  const parentFull = `${parentRef.owner}/${parentRef.repo}`;
  const parentDisplay = `${parentFull}#${parentRef.number}`;
  const context = `Parent ${parentDisplay} for ${target}`;
  const endpoint = `repos/${opts.repo}/issues/${opts.issue}`;
  const call: CmdCall = (cmd) => runWithRetry(deps.runCmd, cmd, { sleep: deps.sleep });
  try {
    const childNodeId = await resolveIssueNodeId(call, opts.repo!, opts.issue!);
    const parentNodeId = await resolveIssueNodeId(call, parentFull, parentRef.number);
    await runGraphql(
      call,
      addSubIssueMutation(parentNodeId, childNodeId),
      "addSubIssue",
      "sub-issue",
    );
  } catch (error) {
    throw new Error(
      `Failed to set ${context}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let rawParentUrl = "";
  try {
    const read = await call(["gh", "api", endpoint, "--jq", ".parent_issue_url"]);
    if (read.code !== 0) throw new Error("read-back failed");
    rawParentUrl = read.stdout.trim();
    if (!rawParentUrl) throw new Error("empty parent_issue_url");
  } catch {
    throw new Error(`${context} is unverified: could not read back the native Parent.`);
  }

  if (rawParentUrl === "null") {
    throw new Error(`${target}: Parent mismatch: expected ${parentDisplay}, got none.`);
  }
  const match = rawParentUrl.match(
    /(?:repos|github\.com)\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)\/?$/,
  );
  if (!match) {
    throw new Error(`${context} is unverified: could not read back the native Parent.`);
  }
  const actualRepo = match[1];
  const actualNumber = parseInt(match[2], 10);
  if (
    actualRepo.toLowerCase() !== parentFull.toLowerCase() ||
    actualNumber !== parentRef.number
  ) {
    throw new Error(
      `${target}: Parent mismatch: expected ${parentDisplay}, got ${actualRepo}#${actualNumber}.`,
    );
  }
  console.log(`set ${target} Parent to ${parentDisplay}; read-back verified`);
}

function validateAndParseParent(parent: string, targetRepoFull?: string, targetIssue?: number): {
  ok: true;
  ref: ParsedIssueRef;
} | {
  ok: false;
  error: string;
} {
  let ref: ParsedIssueRef;
  try {
    const defaultRepo = targetRepoFull && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepoFull)
      ? normalizeRepo(targetRepoFull)
      : { owner: "WebJamApps", name: "web-jam-tools" };
    ref = parseIssueRef(parent, defaultRepo);
  } catch {
    return {
      ok: false,
      error: "refusing to edit: --parent requires a positive issue number or repo#n reference.",
    };
  }
  if (!Number.isSafeInteger(ref.number) || ref.number <= 0) {
    return {
      ok: false,
      error: "refusing to edit: --parent requires a positive issue number or repo#n reference.",
    };
  }
  if (
    targetRepoFull &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepoFull) &&
    Number.isSafeInteger(targetIssue) &&
    (targetIssue ?? 0) > 0
  ) {
    const targetRepo = normalizeRepo(targetRepoFull);
    if (
      ref.owner.toLowerCase() === targetRepo.owner.toLowerCase() &&
      ref.repo.toLowerCase() === targetRepo.name.toLowerCase() &&
      ref.number === targetIssue
    ) {
      return {
        ok: false,
        error: `refusing to edit: issue ${targetRepoFull}#${targetIssue} cannot be its own parent.`,
      };
    }
  }
  return { ok: true, ref };
}

export async function run(args: string[], deps: Deps): Promise<number> {
  const opts = parseArgs(args);
  if (opts.priorityError) {
    console.error(`refusing to edit: ${opts.priorityError}`);
    return 1;
  }
  if (opts.typeError) {
    console.error(`refusing to edit: ${opts.typeError}`);
    return 1;
  }
  if (opts.parentError) {
    console.error(`refusing to edit: ${opts.parentError}`);
    return 1;
  }
  if (
    opts.priority !== undefined &&
    !Object.values(PRIORITY_MAP).some((level) => level.name === opts.priority)
  ) {
    console.error(
      "refusing to edit: --priority requires Urgent, High, Medium or Low (case-sensitive).",
    );
    return 1;
  }
  if (
    opts.type !== undefined &&
    !(VALID_ISSUE_TYPES as readonly string[]).includes(opts.type)
  ) {
    console.error(
      "refusing to edit: --type requires Task, Bug, Feature or Epic (case-sensitive).",
    );
    return 1;
  }
  let parentRef: ParsedIssueRef | undefined;
  if (opts.parent !== undefined) {
    const validated = validateAndParseParent(opts.parent, opts.repo, opts.issue);
    if (!validated.ok) {
      console.error(validated.error);
      return 1;
    }
    parentRef = validated.ref;
  }
  if (
    (opts.priority !== undefined || opts.type !== undefined || opts.parent !== undefined) &&
    (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo ?? "") ||
      !Number.isSafeInteger(opts.issue) || (opts.issue ?? 0) <= 0)
  ) {
    console.error(
      "refusing to edit native fields: give an owner/repo and a positive integer issue number.",
    );
    return 1;
  }
  if (
    !opts.repo || !opts.issue ||
    (opts.rest.length === 0 && opts.priority === undefined && opts.type === undefined &&
      opts.parent === undefined)
  ) {
    console.error(USAGE);
    return 1;
  }

  const bodyFlags = findBodyFlags(opts.rest);
  if (bodyFlags.length > 1) {
    console.error(
      "refusing to edit: the body is given more than once (--body / -b / --body-file / -F); give it exactly once.",
    );
    return 1;
  }
  const bodyFlag = bodyFlags[0];
  let bodyText: string | undefined;
  if (bodyFlag !== undefined) {
    if (bodyFlag.value === undefined) {
      console.error(`refusing to edit: ${opts.rest[bodyFlag.index]} is given with no value.`);
      return 1;
    }
    bodyText = bodyFlag.kind === "file" ? await deps.readFileText(bodyFlag.value) : bodyFlag.value;
  }
  if (bodyText !== undefined && bodyFlag !== undefined) {
    const notEmpty = checkNotEmpty(bodyText);
    if (!notEmpty.ok) {
      console.error(notEmpty.error);
      return 1;
    }
    const citations = checkIssueCitations(bodyText);
    if (!citations.ok) {
      console.error(citations.error);
      return 1;
    }
    // Authored-by footer (web-jam-tools#1205): the replacement body names the editing model.
    try {
      opts.author = await resolveSigningAuthor(opts.author, deps.signing);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    const authorCheck = await checkAuthorOnRoster(opts.author, deps.runCmd, deps.probeScriptPath);
    if (!authorCheck.ok) {
      console.error(`refusing to edit: ${authorCheck.message}`);
      return 1;
    }
    bodyText = withFooter(bodyText, opts.author!);
    // Whatever form the body arrived in, gh receives it as `--body <text>`.
    opts.rest.splice(bodyFlag.index, bodyFlag.span, "--body", bodyText);
  }

  const credResult = checkNoCredentialLiteral(opts.rest.join(" "));
  if (!credResult.ok) {
    console.error(credResult.error);
    return 1;
  }

  if (bodyText !== undefined) {
    try {
      const current = await runWithRetry(deps.runCmd, [
        "gh",
        "issue",
        "view",
        String(opts.issue),
        "--repo",
        opts.repo,
        "--json",
        "body",
      ], { sleep: deps.sleep });
      if (current.code !== 0) throw new Error("could not read the current issue body");
      const parsed = JSON.parse(current.stdout);
      if (typeof parsed?.body !== "string") {
        throw new Error("could not read the current issue body");
      }
      await checkDesignBody(bodyText, parsed.body);
    } catch (error) {
      console.error(`refusing to edit: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  const ghArgs = ["gh", "issue", "edit", String(opts.issue), "--repo", opts.repo, ...opts.rest];

  if (opts.dryRun) {
    if (opts.rest.length) console.log(`dry run: would edit issue via: ${ghArgs.join(" ")}`);
    if (opts.priority !== undefined) {
      console.log(
        `dry run: would set ${opts.repo}#${opts.issue} Priority to ${opts.priority} and read it back`,
      );
    }
    if (opts.type !== undefined) {
      console.log(
        `dry run: would set ${opts.repo}#${opts.issue} Type to ${opts.type} and read it back`,
      );
    }
    if (parentRef !== undefined) {
      console.log(
        `dry run: would link ${opts.repo}#${opts.issue} under parent ${parentRef.owner}/${parentRef.repo}#${parentRef.number} and read it back`,
      );
    }
    return 0;
  }

  if (opts.rest.length) {
    const result = await runWithRetry(deps.runCmd, ghArgs, { sleep: deps.sleep });
    if (result.code !== 0) {
      console.error(`gh issue edit failed after ${result.attempts} attempt(s): ${result.stderr}`);
      return 1;
    }
    console.log(`edited ${opts.repo}#${opts.issue} via gh issue edit`);
  }
  const nativeSteps: Array<() => Promise<void>> = [];
  if (opts.priority !== undefined) nativeSteps.push(() => setPriority(opts, deps));
  if (opts.type !== undefined) nativeSteps.push(() => setType(opts, deps));
  if (parentRef !== undefined) {
    const resolvedParent = parentRef;
    nativeSteps.push(() => setParent(opts, resolvedParent, deps));
  }
  for (const step of nativeSteps) {
    try {
      await step();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  return 0;
}

async function realRunCmd(cmd: string[]) {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

if (import.meta.main) {
  const deps: Deps = { readFileText: (p) => Deno.readTextFile(p), runCmd: realRunCmd };
  Deno.exit(await run(Deno.args, deps));
}
