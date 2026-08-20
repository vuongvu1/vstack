import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
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

/** Tried in order — complementary, not redundant. Some videos' only muxed
 *  rendition is progressive itag 18, which 403s for the ANDROID_VR client
 *  yt-dlp 2026.07.04 extracts by default; those download fine over DASH
 *  (video-only + audio-only itags). Other videos are the exact reverse:
 *  DASH 403s, the muxed progressive itag downloads fine. yt-dlp's own `/`
 *  fallback inside a single selector cannot cover this, because the 403
 *  happens at *download* time, after yt-dlp has already committed to a
 *  format — so the retry has to live here instead. Both cap at 1080p so a
 *  4K source doesn't pull far more than a 1080-wide output needs.
 *  Verified directly against `yt-dlp` on the CLI, independent of this
 *  codebase. Revisit once yt-dlp/YouTube compatibility catches up. */
const FORMATS = [
  "bv*[height<=1080]+ba[ext=m4a]/bv*[height<=1080]+ba",
  "best[height<=1080]/best",
];

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
    // Must end in .mp4: with --merge-output-format mp4, yt-dlp appends the
    // container extension whenever -o does not already carry it, which
    // would otherwise put the real output at `<path>.part.mp4` while this
    // code renamed from `<path>.part` — a mismatch that silently masked a
    // successful download as a failed one.
    const partial = `${path}.part.mp4`;
    let lastErr: unknown;
    let fetched = false;
    for (const format of FORMATS) {
      try {
        await run(
          "yt-dlp",
          [
            "-f",
            format,
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
        console.warn(
          `vstack: fetched ${videoId} ${windowStart}-${windowEnd} using format "${format}"`,
        );
        fetched = true;
        break;
      } catch (err) {
        lastErr = err;
        // Each attempt cleans up its own partial before the next one starts
        // — otherwise a stale partial from a failed attempt could be renamed
        // as if a later attempt had succeeded.
        await rm(partial, { force: true });
      }
    }
    if (!fetched) throw toolError("yt-dlp", lastErr);

    // Check the assumption rather than trusting it: a silent mismatch
    // between where yt-dlp actually wrote the file and where this code
    // looked for it is exactly what hid the .part/.part.mp4 bug above, and
    // would hide the next one just as quietly.
    if (!existsSync(path)) {
      const dirEntries = await readdir(dirname(path)).catch(() => []);
      throw new Error(
        `yt-dlp reported success but ${path} does not exist. ` +
          `Directory contents: ${dirEntries.join(", ") || "(empty)"}`,
      );
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
