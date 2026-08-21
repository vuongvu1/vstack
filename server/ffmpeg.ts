import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isValidBox } from "../src/geometry.ts";
import type { Rect, Size } from "../src/geometry.ts";
import { cellsOf, ratioOf } from "../src/layout.ts";
import type { Layout } from "../src/layout.ts";
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

function cacheSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? cacheSize(p) : statSync(p).size;
  }
  return total;
}

// ponytail: no eviction, just visibility. Add an LRU when this gets annoying.
/** Logs the media cache's total size. Called once at server boot and again
 *  after every successful fetch — a long session that only logged at boot
 *  would grow the cache silently until the next restart. */
export function reportCache(): void {
  try {
    if (!existsSync(MEDIA_DIR)) return;
    const mb = Math.round(cacheSize(MEDIA_DIR) / 1e6);
    if (mb > 0) console.warn(`vstack: media cache is ${mb} MB (media/)`);
  } catch (err) {
    console.warn("vstack: could not compute media cache size:", err);
  }
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
  layout: Layout;
  boxes: Rect[];
  source: Size;
  out: string;
};

/** One decode, split N ways, each leg cropped and scaled to its cell, then
 *  composed. Two -i of the same file would decode it twice.
 *
 *  A single xstack rather than hstack-per-row-then-vstack: it needs no
 *  special case for single-column rows, and its `layout=` string comes
 *  straight out of cellsOf, so the composition can't drift from the cells
 *  the preview and the editor use. For the 1-1 layout it emits
 *  `layout=0_0|0_960`, which is pixel-identical to the vstack this
 *  replaced. */
export function buildFilter(layout: Layout, boxes: Rect[]): string {
  const cells = cellsOf(layout);
  const legs = cells.map((cell, i) => {
    const r = boxes[i];
    // Thrown, not defaulted: a missing box means the caller and the layout
    // disagree, and a zero-size fallback would emit a filter graph ffmpeg
    // fails on unreadably. assertBoxes normally catches this first.
    if (r === undefined) {
      throw new Error(
        `buildFilter: layout ${layout.id} needs ${cells.length} boxes, got ${boxes.length}.`,
      );
    }
    return (
      `[c${i}]crop=${r.w}:${r.h}:${r.x}:${r.y},` +
      `scale=${cell.w}:${cell.h}:flags=lanczos[s${i}]`
    );
  });
  const inputs = cells.map((_, i) => `[c${i}]`).join("");
  const scaled = cells.map((_, i) => `[s${i}]`).join("");
  const positions = cells.map((c) => `${c.x}_${c.y}`).join("|");
  return [
    `[0:v]split=${cells.length}${inputs}`,
    ...legs,
    `${scaled}xstack=inputs=${cells.length}:layout=${positions}[v]`,
  ].join(";");
}

/** Numbers are the one thing interpolated into the filter string, and a NaN
 *  or out-of-bounds rect makes ffmpeg fail unreadably. Same isValidBox the
 *  client editor uses, so there is one definition of a legal rect — checked
 *  per box against *its own cell's* ratio, because a flawless 9:8 rect is
 *  still illegal for a 540x960 cell and would export stretched. */
export function assertBoxes(layout: Layout, boxes: Rect[], source: Size): void {
  const cells = cellsOf(layout);
  if (!Array.isArray(boxes) || boxes.length !== cells.length) {
    throw new Error(
      `Layout ${layout.id} needs ${cells.length} boxes, got ` +
        `${Array.isArray(boxes) ? String(boxes.length) : typeof boxes}.`,
    );
  }
  cells.forEach((cell, i) => {
    const rect = boxes[i];
    const ratio = ratioOf(cell);
    if (rect === undefined || !isValidBox(rect, source, ratio)) {
      throw new Error(
        `Invalid box ${i + 1} ${JSON.stringify(rect)} for source ` +
          `${source.w}x${source.h}: must be integers, ${cell.w}:${cell.h} ` +
          `(w = round(h * ${ratio})), and fully inside the frame.`,
      );
    }
  });
}

export async function exportClip(opts: ExportOpts): Promise<string> {
  assertBoxes(opts.layout, opts.boxes, opts.source);
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
        "-filter_complex", buildFilter(opts.layout, opts.boxes),
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
