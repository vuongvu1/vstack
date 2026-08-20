import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HALF, isValidBox } from "../src/geometry.ts";
import type { Rect, Size } from "../src/geometry.ts";
import { toolError } from "./errors.ts";

const run = promisify(execFile);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MEDIA_DIR = join(ROOT, "media");

/** Window bounds are integers so filenames are stable and the cache
 *  actually hits on a repeated request. Task 6 reconstructs this exact name
 *  from videoId + window bounds, so clipPath and the served clipUrl must
 *  derive from the same template rather than each string-building it. */
export function clipName(windowStart: number, windowEnd: number): string {
  return `${windowStart}-${windowEnd}.mp4`;
}

export function clipPath(videoId: string, windowStart: number, windowEnd: number): string {
  return join(MEDIA_DIR, videoId, clipName(windowStart, windowEnd));
}

/** The fetched clip's real dimensions. yt-dlp picks a format, so these can
 *  differ from what --dump-json advertised — and since crop rects are stored
 *  in source pixels, framing against the wrong dimensions silently
 *  mis-crops. This is the number geometry must use. */
export async function probeFile(path: string): Promise<{ width: number; height: number }> {
  let stdout: string;
  try {
    ({ stdout } = await run("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      path,
    ]));
  } catch (err) {
    throw toolError("ffprobe", err);
  }
  const stream = (JSON.parse(stdout) as { streams?: { width: number; height: number }[] })
    .streams?.[0];
  if (!stream?.width || !stream?.height) {
    throw new Error(`ffprobe found no video stream in ${path}`);
  }
  return { width: stream.width, height: stream.height };
}

export type ExportOpts = {
  input: string;
  start: number;
  duration: number;
  top: Rect;
  bottom: Rect;
  source: Size;
  out: string;
};

/** One decode, split two ways, each leg cropped and scaled to a half, then
 *  stacked. Two -i of the same file would decode it twice. */
export function buildFilter(top: Rect, bottom: Rect): string {
  const leg = (r: Rect) =>
    `crop=${r.w}:${r.h}:${r.x}:${r.y},scale=${HALF.w}:${HALF.h}:flags=lanczos`;
  return [
    "[0:v]split=2[a][b]",
    `[a]${leg(top)}[t]`,
    `[b]${leg(bottom)}[u]`,
    "[t][u]vstack=inputs=2[v]",
  ].join(";");
}

/** Numbers are the one thing interpolated into the filter string, and a NaN
 *  or out-of-bounds rect makes ffmpeg fail unreadably. Same isValidBox the
 *  client editor uses, so there is one definition of a legal rect. */
export function assertBoxes(top: Rect, bottom: Rect, source: Size): void {
  for (const [name, rect] of [["top", top], ["bottom", bottom]] as const) {
    if (!isValidBox(rect, source)) {
      throw new Error(
        `Invalid ${name} box ${JSON.stringify(rect)} for source ` +
          `${source.w}x${source.h}: must be integers, 9:8 (w = round(h * 9/8)), ` +
          `and fully inside the frame.`,
      );
    }
  }
}

export async function exportClip(opts: ExportOpts): Promise<string> {
  assertBoxes(opts.top, opts.bottom, opts.source);
  if (!Number.isFinite(opts.start) || opts.start < 0) {
    throw new Error(`Invalid start ${opts.start}: must be a non-negative number of seconds.`);
  }
  if (!Number.isFinite(opts.duration) || opts.duration <= 0) {
    throw new Error(`Invalid duration ${opts.duration}: must be a positive number of seconds.`);
  }
  try {
    await run(
      "ffmpeg",
      [
        "-v", "error",
        "-i", opts.input,
        // -ss AFTER -i is frame-accurate. Before -i it snaps to a keyframe
        // and drifts up to ~2s; decoding the pad is what buys the accuracy.
        "-ss", String(opts.start),
        // -t (duration) not -to, which is ambiguous after a seek.
        "-t", String(opts.duration),
        "-filter_complex", buildFilter(opts.top, opts.bottom),
        "-map", "[v]",
        // The ? makes audio optional so a silent source still exports.
        "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        "-y", opts.out,
      ],
      { maxBuffer: 16 << 20 },
    );
  } catch (err) {
    throw toolError("ffmpeg", err);
  }
  return opts.out;
}
