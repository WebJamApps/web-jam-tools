/**
 * Helper library for scripts/create-issue.ts (web-jam-tools#514)
 */

import {
  defaultTokenPath,
  isExpired,
  loadToken,
} from "../../hooks/lib/check_issue_approval_token.ts";

export interface CreateIssueOptions {
  repo?: string;
  title: string;
  bodyFile: string;
  type?: string;
  labels?: string[];
  milestone?: string;
  priority?: string;
  parent?: number;
  blockedBy?: string[];
  escalationReason?: string;
  dryRun?: boolean;
}

export interface VerificationResult {
  ok: boolean;
  errors: string[];
}

export interface IssueData {
  number: number;
  title: string;
  body?: string;
  labels?: Array<{ name: string }>;
  milestone?: { title: string; number?: number };
  type?: { name: string };
  parent?: { number: number; id?: string };
  parent_issue_url?: string;
  blocked_by?: Array<{
    id?: number;
    number: number;
    repository?: { name?: string; full_name?: string; owner?: { login?: string } };
  }>;
  issue_field_values?: Array<{
    issue_field_id?: number;
    issue_field_name?: string;
    value?: number | string;
    single_select_option?: { id?: number; name: string };
  }>;
}

export interface ExecDeps {
  runCmd: (
    cmd: string[],
    stdin?: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  readFileText: (path: string) => Promise<string>;
}

export const PRIORITY_MAP: Record<string, { id: number; node_id: string; name: string }> = {
  urgent: { id: 6835640, node_id: "IFSSO_kgDOAGhNuA", name: "Urgent" },
  high: { id: 6835641, node_id: "IFSSO_kgDOAGhNuQ", name: "High" },
  medium: { id: 6835642, node_id: "IFSSO_kgDOAGhNug", name: "Medium" },
  low: { id: 6835643, node_id: "IFSSO_kgDOAGhNuw", name: "Low" },
};

export const PRIORITY_FIELD_ID = 3909188;
export const PRIORITY_FIELD_NODE_ID = "IFSS_kgDOADumRA";

export function parseArgs(args: string[]): CreateIssueOptions {
  const options: CreateIssueOptions = {
    title: "",
    bodyFile: "",
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--repo" && i + 1 < args.length) {
      options.repo = args[++i];
    } else if (arg.startsWith("--repo=")) {
      options.repo = arg.slice("--repo=".length);
    } else if (arg === "--title" && i + 1 < args.length) {
      options.title = args[++i];
    } else if (arg.startsWith("--title=")) {
      options.title = arg.slice("--title=".length);
    } else if ((arg === "--body-file" || arg === "-F") && i + 1 < args.length) {
      options.bodyFile = args[++i];
    } else if (arg.startsWith("--body-file=")) {
      options.bodyFile = arg.slice("--body-file=".length);
    } else if ((arg === "--type" || arg === "-t") && i + 1 < args.length) {
      options.type = args[++i];
    } else if (arg.startsWith("--type=")) {
      options.type = arg.slice("--type=".length);
    } else if ((arg === "--label" || arg === "--labels" || arg === "-l") && i + 1 < args.length) {
      const val = args[++i];
      const items = val.split(",").map((s) => s.trim()).filter(Boolean);
      options.labels = [...(options.labels || []), ...items];
    } else if (arg.startsWith("--label=") || arg.startsWith("--labels=")) {
      const val = arg.includes("--labels=")
        ? arg.slice("--labels=".length)
        : arg.slice("--label=".length);
      const items = val.split(",").map((s) => s.trim()).filter(Boolean);
      options.labels = [...(options.labels || []), ...items];
    } else if ((arg === "--milestone" || arg === "-m") && i + 1 < args.length) {
      options.milestone = args[++i];
    } else if (arg.startsWith("--milestone=")) {
      options.milestone = arg.slice("--milestone=".length);
    } else if (arg === "--priority" && i + 1 < args.length) {
      options.priority = args[++i];
    } else if (arg.startsWith("--priority=")) {
      options.priority = arg.slice("--priority=".length);
    } else if (arg === "--parent" && i + 1 < args.length) {
      options.parent = parseInt(args[++i], 10);
    } else if (arg.startsWith("--parent=")) {
      options.parent = parseInt(arg.slice("--parent=".length), 10);
    } else if (arg === "--blocked-by" && i + 1 < args.length) {
      const val = args[++i];
      const items = val.split(",").map((s) => s.trim()).filter(Boolean);
      options.blockedBy = [...(options.blockedBy || []), ...items];
    } else if (arg.startsWith("--blocked-by=")) {
      const val = arg.slice("--blocked-by=".length);
      const items = val.split(",").map((s) => s.trim()).filter(Boolean);
      options.blockedBy = [...(options.blockedBy || []), ...items];
    } else if (arg === "--escalation-reason" && i + 1 < args.length) {
      options.escalationReason = args[++i];
    } else if (arg.startsWith("--escalation-reason=")) {
      options.escalationReason = arg.slice("--escalation-reason=".length);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    }
    i++;
  }

  return options;
}

export interface ApprovalCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Gate 2 approval-token check (web-jam-tools#747). Refuses to file an issue
 * unless a live, unexpired token — written by the plan gate via
 * scripts/write_issue_approval_token.ts once Josh approves a filing plan —
 * covers this exact repository and title.
 *
 * This is the ONLY enforcement point on agy/Antigravity: agy has no hook
 * mechanism at all, but both surfaces run this same `deno task create-issue`
 * path, so the check placed here travels to both. On Claude Code it backs up
 * hooks/require-approval-token-on-issue-write.sh, which denies the same Bash
 * `gh issue create` / `deno task create-issue` call before it would even
 * reach this function — this check is the fallback for a session that
 * somehow bypasses that hook (or for agy, which has none).
 *
 * Deliberately does NOT check `session_id` the way
 * hooks/lib/check_issue_approval_token.ts's `decide()` does for the MCP/Bash
 * hook path: a bare CLI invocation carries no session context to compare
 * against, so repo + title + expiry is all there is to verify here.
 */
export function checkApprovalToken(
  repoFull: string,
  title: string,
  tokenPath: string = defaultTokenPath(),
  nowMs: number = Date.now(),
): ApprovalCheckResult {
  const token = loadToken(tokenPath);
  if (!token) {
    return {
      ok: false,
      reason:
        `No approval token found at ${tokenPath}. Get Josh's explicit approval for this plan first (via /design-issue's plan gate), or ask him directly.`,
    };
  }
  if (isExpired(token, nowMs)) {
    return { ok: false, reason: `Approval token expired at ${token.expires_at}.` };
  }
  if (token.repo !== repoFull) {
    return { ok: false, reason: `Approval token is scoped to ${token.repo}, not ${repoFull}.` };
  }
  if (!token.titles.includes(title)) {
    return {
      ok: false,
      reason: `"${title}" is not among the titles approved in this plan's approval token.`,
    };
  }
  return { ok: true };
}

export function normalizeRepo(rawRepo?: string): { owner: string; name: string; full: string } {
  if (!rawRepo) {
    return { owner: "WebJamApps", name: "web-jam-tools", full: "WebJamApps/web-jam-tools" };
  }
  if (rawRepo.includes("/")) {
    const parts = rawRepo.split("/");
    return { owner: parts[0], name: parts[1], full: `${parts[0]}/${parts[1]}` };
  }
  return { owner: "WebJamApps", name: rawRepo, full: `WebJamApps/${rawRepo}` };
}

export interface ParsedIssueRef {
  owner: string;
  repo: string;
  number: number;
  raw: string;
}

export function parseIssueRef(
  raw: string | number,
  defaultRepo: { owner: string; name: string } = { owner: "WebJamApps", name: "web-jam-tools" },
): ParsedIssueRef {
  const str = String(raw).trim();
  if (!str) {
    throw new Error(`Empty issue reference: "${raw}"`);
  }

  // Case 1: "owner/repo#123"
  const fullMatch = str.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/);
  if (fullMatch) {
    return {
      owner: fullMatch[1],
      repo: fullMatch[2],
      number: parseInt(fullMatch[3], 10),
      raw: str,
    };
  }

  // Case 2: "repo#123"
  const repoMatch = str.match(/^([A-Za-z0-9_.-]+)#(\d+)$/);
  if (repoMatch) {
    return {
      owner: defaultRepo.owner,
      repo: repoMatch[1],
      number: parseInt(repoMatch[2], 10),
      raw: str,
    };
  }

  // Case 3: "#123" or "123"
  const numMatch = str.match(/^#?(\d+)$/);
  if (numMatch) {
    return {
      owner: defaultRepo.owner,
      repo: defaultRepo.name,
      number: parseInt(numMatch[1], 10),
      raw: str,
    };
  }

  throw new Error(
    `Invalid issue reference format: "${str}". Expected 123, #123, repo#123, or owner/repo#123`,
  );
}

export async function getIssueAncestors(
  repoInfo: { owner: string; name: string; full?: string },
  startIssueNumber: number,
  runCmd: ExecDeps["runCmd"] = defaultExecDeps.runCmd,
): Promise<Array<{ owner: string; name: string; number: number }>> {
  const ancestors: Array<{ owner: string; name: string; number: number }> = [];
  const visited = new Set<string>();

  let currOwner = repoInfo.owner;
  let currName = repoInfo.name;
  let currNumber = startIssueNumber;

  while (true) {
    const key = `${currOwner}/${currName}#${currNumber}`.toLowerCase();
    if (visited.has(key)) break;
    visited.add(key);

    const query = `
      query GetParent {
        repository(owner: "${currOwner}", name: "${currName}") {
          issue(number: ${currNumber}) {
            parent {
              number
              repository {
                name
                owner { login }
              }
            }
          }
        }
      }
    `;

    const res = await runCmd(["gh", "api", "graphql", "-f", `query=${query}`]);
    if (res.code !== 0) {
      break;
    }

    let data;
    try {
      data = JSON.parse(res.stdout);
    } catch {
      break;
    }

    const parent = data?.data?.repository?.issue?.parent;
    if (!parent || !parent.number) {
      break;
    }

    const pOwner = parent.repository?.owner?.login || currOwner;
    const pName = parent.repository?.name || currName;
    const pNumber = parent.number;

    ancestors.push({ owner: pOwner, name: pName, number: pNumber });

    currOwner = pOwner;
    currName = pName;
    currNumber = pNumber;
  }

  return ancestors;
}

export function verifyIssueAttributes(
  actual: IssueData,
  requested: CreateIssueOptions,
): VerificationResult {
  const errors: string[] = [];

  if (requested.title && actual.title !== requested.title) {
    errors.push(`Title mismatch: expected "${requested.title}", got "${actual.title}"`);
  }

  if (requested.labels && requested.labels.length > 0) {
    const actualLabelNames = new Set(
      (actual.labels || []).map((l: { name: string }) => l.name.toLowerCase()),
    );
    for (const reqLabel of requested.labels) {
      if (!actualLabelNames.has(reqLabel.toLowerCase())) {
        errors.push(`Label "${reqLabel}" did not stick`);
      }
    }
  }

  if (requested.type) {
    const actualType = actual.type?.name;
    if (!actualType || actualType.toLowerCase() !== requested.type.toLowerCase()) {
      errors.push(`Type mismatch: expected "${requested.type}", got "${actualType || "none"}"`);
    }
  }

  if (requested.milestone) {
    const actualMsTitle = actual.milestone?.title;
    const actualMsNum = actual.milestone?.number?.toString();
    const reqMs = requested.milestone.toString().toLowerCase();
    if (
      (!actualMsTitle || actualMsTitle.toLowerCase() !== reqMs) &&
      (!actualMsNum || actualMsNum.toLowerCase() !== reqMs)
    ) {
      errors.push(
        `Milestone mismatch: expected "${requested.milestone}", got "${
          actualMsTitle || actualMsNum || "none"
        }"`,
      );
    }
  }

  if (requested.priority) {
    const priorityField = (actual.issue_field_values || []).find(
      (fv) =>
        fv.issue_field_id === PRIORITY_FIELD_ID ||
        fv.issue_field_name?.toLowerCase() === "priority",
    );
    const actualPriority = priorityField?.single_select_option?.name;
    if (!actualPriority || actualPriority.toLowerCase() !== requested.priority.toLowerCase()) {
      errors.push(
        `Priority mismatch: expected "${requested.priority}", got "${actualPriority || "none"}"`,
      );
    }
  }

  if (requested.parent !== undefined) {
    const actualParentNum = actual.parent?.number ??
      (actual.parent_issue_url
        ? parseInt(actual.parent_issue_url.split("/").pop() || "0", 10)
        : undefined);
    if (actualParentNum !== requested.parent) {
      errors.push(
        `Parent issue mismatch: expected #${requested.parent}, got ${
          actualParentNum ? `#${actualParentNum}` : "none"
        }`,
      );
    }
  }

  if (requested.blockedBy && requested.blockedBy.length > 0) {
    const actualDeps = actual.blocked_by || [];
    const defaultRepoInfo = normalizeRepo(requested.repo);
    for (const reqBlocker of requested.blockedBy) {
      const parsed = parseIssueRef(reqBlocker, {
        owner: defaultRepoInfo.owner,
        name: defaultRepoInfo.name,
      });
      const found = actualDeps.some(
        (d) =>
          d.number === parsed.number &&
          (!d.repository?.name || d.repository.name.toLowerCase() === parsed.repo.toLowerCase()),
      );
      if (!found) {
        errors.push(`Blocked-by dependency "${reqBlocker}" did not stick`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export const defaultExecDeps: ExecDeps = {
  async runCmd(cmd: string[], stdin?: string) {
    const command = new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdin: stdin !== undefined ? "piped" : "inherit",
      stdout: "piped",
      stderr: "piped",
    });
    const child = command.spawn();
    if (stdin !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(stdin));
      await writer.close();
    }
    const { code, stdout, stderr } = await child.output();
    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  },
  async readFileText(path: string) {
    return await Deno.readTextFile(path);
  },
};

export async function createIssueAndVerify(
  options: CreateIssueOptions,
  deps: ExecDeps = defaultExecDeps,
  approvalCheck: (repoFull: string, title: string) => ApprovalCheckResult = (repoFull, title) =>
    checkApprovalToken(repoFull, title),
): Promise<string> {
  if (!options.title) {
    throw new Error("Missing required argument --title");
  }
  if (!options.bodyFile) {
    throw new Error("Missing required argument --body-file");
  }

  const repoInfo = normalizeRepo(options.repo);

  // Parse requested blockers (if any)
  const parsedBlockers = (options.blockedBy || []).map((b) =>
    parseIssueRef(b, { owner: repoInfo.owner, name: repoInfo.name })
  );

  // Self-blocking / parent-equals-blocker and ancestor refusal checks
  if (options.parent !== undefined && parsedBlockers.length > 0) {
    for (const blocker of parsedBlockers) {
      if (
        blocker.owner.toLowerCase() === repoInfo.owner.toLowerCase() &&
        blocker.repo.toLowerCase() === repoInfo.name.toLowerCase() &&
        blocker.number === options.parent
      ) {
        throw new Error(
          `Refused: requested blocker #${blocker.number} is the parent #${options.parent} of this issue (an issue cannot be blocked by its parent).`,
        );
      }
    }

    const ancestors = await getIssueAncestors(repoInfo, options.parent, deps.runCmd);
    for (const blocker of parsedBlockers) {
      const isAncestor = ancestors.some(
        (a) =>
          a.owner.toLowerCase() === blocker.owner.toLowerCase() &&
          a.name.toLowerCase() === blocker.repo.toLowerCase() &&
          a.number === blocker.number,
      );
      if (isAncestor) {
        throw new Error(
          `Refused: requested blocker #${blocker.number} is an ancestor of parent #${options.parent} of this issue.`,
        );
      }
    }
  }

  if (options.dryRun) {
    return `dry run: would create issue "${options.title}" in ${repoInfo.full}`;
  }

  // 0. Gate 2 approval-token check (web-jam-tools#747) — refuses to file
  // unless Josh's plan gate already approved this exact repo + title.
  const approval = approvalCheck(repoInfo.full, options.title);
  if (!approval.ok) {
    throw new Error(`Refused to file issue — Gate 2 approval required: ${approval.reason}`);
  }

  const bodyText = await deps.readFileText(options.bodyFile);

  // 1. Create base issue via gh issue create
  const ghArgs = [
    "gh",
    "issue",
    "create",
    "--repo",
    repoInfo.full,
    "--title",
    options.title,
    "--body",
    bodyText,
  ];

  if (options.milestone) {
    ghArgs.push("--milestone", options.milestone);
  }

  if (options.labels && options.labels.length > 0) {
    for (const label of options.labels) {
      ghArgs.push("--label", label);
    }
  }

  const createRes = await deps.runCmd(ghArgs);
  if (createRes.code !== 0) {
    throw new Error(`Failed to create issue: ${createRes.stderr || createRes.stdout}`);
  }

  const outputUrl = createRes.stdout.trim();
  const issueNumMatch = outputUrl.match(/\/issues\/(\d+)/);
  if (!issueNumMatch) {
    throw new Error(`Could not parse issue number from gh output: ${outputUrl}`);
  }
  const childNumber = parseInt(issueNumMatch[1], 10);

  // 2. Set native Type field via GraphQL mutation if requested
  if (options.type) {
    const typeQuery = `
      query GetChildAndTypes {
        repository(owner: "${repoInfo.owner}", name: "${repoInfo.name}") {
          issue(number: ${childNumber}) { id }
          issueTypes(first: 25) {
            nodes { id name }
          }
        }
      }
    `;

    const tRes = await deps.runCmd(["gh", "api", "graphql", "-f", `query=${typeQuery}`]);
    if (tRes.code !== 0) {
      throw new Error(`Failed to resolve issue type info: ${tRes.stderr || tRes.stdout}`);
    }

    const tData = JSON.parse(tRes.stdout);
    const childNodeId = tData?.data?.repository?.issue?.id;
    const typeNodes: Array<{ id: string; name: string }> =
      tData?.data?.repository?.issueTypes?.nodes || [];
    const matchedType = typeNodes.find(
      (tn) => tn.name.toLowerCase() === options.type!.toLowerCase(),
    );

    if (!matchedType) {
      throw new Error(
        `Invalid issue type "${options.type}". Available types: ${
          typeNodes.map((t) => t.name).join(", ")
        }`,
      );
    }

    if (!childNodeId) {
      throw new Error(`Could not resolve child issue node ID for #${childNumber}`);
    }

    const typeMutation = `
      mutation SetIssueType {
        updateIssue(input: {
          id: "${childNodeId}",
          issueTypeId: "${matchedType.id}"
        }) {
          clientMutationId
        }
      }
    `;

    const tmRes = await deps.runCmd(["gh", "api", "graphql", "-f", `query=${typeMutation}`]);
    if (tmRes.code !== 0) {
      throw new Error(`Failed to set issue Type via GraphQL: ${tmRes.stderr || tmRes.stdout}`);
    }
  }

  // 3. Set Priority field via GraphQL mutation if requested
  if (options.priority) {
    const normPriorityKey = options.priority.toLowerCase();
    const spec = PRIORITY_MAP[normPriorityKey];

    if (!spec) {
      throw new Error(
        `Invalid priority level "${options.priority}". Expected Urgent, High, Medium, or Low.`,
      );
    }

    const childNodeQuery = `
      query GetChildNodeId {
        repository(owner: "${repoInfo.owner}", name: "${repoInfo.name}") {
          issue(number: ${childNumber}) { id }
        }
      }
    `;

    const cRes = await deps.runCmd(["gh", "api", "graphql", "-f", `query=${childNodeQuery}`]);
    if (cRes.code !== 0) {
      throw new Error(
        `Failed to resolve child issue node ID for Priority: ${cRes.stderr || cRes.stdout}`,
      );
    }

    const cData = JSON.parse(cRes.stdout);
    const childNodeId = cData?.data?.repository?.issue?.id;
    if (!childNodeId) {
      throw new Error(`Could not resolve child issue node ID for #${childNumber}`);
    }

    const prioMutation = `
      mutation SetPriority {
        updateIssueFieldValue(input: {
          issueId: "${childNodeId}",
          issueField: {
            fieldId: "${PRIORITY_FIELD_NODE_ID}",
            singleSelectOptionId: "${spec.node_id}"
          }
        }) {
          clientMutationId
        }
      }
    `;

    const pRes = await deps.runCmd(["gh", "api", "graphql", "-f", `query=${prioMutation}`]);
    if (pRes.code !== 0) {
      throw new Error(`Failed to set Priority field via GraphQL: ${pRes.stderr || pRes.stdout}`);
    }
  }

  // 4. Attach parent sub-issue via GraphQL addSubIssue if requested
  if (options.parent !== undefined) {
    const parentQuery = `
      query GetIssueNodeIds {
        parent: repository(owner: "${repoInfo.owner}", name: "${repoInfo.name}") {
          issue(number: ${options.parent}) { id }
        }
        child: repository(owner: "${repoInfo.owner}", name: "${repoInfo.name}") {
          issue(number: ${childNumber}) { id }
        }
      }
    `;

    const queryRes = await deps.runCmd([
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${parentQuery}`,
    ]);
    if (queryRes.code !== 0) {
      throw new Error(
        `Failed to resolve node IDs for parent attach: ${queryRes.stderr || queryRes.stdout}`,
      );
    }

    const queryData = JSON.parse(queryRes.stdout);
    const parentId = queryData?.data?.parent?.issue?.id;
    const childId = queryData?.data?.child?.issue?.id;

    if (!parentId || !childId) {
      throw new Error(
        `Could not resolve GraphQL node IDs: parentId=${parentId}, childId=${childId}`,
      );
    }

    const addSubIssueMutation = `
      mutation AddSubIssue {
        addSubIssue(input: { issueId: "${parentId}", subIssueId: "${childId}" }) {
          issue { id }
          subIssue { id }
        }
      }
    `;

    const mutRes = await deps.runCmd([
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${addSubIssueMutation}`,
    ]);
    if (mutRes.code !== 0) {
      throw new Error(
        `Failed to attach parent sub-issue via addSubIssue: ${mutRes.stderr || mutRes.stdout}`,
      );
    }
  }

  // 4b. Register blocked_by dependencies if requested
  if (parsedBlockers.length > 0) {
    for (const blocker of parsedBlockers) {
      const blockerIdQuery = `
        query GetBlockerId {
          repository(owner: "${blocker.owner}", name: "${blocker.repo}") {
            issue(number: ${blocker.number}) {
              databaseId
              id
            }
          }
        }
      `;
      const bRes = await deps.runCmd(["gh", "api", "graphql", "-f", `query=${blockerIdQuery}`]);
      let blockerDbId: number | undefined;
      if (bRes.code === 0) {
        try {
          const bData = JSON.parse(bRes.stdout);
          blockerDbId = bData?.data?.repository?.issue?.databaseId;
        } catch {
          // ignore
        }
      }

      if (!blockerDbId) {
        const rRes = await deps.runCmd([
          "gh",
          "api",
          `repos/${blocker.owner}/${blocker.repo}/issues/${blocker.number}`,
        ]);
        if (rRes.code !== 0) {
          throw new Error(
            `Failed to resolve database ID for blocker ${blocker.repo}#${blocker.number}: ${
              rRes.stderr || rRes.stdout
            }`,
          );
        }
        const rData = JSON.parse(rRes.stdout);
        blockerDbId = rData.id;
      }

      if (!blockerDbId) {
        throw new Error(
          `Could not resolve database ID for blocker ${blocker.repo}#${blocker.number}`,
        );
      }

      const addDepRes = await deps.runCmd([
        "gh",
        "api",
        "-X",
        "POST",
        `repos/${repoInfo.full}/issues/${childNumber}/dependencies/blocked_by`,
        "-F",
        `issue_id=${blockerDbId}`,
      ]);

      if (addDepRes.code !== 0) {
        throw new Error(
          `Failed to register blocked_by dependency on ${blocker.repo}#${blocker.number}: ${
            addDepRes.stderr || addDepRes.stdout
          }`,
        );
      }
    }
  }

  // 5. Re-read issue to verify attributes
  const readRes = await deps.runCmd(["gh", "api", `repos/${repoInfo.full}/issues/${childNumber}`]);
  if (readRes.code !== 0) {
    throw new Error(
      `Failed to re-read created issue for verification: ${readRes.stderr || readRes.stdout}`,
    );
  }

  const actual: IssueData = JSON.parse(readRes.stdout);

  // If parent requested, also query parent in GraphQL to be 100% thorough if REST parent field is missing
  if (options.parent !== undefined && !actual.parent && !actual.parent_issue_url) {
    const parentCheckQuery = `
      query CheckParent {
        repository(owner: "${repoInfo.owner}", name: "${repoInfo.name}") {
          issue(number: ${childNumber}) {
            parent { number }
          }
        }
      }
    `;
    const pCheckRes = await deps.runCmd([
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${parentCheckQuery}`,
    ]);
    if (pCheckRes.code === 0) {
      const pData = JSON.parse(pCheckRes.stdout);
      const pNum = pData?.data?.repository?.issue?.parent?.number;
      if (pNum) {
        actual.parent = { number: pNum };
      }
    }
  }

  // If blockedBy requested, fetch dependencies list
  if (options.blockedBy && options.blockedBy.length > 0) {
    const depReadRes = await deps.runCmd([
      "gh",
      "api",
      `repos/${repoInfo.full}/issues/${childNumber}/dependencies/blocked_by`,
    ]);
    if (depReadRes.code === 0) {
      try {
        actual.blocked_by = JSON.parse(depReadRes.stdout);
      } catch {
        // ignore
      }
    }
  }

  const verification = verifyIssueAttributes(actual, options);
  if (!verification.ok) {
    throw new Error(
      `Issue verification failed for #${childNumber}:\n` +
        verification.errors.map((e) => `  - ${e}`).join("\n"),
    );
  }

  return `${repoInfo.name}#${childNumber} "${options.title}"`;
}
