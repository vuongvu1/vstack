import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { PAD } from "../src/geometry.ts";
import { HttpError, toolError } from "./errors.ts";
import { clipName, clipPath, probeFile } from "./ffmpeg.ts";

const run = promisify(execFile);
const BIG = 64 << 20; // yt-dlp --dump-json on a long video is multi-MB

export type ProbeResult = {
  videoId: string;
  duration: number;
  width: number;
  height: number;
  title: string;
  isLive: boolean;
};

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

const HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

/** Accepts watch?v=, youtu.be/, /shorts/, /live/ and /embed/ forms.
 *  Returns null for anything that is not an 11-char YouTube id, so a bad
 *  URL is rejected before any process is spawned. */
export function videoIdFrom(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return ID_RE.test(url.trim()) ? url.trim() : null;
  }
  if (!HOSTS.has(parsed.hostname)) return null;
  const fromQuery = parsed.searchParams.get("v");
  const last = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
  const candidate = fromQuery ?? last;
  return ID_RE.test(candidate) ? candidate : null;
}

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export async function probe(videoId: string): Promise<ProbeResult> {
  let stdout: string;
  let j: Record<string, unknown>;
  try {
    ({ stdout } = await run(
      "yt-dlp",
      ["--dump-json", "--no-warnings", "--no-playlist", watchUrl(videoId)],
      { maxBuffer: BIG },
    ));
    j = JSON.parse(stdout) as Record<string, unknown>;
  } catch (err) {
    throw toolError("yt-dlp", err);
  }
  return {
    videoId,
    duration: Number(j.duration ?? 0),
    width: Number(j.width ?? 0),
    height: Number(j.height ?? 0),
    title: String(j.title ?? videoId),
    isLive: Boolean(j.is_live),
  };
}

export type WindowResult = {
  clipUrl: string;
  windowStart: number;
  windowEnd: number;
  width: number;
  height: number;
};

// ponytail: `bestvideo[height<=1080]+bestaudio/best[height<=1080]/best`
// (the ≥1080p-preferring selector we'd rather use — the crop is a sub-rect
// of the source scaled up to 1080 wide, so a 720p source means a 1.33x
// upscale) resolves to a progressive itag whose googlevideo CDN URL 403s on
// download for at least the ANDROID_VR client yt-dlp 2026.07.04 extracts by
// default — verified directly against `yt-dlp` on the CLI, independent of
// this codebase. `best` resolves to an HLS-backed itag that downloads fine.
// Capped at 1080p so a 4K source doesn't pull far more than a 1080-wide
// output needs; falls back to uncapped `best` if no <=1080 format exists.
// Revisit once yt-dlp/YouTube compatibility catches up.
const FORMAT = "best[height<=1080]/best";

/** Fetches (and caches) `[start − PAD, end + PAD]` clamped to the video's
 *  own bounds, then reports the clip's *actual* dimensions via ffprobe —
 *  yt-dlp picks a format, so the fetched resolution can differ from what
 *  --dump-json advertised, and crop rects are stored in source pixels. */
export async function fetchWindow(
  videoId: string,
  start: number,
  end: number,
  duration: number,
): Promise<WindowResult> {
  const windowStart = Math.max(0, Math.floor(start - PAD));
  const windowEnd = Math.min(
    Math.ceil(end + PAD),
    Math.ceil(duration) || Number.POSITIVE_INFINITY,
  );
  if (windowEnd <= windowStart) {
    throw new HttpError(
      400,
      `Requested window [${windowStart}, ${windowEnd}] is empty for a ${duration}s video.`,
    );
  }
  const path = clipPath(videoId, windowStart, windowEnd);

  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true });
    // Download to a `.part` sibling and rename only on success. --downloader
    // ffmpeg writes straight to -o with no .part convention of its own, so
    // without this a killed or failed fetch leaves a truncated mp4 at the
    // exact cache path — existsSync(path) must never be true for a
    // half-written clip, or the next request serves it as a broken cache hit.
    const partial = `${path}.part`;
    try {
      await run(
        "yt-dlp",
        [
          "-f",
          FORMAT,
          "--download-sections",
          `*${windowStart}-${windowEnd}`,
          "--downloader",
          "ffmpeg",
          "--merge-output-format",
          "mp4",
          "--no-playlist",
          "--no-warnings",
          "-o",
          partial,
          watchUrl(videoId),
        ],
        { maxBuffer: BIG },
      );
      await rename(partial, path);
    } catch (err) {
      await rm(partial, { force: true });
      throw toolError("yt-dlp", err);
    }
  }

  const { width, height } = await probeFile(path);
  return {
    clipUrl: `/media/${videoId}/${clipName(windowStart, windowEnd)}`,
    windowStart,
    windowEnd,
    width,
    height,
  };
}
