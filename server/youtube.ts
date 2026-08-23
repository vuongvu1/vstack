/** YouTube upload. Sits at the errors-only layer beside `ffmpeg.ts` and
 *  `starter.ts` rather than above them — it re-derives its own paths and
 *  never needs MEDIA_DIR or OUT_DIR, which the caller hands it instead.
 *
 *  An unaudited YouTube Data API project has every `videos.insert` upload
 *  locked to private viewing, so "publish" here means "upload a private
 *  draft" and the public flip stays a manual step in YouTube Studio. That is
 *  not a limitation to route around; it is what this module does. */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Outside the project root on purpose. Vite's dev server serves the project
 *  root statically — that is how `/out/<name>` and `/media/…` reach the
 *  browser with no route behind them — so a `secrets/` directory here would
 *  hand a refresh token to any page the browser has open. Nothing under the
 *  project root is private, so nothing private goes under it. */
export const CONFIG_DIR = join(homedir(), ".vstack");
/** The OAuth client JSON downloaded from Google Cloud Console. */
export const CLIENT_PATH = join(CONFIG_DIR, "youtube-client.json");
/** `{ refresh_token }`, written at mode 0600 by `pnpm youtube-auth`. */
export const TOKEN_PATH = join(CONFIG_DIR, "youtube-token.json");

export const SCOPE = "https://www.googleapis.com/auth/youtube.upload";

export const AUTH_HINT =
  "YouTube publishing is not set up (or the token expired). Fix: pnpm youtube-auth";

export type Client = { clientId: string; clientSecret: string };

/** The OAuth client. Env vars win so a second project needs no file move.
 *  Google's downloaded file nests the pair under `installed` for a Desktop
 *  client and `web` for a Web one; both are read, though Desktop is what the
 *  setup instructions ask for — Google ignores the port on a loopback
 *  redirect for that client type, so the script's port needs no
 *  registration. */
export function readClient(): Client | null {
  const id = process.env.VSTACK_YT_CLIENT_ID;
  const secret = process.env.VSTACK_YT_CLIENT_SECRET;
  if (id && secret) return { clientId: id, clientSecret: secret };
  if (!existsSync(CLIENT_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CLIENT_PATH, "utf8")) as {
      installed?: { client_id?: string; client_secret?: string };
      web?: { client_id?: string; client_secret?: string };
    };
    const found = raw.installed ?? raw.web;
    if (!found?.client_id || !found.client_secret) return null;
    return { clientId: found.client_id, clientSecret: found.client_secret };
  } catch {
    // A corrupt or hand-edited file reads the same as no file: the fix is
    // the same command either way.
    return null;
  }
}

export function readRefreshToken(): string | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as { refresh_token?: string };
    return raw.refresh_token ?? null;
  } catch {
    return null;
  }
}

/** Soft, unlike `checkStarter`: missing credentials mean Publish does not
 *  work, not that vstack refuses to boot. Everything else in this app works
 *  without a Google project, and `/api/publish` returns the same hint at the
 *  moment it is actually needed. */
export function checkYouTube(): void {
  if (readClient() !== null && readRefreshToken() !== null) return;
  console.warn(`vstack: ${AUTH_HINT}`);
}

/** Trades an authorisation code for a refresh token. Lives here rather than
 *  in the script so the two token calls sit next to each other and share one
 *  error shape. */
export async function exchangeCode(
  client: Client,
  code: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${text}`);
  const body = JSON.parse(text) as { refresh_token?: string };
  if (!body.refresh_token) {
    throw new Error(
      "Google returned no refresh_token. This happens when the account has " +
        "already granted this client and Google reuses the old grant — the " +
        "auth URL sends prompt=consent to avoid it, so check that the URL " +
        "opened was the one this script printed.",
    );
  }
  return body.refresh_token;
}

export type SnippetInput = { title: string; description: string; tags: string };

export type VideoResource = {
  snippet: { title: string; description: string; tags: string[]; categoryId: string };
  status: { privacyStatus: string; selfDeclaredMadeForKids: boolean };
};

/** YouTube rejects a longer title outright, and `starterTitle` — which this
 *  prefills from — allows 200. */
const TITLE_MAX = 100;
const SHORTS = "#Shorts";
/** People & Blogs. A picker would be an AppState field, a categories route
 *  and a save/restore migration for a value this tool never varies.
 *  ponytail: add one the day a second category is wanted. */
const CATEGORY = "22";

/** Everything the upload decides, in one pure function so the decisions can
 *  be tested without a network. */
export function buildSnippet(input: SnippetInput): VideoResource {
  const description = input.description.trim();
  return {
    snippet: {
      title: input.title.trim().slice(0, TITLE_MAX),
      // Case-insensitive, and only when absent: a user who typed the tag
      // themselves must not get it twice.
      description: /#shorts\b/i.test(description)
        ? description
        : `${description === "" ? "" : `${description}\n\n`}${SHORTS}`,
      tags: input.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== ""),
      categoryId: CATEGORY,
    },
    status: {
      privacyStatus: "private",
      // Required by the API — an upload without it is rejected.
      selfDeclaredMadeForKids: false,
    },
  };
}
