/** The audio cutter's one ffmpeg pass.
 *
 *  Sits BESIDE `ffmpeg.ts`, `starter.ts`, `longform.ts` and `lofi.ts` rather
 *  than above any of them: every path is the caller's, so it needs neither
 *  `MEDIA_DIR` nor `OUT_DIR`, and it imports nothing from `ffmpeg.ts` at
 *  all. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Segment } from "../src/segments.ts";
import { toolError } from "./errors.ts";

const run = promisify(execFile);

/** VBR, roughly 190 kbps. Deliberately not configurable: the user picked a
 *  file and wants the audio out of it, and a bitrate knob is a setting to
 *  explain rather than a decision anyone has to make. */
export const MP3_QUALITY = "2";

/** One range of `src`, re-encoded to mp3 at `out`.
 *
 *  `-ss` goes BEFORE `-i`, the same lesson `exportClip`'s mask input and
 *  `stackWide`'s per-part trims both carry: ffmpeg attaches an option to the
 *  *next* `-i`, so the other order would seek nothing, and `-ss` before the
 *  input is also what makes `-t` a duration measured from the seek point
 *  rather than from zero.
 *
 *  Re-encoding rather than stream-copying, so the in-point is exact. A copy
 *  snaps to the nearest frame boundary and silently moves the mark the user
 *  aimed at — the preview/export divergence this codebase treats as the
 *  cardinal failure, in the one phase whose entire job is where a cut lands.
 *
 *  `-vn` because the output is audio: a video input's picture is discarded
 *  here, the way a lofi speech's is.
 *
 *  ponytail: one pass per range. N is capped at `MAX_SEGMENTS` and these
 *  files are short, so a single decode with N outputs is not worth the
 *  mapping. */
export async function cutMp3(src: string, range: Segment, out: string): Promise<void> {
  try {
    await run("ffmpeg", [
      "-v", "error",
      "-ss", String(range.start),
      "-i", src,
      "-t", String(range.end - range.start),
      "-vn",
      "-c:a", "libmp3lame",
      "-q:a", MP3_QUALITY,
      "-y", out,
    ]);
  } catch (err) {
    throw toolError("ffmpeg", err);
  }
}
