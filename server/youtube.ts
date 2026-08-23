/** YouTube upload. Sits at the errors-only layer beside `ffmpeg.ts` and
 *  `starter.ts` rather than above them — it re-derives its own paths and
 *  never needs MEDIA_DIR or OUT_DIR, which the caller hands it instead.
 *
 *  An unaudited YouTube Data API project has every `videos.insert` upload
 *  locked to private viewing, so "publish" here means "upload a private
 *  draft" and the public flip stays a manual step in YouTube Studio. That is
 *  not a limitation to route around; it is what this module does. */

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { YT_TITLE_MAX } from "../src/defaults.ts";
import { HttpError } from "./errors.ts";

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

// `accessToken` throws this for two different causes — no OAuth client JSON
// at all, or a client but no (or an expired) refresh token — because
// `pnpm youtube-auth` is step one for either: it refuses with "no OAuth
// client" for the first and performs the consent flow for the second.
export const AUTH_HINT =
  "YouTube publishing is not set up, or has no client/token. Fix: pnpm youtube-auth";

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

/** Access tokens last an hour; a publish takes seconds. Cached with 30s of
 *  slack so a token cannot expire between the check and the upload. */
let cached: { token: string; expires: number } | null = null;

export async function accessToken(): Promise<string> {
  if (cached !== null && cached.expires > Date.now() + 30_000) return cached.token;
  const client = readClient();
  const refresh = readRefreshToken();
  if (client === null || refresh === null) throw new HttpError(400, AUTH_HINT);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    // A 400 or 401 here is almost always Google having expired the refresh
    // token, which it does after 7 days for any consent screen still in
    // Testing publishing status. Naming the fix matters more than the raw
    // "invalid_grant" would.
    if (res.status === 400 || res.status === 401) throw new HttpError(400, `${AUTH_HINT}\n\n${text}`);
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }
  const body = JSON.parse(text) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

export type SnippetInput = { title: string; description: string; tags: string };

export type VideoResource = {
  snippet: { title: string; description: string; tags: string[]; categoryId: string };
  status: { privacyStatus: string; selfDeclaredMadeForKids: boolean };
};

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
      title: input.title.trim().slice(0, YT_TITLE_MAX),
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

// ponytail: one global upload slot — this is a single-user local tool and
// two publishes cannot overlap in the UI. Key it by output name if that ever
// stops being true.
let progress = { sent: 0, total: 0 };

export function publishProgress(): { sent: number; total: number } {
  return { ...progress };
}

/** The resumable protocol's second leg. Deliberately `node:https` and not
 *  `fetch`: this PUT needs an exact `Content-Length`, and `Content-Length` is
 *  a forbidden header name under the fetch spec — a fetch with a stream body
 *  is free to drop it and send chunked, which this endpoint does not accept.
 *  Piping a read stream into an https request also gives byte-level progress
 *  from one `data` listener, with no transform stream in the way. */
function putVideo(session: string, path: string, size: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // `seenResponse` decides which side owns a failure: once headers have
    // arrived, a write-side error is just the still-open socket noticing the
    // server already hung up, not the actual failure.
    let seenResponse = false;
    const file = createReadStream(path);
    // Tears down both streams before rejecting, on every error path (never
    // on the success path below, where both have already ended naturally).
    // Without this a failed upload leaves an open fd and a socket with a
    // declared-but-unsent Content-Length until GC. Declared before `req` is
    // assigned; every call site below is inside a callback that only runs
    // once `req` exists, never in this function's own synchronous body.
    const fail = (err: Error) => {
      file.destroy();
      req.destroy();
      reject(err);
    };
    const req = httpsRequest(
      session,
      { method: "PUT", headers: { "content-type": "video/mp4", "content-length": size } },
      (res) => {
        seenResponse = true;
        // Without this, Node swallows a destroyed response with no listener
        // and "end" never fires — the promise settles neither way and the
        // upload hangs forever (busy stuck, poll ticking, progress never
        // reset) until the page is reloaded.
        res.on("error", fail);
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 300) {
            // Google's own body, verbatim — the same posture yt-dlp and
            // ffmpeg stderr already get. A 403 here is usually the ~100
            // uploads/day this endpoint has had its own quota for since
            // June 2026.
            fail(new Error(`Upload failed (${res.statusCode ?? 0}): ${text}`));
          } else {
            resolve(text);
          }
        });
      },
    );
    // Without this a silently stalled connection hangs the promise forever —
    // no FIN, no RST, so neither error handler ever fires. Ten minutes is far
    // longer than a few-MB upload needs and short enough to not look frozen.
    req.setTimeout(600_000, () => {
      req.destroy(new Error("The upload timed out after 10 minutes with no response from YouTube."));
    });
    // A write-side error must not preempt a response that already arrived:
    // when the endpoint rejects an upload early it answers and closes, and
    // the EPIPE from the still-writing body would otherwise replace Google's
    // own message with "write EPIPE". If nothing was received at all, the
    // write error IS the failure, so it still rejects — named, because
    // "EPIPE" alone tells the user nothing they can act on.
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (seenResponse) return;
      const cause =
        err.code === "EPIPE" || err.code === "ECONNRESET"
          ? "YouTube closed the connection during the upload — this is usually the daily upload quota or an expired session. "
          : "";
      fail(new Error(`${cause}${err.message}`));
    });
    file.on("data", (chunk: Buffer) => {
      progress = { sent: progress.sent + chunk.length, total: size };
    });
    file.on("error", fail);
    file.pipe(req);
  });
}

/** Uploads a finished short and returns its video id. It lands **private**
 *  and there is no option: an unaudited API project has every videos.insert
 *  locked to private viewing, so the public flip is a manual step in Studio. */
export async function uploadVideo(opts: {
  path: string;
  size: number;
  video: VideoResource;
}): Promise<string> {
  const token = await accessToken();
  const init = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(opts.size),
        "x-upload-content-type": "video/mp4",
      },
      body: JSON.stringify(opts.video),
    },
  );
  if (!init.ok) {
    throw new Error(`YouTube refused the upload session (${init.status}): ${await init.text()}`);
  }
  const session = init.headers.get("location");
  if (session === null) {
    throw new Error("YouTube accepted the session but returned no Location header.");
  }

  progress = { sent: 0, total: opts.size };
  try {
    const body = JSON.parse(await putVideo(session, opts.path, opts.size)) as { id?: string };
    if (body.id === undefined) {
      throw new Error("The upload succeeded but YouTube returned no video id.");
    }
    return body.id;
  } finally {
    // Reset on the failure path too — a stale 90% left behind would make the
    // next publish look like it started three-quarters done.
    progress = { sent: 0, total: 0 };
  }
}

/** Sets a video's custom thumbnail.
 *
 *  Plain `fetch` with a Buffer body, deliberately unlike the video upload's
 *  `node:https` PUT: a Buffer body gets its `Content-Length` set for us, so
 *  the forbidden-header problem that forces the other one onto `node:https`
 *  never arises. The file is under 2 MB by construction — that is the API's
 *  cap and why `firstFrame` compresses.
 *
 *  `youtube.upload`, the scope the auth script already requests, is one of
 *  the scopes this method accepts, so nothing has to be re-authorised.
 *
 *  Throws on refusal, and the caller is expected to treat that as
 *  non-fatal: a 403 here usually means the channel has never been
 *  phone-verified, which blocks custom thumbnails account-wide and has
 *  nothing to do with the video that just uploaded fine. */
export async function setThumbnail(videoId: string, jpeg: string): Promise<void> {
  const token = await accessToken();
  const res = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/thumbnails/set" +
      `?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "image/jpeg" },
      body: readFileSync(jpeg),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    // Google's own body, verbatim, like every other failure in this module.
    throw new Error(`Thumbnail rejected (${res.status}): ${text}`);
  }
  // A 2xx here is NOT proof the thumbnail is in use. The reply is a
  // ThumbnailSetResponse listing the sizes YouTube actually generated, and
  // an empty `items` is how "accepted, then not applied" looks from the
  // outside — which a bare status check cannot tell apart from success.
  // Logged rather than parsed: what YouTube returns here is the only view
  // this scope has of what it stored, and `videos.list` would need a scope
  // the auth script does not request.
  console.warn(`vstack: thumbnails.set answered ${res.status}: ${text.trim()}`);
}
