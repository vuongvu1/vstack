/** The script reader's one job: a whole voiceover script, read aloud into
 *  one mp3.
 *
 *  Sits BESIDE `cut.ts`, `lofi.ts`, `longform.ts` and `starter.ts`: every
 *  path is the caller's, so it needs neither `MEDIA_DIR` nor `OUT_DIR`. It
 *  reaches into two siblings on purpose — `speak` because `starter.ts` stays
 *  the only thing that ever spawns `tts.py`, and `MP3_QUALITY` because two
 *  mp3 producers in one app should not encode at two qualities. */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { MP3_QUALITY } from "./cut.ts";
import { toolError } from "./errors.ts";
import { speak } from "./starter.ts";

const run = promisify(execFile);

/** Speaks `script` in `voice` and encodes it to mp3 at `out`.
 *
 *  The whole script goes to the engine in ONE call. VieNeu v3 Turbo chunks
 *  it itself (256 chars, joined with a short silence); chunking here as well
 *  would double the pauses and could split a sentence the engine would have
 *  kept whole.
 *
 *  ponytail: one blocking run, no progress. Measured at the `SCRIPT_MAX`
 *  cap: 110s wall and 1.78 GB peak for 12m25s of audio. Progress and
 *  chunk-resume are the upgrade if scripts outgrow that wait. */
export async function scriptMp3(
  script: string,
  voice: string,
  dir: string,
  out: string,
): Promise<void> {
  const wav = join(dir, "script.wav");
  await speak(script, dir, wav, voice);
  try {
    await run("ffmpeg", [
      "-v", "error",
      "-i", wav,
      "-c:a", "libmp3lame",
      "-q:a", MP3_QUALITY,
      "-y", out,
    ]);
  } catch (err) {
    throw toolError("ffmpeg", err);
  }
}
