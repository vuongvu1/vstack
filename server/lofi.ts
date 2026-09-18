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

/** The "vinyl record" treatment on a cut-in's own voice, and the surface
 *  noise under the whole mix.
 *
 *  Three effects, and the ORDER of the first two inside the speech chain is
 *  load-bearing. `acrusher` is a bit-reducer, so it generates aliasing all
 *  the way up to Nyquist; it sits BEFORE `lowpass` so that grit is rolled
 *  off with everything else. Put it after and the render stops being
 *  band-limited at all — which `server/lofi.test.ts`'s own above-6 kHz
 *  assertion reads as the failure it is.
 *
 *  `mode=lin`, never `mode=log`. Log-mode quantisation takes a logarithm of
 *  the sample, and a cut-in with no audio of its own is fed DIGITAL SILENCE
 *  by the `anullsrc` stand-in — log(0) is -inf, the NaN reaches the AAC
 *  encoder, and the render dies with `Error submitting audio frame to the
 *  encoder: Invalid argument`, which names neither this filter nor silence.
 *  Every test using the silent fixture failed on exactly that.
 *
 *  There is deliberately NO pitch wobble, though the effect this imitates
 *  has one. `vibrato` emits NaN inside this graph: isolated on the same
 *  fixture it is clean at every depth tried, and inside the full render it
 *  poisons the mix and kills the AAC encoder with `Error submitting audio
 *  frame to the encoder: Invalid argument`. Bisected against the real
 *  failing command — removing `vibrato` was the only variant of seven that
 *  came back clean. It is also the effect least suited to a voice: on
 *  singing a wobble reads as a warped record, on speech as seasick.
 *
 *  ponytail: no wobble. If one is wanted, `chorus` with a slow depth is the
 *  other way to get pitch movement, and a newer ffmpeg may simply fix
 *  `vibrato` — re-bisect against the full graph rather than testing the
 *  filter on its own, which is what hid this. */
const CRUSH_BITS = 10;
const CRUSH_MIX = 0.5;

const asset = (name: string) => fileURLToPath(new URL(`assets/${name}`, import.meta.url));

/** Surface noise, looped under the render for its whole length.
 *
 *  Built from the lead-in grooves of two public-domain Edison cylinder
 *  recordings — the seconds of pure groove noise before each band starts —
 *  reversed and speed-varied into a ~12s loop so its own period is not
 *  audible under a three-minute track. Measured at a 23 dB crest factor,
 *  which is what makes it read as POPS rather than as hiss.
 *
 *  Two gains rather than a gate: the bed plays at `CRACKLE_BED` for the
 *  whole render and each cut-in adds a second leg at `CRACKLE_BOOST`, faded
 *  in and out. A `volume` gated on `enable=` would step, and a step clicks
 *  at both edges — the same reason the duck is a compressor.
 *
 *  The two legs POWER-sum, not amplitude-sum, and the difference is not
 *  academic. Each tap reads a different moment of the asset — the bed runs
 *  from its start, a boost leg is delayed onto its own cut-in — so the two
 *  are uncorrelated noise: equal gains give +3 dB under a cut-in, not the
 *  +6 dB the numbers look like they promise. Measured at exactly +3.0 dB
 *  when both were 0.6. To lift by roughly N dB the boost wants
 *  `bed * sqrt(10^(N/10) - 1)`, which is where 0.9 against a 0.6 bed comes
 *  from: about +5 dB, "a bit louder" rather than a different scene. */
export const CRACKLE_PATH = asset("vinyl-crackle.mp3");
const CRACKLE_BED = 0.18;
const CRACKLE_BOOST = 0.39;

/** Levels the noise before either gain sees it, and this is what makes the
 *  bed audible at all rather than a knob nobody can hear.
 *
 *  A crackle recording is sparse pops over near-silence: the asset here
 *  measures a 41 dB crest factor (mean -46.5, peaks -5.6). Its MEAN is what
 *  sits under the music, and its PEAKS are what decide when it clips, so
 *  raising the gain until the bed is heard puts the pops through the
 *  ceiling first — measured, at the gain needed for parity above 6 kHz the
 *  peaks land at +2 dBFS. `compand` closes that gap: it lifts the quiet
 *  floor between pops by about 19 dB and brings the crest to 27 dB, after
 *  which a bed gain WELL under unity is both audible and clear of clipping.
 *
 *  The cost is character, and it is a real one: a levelled record sounds
 *  more like continuous surface noise and less like the occasional pop.
 *  Drop this filter from the two taps below to get the raw asset back, and
 *  expect to hear it only in a quiet passage. */
const CRACKLE_LEVEL =
  "compand=attacks=0.01:decays=0.2:points=-70/-35|-30/-18|-10/-10|0/-8";

/** One speech, and where its own picture starts in the music's timeline. Its
 *  duration is probed here rather than taken from the caller: the graph's
 *  fades, its `enable=` window and its audio delay all have to agree about
 *  it, and one prober is how they stay agreed.
 *
 *  `renderLofi` requires an array of `Cut`s in ASCENDING `at` order — the
 *  half-gap fade clamp indexes each cut's own neighbours (`cuts[i - 1]`,
 *  `cuts[i + 1]`) to find the gap on either side, and an unsorted array
 *  hands it the wrong neighbour rather than failing loudly. `/api/lofi`
 *  sorts before calling this, which is what keeps the one real caller
 *  safe. */
export type Cut = { path: string; at: number };

/** Boot check for the one asset this journey bundles. Hard, like
 *  `checkLongform`'s: a missing file fails a render that is minutes of
 *  encoding away from discovering it. */
export async function checkLofi(): Promise<void> {
  if (!existsSync(CRACKLE_PATH)) {
    console.error(`vstack: bundled asset missing at ${CRACKLE_PATH}.`);
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
  // Positional and conditional, the way `stackWide`'s inputs are: image,
  // music, the cuts, then the silence stand-in when some cut-in carries no
  // audio of its own. The stand-in is LAST on purpose — an input added after
  // it would shift its index and break silent cut-ins only, which is the
  // failure `server/starter.test.ts` documents for the same arithmetic.
  const firstCut = 2;
  const silenceIndex = firstCut + cuts.length;
  // AFTER the stand-in, never before it: an input inserted above that index
  // shifts it and breaks silent cut-ins only, which is the failure
  // `server/starter.test.ts` documents for this same arithmetic.
  const crackleIndex = silenceIndex + (anySilent ? 1 : 0);

  const inputs: string[] = [
    "-loop", "1", "-framerate", String(FPS), "-t", String(seconds), "-i", image,
    "-i", music,
  ];
  for (const cut of cuts) inputs.push("-i", cut.path);
  if (anySilent) inputs.push("-f", "lavfi", "-i", `anullsrc=r=${RATE}:cl=stereo`);
  // Looped rather than trimmed to length here: the asset is ~12s and a track
  // is minutes. Every tap below `atrim`s its own copy, and the output's own
  // `-t` bounds the lot, so the infinite input can never outrun the render.
  inputs.push("-stream_loop", "-1", "-i", CRACKLE_PATH);

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
  // Each fade is also clamped to HALF the room actually available on its own
  // side — the gap to the previous cut-in's own end (or to the track's
  // start, for the first) on the way out, and the gap to the next cut-in's
  // start (or to the track's end, for the last) on the way in. Cuts closer
  // together than 2 * FADE would otherwise overlap their fade-in and the
  // neighbour's fade-out on the same stream: chained through `enable=`,
  // that re-dims a picture the other pair had just restored, and at a small
  // enough gap the background never returns to full brightness at all.
  // Splitting the gap in half is the same "two neighbours each give up half
  // the seam" rule `GUTTER / 2` follows in `src/frame.ts` — both edges give
  // up an equal share so the two ramps meet exactly, never overlap. A gap of
  // zero degenerates to no dip at all between that pair, which is correct:
  // there is no room for one. This is a DIFFERENT clamp from the per-cut
  // `d = Math.min(FADE, dur / 3)` below, which bounds a fade against its own
  // cut-in's length rather than against the space around it — collapsing
  // the two into one would tie the background's transition time to a
  // property (the speech's duration) that has nothing to do with it.
  const bgFades = cuts
    .map((cut, i) => {
      const dur = probed[i]?.seconds ?? 0;
      const prevEnd = i > 0 ? (cuts[i - 1]?.at ?? 0) + (probed[i - 1]?.seconds ?? 0) : 0;
      const nextAt = i < cuts.length - 1 ? (cuts[i + 1]?.at ?? seconds) : seconds;
      const gapBefore = Math.max(0, cut.at - prevEnd);
      const gapAfter = Math.max(0, nextAt - (cut.at + dur));
      const dOut = Math.min(FADE, gapBefore / 2);
      const dIn = Math.min(FADE, gapAfter / 2);
      const outAt = cut.at - dOut;
      const inAt = cut.at + dur;
      let f = "";
      if (dOut > 0) {
        f += `fade=t=out:st=${outAt}:d=${dOut}:enable='between(t,${outAt},${outAt + dOut})',`;
      }
      if (dIn > 0) {
        f += `fade=t=in:st=${inAt}:d=${dIn}:enable='between(t,${inAt},${inAt + dIn})',`;
      }
      return f;
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
      const dur = probed[i]?.seconds ?? 0;
      // `atrim` matters only for the stand-in, which carries no `-t` of its
      // own and would otherwise run for the length of the whole track.
      //
      // ponytail: no `afade` at this hard `atrim` edge. A speech recording
      // is near-silent at its own end and the video is dipping to black over
      // the same instant, which covers most of it — but a genuine click is
      // possible on a recording that does not fade out on its own. Add
      // `afade=t=out:st=${dur - d}:d=${d}` (the same `d` the video's own
      // local fade uses, `Math.min(FADE, dur / 3)`) the day a real render
      // audibly clicks; not added now because tuning it needs a recording to
      // listen to, not a synthetic fixture.
      // The vinyl treatment runs only on a cut-in that HAS audio. A silent
      // one is standing in with `anullsrc`, and there is nothing in digital
      // silence to band-limit, wobble or bit-crush — the leg exists only to
      // keep the mix's input count right and give the sidechain something to
      // follow.
      //
      // This is a correctness fix, not a saving. `vibrato` fed pure silence
      // emits NaN, which propagates through the mix to the AAC encoder and
      // kills the render with `Error submitting audio frame to the encoder:
      // Invalid argument` — a message naming neither this filter nor the
      // silence that triggered it. Bisected out of a real failure; every
      // test using the silent fixture died on it and no other test did.
      const voice = probed[i]?.hasAudio === true;
      const src = voice ? `${firstCut + i}:a` : `${silenceIndex}:a`;
      const vinyl = voice
        ? `highpass=f=${SPEECH_HP},` +
          `acrusher=bits=${CRUSH_BITS}:mode=lin:mix=${CRUSH_MIX},` +
          `lowpass=f=${SPEECH_LP},volume=${SPEECH_GAIN},`
        : "";
      legs.push(
        `[${src}]atrim=0:${dur},asetpts=PTS-STARTPTS,${vinyl}` +
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
    // `sidechaincompress` is a FRAMESYNC filter: its output ends the instant
    // its SHORTER input ends, not when the longer one does — unlike `amix`,
    // which has its own `duration=` option and silence-pads a short input up
    // to the target length. `[sc]` is only as long as the last speech, so
    // without this pad `[ducked]` died at the last cut-in's own end and the
    // final `amix ... duration=first` faithfully inherited that truncated
    // length from its first input: the container and video ran the full
    // track, but the music itself went silent partway through. `apad`'s
    // `whole_dur` is the same `seconds` this graph already probed from the
    // track, so the sidechain now runs exactly as long as `[music]` does and
    // the compressor has something to follow all the way to the end.
    //
    // Only `[sc]` needs this. `[sm]` — the AUDIBLE copy — reaches the mix
    // through `amix ... duration=first`, which already silence-pads a
    // shorter second input up to its first input's length on its own; once
    // `[ducked]` is the full track length, `[sm]`'s own shortness is handled
    // the ordinary way `amix` was already relied on to handle it everywhere
    // else in this graph.
    legs.push(`[sc]apad=whole_dur=${seconds}[scp]`);
    legs.push(
      `[music][scp]sidechaincompress=threshold=${DUCK_THRESHOLD}:ratio=${DUCK_RATIO}:` +
        `attack=${DUCK_ATTACK}:release=${DUCK_RELEASE}[ducked]`,
    );
    // `duration=first` keeps the programme's length — the music's — so a
    // delayed stream cannot extend the render past the duration the caller
    // has already committed to in the filename.
    // The crackle, in two layers so its level can change without a step.
    // One tap is the bed, trimmed to the track; one per cut-in is the boost,
    // faded at both edges and delayed onto its own cut. They SUM, so the
    // noise is quiet throughout and lifts under each voice.
    //
    // The crackle plays at FULL SPECTRUM — no band-limiting, unlike the
    // voice. Rolling it off to 300-3000 Hz the way the voice is rolled off
    // sounds principled and is what the first version did, but it makes the
    // crackle inaudible: measured against a real track, the noise sits 34 dB
    // under the music below 3 kHz and only 10 dB under it above 3 kHz, so
    // the rolled-off half is the only half that could ever be heard, and
    // what survives lands exactly where the music is loudest. Verified by
    // rendering the same demo with the crackle gain at zero: identical to
    // 0.1 dB in mean AND peak, i.e. the bed was contributing nothing at all.
    //
    // The cost is that the finished mix is no longer band-limited above
    // 6 kHz. That is fine, and the test that used to assert it now measures
    // the SPEECH's own contribution rather than the whole mix — the speech
    // is what the band-limit was ever about.
    //
    // ponytail: no filtering on the noise whatsoever, not even a rumble
    // highpass. It is the user's own asset, played as supplied; add one the
    // day a file with real low-end rumble fights the music.
    const ckTaps = [`[ckbed]`, ...cuts.map((_, i) => `[ckup${i}]`)].join("");
    legs.push(`[${crackleIndex}:a]asplit=${cuts.length + 1}${ckTaps}`);
    legs.push(
      `[ckbed]atrim=0:${seconds},asetpts=PTS-STARTPTS,${CRACKLE_LEVEL},` +
        `volume=${CRACKLE_BED},aresample=${RATE},${fmt}[bed]`,
    );
    cuts.forEach((cut, i) => {
      const dur = probed[i]?.seconds ?? 0;
      const d = Math.min(FADE, dur / 3);
      legs.push(
        `[ckup${i}]atrim=0:${dur},asetpts=PTS-STARTPTS,${CRACKLE_LEVEL},` +
          `volume=${CRACKLE_BOOST},afade=t=in:st=0:d=${d},` +
          `afade=t=out:st=${dur - d}:d=${d},` +
          `adelay=${Math.round(cut.at * 1000)}:all=1,aresample=${RATE},${fmt}[ckb${i}]`,
      );
    });
    const ckLegs = cuts.map((_, i) => `[ckb${i}]`).join("");
    // The programme's own length is the music's, so `duration=first` with
    // `[ducked]` first is what stops a delayed speech — or a looped crackle
    // leg — extending the render past the duration the caller has already
    // committed to in the filename.
    legs.push(
      `[ducked][sm][bed]${ckLegs}amix=inputs=${3 + cuts.length}:` +
        `normalize=0:duration=first[a]`,
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
