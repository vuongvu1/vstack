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
/** Makeup for what the band takes out, plus a little over the top: the duck
 *  only lowers the music, so the voice's own level is the other half of
 *  whether it reads. The speech leg is what sets the finished mix's peak, so
 *  this is also the clipping knob: measured on a synthetic render, 1.6 peaks
 *  at -4.0 dBFS and 2.0 at -3.1, both clear. Well past 2.5 wants a check. */
const SPEECH_GAIN = 2.0;

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

/** The spinning mark in the top-right corner, bundled rather than uploaded.
 *
 *  It is in EVERY lofi render and there is no way to turn it off, which is
 *  the same posture the crackle takes: this journey's look is the feature,
 *  not a set of options. `checkLofi` fails the boot if it is missing, for
 *  the reason every other bundled asset does — a render discovers it minutes
 *  of encoding in. */
export const LOGO_PATH = asset("lofi-video-logo.png");

/** How wide the mark is drawn, and how far the SPINNING BOX sits from the
 *  frame's edges. Aspect is preserved (`decrease`), so a non-square
 *  replacement fits inside this box rather than stretching to it.
 *
 *  The margin bounds the box rather than the upright mark, and that is a
 *  correction rather than a preference. Measured the other way round — the
 *  margin describing the mark's own edge — the clearance is only
 *  `LOGO_MARGIN - (LOGO_BOX - LOGO_SIZE) / 2` at 45 degrees, measured at
 *  10px on a 1920 frame when the mark was 180px: an outstretched arm all but
 *  touching the edge for a quarter of every turn, and full clearance at 0
 *  and 90 where anybody checking a single frame would look. Note the gap
 *  widens with `LOGO_SIZE`, so the bug the other way round would have got
 *  worse every time someone enlarged the mark. Bounding the box makes the guarantee
 *  angle-independent, and costs only that the upright mark sits
 *  `(LOGO_BOX - LOGO_SIZE) / 2` further in than the number suggests. */
const LOGO_SIZE = 300;
const LOGO_MARGIN = 40;

/** One full turn, in seconds. Exported so `server/lofi.test.ts` samples the
 *  render at real multiples of it rather than at a second copy of the
 *  number — the test's whole job is proving the period, and a duplicated
 *  constant would move with it. */
export const SPIN_SECONDS = 10;

/** The square the mark rotates INSIDE, and it must be at least the mark's
 *  own diagonal or the corners are sheared off at 45 degrees.
 *
 *  `rotate` renders into a box of the input's size unless told otherwise, so
 *  a 180px square turning inside a 180px box loses everything past the
 *  inscribed circle — worst at 45 degrees, and invisible at 0 and 90, which
 *  is exactly the sort of defect that looks fine in the one frame anybody
 *  checks. Padding to the diagonal FIRST and rotating inside that is what
 *  makes every angle safe: at the current 300, 300 * sqrt(2) = 424.3, so
 *  the box is 426.
 *
 *  Derived rather than written down so the two cannot drift apart, and
 *  rounded UP to an even number because it feeds the overlay offsets
 *  below. */
const LOGO_BOX = Math.ceil((LOGO_SIZE * Math.SQRT2) / 2) * 2;

/** Both offsets are floored to even, for the reason a custom box's `out` is:
 *  an `overlay` at an odd offset in yuv420p lands on a half-chroma-sample
 *  boundary. `LOGO_BOX` is even too, so the box's far edges land even
 *  as well. */
const even = (v: number) => Math.floor(v / 2) * 2;
const LOGO_X = even(WIDE.w - LOGO_MARGIN - LOGO_BOX);
const LOGO_Y = even(LOGO_MARGIN);

/** The frequency bars along the bottom, drawn from the render's own finished
 *  mix — music, speech and crackle together, not the music alone.
 *
 *  `showcqt` rather than `showfreqs`, and the difference is visible rather
 *  than academic. `showfreqs` spaces bins LINEARLY in frequency, so on music
 *  the bass owns the left quarter and the right two-thirds is a flat line —
 *  measured on the bundled track, every amplitude scale tried (`log`,
 *  `sqrt`, `cbrt`, with and without a treble tilt) gave the same descending
 *  ramp. `showcqt` is constant-Q: its bins are musical intervals, so the
 *  spectrum a listener hears as "spread out" looks spread out.
 *
 *  `ascale`'s sibling knob here is `bar_g`, the bar gamma, and `minamp` is
 *  NOT an alternative — `showfreqs` caps it at 1e-6, so the visible dynamic
 *  range cannot be narrowed from that end at all. The frequency range is
 *  clipped to `VIZ_LO`..`VIZ_HI` because a lofi track has almost nothing
 *  above 7 kHz and the default runs to 20 kHz, spending a third of the
 *  width on silence. */
const VIZ_HEIGHT = 360;
const VIZ_BARS = 48;
const VIZ_ALPHA = 0.85;
const VIZ_GAMMA = 5;
const VIZ_LO = 55;
const VIZ_HI = 7040;

/** How much of each bar's slot the bar itself fills — `gifsync`'s own
 *  `bw * 0.7`, which is where the 48 bars and the white-at-0.85 come from
 *  too. Expressed as a count of columns rather than a fraction because it
 *  is spent as one, see `renderLofi`. */
const VIZ_COLS = 10;
const VIZ_FILL = 7;

/** Where the spinning box lands, exported for the same reason
 *  `SPIN_SECONDS` is: the test crops exactly this rect out of a real render,
 *  and a second copy of the arithmetic would drift the day the mark moves. */
export const LOGO_RECT = { x: LOGO_X, y: LOGO_Y, side: LOGO_BOX };

/** The band the bars occupy, and one bar's slot inside it — exported for
 *  the test to crop and to classify columns, same reason as `LOGO_RECT`.
 *  `fill` is the lit part of a slot; the rest is the gap. */
export const VIZ_RECT = { x: 0, y: WIDE.h - VIZ_HEIGHT, w: WIDE.w, h: VIZ_HEIGHT };
export const VIZ_BAR = {
  slot: WIDE.w / VIZ_BARS,
  fill: (WIDE.w / VIZ_BARS) * (VIZ_FILL / VIZ_COLS),
};

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

/** Boot check for the assets this journey bundles. Hard, like
 *  `checkLongform`'s: a missing file fails a render that is minutes of
 *  encoding away from discovering it. */
export async function checkLofi(): Promise<void> {
  for (const path of [CRACKLE_PATH, LOGO_PATH]) {
    if (!existsSync(path)) {
      console.error(`vstack: bundled asset missing at ${path}.`);
      process.exit(1);
    }
  }
}

/** How many frames the background carries, or 0 when ffprobe will not say.
 *
 *  This is the whole still-vs-animated decision, and it has to be made from
 *  the bytes rather than from a MIME type the client claimed: `renderLofi`
 *  needs two DIFFERENT input forms for the two cases and they are not
 *  interchangeable in either direction.
 *
 *  Local rather than in `ffmpeg.ts` beside `probeAudio` because nothing else
 *  asks this question — `probeFile` already covers "what shape is it", and a
 *  second exported prober whose one caller is this line is a layer's worth
 *  of API for no reader's benefit.
 *
 *  A still JPEG reports no `nb_frames` at all (the field is absent, not 1)
 *  and a 0.04s duration, so neither of those can be the test; a GIF reports
 *  a real count. `> 1` is therefore the rule, and a format that declines to
 *  report a count falls back to the still path — which shows its first frame
 *  rather than failing, the right way round for a surprise input. */
async function frameCount(path: string): Promise<number> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=nb_frames",
      "-of", "default=nk=1:nw=1",
      path,
    ]);
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
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
 *  One thing is drawn OVER the background: the bundled mark, spinning in
 *  the top-right corner for the whole render. It is not a speech and not an
 *  option — see `LOGO_PATH`.
 *
 *  The background MAY MOVE. It is a still picture in the ordinary case and
 *  an animated one (a GIF) when the user picked one, looped for as long as
 *  the track runs. Nothing downstream of the input changes between the two —
 *  the same `scale`+`crop` cover-crops either, and the same `-t` bounds
 *  either — so "the picture is the whole video" holds exactly as written
 *  above, with "picture" meaning a loop rather than a frame.
 *
 *  The output's duration is still the music's by construction (`-t` plus the
 *  background input's own), so nothing sums, no leg's length feeds a later
 *  leg's offset, and the name `/api/lofi` builds from that duration cannot
 *  come to describe a different file. A background that runs LONGER than the
 *  track is cut off by that same `-t` rather than extending anything. */
export async function renderLofi(opts: {
  /** A still picture or an animated one. `renderLofi` decides which by
   *  counting its frames, never by its name or the caller's say-so. */
  background: string;
  music: string;
  cuts: Cut[];
  out: string;
}): Promise<string> {
  const { background, music, cuts, out } = opts;
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
  // APPENDED LAST, after the crackle, which is the rule every input in this
  // graph has followed since the `anullsrc` stand-in taught it: an index
  // inserted above an existing one shifts that one silently. Nothing here is
  // conditional — the logo is bundled and always drawn — so the arithmetic
  // stays flat.
  const logoIndex = crackleIndex + 1;

  // The two input forms are NOT interchangeable, in either direction, and
  // picking the wrong one does not fail politely.
  //
  // `-loop 1` is an image2-demuxer option: it MANUFACTURES frames from a
  // single picture, which is exactly right for a still and does nothing
  // useful for a file that already has frames of its own — it would hold the
  // first one forever and the animation would silently never play.
  //
  // `-stream_loop -1` replays the whole decoded input, which is right for an
  // animation and is a HANG for a still: measured here, a JPEG under
  // `-stream_loop -1 -t 6` never produced a frame and ffmpeg had to be
  // killed. It spins re-opening a one-frame input whose timestamps never
  // advance. So this is a real fork rather than a tidiness one, and the
  // still branch must keep `-loop 1`.
  //
  // `-t` is an INPUT option on both, which is what bounds `[v]` at the
  // track's length whichever branch runs.
  const moving = (await frameCount(background)) > 1;
  const inputs: string[] = moving
    ? ["-stream_loop", "-1", "-t", String(seconds), "-i", background]
    : ["-loop", "1", "-framerate", String(FPS), "-t", String(seconds), "-i", background];
  inputs.push("-i", music);
  for (const cut of cuts) inputs.push("-i", cut.path);
  // Looped rather than trimmed to length here: the asset is ~12s and a track
  // is minutes. Every tap below `atrim`s its own copy, and the output's own
  // `-t` bounds the lot, so the infinite input can never outrun the render.
  inputs.push("-stream_loop", "-1", "-i", CRACKLE_PATH);
  // `-loop 1` and NOT `-stream_loop -1`, the same fork the background takes
  // and for the same measured reason: `-stream_loop` on a one-frame input
  // spins without ever emitting a frame. `-framerate` is what makes the
  // `rotate` expression's `t` advance at the rate the encoder expects, since
  // the spin is a function of the frame's own timestamp.
  inputs.push("-loop", "1", "-framerate", String(FPS), "-t", String(seconds), "-i", LOGO_PATH);

  const legs: string[] = [];

  // The whole video track: the background, cover-cropped so it fills the
  // frame edge to edge, from t=0 to the end. No fades and no overlays — a
  // speech is audio, so there is nothing for the picture to get out of the
  // way of.
  //
  // Identical for a still and for an animation, deliberately. `scale`+`crop`
  // cover-crops a stream frame by frame, so the moving case needs no second
  // recipe, and `fps` is what turns a GIF's own irregular inter-frame delays
  // into the constant rate the encoder wants.
  legs.push(
    `[0:v]scale=${WIDE.w}:${WIDE.h}:force_original_aspect_ratio=increase,` +
      `crop=${WIDE.w}:${WIDE.h},fps=${FPS},setsar=1[bgx]`,
  );

  // The mark, spinning once every `SPIN_SECONDS` in the top-right corner.
  //
  // Four filters and the ORDER of the middle two is the load-bearing part.
  // `format=rgba` first, because `rotate`'s `c=none` fills the corners it
  // sweeps with TRANSPARENCY and there is nowhere to put that without an
  // alpha channel — on an opaque input the same filter fills with black and
  // the mark arrives inside a hard square. `pad` BEFORE `rotate`, because
  // `rotate` renders into a box the size of its input and anything past the
  // inscribed circle is sheared off; padding to the diagonal first is what
  // gives every angle room. The pad colour is `0x00000000` — transparent
  // black, not black — for the same reason the format comes first.
  //
  // `a=2*PI*t/SPIN` is an expression over the frame's own timestamp rather
  // than a frame counter, so the spin is real seconds and does not change if
  // `FPS` ever does.
  legs.push(
    `[${logoIndex}:v]format=rgba,` +
      `scale=${LOGO_SIZE}:${LOGO_SIZE}:force_original_aspect_ratio=decrease,` +
      `pad=${LOGO_BOX}:${LOGO_BOX}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,` +
      `rotate=a=2*PI*t/${SPIN_SECONDS}:c=none[logo]`,
  );
  // The frequency bars, full width along the bottom, drawn from the mix the
  // viewer actually hears (`[aviz]`, split off the finished audio below).
  //
  // Rendered at `VIZ_BARS` COLUMNS and scaled up, which is what makes them
  // discrete bars rather than a continuous spectrum: one source column
  // becomes one bar, and `flags=neighbor` is load-bearing — any other
  // scaler interpolates the steps into a smooth ridge.
  //
  // The gaps between bars come from a per-pixel expression, and WHERE it
  // runs is the whole performance story. Masking at the final 1920 wide
  // costs 14s per minute of render, measured: 19.9s against a 5.7s
  // no-mask baseline, the same lesson `SCREEN_FILTER` records for the
  // starter screen. So the bars are widened to `VIZ_COLS` columns each
  // first (480 px), the expression zeroes `VIZ_COLS - VIZ_FILL` of every
  // ten there, and the result is scaled the rest of the way. Identical
  // output — verified frame against frame — for a sixteenth of the
  // evaluations: 9.7s against 19.9s.
  //
  // The alpha is `max(r,g,b)` rather than `r`: `showcqt` tints its bars by
  // pitch class, so keying on the red channel alone would make a blue bar
  // vanish. The colour is thrown away and replaced with white anyway — the
  // tint is `gifsync`'s white-at-0.85, not `showcqt`'s rainbow.
  const gap =
    `geq=r=255:g=255:b=255:` +
    `a='if(lt(mod(X\,${VIZ_COLS})\,${VIZ_FILL})\,` +
    `max(r(X\,Y)\,max(g(X\,Y)\,b(X\,Y)))\,0)'`;
  legs.push(
    `[aviz]showcqt=s=${VIZ_BARS}x${VIZ_HEIGHT}:sono_h=0:bar_g=${VIZ_GAMMA}:` +
      `count=6:basefreq=${VIZ_LO}:endfreq=${VIZ_HI}:fps=${FPS}[vzraw]`,
  );
  legs.push(
    `[vzraw]scale=${VIZ_BARS * VIZ_COLS}:${VIZ_HEIGHT}:flags=neighbor,format=rgba,` +
      `${gap},scale=${WIDE.w}:${VIZ_HEIGHT}:flags=neighbor,` +
      `colorchannelmixer=aa=${VIZ_ALPHA}[viz]`,
  );

  // Bars first, mark second, so the mark is topmost. They do not overlap
  // today — the bars own the bottom third and the mark the top-right
  // corner — so the order is insurance rather than a rule.
  //
  // `format=yuv420p` comes AFTER both overlays rather than on `[bgx]`
  // before them: the blends have to happen somewhere that can represent
  // alpha, and compositing into a subsampled plane first throws away the
  // colour resolution the mark's edges need.
  legs.push(`[bgx][viz]overlay=0:${WIDE.h - VIZ_HEIGHT}:format=auto[vbars]`);
  legs.push(`[vbars][logo]overlay=${LOGO_X}:${LOGO_Y}:format=auto,format=yuv420p[v]`);

  const fmt = `aformat=sample_fmts=fltp:channel_layouts=stereo`;
  legs.push(`[1:a]aresample=${RATE},${fmt}[music]`);

  if (cuts.length === 0) {
    legs.push(`[music]anull[amix]`);
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
        `normalize=0:duration=first[amix]`,
    );
  }

  // The bars read the FINISHED mix, which is why this split is here rather
  // than off `[music]` further up: a visualiser that ignored the speech and
  // the crackle would sit still through the one moment in the render a
  // viewer is most likely to be watching it. `[a]` is what gets mapped; the
  // second tap is video's problem.
  legs.push(`[amix]asplit=2[a][aviz]`);

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
