/** The lofi journey's one ffmpeg pass.
 *
 *  Sits BESIDE `ffmpeg.ts`, `longform.ts` and `starter.ts` rather than above
 *  any of them: it takes every path from the caller, needs neither
 *  `MEDIA_DIR` nor `OUT_DIR`, and may read `probeFile` and nothing else. */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { toolError } from "./errors.ts";
import { probeAudio, probeFile } from "./ffmpeg.ts";

const run = promisify(execFile);

/** YouTube's long-form shape. A lofi mix is a track long; there is no
 *  vertical case to configure. */
export const WIDE = { w: 1920, h: 1080 };

const FPS = 30;
const RATE = 44100;
const CRF = "20";

/** How long the dip at each edge of a cut-in takes.
 *
 *  The client's `src/lofi.ts` declares the same 0.5s and reserves `2 * FADE`
 *  around every speech it places. The two are deliberately NOT shared —
 *  they sit on opposite sides of the client/server line, the same split
 *  `src/preview.ts` and `server/starter.ts` already live with — so
 *  `server/lofi.test.ts` and `src/lofi.test.ts` each pin the value. Change
 *  one and change the other. */
export const FADE = 0.5;

/** The blur behind a cut-in's letterbox, computed at 480x270 and stretched
 *  back up. Same value and same reasoning as `longform.ts`'s: the upscale
 *  supplies most of the softening, and a gblur over a 1920x3413 intermediate
 *  costs roughly fifty times as much for a picture whose entire purpose is
 *  to be out of focus. */
const BLUR_SIGMA = 12;
const BG_W = 480;
const BG_H = 270;

/** The speech's own band. An AM-radio 300-3000 Hz is the whole "lofi
 *  effect" — it is what makes a clean recording sit inside the mix instead
 *  of on top of it. */
const SPEECH_HP = 300;
const SPEECH_LP = 3000;
/** Makeup for what the band takes out. */
const SPEECH_GAIN = 1.6;

/** The duck. `sidechaincompress` takes a threshold and a ratio, not a target
 *  depth, which is why there is no dB knob here — the depth is whatever
 *  those two produce against the track's own level.
 *
 *  A compressor rather than `volume=enable='between(t,a,b)'`: a step has no
 *  attack or release and clicks at both edges. It is also what makes a
 *  merely adequate trough sound deliberate, so the detector only has to find
 *  a thin stretch rather than a silent one. */
const DUCK_THRESHOLD = 0.03;
const DUCK_RATIO = 8;
const DUCK_ATTACK = 20;
const DUCK_RELEASE = 400;

/** The swell over each cut-in.
 *
 *  Re-derived here rather than imported from `longform.ts`, which is this
 *  module's SIBLING: a path is not a dependency, and importing across that
 *  line would put a cycle-shaped edge into a layering that is deliberately
 *  acyclic. Same call `longform.ts` itself made against `starter.ts`. */
const asset = (name: string) => fileURLToPath(new URL(`assets/${name}`, import.meta.url));
export const TRANSITION_PATH = asset("long-form-transition-sound.mp3");

/** Where the swell peaks inside the asset — it opens on ~0.6s of near
 *  silence, so it is placed by its peak and not by its start. A delay of the
 *  boundary itself would put the swell a second after the cut, over a
 *  picture that has already come back up. */
export const TRANSITION_PEAK = 1.2;
const TRANSITION_GAIN = 1.0;

/** One speech, and where its own picture starts in the music's timeline. Its
 *  duration is probed here rather than taken from the caller: the graph's
 *  fades, its `enable=` window and its audio delay all have to agree about
 *  it, and one prober is how they stay agreed. */
export type Cut = { path: string; at: number };

/** Boot check for the one asset this journey plays. Hard, like
 *  `checkLongform`'s: a missing file fails a render that is minutes of
 *  encoding away from discovering it. */
export async function checkLofi(): Promise<void> {
  if (!existsSync(TRANSITION_PATH)) {
    console.error(`vstack: bundled asset missing at ${TRANSITION_PATH}.`);
    process.exit(1);
  }
}

/** Renders the picture, the track and the cut-ins into one 1920x1080 file.
 *
 *  OVERLAY, not concat, and that is the load-bearing choice: the output's
 *  duration is the music's by construction (`-t`), so nothing sums, no leg's
 *  length feeds a later leg's offset, and the name `/api/lofi` builds from
 *  that duration cannot come to describe a different file. A concat of image
 *  legs and speech legs would put all of that arithmetic back.
 *
 *  Each speech is padded to its own start with `tpad` rather than shifted
 *  with `setpts`, and gated with `enable=`. The padding frames are black and
 *  are never drawn, because `enable=` is false while they pass; what it buys
 *  is that `overlay`'s second input always has a frame, which a bare `setpts`
 *  offset does not guarantee.
 *
 *  ponytail: `tpad` synthesises `at * FPS` black frames per cut-in — free to
 *  make, not free to push through the chain. Switch to a `setpts` offset if
 *  a long track with many cut-ins ever makes the encode drag, and re-check
 *  the timing assertions in `server/lofi.test.ts` when you do. */
export async function renderLofi(opts: {
  image: string;
  music: string;
  cuts: Cut[];
  out: string;
}): Promise<string> {
  const { image, music, cuts, out } = opts;
  // `probeAudio`, never `probeFile`: the track has no video stream, and
  // `probeFile` throws on exactly that. Task 2's prober, imported rather
  // than duplicated — `ffmpeg.ts` is the layer below this one, so there is
  // no layering reason to re-derive it the way the ASSET path is re-derived.
  const { seconds } = await probeAudio(music);
  if (!(seconds > 0)) throw new Error(`Could not read a duration from ${music}.`);

  const probed = await Promise.all(cuts.map((c) => probeFile(c.path)));
  const anySilent = probed.some((p) => !p.hasAudio);
  // Positional and conditional, exactly as `stackWide`'s inputs are: image,
  // music, the cuts, then the stand-in, then the swell. Appending the swell
  // AFTER the stand-in is what keeps the stand-in's index the arithmetic it
  // already was.
  const firstCut = 2;
  const silenceIndex = firstCut + cuts.length;
  const soundIndex = silenceIndex + (anySilent ? 1 : 0);

  const inputs: string[] = [
    "-loop", "1", "-framerate", String(FPS), "-t", String(seconds), "-i", image,
    "-i", music,
  ];
  for (const cut of cuts) inputs.push("-i", cut.path);
  if (anySilent) inputs.push("-f", "lavfi", "-i", `anullsrc=r=${RATE}:cl=stereo`);
  if (cuts.length > 0) inputs.push("-i", TRANSITION_PATH);

  const legs: string[] = [];

  // The base picture, cover-cropped so it fills the frame edge to edge, with
  // one fade pair per cut-in chained onto it, each scoped to its own window
  // with `enable=`.
  //
  // The scoping is load-bearing, not decoration: `fade` doesn't merely ramp
  // and hold within its own window, it multiplies by its ramp factor at
  // EVERY frame it sees — a bare `fade=t=in:st=X` blacks out every frame
  // with pts < X, unconditionally, because "before the fade" is factor 0
  // rather than "unmodified". Chained after an earlier `fade=out`, that
  // blacking reaches back over frames the first filter had already left
  // alone, and even a single cut then wipes the whole picture before it.
  // Confirmed empirically: the unscoped chain read all-16 (black) at every
  // sampled t, including t=0, for a cut at t=12. `enable=` makes each fade a
  // no-op passthrough outside its own [st, st+d], so the two filters can be
  // chained without one undoing the other's untouched frames.
  const bgFades = cuts
    .map((cut, i) => {
      const dur = probed[i]?.seconds ?? 0;
      const outAt = Math.max(0, cut.at - FADE);
      const inAt = cut.at + dur;
      return (
        `fade=t=out:st=${outAt}:d=${FADE}:enable='between(t,${outAt},${outAt + FADE})',` +
        `fade=t=in:st=${inAt}:d=${FADE}:enable='between(t,${inAt},${inAt + FADE})',`
      );
    })
    .join("");
  legs.push(
    `[0:v]scale=${WIDE.w}:${WIDE.h}:force_original_aspect_ratio=increase,` +
      `crop=${WIDE.w}:${WIDE.h},fps=${FPS},setsar=1,${bgFades}format=yuv420p[bg]`,
  );

  cuts.forEach((cut, i) => {
    const idx = firstCut + i;
    const dur = probed[i]?.seconds ?? 0;
    // Clamped so a pathologically short cut-in cannot have its fade-in
    // overlap its fade-out, which multiplies to a clip that never reaches
    // full brightness. Same clamp, same reason, as `stackWide`'s.
    const d = Math.min(FADE, dur / 3);
    legs.push(
      `[${idx}:v]split=2[cbg${i}][cfg${i}]`,
      `[cbg${i}]scale=${BG_W}:${BG_H}:force_original_aspect_ratio=increase,` +
        `crop=${BG_W}:${BG_H},gblur=sigma=${BLUR_SIGMA},` +
        `scale=${WIDE.w}:${WIDE.h},setsar=1[cbgz${i}]`,
      // `decrease`, never a fixed height: an upload is whatever file the user
      // picked, and a cut-in wider than 16:9 would overflow the frame.
      `[cfg${i}]scale=${WIDE.w}:${WIDE.h}:force_original_aspect_ratio=decrease:` +
        `force_divisible_by=2,setsar=1[cfgz${i}]`,
      // floor(x/2)*2 on both axes: `force_divisible_by=2` makes the fitted
      // size even, not the centring offset, and an overlay at an odd offset
      // in yuv420p lands on a half-chroma-sample boundary.
      `[cbgz${i}][cfgz${i}]overlay=floor((W-w)/4)*2:floor((H-h)/4)*2,fps=${FPS},` +
        `setpts=PTS-STARTPTS,fade=t=in:st=0:d=${d},fade=t=out:st=${dur - d}:d=${d},` +
        `tpad=start_duration=${cut.at},format=yuv420p[cut${i}]`,
    );
  });

  // Chained overlays, each gated to its own window. `eof_action=pass` and
  // `repeatlast=0` are what stop a finished cut-in's last frame sticking over
  // the rest of the track.
  let base = "[bg]";
  cuts.forEach((cut, i) => {
    const dur = probed[i]?.seconds ?? 0;
    const label = i === cuts.length - 1 ? "[v]" : `[ov${i}]`;
    legs.push(
      `${base}[cut${i}]overlay=0:0:eof_action=pass:repeatlast=0:` +
        `enable='between(t,${cut.at},${cut.at + dur})'${label}`,
    );
    base = label;
  });
  if (cuts.length === 0) legs.push(`[bg]null[v]`);

  const fmt = `aformat=sample_fmts=fltp:channel_layouts=stereo`;
  legs.push(`[1:a]aresample=${RATE},${fmt}[music]`);

  if (cuts.length === 0) {
    legs.push(`[music]anull[a]`);
  } else {
    cuts.forEach((cut, i) => {
      const src = probed[i]?.hasAudio === true ? `${firstCut + i}:a` : `${silenceIndex}:a`;
      const dur = probed[i]?.seconds ?? 0;
      // `atrim` matters only for the stand-in, which carries no `-t` of its
      // own and would otherwise run for the length of the whole track.
      legs.push(
        `[${src}]atrim=0:${dur},asetpts=PTS-STARTPTS,` +
          `highpass=f=${SPEECH_HP},lowpass=f=${SPEECH_LP},volume=${SPEECH_GAIN},` +
          `adelay=${Math.round(cut.at * 1000)}:all=1,aresample=${RATE},${fmt}[sp${i}]`,
      );
    });
    const spLabels = cuts.map((_, i) => `[sp${i}]`).join("");
    legs.push(
      cuts.length === 1
        ? `[sp0]anull[speech]`
        : `${spLabels}amix=inputs=${cuts.length}:normalize=0:duration=longest[speech]`,
    );
    // One copy drives the duck, the other is heard. `normalize=0` on every
    // mix: amix divides by its input count by default, so the whole render
    // would come out quiet purely for carrying a second stream.
    legs.push(`[speech]asplit=2[sc][sm]`);
    legs.push(
      `[music][sc]sidechaincompress=threshold=${DUCK_THRESHOLD}:ratio=${DUCK_RATIO}:` +
        `attack=${DUCK_ATTACK}:release=${DUCK_RELEASE}[ducked]`,
    );
    // `duration=first` keeps the programme's length — the music's — so a
    // delayed stream cannot extend the render past the duration the caller
    // has already committed to in the filename.
    legs.push(`[ducked][sm]amix=inputs=2:normalize=0:duration=first[mix]`);

    const taps = cuts.map((_, i) => `[ts${i}]`).join("");
    legs.push(`[${soundIndex}:a]asplit=${cuts.length}${taps}`);
    cuts.forEach((cut, i) => {
      // Placed by the swell's PEAK, clamped at zero because `adelay` cannot
      // take a negative offset and a cut-in inside the lead-in would ask for
      // one. On the way IN only: leaving a cut-in has the voice ending and
      // the track coming back, and a second swell there is noise.
      const delay = Math.max(0, Math.round((cut.at - TRANSITION_PEAK) * 1000));
      legs.push(
        `[ts${i}]adelay=${delay}:all=1,volume=${TRANSITION_GAIN},` +
          `aresample=${RATE},${fmt}[tsd${i}]`,
      );
    });
    const delayed = cuts.map((_, i) => `[tsd${i}]`).join("");
    legs.push(
      `[mix]${delayed}amix=inputs=${cuts.length + 1}:normalize=0:duration=first[a]`,
    );
  }

  try {
    await run(
      "ffmpeg",
      [
        "-v", "error",
        ...inputs,
        "-filter_complex", legs.join(";"),
        "-map", "[v]",
        "-map", "[a]",
        "-t", String(seconds),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", CRF,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
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
