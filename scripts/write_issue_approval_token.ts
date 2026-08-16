/**
 * Writes the issue-approval token when the /design-issue plan gate passes (web-jam-tools#595).
 *
 * Writes an approval token in the shape parsed by hooks/lib/check_issue_approval_token.ts:
 *   {
 *     "session_id": "<the session that got approval>",
 *     "repo": "<owner>/<repo>",
 *     "titles": ["exact title 1", "exact title 2", ...],
 *     "expires_at": "<ISO 8601 timestamp>"
 *   }
 *
 * Default token path: $HOME/.claude/state/issue-approval-token.json
 * Supports path override via ISSUE_APPROVAL_TOKEN_PATH env var or --token-path flag.
 *
 * CLI usage:
 *   deno run --allow-env --allow-read --allow-write scripts/write_issue_approval_token.ts \
 *     --session-id "<session-id>" \
 *     --repo "WebJamApps/web-jam-tools" \
 *     --title "Title 1" \
 *     --title "Title 2"
 */

import { dirname } from "@std/path";
import { parseArgs } from "@std/cli/parse-args";
import {
  type ApprovalToken,
  defaultTokenPath,
} from "../hooks/lib/check_issue_approval_token.ts";

export interface WriteApprovalTokenOptions {
  sessionId: string;
  repo: string;
  titles: string[];
  expiresAt?: string;
  ttlHours?: number;
  tokenPath?: string;
}

/**
 * Builds and validates an ApprovalToken object.
 * Throws an Error if required fields are missing or invalid.
 */
export function buildApprovalToken(options: WriteApprovalTokenOptions): ApprovalToken {
  const sessionId = options.sessionId?.trim();
  if (!sessionId) {
    throw new Error("sessionId is required and cannot be empty");
  }

  let repo = options.repo?.trim();
  if (!repo) {
    throw new Error("repo is required and cannot be empty");
  }
  if (!repo.includes("/")) {
    repo = `WebJamApps/${repo}`;
  }

  const titles = (options.titles || [])
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (titles.length === 0) {
    throw new Error("titles must contain at least one non-empty title");
  }

  let expiresAt = options.expiresAt?.trim();
  if (!expiresAt) {
    const ttlHours = options.ttlHours ?? 4;
    expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
  } else {
    const parsed = Date.parse(expiresAt);
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid expiresAt timestamp: ${expiresAt}`);
    }
  }

  return {
    session_id: sessionId,
    repo,
    titles,
    expires_at: expiresAt,
  };
}

/**
 * Writes the approval token to disk asynchronously.
 */
export async function writeApprovalToken(
  options: WriteApprovalTokenOptions,
): Promise<{ token: ApprovalToken; path: string }> {
  const token = buildApprovalToken(options);
  const path = options.tokenPath || defaultTokenPath();
  const dir = dirname(path);
  if (dir && dir !== ".") {
    await Deno.mkdir(dir, { recursive: true });
  }
  await Deno.writeTextFile(path, JSON.stringify(token, null, 2) + "\n");
  return { token, path };
}

/**
 * Writes the approval token to disk synchronously.
 */
export function writeApprovalTokenSync(
  options: WriteApprovalTokenOptions,
): { token: ApprovalToken; path: string } {
  const token = buildApprovalToken(options);
  const path = options.tokenPath || defaultTokenPath();
  const dir = dirname(path);
  if (dir && dir !== ".") {
    Deno.mkdirSync(dir, { recursive: true });
  }
  Deno.writeTextFileSync(path, JSON.stringify(token, null, 2) + "\n");
  return { token, path };
}

if (import.meta.main) {
  try {
    const args = parseArgs(Deno.args, {
      string: [
        "session-id",
        "repo",
        "title",
        "titles",
        "titles-file",
        "expires-at",
        "ttl-hours",
        "token-path",
      ],
      boolean: ["json", "help"],
      collect: ["title"],
      alias: {
        s: "session-id",
        r: "repo",
        t: "title",
        p: "token-path",
        h: "help",
      },
    });

    if (args.help) {
      console.log(`Usage: deno run --allow-env --allow-read --allow-write scripts/write_issue_approval_token.ts [options]

Options:
  -s, --session-id <id>     Session ID that received plan-gate approval (defaults to $CLAUDE_SESSION_ID or $SESSION_ID)
  -r, --repo <owner/repo>   Target repository (e.g. WebJamApps/web-jam-tools)
  -t, --title <title>       Approved issue title (can be repeated)
  --titles <list|json>      Approved titles as JSON array or comma-separated list
  --titles-file <path>      Path to file with titles (one per line or JSON array)
  --ttl-hours <hours>       Token TTL in hours (default: 4)
  --expires-at <iso>        Explicit expiration ISO 8601 timestamp
  -p, --token-path <path>   Override token output path (defaults to $ISSUE_APPROVAL_TOKEN_PATH or ~/.claude/state/issue-approval-token.json)
  --json                    Output written token as JSON to stdout
  -h, --help                Show this help message
`);
      Deno.exit(0);
    }

    const sessionId = args["session-id"] ||
      Deno.env.get("CLAUDE_SESSION_ID") ||
      Deno.env.get("SESSION_ID") ||
      "";
    const repo = args.repo || "";

    const titles: string[] = [];
    if (Array.isArray(args.title)) {
      titles.push(...args.title);
    } else if (typeof args.title === "string" && args.title) {
      titles.push(args.title);
    }

    if (args.titles) {
      try {
        const parsed = JSON.parse(args.titles);
        if (Array.isArray(parsed)) {
          titles.push(...parsed.map(String));
        } else {
          titles.push(...args.titles.split(","));
        }
      } catch {
        titles.push(...args.titles.split(","));
      }
    }

    if (args["titles-file"]) {
      const content = await Deno.readTextFile(args["titles-file"]);
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          titles.push(...parsed.map(String));
        } else {
          titles.push(...content.split("\n"));
        }
      } catch {
        titles.push(...content.split("\n"));
      }
    }

    if (titles.length === 0 && args._.length > 0) {
      titles.push(...args._.map(String));
    }

    const ttlHours = args["ttl-hours"] ? Number(args["ttl-hours"]) : undefined;
    const expiresAt = args["expires-at"];
    const tokenPath = args["token-path"];

    const { token, path } = await writeApprovalToken({
      sessionId,
      repo,
      titles,
      ttlHours,
      expiresAt,
      tokenPath,
    });

    if (args.json) {
      console.log(JSON.stringify(token, null, 2));
    } else {
      console.log(`Approval token successfully written to ${path}`);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
}
