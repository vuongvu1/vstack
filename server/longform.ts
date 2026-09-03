/** The long-form journey's one ffmpeg pass.
 *
 *  Sits BESIDE `ffmpeg.ts` rather than above it: it takes an output path
 *  from the caller and never needs `MEDIA_DIR` or `OUT_DIR`, the same
 *  posture `starter.ts` and `youtube.ts` already hold. It may read
 *  `probeFile`, and nothing else. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toolError } from "./errors.ts";
import { probeFile } from "./ffmpeg.ts";

const run = promisify(execFile);

/** YouTube's long-form shape, and not configurable: every input this feature
 *  takes is a 1080x1920 short, so a knob here would have one legal value. */
export const WIDE = { w: 1920, h: 1080 };

/** The blur is computed at 480x270 and stretched back up sixteenfold, and
 *  that stretch supplies most of the softening on its own — which is why
 *  this is 12 where `starter.ts`'s own BLUR_SIGMA is 30. Deliberately NOT
 *  imported from there: the two blur different things at different scales,
 *  and one shared constant would make tuning either one move the other.
 *
 *  Do not "improve" this by blurring at full resolution. A 1080x1920 source
 *  scaled to COVER 1920x1080 is 1920x3413, and gblur over that costs roughly
 *  fifty times what it costs here — for a picture whose entire purpose is to
 *  be out of focus. */
const BLUR_SIGMA = 12;
const BG_W = 480;
const BG_H = 270;

const FPS = 30;
const RATE = 44100;
/** The same crf `exportClip` uses. Unlike `concatClips` this is not an
 *  intermediate — it is the product — so there is no later generation to
 *  keep headroom for. */
const CRF = "20";

/** Letterboxes each part onto a blurred copy of itself and concatenates the
 *  lot into one 1920x1080 file, in ONE encode.
 *
 *  Every leg is normalised before `concat` sees it, for the same reason
 *  `concatClips` and `prependStarter` do it: `concat` REFUSES a mismatch
 *  rather than picking a side, and a SAR difference fails with `Nothing was
 *  written into output file`, which names nothing.
 *
 *  Two scale choices are load-bearing:
 *
 *  - The background is `increase` + `crop`, so it fills the frame edge to
 *    edge with no black anywhere.
 *  - The foreground is `decrease` + `force_divisible_by=2`, so a part that
 *    is NOT vertical fits inside the frame instead of overflowing it. An
 *    upload is any file the user picked; only the common case is 9:16.
 *
 *  A part with no audio gets a leg cut from a shared `anullsrc` input,
 *  appended LAST so the real parts' input indices never move — the same
 *  positional rule `concatClips` follows. */
export async function stackWide(paths: string[], out: string): Promise<string> {
  if (paths.length === 0) throw new Error("stackWide needs at least one part.");

  const probed = await Promise.all(paths.map((p) => probeFile(p)));
  const anySilent = probed.some((p) => !p.hasAudio);
  const silenceIndex = paths.length;

  const inputs: string[] = [];
  for (const path of paths) inputs.push("-i", path);
  if (anySilent) {
    inputs.push("-f", "lavfi", "-i", `anullsrc=r=${RATE}:cl=stereo`);
  }

  const legs: string[] = [];
  const labels: string[] = [];
  paths.forEach((_, i) => {
    const p = probed[i];
    const hasAudio = p?.hasAudio === true;
    const seconds = p?.seconds ?? 0;
    legs.push(
      `[${i}:v]split=2[bg${i}][fg${i}]`,
      `[bg${i}]scale=${BG_W}:${BG_H}:force_original_aspect_ratio=increase,` +
        `crop=${BG_W}:${BG_H},gblur=sigma=${BLUR_SIGMA},` +
        `scale=${WIDE.w}:${WIDE.h},setsar=1[bgz${i}]`,
      `[fg${i}]scale=${WIDE.w}:${WIDE.h}:force_original_aspect_ratio=decrease:` +
        `force_divisible_by=2,setsar=1[fgz${i}]`,
      `[bgz${i}][fgz${i}]overlay=(W-w)/2:(H-h)/2,fps=${FPS},` +
        `setpts=PTS-STARTPTS,format=yuv420p[v${i}]`,
    );
    // A silent part's leg is cut out of the shared anullsrc instead, trimmed
    // to this part's own length so the two streams stay in step.
    const audioSrc = hasAudio ? `${i}:a` : `${silenceIndex}:a`;
    legs.push(
      `[${audioSrc}]atrim=0:${seconds},asetpts=PTS-STARTPTS,aresample=${RATE},` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`,
    );
    labels.push(`[v${i}][a${i}]`);
  });
  legs.push(`${labels.join("")}concat=n=${paths.length}:v=1:a=1[v][a]`);

  try {
    await run(
      "ffmpeg",
      [
        "-v", "error",
        ...inputs,
        "-filter_complex", legs.join(";"),
        "-map", "[v]",
        "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", CRF,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        "-y", out,
      ],
      { maxBuffer: 16 << 20 },
    );
  } catch (err) {
    throw toolError("ffmpeg", err);
  }
  return out;
}
