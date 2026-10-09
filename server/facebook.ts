/** Facebook Page Reels upload. Sits beside `youtube.ts` at the errors-only
 *  layer and imports nothing from it — the two APIs share only "stream a file
 *  over https", and a shared publisher layer would be two copies with extra
 *  indirection.
 *
 *  Every Reel lands as a DRAFT on the Page, for the user to schedule in Meta
 *  Business Suite. Unlike YouTube there is no forced-private mode, so DRAFT
 *  is what keeps "publish" from meaning "live to every follower". */

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { HttpError } from "./errors.ts";

/** Re-derived rather than imported from `youtube.ts`, its sibling — the same
 *  call `starter.ts` and `youtube.ts` each make. Outside the project root
 *  because Vite serves that root statically. */
export const CONFIG_DIR = join(homedir(), ".vstack");
/** `{ appId, appSecret }`, written by hand once. Only the auth script reads it. */
export const CLIENT_PATH = join(CONFIG_DIR, "facebook-client.json");
/** `{ pageId, pageName, pageToken }`, written at mode 0600 by `pnpm facebook-auth`. */
export const TOKEN_PATH = join(CONFIG_DIR, "facebook-token.json");

// ponytail: pinned. Meta retires a Graph version about two years after
// release; bump this when the API starts answering with a deprecation error.
export const GRAPH_VERSION = "v23.0";
export const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export const AUTH_HINT =
  "Facebook Reels publishing is not set up. Fix: see scripts/facebook-auth.ts, then pnpm facebook-auth <token>";

/** Meta's own bounds for an API-published Reel. */
export const REEL_MIN = 3;
export const REEL_MAX = 90;

const SHORTS = /(^|\s)#shorts(?=\s|$)/gi;
// The description template's Ko-fi line is for YouTube only; with it goes the
// `------` rule that would otherwise end the post on nothing.
const KOFI = /^.*ko-fi\.com.*$/gim;
const TRAILING_RULE = /\n\s*-{3,}\s*$/;

function clean(text: string): string {
  return text
    .replace(SHORTS, "$1")
    .replace(KOFI, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(TRAILING_RULE, "")
    .trim();
}

/** Reels has one text field. It gets the YouTube title and description, minus
 *  `#Shorts` — a YouTube classifier that means nothing on Facebook — and minus
 *  the Ko-fi line. Every other hashtag stays exactly as written. */
export function buildCaption(title: string, description: string): string {
  return [clean(title), clean(description)].filter((part) => part !== "").join("\n\n");
}

/** Checked before a byte is sent: Meta accepts the whole upload and only
 *  refuses an out-of-range Reel at `finish`. */
export function reelLengthError(seconds: number): string | null {
  if (seconds >= REEL_MIN && seconds <= REEL_MAX) return null;
  return `This video is ${seconds.toFixed(1)}s; a Facebook Reel must be ${REEL_MIN}–${REEL_MAX}s.`;
}

export type PageToken = { pageId: string; pageName: string; pageToken: string };

export function readPageToken(): PageToken | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as Partial<PageToken>;
    if (!raw.pageId || !raw.pageToken) return null;
    return { pageId: raw.pageId, pageName: raw.pageName ?? "", pageToken: raw.pageToken };
  } catch {
    return null;
  }
}

/** Soft, like `checkYouTube`: only the Reel button needs it. */
export function checkFacebook(): void {
  if (readPageToken() !== null) return;
  console.warn(`vstack: ${AUTH_HINT}`);
}

/** One Graph POST. The token rides in the form body, never the URL — URLs
 *  end up in logs and error messages. Meta's own message is passed through
 *  verbatim, rate-limit refusals included. */
export async function graphPost(
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Facebook answered ${res.status} with a non-JSON body: ${text}`);
  }
  if (!res.ok || body.error !== undefined) {
    const message = (body.error as { message?: string } | undefined)?.message ?? text;
    throw new Error(`Facebook refused ${path} (${res.status}): ${message}`);
  }
  return body;
}

// ponytail: one global upload slot for both Facebook uploads, same posture
// as youtube.ts's — the UI cannot run two at once.
let progress = { sent: 0, total: 0 };

export function reelProgress(): { sent: number; total: number } {
  return { ...progress };
}

/** The byte leg of both uploads: the whole file in one POST, answered with
 *  Meta's response body. `node:https` for `putVideo`'s reason — an exact
 *  `Content-Length` is a forbidden header under fetch — and with every one of
 *  its guards; see the comments there for why each exists. */
function sendBytes(
  url: string,
  headers: Record<string, string>,
  path: string,
  size: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let seenResponse = false;
    const file = createReadStream(path);
    const fail = (err: Error) => {
      file.destroy();
      req.destroy();
      reject(err);
    };
    const req = httpsRequest(
      url,
      { method: "POST", headers: { ...headers, "content-length": size } },
      (res) => {
        seenResponse = true;
        res.on("error", fail);
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 300) fail(new Error(`Facebook upload failed (${res.statusCode ?? 0}): ${text}`));
          else resolve(text);
        });
      },
    );
    req.setTimeout(600_000, () => {
      req.destroy(new Error("The Facebook upload timed out after 10 minutes with no response."));
    });
    req.on("error", (err) => {
      if (!seenResponse) fail(err);
    });
    file.on("data", (chunk: Buffer) => {
      progress = { sent: progress.sent + chunk.length, total: size };
    });
    file.on("error", fail);
    file.pipe(req);
  });
}

/** Uploads a finished short as a Reel DRAFT on the Page and returns where to
 *  find it. Three legs: `start` mints a video id, the bytes go to rupload,
 *  `finish` attaches the caption and the state. */
export async function uploadReel(opts: {
  path: string;
  size: number;
  caption: string;
}): Promise<{ videoId: string; url: string }> {
  const page = readPageToken();
  if (page === null) throw new HttpError(400, AUTH_HINT);
  const reels = `${page.pageId}/video_reels`;

  const start = await graphPost(reels, { upload_phase: "start", access_token: page.pageToken });
  const videoId = start.video_id;
  if (typeof videoId !== "string") throw new Error("Facebook started the upload but returned no video_id.");

  progress = { sent: 0, total: opts.size };
  try {
    await sendBytes(
      `https://rupload.facebook.com/video-upload/${GRAPH_VERSION}/${videoId}`,
      { authorization: `OAuth ${page.pageToken}`, offset: "0", file_size: String(opts.size) },
      opts.path,
      opts.size,
    );
  } finally {
    progress = { sent: 0, total: 0 };
  }

  await graphPost(reels, {
    upload_phase: "finish",
    video_id: videoId,
    video_state: "DRAFT",
    description: opts.caption,
    access_token: page.pageToken,
  });
  return { videoId, url: suiteUrl(page.pageId) };
}

// ponytail: Business Suite's posts view for the Page, whose Drafts tab holds
// what these uploads leave. Meta documents no stable deep link to one draft.
function suiteUrl(pageId: string): string {
  return `https://business.facebook.com/latest/posts?asset_id=${pageId}`;
}

/** The Meta app id the upload session is opened under. Read from the client
 *  file rather than the token file because a token written before this
 *  existed does not carry it, and the auth script needs the file anyway. */
function readAppId(): string | null {
  try {
    const raw = JSON.parse(readFileSync(CLIENT_PATH, "utf8")) as { appId?: string };
    return raw.appId ?? null;
  } catch {
    return null;
  }
}

/** Uploads a finished horizontal render to the Page as an UNPUBLISHED video,
 *  for the user to schedule in Business Suite. The Resumable Upload API, the
 *  flow Meta now recommends for Page videos: open a session under the app,
 *  send the bytes, then attach the returned handle to `/{page}/videos`.
 *  The Page token opens the session (verified), so this needs no user token.
 *
 *  ponytail: one POST for the whole file and no resume. Meta answers
 *  `file_offset` on a GET of the session if a multi-GB upload ever needs it.
 *  No size or duration cap is checked: Meta's docs state none, and the one
 *  journey that makes very large files (lofi) is not offered this button. */
export async function uploadPageVideo(opts: {
  path: string;
  size: number;
  title: string;
  description: string;
  /** A still JPEG for the cover, if the render has one. */
  thumb: string | null;
}): Promise<{ videoId: string; url: string }> {
  const page = readPageToken();
  const appId = readAppId();
  if (page === null || appId === null) throw new HttpError(400, AUTH_HINT);

  const session = await graphPost(`${appId}/uploads`, {
    file_name: basename(opts.path),
    file_length: String(opts.size),
    file_type: "video/mp4",
    access_token: page.pageToken,
  });
  if (typeof session.id !== "string") throw new Error("Facebook opened no upload session.");

  progress = { sent: 0, total: opts.size };
  let handle: unknown;
  try {
    const text = await sendBytes(
      `${GRAPH}/${session.id}`,
      { authorization: `OAuth ${page.pageToken}`, file_offset: "0" },
      opts.path,
      opts.size,
    );
    handle = (JSON.parse(text) as { h?: unknown }).h;
  } finally {
    progress = { sent: 0, total: 0 };
  }
  if (typeof handle !== "string") throw new Error("Facebook took the bytes but returned no file handle.");

  // Multipart rather than a form body: `thumb` is raw image data. Small,
  // so plain fetch is fine here — the forbidden-header problem is the video's.
  const form = new FormData();
  form.set("access_token", page.pageToken);
  form.set("title", opts.title);
  form.set("description", opts.description);
  form.set("published", "false");
  form.set("fbuploader_video_file_chunk", handle);
  if (opts.thumb !== null) {
    form.set("thumb", new Blob([readFileSync(opts.thumb)], { type: "image/jpeg" }), "thumb.jpg");
  }
  const res = await fetch(`${GRAPH}/${page.pageId}/videos`, { method: "POST", body: form });
  const text = await res.text();
  const body = JSON.parse(text) as { id?: unknown; error?: { message?: string } };
  if (!res.ok || typeof body.id !== "string") {
    throw new Error(`Facebook refused the video (${res.status}): ${body.error?.message ?? text}`);
  }
  return { videoId: body.id, url: suiteUrl(page.pageId) };
}
