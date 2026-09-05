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

/** How long each dip to black takes, at both ends of a boundary — so a
 *  transition costs 2 * FADE of screen time and a beat the eye reads as a
 *  chapter break.
 *
 *  Spent as `fade`/`afade` on the legs `concat` already joins, which is why
 *  the output's duration is UNCHANGED: `keptSeconds`, `/api/stack`'s `total`
 *  and `outName` all stay exact, and the name cannot come to disagree with
 *  the file it names.
 *
 *  ponytail: a dip, not a crossfade. `xfade` + `acrossfade` would dissolve
 *  the parts into each other instead, and costs three things this does not:
 *  the chain is pairwise rather than per-leg, each step's `offset=` is the
 *  running total minus k * d (so every part's duration feeds every later
 *  offset), and the output comes out `(N-1) * d` SHORTER — which both
 *  `stackWide` and the route's `total` would have to agree on or the
 *  filename stops describing the file. Worth it only if the dissolve
 *  actually looks better here, which on unrelated clips (one part's body
 *  melting into the next part's title card) is not obvious. */
export const FADE = 0.5;

const FPS = 30;
const RATE = 44100;
/** The same crf `exportClip` uses. Unlike `concatClips` this is not an
 *  intermediate — it is the product — so there is no later generation to
 *  keep headroom for. */
const CRF = "20";

/** The shortest a stripped part is allowed to come back as.
 *
 *  A part shorter than the cut would land at zero or negative seconds, which
 *  ffmpeg reads as "no frames" and `concat` reads as a missing leg — so the
 *  whole render fails on one odd upload. Anything under this floor keeps its
 *  full length instead: an upload this app did not produce has no outro to
 *  strip, and guessing that it does is how a stack silently loses a second
 *  of real content off every part. */
export const MIN_KEPT = 1;

/** How much of a part survives the outro strip.
 *
 *  `tail` is the bundled outro's own probed length, passed in by the caller
 *  rather than read here: `END_PATH` lives in `starter.ts`, which is this
 *  module's SIBLING, and importing across that line would put a cycle-shaped
 *  edge into a layering that is deliberately acyclic. The caller already
 *  imports both.
 *
 *  The last part keeps its outro — it is the video's own ending — so
 *  `isLast` is what decides, never the index. `tail` of 0 makes this the
 *  identity, which is what every caller that predates the strip passes. */
export function keptSeconds(seconds: number, isLast: boolean, tail: number): number {
  if (isLast || tail <= 0) return seconds;
  const kept = seconds - tail;
  return kept < MIN_KEPT ? seconds : kept;
}

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
 *  positional rule `concatClips` follows.
 *
 *  `tail` is how many seconds every part BUT THE LAST gives up off its end —
 *  the bundled outro, so a compilation plays one ending rather than one per
 *  part. It arrives as an input `-t` on each part rather than as a `trim`
 *  filter, so the demuxer stops early and nothing past the cut is decoded at
 *  all. Defaults to 0, which is the identity and what every existing caller
 *  gets. */
export async function stackWide(
  paths: string[],
  out: string,
  tail = 0,
): Promise<string> {
  if (paths.length === 0) throw new Error("stackWide needs at least one part.");

  const probed = await Promise.all(paths.map((p) => probeFile(p)));
  const anySilent = probed.some((p) => !p.hasAudio);
  const silenceIndex = paths.length;
  const kept = probed.map((p, i) =>
    keptSeconds(p?.seconds ?? 0, i === paths.length - 1, tail),
  );

  const inputs: string[] = [];
  paths.forEach((path, i) => {
    // Declared BEFORE the -i it belongs to: ffmpeg attaches an option to the
    // NEXT -i, so the other order would make this an option on the following
    // part and cut the wrong file. Same lesson as the mask input in
    // `exportClip`.
    if ((kept[i] ?? 0) < (probed[i]?.seconds ?? 0)) inputs.push("-t", String(kept[i]));
    inputs.push("-i", path);
  });
  if (anySilent) {
    inputs.push("-f", "lavfi", "-i", `anullsrc=r=${RATE}:cl=stereo`);
  }

  const legs: string[] = [];
  const labels: string[] = [];
  paths.forEach((_, i) => {
    const p = probed[i];
    const hasAudio = p?.hasAudio === true;
    // The KEPT length, not the file's. A sounded part is already cut by its
    // input `-t` and this is a no-op on it; the shared `anullsrc` carries no
    // `-t` at all, so for a silent part this is the only thing that stops
    // its stand-in leg running past the video it stands in for.
    const seconds = kept[i] ?? 0;
    // The transition. Clamped so a pathologically short part cannot have its
    // fade-in overlap its fade-out, which reads as a part that never reaches
    // full brightness rather than as a transition. At any real length this
    // is a flat FADE.
    const d = Math.min(FADE, seconds / 3);
    // Only BETWEEN parts. The compilation opens on the first part's title
    // card and closes on the bundled outro, both of which already start and
    // end deliberately — fading them would be fading something that needs no
    // help. Declared after `setpts=PTS-STARTPTS` in the chain below so `st=`
    // is measured from this part's own zero rather than from its source
    // timestamps.
    const vFade =
      (i > 0 ? `fade=t=in:st=0:d=${d},` : "") +
      (i < paths.length - 1 ? `fade=t=out:st=${seconds - d}:d=${d},` : "");
    const aFade =
      (i > 0 ? `afade=t=in:st=0:d=${d},` : "") +
      (i < paths.length - 1 ? `afade=t=out:st=${seconds - d}:d=${d},` : "");
    legs.push(
      `[${i}:v]split=2[bg${i}][fg${i}]`,
      `[bg${i}]scale=${BG_W}:${BG_H}:force_original_aspect_ratio=increase,` +
        `crop=${BG_W}:${BG_H},gblur=sigma=${BLUR_SIGMA},` +
        `scale=${WIDE.w}:${WIDE.h},setsar=1[bgz${i}]`,
      `[fg${i}]scale=${WIDE.w}:${WIDE.h}:force_original_aspect_ratio=decrease:` +
        `force_divisible_by=2,setsar=1[fgz${i}]`,
      // `force_divisible_by=2` only guarantees the fitted size is even, not
      // that `(W-w)/2` is: it lands odd whenever `w ≡ 2 (mod 4)` (e.g. a
      // 1084x1920 upload fits to 610x1080, offset 655). An overlay at an odd
      // offset in yuv420p sits on a half-chroma-sample boundary — the same
      // invariant the custom-boxes feature states for its own overlay.
      // floor(x/2)*2 forces both axes even; W/w are only known to ffmpeg, so
      // this stays an expression rather than a TypeScript computation.
      `[bgz${i}][fgz${i}]overlay=floor((W-w)/4)*2:floor((H-h)/4)*2,fps=${FPS},` +
        `setpts=PTS-STARTPTS,${vFade}format=yuv420p[v${i}]`,
    );
    // A silent part's leg is cut out of the shared anullsrc instead, trimmed
    // to this part's own length so the two streams stay in step.
    const audioSrc = hasAudio ? `${i}:a` : `${silenceIndex}:a`;
    legs.push(
      `[${audioSrc}]atrim=0:${seconds},asetpts=PTS-STARTPTS,aresample=${RATE},` +
        `${aFade}aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`,
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
