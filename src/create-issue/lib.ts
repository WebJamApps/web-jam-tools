/**
 * Helper library for scripts/create-issue.ts (web-jam-tools#514)
 */

export interface CreateIssueOptions {
  repo?: string;
  title: string;
  bodyFile: string;
  type?: string;
  labels?: string[];
  milestone?: string;
  priority?: string;
  parent?: number;
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

export const PRIORITY_MAP: Record<string, { id: number; name: string }> = {
  urgent: { id: 6835640, name: "Urgent" },
  high: { id: 6835641, name: "High" },
  medium: { id: 6835642, name: "Medium" },
  low: { id: 6835643, name: "Low" },
};

export const PRIORITY_FIELD_ID = 3909188;

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
    }
    i++;
  }

  return options;
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
): Promise<string> {
  if (!options.title) {
    throw new Error("Missing required argument --title");
  }
  if (!options.bodyFile) {
    throw new Error("Missing required argument --body-file");
  }

  const bodyText = await deps.readFileText(options.bodyFile);
  const repoInfo = normalizeRepo(options.repo);

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

  const typeName = options.type || "Task";
  ghArgs.push("--type", typeName);

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

  // 2. Set Priority field if requested
  if (options.priority) {
    const normPriorityKey = options.priority.toLowerCase();
    const spec = PRIORITY_MAP[normPriorityKey];
    const prioVal = spec ? spec.name : options.priority;

    const patchPayload = JSON.stringify({
      issue_field_values: [
        {
          field_id: PRIORITY_FIELD_ID,
          value: prioVal,
        },
      ],
    });

    const patchRes = await deps.runCmd(
      ["gh", "api", "-X", "PATCH", `repos/${repoInfo.full}/issues/${childNumber}`, "--input", "-"],
      patchPayload,
    );
    if (patchRes.code !== 0) {
      throw new Error(`Failed to set Priority field: ${patchRes.stderr || patchRes.stdout}`);
    }
  }

  // 3. Attach parent sub-issue if requested
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

  // 4. Re-read issue to verify attributes
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

  const verification = verifyIssueAttributes(actual, options);
  if (!verification.ok) {
    throw new Error(
      `Issue verification failed for #${childNumber}:\n` +
        verification.errors.map((e) => `  - ${e}`).join("\n"),
    );
  }

  return `${repoInfo.name}#${childNumber} "${options.title}"`;
}
