// src/design-issue/file_plan.ts
// Files an approved Gate 2 plan table in one pass: the epic first, then each child with its native
// issue type, native Priority, and native blocked_by links set, attaching each child to the parent
// as a native sub-issue (web-jam-tools#748).
//
// Inherits Gate 2 approval-token enforcement by filing through `src/create-issue/lib.ts`
// (`createIssueAndVerify`).

import { parseArgs } from "@std/cli/parse-args";
import * as path from "@std/path";
import {
  type ApprovalCheckResult,
  checkApprovalToken,
  createIssueAndVerify,
  type CreateIssueOptions,
  defaultExecDeps,
  type ExecDeps,
  normalizeRepo,
} from "../create-issue/lib.ts";
import { expandHome } from "./gate1.ts";

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
  labels?: string[] | string;
  milestone?: string | number;
  repo?: string;
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
  dryRun?: boolean;
  deps?: ExecDeps;
  approvalCheck?: (repoFull: string, title: string) => ApprovalCheckResult;
}

interface ParsedPlan {
  defaultRepo?: string;
  defaultMilestone?: string | number;
  epic?: PlanIssueItem;
  children: PlanIssueItem[];
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

    if (!epic && childrenList.length === 0) {
      throw new Error("Plan contains no issues to file (missing epic and children/issues).");
    }

    return {
      defaultRepo,
      defaultMilestone,
      epic,
      children: childrenList,
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

function resolveLabels(item: PlanIssueItem): string[] {
  const result: string[] = [];
  const addLabel = (l: string) => {
    const trimmed = l.trim();
    if (trimmed && !result.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
      result.push(trimmed);
    }
  };

  const tier = item.tier || item.model || item.modelTier;
  if (tier) {
    addLabel(tier);
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

export async function filePlan(
  options: FilePlanOptions,
): Promise<FilePlanResult> {
  const plan = await parsePlanFile(options.planPath);
  const deps = options.deps || defaultExecDeps;
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

  if (options.dryRun) {
    console.log(`[design:file-plan] Dry run verified: ${allItems.length} issue(s) approved.`);
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
    let filedEpic: FiledIssueInfo | undefined;
    const filedChildren: FiledIssueInfo[] = [];

    // 1. File the Epic first if present
    if (plan.epic) {
      const epicItem = plan.epic;
      const epicRepo = normalizeRepo(epicItem.repo || plan.defaultRepo);
      const epicBodyFile = await prepareBodyFile(epicItem, tempFiles);
      const epicLabels = resolveLabels(epicItem);
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
        milestone: epicMilestone,
        priority: epicItem.priority,
      };

      console.log(`[design:file-plan] Filing Epic: "${epicItem.title}" in ${epicRepo.full}...`);
      const resultStr = await createIssueAndVerify(createOptions, deps, approvalCheck);

      const m = resultStr.match(/#(\d+)/);
      const epicNumber = m ? parseInt(m[1], 10) : 0;
      const epicDbId = await getIssueDatabaseId(epicRepo.full, epicNumber, deps);

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
      const childLabels = resolveLabels(childItem);
      const childMilestone = childItem.milestone !== undefined
        ? String(childItem.milestone)
        : plan.defaultMilestone !== undefined
        ? String(plan.defaultMilestone)
        : undefined;

      // Determine parent
      let parentNumber: number | undefined;
      if (childItem.parent !== undefined) {
        if (typeof childItem.parent === "number") {
          if (byPosition.has(childItem.parent)) {
            parentNumber = byPosition.get(childItem.parent)!.number;
          } else if (byExplicitId.has(String(childItem.parent))) {
            parentNumber = byExplicitId.get(String(childItem.parent))!.number;
          } else {
            parentNumber = childItem.parent;
          }
        } else if (typeof childItem.parent === "string") {
          const pTrim = childItem.parent.trim();
          const pLower = pTrim.toLowerCase();
          if (pLower === "none" || pLower === "null" || pLower === "-" || pLower === "") {
            parentNumber = undefined;
          } else if (pLower === "epic" || pLower === "parent") {
            parentNumber = filedEpic?.number;
          } else if (byExplicitId.has(pLower)) {
            parentNumber = byExplicitId.get(pLower)!.number;
          } else if (byTitle.has(pLower)) {
            parentNumber = byTitle.get(pLower)!.number;
          } else {
            const numMatch = pTrim.match(/^#?(\d+)$/);
            if (numMatch) {
              const numVal = parseInt(numMatch[1], 10);
              if (byPosition.has(numVal)) {
                parentNumber = byPosition.get(numVal)!.number;
              } else {
                parentNumber = numVal;
              }
            }
          }
        }
      } else if (filedEpic && childRepo.full === filedEpic.repo.full) {
        // Default: attach child to the filed Epic if in the same repository
        parentNumber = filedEpic.number;
      }

      const createOptions: CreateIssueOptions = {
        repo: childRepo.full,
        title: childItem.title,
        bodyFile: childBodyFile,
        type: childItem.type || "Task",
        labels: childLabels.length > 0 ? childLabels : undefined,
        milestone: childMilestone,
        priority: childItem.priority,
        parent: parentNumber,
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
          parentNumber ? ` (parent: #${parentNumber})` : ""
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

export async function runFilePlanCli(args: string[]): Promise<number> {
  const flags = parseArgs(args, {
    boolean: ["dry-run", "help"],
    string: ["plan"],
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
      dryRun: flags["dry-run"],
    });
    return 0;
  } catch (err) {
    console.error(`[design:file-plan] Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
