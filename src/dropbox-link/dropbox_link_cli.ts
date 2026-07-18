// Dropbox share-link CLI (web-jam-tools#171). Turns a Dropbox path — either an
// account-relative path or a local `~/Dropbox/...` path — into the two link
// forms WebJamApps needs when adding a song to the web-jam-back Setlist:
//   - Setlist form:  www.dropbox.com/scl/fi/...?rlkey=...&dl=0  (viewer link)
//   - Songs/widget:  dl.dropboxusercontent.com/scl/fi/...?rlkey=...&dl=1 (direct stream)
// Both derive from a single shared link (one API call per path).
//
// Auth is a durable OAuth refresh token (the `webjam-setlist-links` Dropbox
// app; scopes files.metadata.read, sharing.read, sharing.write; account
// web.jam.adm@gmail.com) — no more regenerating a 4-hour throwaway token.
// Mirrors web-jam-back/src/lib/calendar.ts's refresh-token pattern: plain
// fetch, no SDK, env-driven secrets. Dropbox's token endpoint wants the app
// key/secret as HTTP Basic auth (Google's puts client_id/secret in the body
// instead — see calendar.ts / send_daily_devotional.ts for that variant).
//
// Idempotent: create_shared_link_with_settings 409s with
// shared_link_already_exists on a path that already has a link; the fallback
// list_shared_links(direct_only) call fetches that same existing link, so
// re-running on the same path never creates a duplicate.
//
// One-time OAuth setup + env vars: see README.md "Dropbox share-link CLI".
//
// Run (batch: multiple path args and/or newline-separated paths on stdin):
//   deno task dropbox:link -- /joshandmariamusic/song.mp3
//   deno task dropbox:link -- ~/Dropbox/joshandmariamusic/song.mp3
//   printf '/a.mp3\n/b.mp3\n' | deno task dropbox:link --

const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const CREATE_LINK_URL = "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings";
const LIST_LINKS_URL = "https://api.dropboxapi.com/2/sharing/list_shared_links";

// ---------- auth ----------

export interface DropboxSecrets {
  appKey: string;
  appSecret: string;
  refreshToken: string;
}

export function dropboxSecrets(): DropboxSecrets {
  const appKey = Deno.env.get("DROPBOX_APP_KEY");
  const appSecret = Deno.env.get("DROPBOX_APP_SECRET");
  const refreshToken = Deno.env.get("DROPBOX_REFRESH_TOKEN");
  if (!appKey || !appSecret || !refreshToken) {
    throw new Error(
      "Missing Dropbox OAuth secrets: set DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN",
    );
  }
  return { appKey, appSecret, refreshToken };
}

// Exchange the stored refresh token for a short-lived access token. The
// refresh token never expires (offline access), so this is the only network
// step needed before every run.
export async function refreshAccessToken(): Promise<string> {
  const { appKey, appSecret, refreshToken } = dropboxSecrets();
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${appKey}:${appSecret}`)}`,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!resp.ok) throw new Error(`dropbox token refresh: ${resp.status} ${await resp.text()}`);
  const body = (await resp.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("dropbox token refresh returned no access_token");
  return body.access_token;
}

// ---------- path auto-detection ----------

// Account-relative path (starts with "/", e.g. /joshandmariamusic/song.mp3)
// is used as-is. A local path (~/Dropbox/... or /home/joshua/Dropbox/...) is
// auto-mapped by stripping everything through the "Dropbox" root folder.
// Pure aside from reading $HOME for "~" expansion (injectable for tests), so
// it's unit-testable without touching the filesystem.
export function toAccountRelativePath(
  rawPath: string,
  home = Deno.env.get("HOME") ?? "",
): string {
  let p = rawPath.trim();
  if (p.startsWith("~")) p = home + p.slice(1);
  const marker = "/Dropbox";
  const idx = p.indexOf(`${marker}/`);
  if (idx !== -1) return p.slice(idx + marker.length); // keep the leading "/"
  if (p.startsWith("/")) return p; // already account-relative
  throw new Error(
    `Cannot determine Dropbox path type for "${rawPath}": expected an account-relative path ` +
      `(starting with "/") or a local path containing "/Dropbox/"`,
  );
}

// ---------- link-form conversion ----------

export interface ShareLinkForms {
  setlistUrl: string;
  widgetUrl: string;
}

// Both output forms derive from the one shared-link URL Dropbox returns:
// swap host + force `dl`, preserving `rlkey` (any other query params, e.g.
// Dropbox's transient `st=`, are intentionally dropped per the settled spec).
export function shareLinkForms(rawUrl: string): ShareLinkForms {
  const u = new URL(rawUrl);
  const rlkey = u.searchParams.get("rlkey");
  const query = (dl: "0" | "1"): string => {
    const params = new URLSearchParams();
    if (rlkey) params.set("rlkey", rlkey);
    params.set("dl", dl);
    return params.toString();
  };
  return {
    setlistUrl: `https://www.dropbox.com${u.pathname}?${query("0")}`,
    widgetUrl: `https://dl.dropboxusercontent.com${u.pathname}?${query("1")}`,
  };
}

// ---------- shared-link create-or-reuse (idempotent) ----------

interface DropboxLinkMetadata {
  url?: string;
}

async function listExistingSharedLink(accessToken: string, path: string): Promise<string> {
  const resp = await fetch(LIST_LINKS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path, direct_only: true }),
  });
  if (!resp.ok) throw new Error(`dropbox list shared links: ${resp.status} ${await resp.text()}`);
  const body = (await resp.json()) as { links?: DropboxLinkMetadata[] };
  const url = body.links?.[0]?.url;
  if (!url) throw new Error(`dropbox list shared links: no existing link found for ${path}`);
  return url;
}

// Create a shared link for `path`; on 409 shared_link_already_exists, fall
// back to listing the existing one instead. This is what makes re-running the
// CLI on the same path idempotent rather than erroring or duplicating links.
export async function createOrGetSharedLink(accessToken: string, path: string): Promise<string> {
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
  const createResp = await fetch(CREATE_LINK_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ path }),
  });
  if (createResp.ok) {
    const body = (await createResp.json()) as DropboxLinkMetadata;
    if (!body.url) throw new Error("dropbox create shared link: response had no url");
    return body.url;
  }
  if (createResp.status === 409) {
    const errBody = await createResp.text();
    if (!errBody.includes("shared_link_already_exists")) {
      throw new Error(`dropbox create shared link: 409 ${errBody}`);
    }
    return await listExistingSharedLink(accessToken, path);
  }
  throw new Error(`dropbox create shared link: ${createResp.status} ${await createResp.text()}`);
}

// ---------- orchestration ----------

export interface LinkResult extends ShareLinkForms {
  input: string;
  path: string;
}

export async function linksForPath(rawPath: string, accessToken: string): Promise<LinkResult> {
  const path = toAccountRelativePath(rawPath);
  const shareUrl = await createOrGetSharedLink(accessToken, path);
  return { input: rawPath, path, ...shareLinkForms(shareUrl) };
}

function printResult(r: LinkResult): void {
  console.log(`${r.input} -> ${r.path}`);
  console.log(`  setlist: ${r.setlistUrl}`);
  console.log(`  widget:  ${r.widgetUrl}`);
}

// Batch entry point: resolves every path against one refreshed access token.
// Returns 0 only if every path succeeded; a failure on one path doesn't stop
// the rest (each is reported and the run still exits non-zero).
export async function main(rawPaths: string[]): Promise<number> {
  if (rawPaths.length === 0) {
    console.error("[dropbox-link] no paths given; pass path args or pipe paths on stdin");
    return 1;
  }
  let accessToken: string;
  try {
    accessToken = await refreshAccessToken();
  } catch (err) {
    console.error(`[dropbox-link] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  let exitCode = 0;
  for (const rawPath of rawPaths) {
    try {
      printResult(await linksForPath(rawPath, accessToken));
    } catch (err) {
      console.error(
        `[dropbox-link] ${rawPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      exitCode = 1;
    }
  }
  return exitCode;
}

async function readStdinPaths(): Promise<string[]> {
  if (Deno.stdin.isTerminal()) return [];
  const text = await new Response(Deno.stdin.readable).text();
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

if (import.meta.main) {
  const argPaths = Deno.args.filter((a) => a !== "--");
  const stdinPaths = await readStdinPaths();
  try {
    Deno.exit(await main([...argPaths, ...stdinPaths]));
  } catch (err) {
    console.error(err);
    Deno.exit(1);
  }
}
