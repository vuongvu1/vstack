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
import { join } from "node:path";
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

function clean(text: string): string {
  return text
    .replace(SHORTS, "$1")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Reels has one text field. It gets the YouTube title and description, minus
 *  `#Shorts` — a YouTube classifier that means nothing on Facebook. Every other
 *  hashtag stays exactly as written. */
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

// ponytail: one global upload slot, same posture as youtube.ts's.
let progress = { sent: 0, total: 0 };

export function reelProgress(): { sent: number; total: number } {
  return { ...progress };
}

/** The upload leg. `node:https` for `putVideo`'s reason — an exact
 *  `Content-Length` is a forbidden header under fetch — and with every one of
 *  its guards; see the comments there for why each exists. */
function sendBytes(videoId: string, token: string, path: string, size: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let seenResponse = false;
    const file = createReadStream(path);
    const fail = (err: Error) => {
      file.destroy();
      req.destroy();
      reject(err);
    };
    const req = httpsRequest(
      `https://rupload.facebook.com/video-upload/${GRAPH_VERSION}/${videoId}`,
      {
        method: "POST",
        headers: {
          authorization: `OAuth ${token}`,
          offset: "0",
          file_size: String(size),
          "content-length": size,
        },
      },
      (res) => {
        seenResponse = true;
        res.on("error", fail);
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 300) fail(new Error(`Reel upload failed (${res.statusCode ?? 0}): ${text}`));
          else resolve();
        });
      },
    );
    req.setTimeout(600_000, () => {
      req.destroy(new Error("The Reel upload timed out after 10 minutes with no response from Facebook."));
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
    await sendBytes(videoId, page.pageToken, opts.path, opts.size);
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
  // ponytail: Business Suite's posts view for the Page, whose Drafts tab holds
  // this. Meta does not document a stable deep link to the drafts list itself.
  return { videoId, url: `https://business.facebook.com/latest/posts?asset_id=${page.pageId}` };
}
