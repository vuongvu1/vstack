import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { PAD } from "../src/geometry.ts";
import { clipPath, probeFile } from "./ffmpeg.ts";
import { HttpError } from "./index.ts";

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

/** Wraps a failed spawn so the route can hand the raw tool output to the
 *  user. yt-dlp's own messages track YouTube's changes better than any
 *  taxonomy of ours would. */
export function toolError(name: string, err: unknown): Error {
  if (err === null || err === undefined) {
    return new Error(`${name} failed: unknown error`);
  }
  const e = err as { stderr?: string; message?: string };
  const tail = (e.stderr ?? e.message ?? "")
    .trim()
    .split("\n")
    .slice(-5)
    .join("\n");
  return new Error(`${name} failed:\n${tail}`);
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
// Revisit once yt-dlp/YouTube compatibility catches up.
const FORMAT = "best";

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
          path,
          watchUrl(videoId),
        ],
        { maxBuffer: BIG },
      );
    } catch (err) {
      throw toolError("yt-dlp", err);
    }
    // -o plus --merge-output-format mp4 does not guarantee the file lands
    // exactly at `path` — yt-dlp can append an extension or pick a
    // different container. The cache key depends on this path being
    // predictable, so a mismatch fails loudly with what's actually on
    // disk rather than silently caching under the wrong name.
    if (!existsSync(path)) {
      const dir = dirname(path);
      const found = existsSync(dir) ? readdirSync(dir).join(", ") : "(directory does not exist)";
      throw new Error(
        `yt-dlp did not produce the expected file ${path}. Directory contents: ${found}`,
      );
    }
  }

  const { width, height } = await probeFile(path);
  return {
    clipUrl: `/media/${videoId}/${windowStart}-${windowEnd}.mp4`,
    windowStart,
    windowEnd,
    width,
    height,
  };
}
