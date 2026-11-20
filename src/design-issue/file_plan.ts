// src/design-issue/file_plan.ts
// Files an approved Gate 2 plan table in one pass: the epic first, then each child with its native
// issue type, native Priority, and native blocked_by links set, attaching each child to the parent
// as a native sub-issue (web-jam-tools#748).
//
// Inherits Gate 2 approval-token enforcement by filing through `src/create-issue/lib.ts`
// (`createIssueAndVerify`).

import { parseArgs } from "@std/cli/parse-args";
import { checkDesignBody, designPathsInBody, isDesignDocFilename } from "../shared/design_body.ts";
import { checkAuthorOnRoster, withFooter } from "../../hooks/lib/authored_by_footer.ts";
import {
  isAgySession,
  isCodexSession,
  resolveSigningAuthor,
} from "../shared/codex_running_model.ts";
import * as path from "@std/path";
import {
  type ApprovalCheckResult,
  checkApprovalToken,
  createIssueAndVerify,
  type CreateIssueOptions,
  defaultExecDeps,
  type ExecDeps,
  normalizeRepo,
  type ParsedIssueRef,
  parseIssueRef,
} from "../create-issue/lib.ts";
import { expandHome } from "./gate1.ts";
import {
  loadModelLabels,
  modelLabelViolation,
  readPlanModelLabels,
} from "../shared/model_label_rule.ts";

import {
  extractBacktickCommands,
  extractDesignHeadings,
  indexPlanRowsByNumber,
  parseStepsAfterMerge,
  validateIssueBodyCriteria,
} from "./lint_plan.ts";
export { validateIssueBodyCriteria };
import { parsePlanTable, PLAN_TABLE_HEADER } from "./plan_table.ts";

export interface PlanIssueItem {
  id?: number | string;
  title: string;
  body?: string;
  bodyFile?: string;
  body_file?: string;
  bodyPath?: string;
  type?: string;
  priority?: string;
  tier?: string;
  model?: string;
  modelTier?: string;
  escalationReason?: string;
  labels?: string[] | string;
  milestone?: string | number;
  repo?: string;
  designDoc?: string;
  design_doc?: string;
  parent?: number | string | null;
  blocked_by?: Array<number | string | { repo?: string; number?: number; id?: number }>;
  blockedBy?: Array<number | string | { repo?: string; number?: number; id?: number }>;
  dependencies?: Array<number | string | { repo?: string; number?: number; id?: number }>;
}

export interface IssuePlanDoc {
  repo?: string;
  milestone?: string | number;
  epic?: PlanIssueItem;
  children?: PlanIssueItem[];
  issues?: PlanIssueItem[];
  plan?: PlanIssueItem[];
  designDoc?: string;
  design_doc?: string;
  planDoc?: string;
  plan_doc?: string;
}

export interface FiledIssueInfo {
  repo: { owner: string; name: string; full: string };
  number: number;
  id?: number;
  title: string;
  type?: string;
}

export interface FilePlanResult {
  epic?: FiledIssueInfo;
  children: FiledIssueInfo[];
  dependencyLinksCount: number;
  totalIssuesFiled: number;
}

export interface FilePlanOptions {
  planPath: string;
  planDoc?: string;
  dryRun?: boolean;
  deps?: ExecDeps;
  approvalCheck?: (repoFull: string, title: string) => ApprovalCheckResult;
  /** `<tool> — <model>` that wrote the plan's issues; required, roster-checked, and written as every body's footer (web-jam-tools#1205). */
  author?: string;
}

interface ParsedPlan {
  defaultRepo?: string;
  defaultMilestone?: string | number;
  epic?: PlanIssueItem;
  children: PlanIssueItem[];
  designDoc?: string;
  planDoc?: string;
}

export function parsePlanJson(jsonText: string): ParsedPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Failed to parse plan JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (Array.isArray(parsed)) {
    const items = parsed as PlanIssueItem[];
    if (items.length === 0) {
      throw new Error("Plan contains no issues to file (empty array).");
    }
    // Check if first item is an Epic
    if (items[0].type?.toLowerCase() === "epic") {
      return {
        epic: items[0],
        children: items.slice(1),
      };
    }
    return {
      children: items,
    };
  }

  if (typeof parsed === "object" && parsed !== null) {
    const doc = parsed as IssuePlanDoc;
    const defaultRepo = doc.repo;
    const defaultMilestone = doc.milestone;
    const epic = doc.epic;
    const childrenList = doc.children || doc.issues || doc.plan || [];
    const designDoc = doc.designDoc ?? doc.design_doc;
    const planDoc = doc.planDoc ?? doc.plan_doc;

    if (!epic && childrenList.length === 0) {
      throw new Error("Plan contains no issues to file (missing epic and children/issues).");
    }

    return {
      defaultRepo,
      defaultMilestone,
      epic,
      children: childrenList,
      designDoc,
      planDoc,
    };
  }

  throw new Error("Invalid plan JSON: expected an object or array.");
}

export async function parsePlanFile(filePath: string): Promise<ParsedPlan> {
  if (!filePath || filePath.trim() === "") {
    throw new Error("Plan file path is required.");
  }
  const absPath = path.resolve(expandHome(filePath.trim()));
  let content: string;
  try {
    content = await Deno.readTextFile(absPath);
  } catch (err) {
    throw new Error(
      `Plan file not found or cannot be read at ${absPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return parsePlanJson(content);
}

function resolveLabels(item: PlanIssueItem, modelLabels: ReadonlySet<string>): string[] {
  const result: string[] = [];
  const addLabel = (l: string) => {
    const trimmed = l.trim();
    if (trimmed && !result.includes(trimmed)) {
      result.push(trimmed);
    }
  };

  const tier = item.tier ?? item.model ?? item.modelTier;
  if (tier !== undefined) {
    for (const label of readPlanModelLabels(tier, modelLabels)) addLabel(label);
  }

  if (item.labels) {
    if (Array.isArray(item.labels)) {
      for (const l of item.labels) {
        addLabel(l);
      }
    } else if (typeof item.labels === "string") {
      for (const l of item.labels.split(",")) {
        addLabel(l);
      }
    }
  }

  return result;
}

export async function getIssueDatabaseId(
  repoFull: string,
  issueNumber: number,
  deps: ExecDeps,
): Promise<number> {
  const res = await deps.runCmd(["gh", "api", `repos/${repoFull}/issues/${issueNumber}`]);
  if (res.code !== 0) {
    throw new Error(
      `Failed to resolve database ID for ${repoFull}#${issueNumber}: ${res.stderr || res.stdout}`,
    );
  }
  const data = JSON.parse(res.stdout);
  if (typeof data.id !== "number") {
    throw new Error(`Response for ${repoFull}#${issueNumber} did not contain numeric id.`);
  }
  return data.id;
}

export async function linkIssueDependency(
  dependentRepoFull: string,
  dependentNumber: number,
  blockingDbId: number,
  deps: ExecDeps,
): Promise<void> {
  const res = await deps.runCmd([
    "gh",
    "api",
    "--method",
    "POST",
    `repos/${dependentRepoFull}/issues/${dependentNumber}/dependencies/blocked_by`,
    "-F",
    `issue_id=${blockingDbId}`,
  ]);
  if (res.code !== 0) {
    throw new Error(
      `Failed to link dependency on ${dependentRepoFull}#${dependentNumber} (blocked by database id ${blockingDbId}): ${
        res.stderr || res.stdout
      }`,
    );
  }
}

async function prepareBodyFile(
  item: PlanIssueItem,
  tempFiles: string[],
): Promise<string> {
  const explicitBodyFile = item.bodyFile || item.body_file || item.bodyPath;
  if (explicitBodyFile) {
    return path.resolve(expandHome(explicitBodyFile));
  }
  const bodyContent = item.body ?? `## What this builds\n\n${item.title}\n`;
  const tempPath = await Deno.makeTempFile({
    prefix: "design-plan-body-",
    suffix: ".md",
  });
  tempFiles.push(tempPath);
  await Deno.writeTextFile(tempPath, bodyContent);
  return tempPath;
}

/** Resolve parents before filing, using the same epic-first, then child order as the filer. */
function resolvePlanParents(
  plan: ParsedPlan,
): Array<number | string | PlanIssueItem | undefined> {
  const available: PlanIssueItem[] = plan.epic ? [plan.epic] : [];
  return plan.children.map((child, index) => {
    const repo = normalizeRepo(child.repo || plan.defaultRepo);
    const invalid = (reason: string): never => {
      throw new Error(
        `Cannot resolve parent ${JSON.stringify(child.parent)} for plan child ${
          index + 1
        } ("${child.title}"): ${reason}`,
      );
    };
    const explicitId = (key: string) =>
      available.findLast((item) => {
        if (item.id === undefined) return false;
        const id = String(item.id).trim().toLowerCase();
        return id === key || id.replace(/^#/, "") === key;
      });
    const position = (number: number) =>
      number >= 1 && number <= index ? plan.children[number - 1] : undefined;

    let target: number | string | PlanIssueItem | undefined;
    const parent = child.parent;
    if (parent === undefined) {
      target = plan.epic ?? undefined;
    } else if (parent === null) {
      target = undefined;
    } else if (typeof parent === "number") {
      target = position(parent) ?? explicitId(String(parent)) ?? parent;
    } else if (typeof parent === "string") {
      const trimmed = parent.trim();
      const lower = trimmed.toLowerCase();
      if (["none", "null", "-", ""].includes(lower)) {
        target = undefined;
      } else if (lower === "epic" || lower === "parent") {
        target = plan.epic ?? invalid("the plan has no epic");
      } else {
        target = explicitId(lower) ??
          available.find((item) => item.title.trim().toLowerCase() === lower);
        if (target === undefined) {
          // Bare numbers retain their position lookup. A repository citation
          // always means an existing issue, after explicit IDs and titles.
          const numeric = trimmed.match(/^#?(\d+)$/);
          if (numeric) {
            const number = Number(numeric[1]);
            target = position(number) ?? number;
          } else {
            const reference = (() => {
              try {
                return parseIssueRef(trimmed, repo);
              } catch {
                return invalid("no preceding plan item or valid issue citation matches this value");
              }
            })();
            target = `${reference.owner}/${reference.repo}#${reference.number}`;
          }
        }
      }
    } else {
      invalid("expected an issue number, a string reference, or null");
    }
    available.push(child);
    return target;
  });
}

export function extractAcceptanceCriteria(
  body: string,
): { inCriteria: boolean; criteria: Array<{ text: string; lineNum: number }> } {
  const lines = body.split(/\r?\n/);
  let inCriteria = false;
  let criteriaLevel = 2;
  const criteria: { text: string; lineNum: number }[] = [];
  let currentCriterion: { text: string; lineNum: number } | null = null;

  const flushCurrent = () => {
    if (currentCriterion !== null) {
      const trimmedText = currentCriterion.text.trim();
      if (trimmedText.length > 0) {
        criteria.push({ text: trimmedText, lineNum: currentCriterion.lineNum });
      }
      currentCriterion = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!inCriteria) {
      const criteriaHeaderMatch = trimmed.match(/^(#{1,6})\s+Acceptance\s+criteria\b/i);
      if (criteriaHeaderMatch) {
        inCriteria = true;
        criteriaLevel = criteriaHeaderMatch[1].length;
      }
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      if (level <= criteriaLevel) {
        flushCurrent();
        break;
      } else {
        // Nested subsection within Acceptance criteria (e.g. ### Behavior)
        flushCurrent();
        continue;
      }
    }

    if (trimmed === "" || trimmed.startsWith("<!--") || trimmed.startsWith("🤖 Authored by ")) {
      flushCurrent();
      continue;
    }

    const isListItem = /^\s*(?:[-*+]|\d+[.)])\s+/.test(rawLine);
    if (isListItem) {
      flushCurrent();
      currentCriterion = { text: trimmed, lineNum: i + 1 };
    } else if (currentCriterion !== null) {
      currentCriterion.text += " " + trimmed;
    } else {
      currentCriterion = { text: trimmed, lineNum: i + 1 };
    }
  }

  flushCurrent();
  return { inCriteria, criteria };
}
export async function filePlan(
  options: FilePlanOptions,
): Promise<FilePlanResult> {
  const plan = await parsePlanFile(options.planPath);
  const deps = options.deps || defaultExecDeps;
  options = { ...options, author: await resolveSigningAuthor(options.author, deps.signing) };
  const approvalCheck = options.approvalCheck ||
    ((repoFull, title) => checkApprovalToken(repoFull, title));

  // Collect all items for pre-validation / dry-run
  const allItems: Array<{ item: PlanIssueItem; isEpic: boolean }> = [];
  if (plan.epic) {
    allItems.push({ item: plan.epic, isEpic: true });
  }
  for (const child of plan.children) {
    allItems.push({ item: child, isEpic: false });
  }

  // Validate every body, including epics and manual steps, before any issue is filed.
  for (const { item } of allItems) {
    const bodyPath = item.bodyFile || item.body_file || item.bodyPath;
    let body = item.body ?? "";
    if (bodyPath) {
      try {
        body = await deps.readFileText(path.resolve(expandHome(bodyPath)));
      } catch (err) {
        throw new Error(
          `Refused to file plan — cannot read body file "${bodyPath}" for issue "${item.title}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    await checkDesignBody(body);
  }

  // Pre-validate titles, Gate 2 approval tokens, and ensure explicit IDs do not collide
  const explicitIdSet = new Set<string>();
  const totalChildren = plan.children.length;

  if (plan.epic && plan.epic.id !== undefined) {
    const epicIdStr = String(plan.epic.id).trim().toLowerCase();
    if (epicIdStr === "") {
      throw new Error("Plan Epic has an empty explicit id.");
    }
    // Collision check: Epic cannot use a numeric id that overlaps any child's 1-based position index
    const numEpicId = parseInt(epicIdStr.replace(/^#/, ""), 10);
    if (!isNaN(numEpicId) && numEpicId >= 1 && numEpicId <= totalChildren) {
      throw new Error(
        `Plan Epic specifies explicit id: ${plan.epic.id}, which collides with 1-based position index of child ${numEpicId} ("${
          plan.children[numEpicId - 1].title
        }"). Epic cannot use numeric IDs that overlap child positions.`,
      );
    }
    explicitIdSet.add(epicIdStr);
  }

  for (let i = 0; i < plan.children.length; i++) {
    const child = plan.children[i];
    const pos = i + 1;
    if (child.id !== undefined) {
      const idStr = String(child.id).trim().toLowerCase();
      if (idStr === "") {
        throw new Error(`Plan child ${pos} ("${child.title}") has an empty explicit id.`);
      }
      if (explicitIdSet.has(idStr)) {
        throw new Error(
          `Plan contains duplicate explicit id: "${child.id}" on child ${pos} ("${child.title}"). Explicit IDs must be unique across the plan.`,
        );
      }
      // Collision check: if the explicit ID is a numeric string equal to a *different* child's 1-based position index (e.g. child 2 has id: 1)
      const numId = parseInt(idStr.replace(/^#/, ""), 10);
      if (!isNaN(numId) && numId >= 1 && numId <= totalChildren && numId !== pos) {
        throw new Error(
          `Plan child ${pos} ("${child.title}") specifies explicit id: ${child.id}, which collides with 1-based position index of child ${numId} ("${
            plan.children[numId - 1].title
          }"). Use unique identifiers or align with position ordering.`,
        );
      }
      explicitIdSet.add(idStr);
    }
  }

  const titleSet = new Set<string>();
  const modelLabels = loadModelLabels();
  const resolvedLabels = new Map<PlanIssueItem, string[]>();
  for (const { item, isEpic } of allItems) {
    if (!item.title || item.title.trim() === "") {
      throw new Error("Plan contains an issue with missing or empty title.");
    }
    const normalizedTitle = item.title.trim().toLowerCase();
    if (titleSet.has(normalizedTitle)) {
      throw new Error(
        `Plan contains duplicate title: "${item.title}". Titles must be unique across the plan (including Epic and children) to allow unambiguous dependency resolution.`,
      );
    }
    titleSet.add(normalizedTitle);

    try {
      const labels = resolveLabels(item, modelLabels);
      const violation = modelLabelViolation(labels, modelLabels, item.escalationReason);
      if (violation) throw new Error(violation);
      resolvedLabels.set(item, labels);
    } catch (error) {
      throw new Error(
        `Refused to file plan — ${isEpic ? "Epic" : "issue"} "${item.title}": ${
          error instanceof Error ? error.message : error
        }`,
      );
    }

    const repoInfo = normalizeRepo(item.repo || plan.defaultRepo);
    const approval = approvalCheck(repoInfo.full, item.title);
    if (!approval.ok) {
      throw new Error(
        `Refused to file ${
          isEpic ? "Epic" : "issue"
        } "${item.title}" — Gate 2 approval required: ${approval.reason}`,
      );
    }
  }

  const parentTargets = resolvePlanParents(plan);

  // Authored-by footer (web-jam-tools#1205) — refuse before anything is filed.
  const authorCheck = await checkAuthorOnRoster(options.author, deps.runCmd, deps.probeScriptPath);
  if (!authorCheck.ok) {
    throw new Error(`Refused to file plan — ${authorCheck.message}`);
  }

  function normalizeDesignDocPath(rawPath: string): string {
    const trimmed = rawPath.trim();
    const expanded = trimmed.startsWith("$HOME/")
      ? expandHome(`~/${trimmed.slice("$HOME/".length)}`)
      : expandHome(trimmed);
    return path.resolve(expanded);
  }

  function extractDesignDocPathsFromBody(body: string): string[] {
    const found: string[] = [...designPathsInBody(body)];
    const seen = new Set(found.map(normalizeDesignDocPath));
    const absRegex = /(?:^|[\s`"'(<[])(\/[^\s`"'()<>[\]]+\.md)\b/g;
    for (const m of body.matchAll(absRegex)) {
      const candidate = m[1];
      if (!isDesignDocFilename(candidate)) continue;
      const normalized = normalizeDesignDocPath(candidate);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        found.push(candidate);
      }
    }
    return found;
  }

  // Validate design document and issue body acceptance criteria (web-jam-tools#1442)
  const fallbackDesignDoc = (plan.designDoc ?? "").trim();
  if (allItems.length === 0 && !fallbackDesignDoc) {
    throw new Error(
      'Refused to file plan — the design document is not named (missing "designDoc" field in plan).',
    );
  }

  const designHeadingsByDoc = new Map<string, ReadonlySet<string>>();

  for (const { item, isEpic } of allItems) {
    const rawItemDesignDoc = (item.designDoc ?? item.design_doc ?? fallbackDesignDoc).trim();
    if (!rawItemDesignDoc) {
      throw new Error(
        `Refused to file plan — the design document is not named (missing "designDoc" field in plan) for issue "${item.title}".`,
      );
    }

    const resolvedItemDesignDoc = normalizeDesignDocPath(rawItemDesignDoc);
    let itemDesignHeadings = designHeadingsByDoc.get(resolvedItemDesignDoc);
    if (!itemDesignHeadings) {
      let designDocContent: string;
      try {
        designDocContent = await deps.readFileText(resolvedItemDesignDoc);
      } catch (err) {
        throw new Error(
          `Refused to file plan — design document at "${rawItemDesignDoc}" (${resolvedItemDesignDoc}) cannot be read for issue "${item.title}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      itemDesignHeadings = extractDesignHeadings(designDocContent);
      designHeadingsByDoc.set(resolvedItemDesignDoc, itemDesignHeadings);
    }

    if (isEpic || item.type?.toLowerCase() === "epic") continue;
    const labels = resolvedLabels.get(item) ?? [];
    const tier = item.tier ?? item.model ?? item.modelTier;
    const hasModelLabel = labels.some((l) => modelLabels.has(l));
    if (!hasModelLabel && (labels.includes("Josh") || tier?.trim() === "Josh")) continue;

    const bodyPath = item.bodyFile || item.body_file || item.bodyPath;
    let body: string | undefined = item.body;
    if (bodyPath) {
      try {
        body = await deps.readFileText(path.resolve(expandHome(bodyPath)));
      } catch (err) {
        throw new Error(
          `Refused to file plan — cannot read body file "${bodyPath}" for issue "${item.title}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (body === undefined) {
      throw new Error(
        `Refused to file plan — issue "${item.title}" body has no "## Acceptance criteria" section.`,
      );
    }

    const hasItemDesignDoc = Boolean((item.designDoc ?? item.design_doc ?? "").trim());
    if (hasItemDesignDoc) {
      for (const bodyDesignPath of extractDesignDocPathsFromBody(body)) {
        if (normalizeDesignDocPath(bodyDesignPath) !== resolvedItemDesignDoc) {
          throw new Error(
            `Refused to file plan — issue "${item.title}" body names "${bodyDesignPath}", which differs from its designDoc "${rawItemDesignDoc}".`,
          );
        }
      }
    }

    validateIssueBodyCriteria(item.title, body, itemDesignHeadings, {
      labels,
      modelLabels,
      designDocLabel: rawItemDesignDoc,
    });
  }

  // Validate "## Steps after the merge" commands against listed rows' acceptance criteria (web-jam-tools#1801)
  const rawPlanDoc = options.planDoc ?? plan.planDoc;
  if (rawPlanDoc !== undefined && rawPlanDoc.trim() !== "") {
    const resolvedPlanDoc = path.resolve(expandHome(rawPlanDoc.trim()));
    let planDocContent: string;
    try {
      planDocContent = await deps.readFileText(resolvedPlanDoc);
    } catch (err) {
      throw new Error(
        `Refused to file plan — plan document at "${rawPlanDoc.trim()}" (${resolvedPlanDoc}) cannot be read: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    await validatePlanStepsAfterMergeBodies(planDocContent, allItems, deps);
  }

  if (options.dryRun) {
    console.log(`[design:file-plan] Dry run verified: ${allItems.length} issue(s) approved.`);
    if (isCodexSession(deps.signing) || isAgySession(deps.signing)) {
      for (const { item } of allItems) {
        const bodyPath = item.bodyFile || item.body_file || item.bodyPath;
        const body = bodyPath
          ? await deps.readFileText(path.resolve(expandHome(bodyPath)))
          : item.body ?? `## What this builds\n\n${item.title}\n`;
        console.log(withFooter(body, options.author!));
      }
    }
    return {
      epic: plan.epic
        ? {
          repo: normalizeRepo(plan.epic.repo || plan.defaultRepo),
          number: 0,
          title: plan.epic.title,
          type: "Epic",
        }
        : undefined,
      children: plan.children.map((c) => ({
        repo: normalizeRepo(c.repo || plan.defaultRepo),
        number: 0,
        title: c.title,
        type: c.type || "Task",
      })),
      dependencyLinksCount: 0,
      totalIssuesFiled: 0,
    };
  }

  const tempFiles: string[] = [];
  try {
    // Separate registries across isolated namespaces to eliminate silent key collisions:
    // 1. byExplicitId: author-provided `item.id`
    // 2. byPosition: 1-based plan child position index (1, 2, 3...)
    // 3. byTitle: lowercase issue title
    // 4. byGitHubCitation: created GitHub issue citations (#500, repo#500)
    const byExplicitId = new Map<string, FiledIssueInfo>();
    const byPosition = new Map<number, FiledIssueInfo>();
    const byTitle = new Map<string, FiledIssueInfo>();
    const byGitHubCitation = new Map<string, FiledIssueInfo>();
    const filedNumbers = new Map<PlanIssueItem, number>();
    let filedEpic: FiledIssueInfo | undefined;
    const filedChildren: FiledIssueInfo[] = [];

    // 0. Pre-validate external parent citations before filing anything (web-jam-tools#1398)
    for (let i = 0; i < parentTargets.length; i++) {
      const target = parentTargets[i];
      const child = plan.children[i];
      const childRepo = normalizeRepo(child.repo || plan.defaultRepo);
      let targetRef: ParsedIssueRef | undefined;
      if (typeof target === "string") {
        targetRef = parseIssueRef(target, { owner: childRepo.owner, name: childRepo.name });
      } else if (typeof target === "number") {
        targetRef = parseIssueRef(target, { owner: childRepo.owner, name: childRepo.name });
      }
      if (targetRef) {
        const parentQuery = `
          query ValidateParent {
            repository(owner: "${targetRef.owner}", name: "${targetRef.repo}") {
              issue(number: ${targetRef.number}) { id }
            }
          }
        `;
        const res = await deps.runCmd(["gh", "api", "graphql", "-f", `query=${parentQuery}`]);
        let parentFound = false;
        if (res.code === 0) {
          try {
            const data = JSON.parse(res.stdout);
            if (data?.data?.repository?.issue?.id ?? data?.data?.parent?.issue?.id) {
              parentFound = true;
            }
          } catch {
            // ignore
          }
        }
        if (!parentFound) {
          const refStr = typeof target === "string"
            ? target
            : `${targetRef.owner}/${targetRef.repo}#${targetRef.number}`;
          throw new Error(
            `Refused to file plan — parent issue "${refStr}" for plan child ${
              i + 1
            } ("${child.title}") not found`,
          );
        }
      }
    }

    // 1. File the Epic first if present
    if (plan.epic) {
      const epicItem = plan.epic;
      const epicRepo = normalizeRepo(epicItem.repo || plan.defaultRepo);
      const epicBodyFile = await prepareBodyFile(epicItem, tempFiles);
      const epicLabels = resolvedLabels.get(epicItem)!;
      const epicMilestone = epicItem.milestone !== undefined
        ? String(epicItem.milestone)
        : plan.defaultMilestone !== undefined
        ? String(plan.defaultMilestone)
        : undefined;

      const createOptions: CreateIssueOptions = {
        repo: epicRepo.full,
        title: epicItem.title,
        bodyFile: epicBodyFile,
        type: epicItem.type || "Epic",
        labels: epicLabels.length > 0 ? epicLabels : undefined,
        escalationReason: epicItem.escalationReason,
        milestone: epicMilestone,
        priority: epicItem.priority,
        author: options.author,
      };

      console.log(`[design:file-plan] Filing Epic: "${epicItem.title}" in ${epicRepo.full}...`);
      const resultStr = await createIssueAndVerify(createOptions, deps, approvalCheck);

      const m = resultStr.match(/#(\d+)/);
      const epicNumber = m ? parseInt(m[1], 10) : 0;
      const epicDbId = await getIssueDatabaseId(epicRepo.full, epicNumber, deps);
      filedNumbers.set(epicItem, epicNumber);

      filedEpic = {
        repo: epicRepo,
        number: epicNumber,
        id: epicDbId,
        title: epicItem.title,
        type: createOptions.type,
      };

      // Register epic under explicit id, title, and github citation namespaces
      if (epicItem.id !== undefined) {
        const idKey = String(epicItem.id).trim().toLowerCase();
        byExplicitId.set(idKey, filedEpic);
        byExplicitId.set(idKey.replace(/^#/, ""), filedEpic);
      }
      byTitle.set(epicItem.title.trim().toLowerCase(), filedEpic);
      byGitHubCitation.set(`#${epicNumber}`, filedEpic);
      byGitHubCitation.set(`${epicRepo.name}#${epicNumber}`, filedEpic);
      byGitHubCitation.set(`${epicRepo.full}#${epicNumber}`, filedEpic);

      console.log(
        `[design:file-plan] Filed Epic: ${epicRepo.name}#${epicNumber} "${epicItem.title}"`,
      );
    }

    // 2. File each Child issue
    for (let i = 0; i < plan.children.length; i++) {
      const childItem = plan.children[i];
      const childRepo = normalizeRepo(childItem.repo || plan.defaultRepo);
      const childBodyFile = await prepareBodyFile(childItem, tempFiles);
      const childLabels = resolvedLabels.get(childItem)!;
      const childMilestone = childItem.milestone !== undefined
        ? String(childItem.milestone)
        : plan.defaultMilestone !== undefined
        ? String(plan.defaultMilestone)
        : undefined;

      const parentTarget = parentTargets[i];
      let parentOption: number | string | undefined;
      if (typeof parentTarget === "number" || typeof parentTarget === "string") {
        parentOption = parentTarget;
      } else if (parentTarget) {
        const parentNum = filedNumbers.get(parentTarget)!;
        const parentRepo = normalizeRepo(parentTarget.repo || plan.defaultRepo);
        if (parentRepo.full.toLowerCase() === childRepo.full.toLowerCase()) {
          parentOption = parentNum;
        } else {
          parentOption = `${parentRepo.full}#${parentNum}`;
        }
      }

      const createOptions: CreateIssueOptions = {
        repo: childRepo.full,
        title: childItem.title,
        bodyFile: childBodyFile,
        type: childItem.type || "Task",
        labels: childLabels.length > 0 ? childLabels : undefined,
        escalationReason: childItem.escalationReason,
        milestone: childMilestone,
        priority: childItem.priority,
        parent: parentOption,
        author: options.author,
      };

      console.log(
        `[design:file-plan] Filing Child ${
          i + 1
        }/${plan.children.length}: "${childItem.title}" in ${childRepo.full}...`,
      );
      const resultStr = await createIssueAndVerify(createOptions, deps, approvalCheck);

      const m = resultStr.match(/#(\d+)/);
      const childNumber = m ? parseInt(m[1], 10) : 0;
      const childDbId = await getIssueDatabaseId(childRepo.full, childNumber, deps);
      filedNumbers.set(childItem, childNumber);

      const filedChild: FiledIssueInfo = {
        repo: childRepo,
        number: childNumber,
        id: childDbId,
        title: childItem.title,
        type: createOptions.type,
      };

      filedChildren.push(filedChild);

      // Register child across isolated namespaces
      const positionIndex = i + 1;
      byPosition.set(positionIndex, filedChild);
      if (childItem.id !== undefined) {
        const idKey = String(childItem.id).trim().toLowerCase();
        byExplicitId.set(idKey, filedChild);
        byExplicitId.set(idKey.replace(/^#/, ""), filedChild);
      }
      byTitle.set(childItem.title.trim().toLowerCase(), filedChild);
      byGitHubCitation.set(`#${childNumber}`, filedChild);
      byGitHubCitation.set(`${childRepo.name}#${childNumber}`, filedChild);
      byGitHubCitation.set(`${childRepo.full}#${childNumber}`, filedChild);

      console.log(
        `[design:file-plan] Filed Child: ${childRepo.name}#${childNumber} "${childItem.title}"${
          parentOption !== undefined ? ` (parent: ${parentOption})` : ""
        }`,
      );
    }

    // Helper: resolves dependency references deterministically
    // Resolution precedence:
    // 1. Role aliases ("epic", "parent")
    // 2. Explicit position prefixes ("pos:1", "position:2", "step:1", "p:1")
    // 3. Explicit plan ID (`item.id`)
    // 4. 1-based child position index (e.g. 1, 2, "1", "#1")
    // 5. Issue title in plan (case-insensitive)
    // 6. GitHub citation created during this filing run (#501, repo#501)
    // 7. External GitHub issue citation (e.g. "web-jam-tools#747" or "#747")
    const resolveDependencyTarget = (
      depRef: number | string | { repo?: string; number?: number; id?: number },
      currentRepoFull: string,
    ): {
      target?: FiledIssueInfo;
      externalRepoFull?: string;
      externalNumber?: number;
      externalDbId?: number;
    } => {
      if (typeof depRef === "number") {
        // Check explicit ID first
        const strKey = String(depRef);
        if (byExplicitId.has(strKey)) {
          return { target: byExplicitId.get(strKey) };
        }
        // Check 1-based child position
        if (byPosition.has(depRef)) {
          return { target: byPosition.get(depRef) };
        }
        // External GitHub issue number in current repository
        return {
          externalRepoFull: currentRepoFull,
          externalNumber: depRef,
        };
      }

      if (typeof depRef === "string") {
        const trimmed = depRef.trim();
        const lower = trimmed.toLowerCase();
        const stripped = lower.replace(/^#/, "");

        // 1. Special role aliases
        if (lower === "epic" || lower === "parent") {
          if (!filedEpic) {
            throw new Error(`Dependency references "${depRef}", but no Epic was defined or filed.`);
          }
          return { target: filedEpic };
        }

        // 2. Explicit position namespaces
        const posMatch = trimmed.match(/^(?:#?pos(?:ition)?|step|p):?(\d+)$/i);
        if (posMatch) {
          const pos = parseInt(posMatch[1], 10);
          if (byPosition.has(pos)) {
            return { target: byPosition.get(pos) };
          }
        }

        // 3. Explicit plan ID
        if (byExplicitId.has(lower)) {
          return { target: byExplicitId.get(lower) };
        }
        if (byExplicitId.has(stripped)) {
          return { target: byExplicitId.get(stripped) };
        }

        // 4. Numeric string -> 1-based position index
        const numOnlyMatch = trimmed.match(/^#?(\d+)$/);
        if (numOnlyMatch) {
          const numVal = parseInt(numOnlyMatch[1], 10);
          if (byPosition.has(numVal)) {
            return { target: byPosition.get(numVal) };
          }
        }

        // 5. In-plan issue title
        if (byTitle.has(lower)) {
          return { target: byTitle.get(lower) };
        }

        // 6. In-session GitHub citation
        if (byGitHubCitation.has(trimmed)) {
          return { target: byGitHubCitation.get(trimmed) };
        }
        if (byGitHubCitation.has(lower)) {
          return { target: byGitHubCitation.get(lower) };
        }

        // 7. External GitHub issue citation
        const extMatch = trimmed.match(/^(?:([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?)#)?(\d+)$/);
        if (extMatch) {
          const repoFull = extMatch[1] ? normalizeRepo(extMatch[1]).full : currentRepoFull;
          const num = parseInt(extMatch[2], 10);
          return {
            externalRepoFull: repoFull,
            externalNumber: num,
          };
        }
      }

      if (typeof depRef === "object" && depRef !== null) {
        if (depRef.id) {
          return { externalDbId: depRef.id };
        }
        return {
          externalRepoFull: depRef.repo ? normalizeRepo(depRef.repo).full : currentRepoFull,
          externalNumber: depRef.number,
        };
      }

      throw new Error(`Unrecognized dependency reference format: ${JSON.stringify(depRef)}`);
    };

    // 3. Link native `blocked_by` dependencies
    let dependencyLinksCount = 0;
    for (let i = 0; i < plan.children.length; i++) {
      const childItem = plan.children[i];
      const filedChild = filedChildren[i];
      const depsList = childItem.blocked_by || childItem.blockedBy || childItem.dependencies || [];

      for (const depRef of depsList) {
        const resolved = resolveDependencyTarget(depRef, filedChild.repo.full);
        let blockingRepoFull = filedChild.repo.full;
        let blockingDbId: number | undefined;
        let blockingNumber: number | undefined;

        if (resolved.target) {
          blockingDbId = resolved.target.id;
          blockingNumber = resolved.target.number;
          blockingRepoFull = resolved.target.repo.full;
        } else {
          blockingRepoFull = resolved.externalRepoFull || filedChild.repo.full;
          blockingNumber = resolved.externalNumber;
          blockingDbId = resolved.externalDbId;
        }

        if (!blockingDbId && blockingNumber) {
          blockingDbId = await getIssueDatabaseId(blockingRepoFull, blockingNumber, deps);
        }

        if (!blockingDbId) {
          throw new Error(
            `Could not resolve blocking dependency "${
              JSON.stringify(depRef)
            }" for ${filedChild.repo.full}#${filedChild.number}`,
          );
        }

        console.log(
          `[design:file-plan] Linking dependency: ${filedChild.repo.full}#${filedChild.number} is blocked by ${blockingRepoFull}${
            blockingNumber ? `#${blockingNumber}` : ""
          } (id: ${blockingDbId})...`,
        );

        await linkIssueDependency(filedChild.repo.full, filedChild.number, blockingDbId, deps);
        dependencyLinksCount++;
      }
    }

    const totalFiled = (filedEpic ? 1 : 0) + filedChildren.length;
    console.log(
      `[design:file-plan] Filing complete: ${totalFiled} issue(s) filed (${
        filedEpic ? "1 epic, " : ""
      }${filedChildren.length} child/children), ${dependencyLinksCount} dependency link(s) created.`,
    );

    return {
      epic: filedEpic,
      children: filedChildren,
      dependencyLinksCount,
      totalIssuesFiled: totalFiled,
    };
  } finally {
    // Clean up temporary body files
    for (const tmp of tempFiles) {
      try {
        await Deno.remove(tmp);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

async function resolvePlanItemBody(
  item: PlanIssueItem,
  deps: ExecDeps,
): Promise<string | undefined> {
  const bodyPath = item.bodyFile || item.body_file || item.bodyPath;
  if (bodyPath) {
    try {
      return await deps.readFileText(path.resolve(expandHome(bodyPath)));
    } catch (err) {
      throw new Error(
        `Refused to file plan — cannot read body file "${bodyPath}" for issue "${item.title}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return item.body;
}

async function validatePlanStepsAfterMergeBodies(
  planDocContent: string,
  allItems: Array<{ item: PlanIssueItem; isEpic: boolean }>,
  deps: ExecDeps,
): Promise<void> {
  const parsedSteps = parseStepsAfterMerge(planDocContent);
  if (!parsedSteps.foundSection) {
    throw new Error(
      'Refused to file plan — plan document is missing required "## Steps after the merge" section.',
    );
  }
  if (parsedSteps.emptySection) {
    throw new Error(
      'Refused to file plan — plan document "## Steps after the merge" section is empty.',
    );
  }
  if (parsedSteps.invalidLines.length > 0) {
    throw new Error(
      `Refused to file plan — invalid line in "## Steps after the merge": "${
        parsedSteps.invalidLines[0].text
      }".`,
    );
  }
  if (parsedSteps.isNone) return;

  const parsedTable = parsePlanTable(planDocContent);
  const rowByNumber = parsedTable ? indexPlanRowsByNumber(parsedTable.rows) : undefined;
  const colTitle = PLAN_TABLE_HEADER.indexOf("Proposed title");
  const normalizeCmd = (cmd: string) => cmd.trim().replace(/\s+/g, " ");

  for (const entry of parsedSteps.entries) {
    if (entry.commands.length === 0) {
      throw new Error(
        `Refused to file plan — row ${entry.rowNumber} in "## Steps after the merge" has no command.`,
      );
    }

    let matched: { item: PlanIssueItem; isEpic: boolean } | undefined;
    if (rowByNumber && parsedTable) {
      const tableRow = rowByNumber.get(entry.rowNumber);
      if (!tableRow) {
        throw new Error(
          `Refused to file plan — "## Steps after the merge" names row ${entry.rowNumber}, which the plan table does not have.`,
        );
      }
      const rowTitle = tableRow.cells[colTitle].replace(/[`*_]/g, "").trim();
      matched = allItems.find(
        (x) => x.item.title.trim().toLowerCase() === rowTitle.toLowerCase(),
      );
      if (
        !matched &&
        parsedTable.rows.length === allItems.length &&
        entry.rowNumber >= 1 &&
        entry.rowNumber <= allItems.length
      ) {
        matched = allItems[entry.rowNumber - 1];
      }
      if (!matched) {
        throw new Error(
          `Refused to file plan — row ${entry.rowNumber} ("${rowTitle}") in "## Steps after the merge" does not match any issue in the plan.`,
        );
      }
    } else if (entry.rowNumber >= 1 && entry.rowNumber <= allItems.length) {
      matched = allItems[entry.rowNumber - 1];
    } else {
      throw new Error(
        `Refused to file plan — row ${entry.rowNumber} in "## Steps after the merge" does not match any issue in the plan.`,
      );
    }

    const body = await resolvePlanItemBody(matched.item, deps);
    if (body === undefined) {
      throw new Error(
        `Refused to file plan — row ${entry.rowNumber} ("${matched.item.title}") body has no "## Acceptance criteria" section.`,
      );
    }
    const { inCriteria, criteria } = extractAcceptanceCriteria(body);
    if (!inCriteria || criteria.length === 0) {
      throw new Error(
        `Refused to file plan — row ${entry.rowNumber} ("${matched.item.title}") body has no "## Acceptance criteria" section.`,
      );
    }

    const criterionCommands = new Set(
      criteria.flatMap((c) => extractBacktickCommands(c.text)).map(normalizeCmd),
    );
    for (const cmd of entry.commands) {
      if (!criterionCommands.has(normalizeCmd(cmd))) {
        throw new Error(
          `Refused to file plan — row ${entry.rowNumber} ("${matched.item.title}") is missing command \`${cmd}\` from "## Steps after the merge" inside an acceptance criterion.`,
        );
      }
    }
  }
}

export async function runFilePlanCli(args: string[]): Promise<number> {
  const flags = parseArgs(args, {
    boolean: ["dry-run", "help"],
    string: ["plan", "plan-doc", "plan_doc", "author"],
    alias: {
      h: "help",
      d: "dry-run",
      p: "plan",
    },
    default: {
      "dry-run": false,
      help: false,
    },
  });

  if (flags.help) {
    console.log(`Usage: deno task design:file-plan <plan.json> [options]

Files an approved Gate 2 plan table in one pass: the epic first, then each child
with its native issue type, native Priority, and native blocked_by links set,
attaching each child to the parent as a native sub-issue.

Dependency Resolution:
  Dependencies ('blocked_by') resolve with the following precedence:
    1. Special role aliases: 'epic', 'parent'
    2. Explicit position prefixes: 'pos:1', 'position:1', 'step:1', 'p:1'
    3. Explicit plan ID ('item.id' or 'id: 1')
    4. 1-based child position index (e.g. 1, 2, '#1')
    5. Issue title in plan (case-insensitive)
    6. External GitHub issue citation ('owner/repo#N' or 'repo#N')
  Note: To cite an external issue whose number matches an in-plan position (e.g. #1),
  use the repo-qualified citation (e.g. 'web-jam-tools#1' or 'WebJamApps/web-jam-tools#1').

Arguments:
  <plan.json>             Path to approved plan JSON file

Options:
  -p, --plan <path>       Explicit plan JSON file path
  --plan-doc <path>       Optional Gate 2 plan markdown file path (to check Steps after the merge)
  --author <tool — model> (required outside Codex) e.g. "Claude Code — Opus"; roster-checked and written as
                          the "Authored by" footer of every issue filed
                          Codex looks up the running model instead of using this value
  -d, --dry-run           Validate plan format and approval tokens without filing
  -h, --help              Show this help message
`);
    return 0;
  }

  const planPath = flags.plan || (flags._.length > 0 ? String(flags._[0]) : "");
  if (!planPath) {
    console.error("Error: Missing required plan JSON file path.");
    console.error("Usage: deno task design:file-plan <plan.json>");
    return 1;
  }

  try {
    await filePlan({
      planPath,
      planDoc: flags["plan-doc"] || flags.plan_doc,
      dryRun: flags["dry-run"],
      author: flags.author,
    });
    return 0;
  } catch (err) {
    console.error(`[design:file-plan] Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
