/** The lofi journey's one ffmpeg pass.
 *
 *  Sits BESIDE `ffmpeg.ts`, `longform.ts` and `starter.ts` rather than above
 *  any of them: it takes every path from the caller, needs neither
 *  `MEDIA_DIR` nor `OUT_DIR`, and may read `probeAudio` and nothing else. */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { toolError } from "./errors.ts";
import { probeAudio } from "./ffmpeg.ts";

const run = promisify(execFile);

/** YouTube's long-form shape. A lofi mix is a track long; there is no
 *  vertical case to configure. */
export const WIDE = { w: 1920, h: 1080 };

const FPS = 30;
const RATE = 44100;
const CRF = "20";

/** How long each edge of a speech's own ramp takes — the crackle boost's
 *  fade in and out, and the room `src/lofi.ts` reserves around every speech
 *  it places.
 *
 *  It used to be the dip to black at each edge of a cut-in as well. There is
 *  no cut-in any more: a speech contributes AUDIO ONLY, the background
 *  picture holds the frame for the whole render, and nothing in the video
 *  fades. See `renderLofi`.
 *
 *  The client's `src/lofi.ts` declares the same 0.5s. The two are
 *  deliberately NOT shared — they sit on opposite sides of the client/server
 *  line, the same split `src/preview.ts` and `server/starter.ts` already
 *  live with — so `server/lofi.test.ts` and `src/lofi.test.ts` each pin the
 *  value. Change one and change the other. */
export const FADE = 0.5;

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

/** The "vinyl record" treatment on a speech's own voice, and the surface
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
 *  the sample, and a recording that runs to digital silence hands it a zero
 *  — log(0) is -inf, the NaN reaches the AAC encoder, and the render dies
 *  with `Error submitting audio frame to the encoder: Invalid argument`,
 *  which names neither this filter nor the silence. Every test using a
 *  silent fixture failed on exactly that, back when a silent cut-in was
 *  something this graph had to stand in for; `server/lofi.test.ts` still
 *  renders a digitally silent speech to keep the linear mode honest.
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
 *  whole render and each speech adds a second leg at `CRACKLE_BOOST`, faded
 *  in and out. A `volume` gated on `enable=` would step, and a step clicks
 *  at both edges — the same reason the duck is a compressor.
 *
 *  The two legs POWER-sum, not amplitude-sum, and the difference is not
 *  academic. Each tap reads a different moment of the asset — the bed runs
 *  from its start, a boost leg is delayed onto its own speech — so the two
 *  are uncorrelated noise: equal gains give +3 dB under a speech, not the
 *  +6 dB the numbers look like they promise. Measured at exactly +3.0 dB
 *  when both were 0.6. To lift the POWER by roughly N dB the boost wants
 *  `bed * sqrt(10^(N/10) - 1)`.
 *
 *  The PEAK moves by a different rule, and that is the one the test reads.
 *  A peak is whichever leg's loudest pop happens to land there rather than
 *  a sum of two, so it tracks `20 * log10(boost / bed)` — 3.8 dB at the
 *  current pair, against 5.3 dB of power. Measured on the synthetic fixture
 *  at +3.6 dB peak and +1.4 dB mean. Tuning by ear moves the power; tuning
 *  against `server/lofi.test.ts` moves the peak, and its bound sits at
 *  +3 dB, so this pair clears it by 0.6 dB and a further cut to the boost
 *  fails that test before it stops being audible. */
export const CRACKLE_PATH = asset("vinyl-crackle.mp3");
const CRACKLE_BED = 0.18;
const CRACKLE_BOOST = 0.28;

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

/** One speech, and where its VOICE enters the music's timeline. Its duration
 *  is probed here rather than taken from the caller: the crackle boost's
 *  fades and the audio delay have to agree about it, and one prober is how
 *  they stay agreed.
 *
 *  `path` may be an audio file or a video one. Only its audio is ever read —
 *  a speech is mixed into the track, never shown — so `probeAudio` is the
 *  prober on both sides of that, and a file with no audio stream is refused
 *  by it rather than rendered as a silent gap nobody notices.
 *
 *  Order does not matter here: every leg is delayed onto its own `at` and
 *  nothing indexes a neighbour. `/api/lofi` still sorts before calling,
 *  because its own "two speeches overlap" check compares each entry with the
 *  one before it. */
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

/** Renders the picture and the track, with every speech mixed into the
 *  track, as one 1920x1080 file.
 *
 *  THE PICTURE IS THE WHOLE VIDEO. A speech contributes audio and nothing
 *  else: it is never shown, never overlaid, and the background does not dip,
 *  fade or move while one plays. An uploaded speech may therefore be an
 *  audio file or a video file indifferently — if it carries pictures, they
 *  are discarded here.
 *
 *  That is a deliberate reversal. This graph used to letterbox each speech
 *  over a blurred copy of itself, `tpad` it to its own start, gate it with
 *  `enable=` and dip the background to black on either side of it. All of it
 *  is gone, along with the `anullsrc` stand-in a silent cut-in needed: the
 *  video track is now one still frame from t=0 to the end, so there is
 *  nothing to synchronise, nothing to fade and nothing to stand in for.
 *  Re-adding any of it means re-reading the two invariants that machinery
 *  carried (the `enable`-scoped fades and their half-gap clamp) in this
 *  file's history — both were correctness fixes, not decoration, and neither
 *  is obvious from the code that replaced them.
 *
 *  The output's duration is still the music's by construction (`-t` plus the
 *  image input's own), so nothing sums, no leg's length feeds a later leg's
 *  offset, and the name `/api/lofi` builds from that duration cannot come to
 *  describe a different file. */
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

  // `probeAudio` on a speech too, for the same reason it is used on the
  // track: a speech may be a bare audio file, which `probeFile` refuses
  // outright, and its pictures are not wanted even when it has them. It also
  // makes "has an audio stream" the trust boundary — a file with none throws
  // here rather than rendering as a silent stretch nobody notices until they
  // watch the output.
  const probed = await Promise.all(cuts.map((c) => probeAudio(c.path)));
  // Positional, the way `stackWide`'s inputs are: image, music, the
  // speeches, the crackle. There is no conditional input left in this graph
  // — the `anullsrc` stand-in went with the cut-in it stood in for — so the
  // arithmetic is now flat.
  const firstCut = 2;
  const crackleIndex = firstCut + cuts.length;

  const inputs: string[] = [
    "-loop", "1", "-framerate", String(FPS), "-t", String(seconds), "-i", image,
    "-i", music,
  ];
  for (const cut of cuts) inputs.push("-i", cut.path);
  // Looped rather than trimmed to length here: the asset is ~12s and a track
  // is minutes. Every tap below `atrim`s its own copy, and the output's own
  // `-t` bounds the lot, so the infinite input can never outrun the render.
  inputs.push("-stream_loop", "-1", "-i", CRACKLE_PATH);

  const legs: string[] = [];

  // The whole video track: the picture, cover-cropped so it fills the frame
  // edge to edge, held from t=0 to the end. No fades and no overlays — a
  // speech is audio, so there is nothing for the picture to get out of the
  // way of.
  legs.push(
    `[0:v]scale=${WIDE.w}:${WIDE.h}:force_original_aspect_ratio=increase,` +
      `crop=${WIDE.w}:${WIDE.h},fps=${FPS},setsar=1,format=yuv420p[v]`,
  );

  const fmt = `aformat=sample_fmts=fltp:channel_layouts=stereo`;
  legs.push(`[1:a]aresample=${RATE},${fmt}[music]`);

  if (cuts.length === 0) {
    legs.push(`[music]anull[a]`);
  } else {
    cuts.forEach((cut, i) => {
      const dur = probed[i]?.seconds ?? 0;
      // `atrim` bounds a speech whose container runs longer than its own
      // audio — a video file whose picture outlasts its sound is the
      // ordinary case, since `dur` here is the CONTAINER's duration.
      //
      // ponytail: no `afade` at this hard `atrim` edge. A speech recording
      // is usually near-silent at its own end, but a genuine click is
      // possible on one that does not fade out on its own — and nothing
      // covers it any more, now that the video no longer dips to black over
      // the same instant. Add `afade=t=out:st=${dur - d}:d=${d}` (the `d`
      // the crackle boost's own fades use, `Math.min(FADE, dur / 3)`) the
      // day a real render audibly clicks; not added now because tuning it
      // needs a recording to listen to, not a synthetic fixture.
      //
      // The vinyl treatment runs on every speech, unconditionally. It used
      // to be skipped on a cut-in with no audio of its own, which was fed
      // digital silence by an `anullsrc` stand-in — and that skip was a
      // correctness fix rather than a saving, because some filters emit NaN
      // on a zero signal and the NaN reaches the AAC encoder as `Error
      // submitting audio frame to the encoder: Invalid argument`. There is
      // no stand-in any more: `probeAudio` above refuses a file with no
      // audio stream, so every leg here carries a real recording. A
      // recording that happens to BE silent still reaches these filters, so
      // the `mode=lin` rule on `acrusher` stays load-bearing.
      legs.push(
        `[${firstCut + i}:a]atrim=0:${dur},asetpts=PTS-STARTPTS,` +
          `highpass=f=${SPEECH_HP},` +
          `acrusher=bits=${CRUSH_BITS}:mode=lin:mix=${CRUSH_MIX},` +
          `lowpass=f=${SPEECH_LP},volume=${SPEECH_GAIN},` +
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
    // without this pad `[ducked]` died at the last speech's own end and the
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
    // One tap is the bed, trimmed to the track; one per speech is the boost,
    // faded at both edges and delayed onto its own speech. They SUM, so the
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
