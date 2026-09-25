/** The lofi journey's one ffmpeg pass.
 *
 *  Sits BESIDE `ffmpeg.ts`, `longform.ts` and `starter.ts` rather than above
 *  any of them: it takes every path from the caller, needs neither
 *  `MEDIA_DIR` nor `OUT_DIR`, and may read `probeAudio` and nothing else. */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { clock } from "../src/format.ts";
import { BUCKETS_PER_SEC } from "../src/lofi.ts";
import { peaks } from "../src/waveform.ts";
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

/** How long the dip at each seam between two tracks takes.
 *
 *  Longer than this journey's own `FADE` (0.5s), and declared separately
 *  rather than shared with it: `FADE` measures a VOICE's breathing room and
 *  this measures a seam between two pieces of music. One constant for two
 *  jobs means tuning either one moves the other — the same reason
 *  `longform.ts` and `starter.ts` keep separate blur sigmas. */
export const TRACK_FADE = 1.5;

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

/** One full turn, in seconds, at a steady rate. Exported so the tests read
 *  the number rather than a second copy of it.
 *
 *  Steady on purpose: a wobbling spin — speed swelling and easing, briefly
 *  turning back about an eighth of the time — shipped for one review and was
 *  taken back out at the user's request. `server/lofi.test.ts` pins a
 *  constant forward rate so it does not creep back in. */
export const SPIN_SECONDS = 10;

/** ffmpeg's `mod`, spelled in TypeScript: `a - b * floor(a / b)`, which is
 *  NOT `%` — `%` keeps the sign of `a`. */
const fmod = (a: number, b: number) => a - b * Math.floor(a / b);

/** The mark's angle at `t` seconds, in radians. The TypeScript spelling of
 *  `SPIN_EXPR`, and the pair are ONE RULE IN TWO LANGUAGES exactly the way
 *  `bounce` and `bounceExpr` are: `server/lofi.test.ts` renders the
 *  expression and a constant angle from this function for the same instant
 *  and requires the two pictures to agree.
 *
 *  Kept as a pair even for a plain spin, because the mark's picture now
 *  breathes, hue-swings and glows too — a test that merely checked the
 *  composed mark kept changing would pass with the spin frozen solid. Only
 *  comparing the ANGLE, in isolation, can tell.
 *
 *  Wrapped into one turn, and that is load-bearing: ffmpeg's `rotate`
 *  overflows past 2048 RADIANS and freezes for the rest of the render (see
 *  `LOGO_FILTER`), so the angle handed to it must stay bounded however long
 *  the track runs. */
export function spinAt(t: number): number {
  return (2 * Math.PI * fmod(t, SPIN_SECONDS)) / SPIN_SECONDS;
}

/** `spinAt`, as the ffmpeg expression `rotate` evaluates per frame. Passed
 *  QUOTED, for the comma reason `bounceExpr` records. */
export const SPIN_EXPR = `2*PI*mod(t,${SPIN_SECONDS})/${SPIN_SECONDS}`;

/** On every wall hit the mark takes a new SIZE and its glow a new COLOUR,
 *  and holds both until the next hit — the DVD screensaver's own trick.
 *  Nothing about either changes BETWEEN hits.
 *
 *  Size steps along a golden-ratio sequence, `1 - (1 - SIZE_MIN) *
 *  frac(h * phi)` for the h-th hit: neighbouring hits always land well
 *  apart and the run never falls into a visible pattern, and hit 0 — the
 *  opening frame — is full size. SHRINK ONLY, and that is geometry rather
 *  than taste: `LOGO_BOX` is the diagonal of `LOGO_SIZE`, and a mark larger
 *  than that would put its corners past the box `rotate` renders into.
 *
 *  The glow's colour turns by the golden ANGLE on each hit, so every colour
 *  is far round the wheel from the one before it. An instant snap, not a
 *  fade — that is the effect being imitated.
 *
 *  Both replaced continuous versions (breathing on a 5.7s cycle, the glow
 *  walking the wheel every 19s, and a gentle ±30 degree hue swing on the
 *  mark itself) after one review, at the user's request. The hue swing went
 *  altogether: the character keeps her own colours. */
const SIZE_MIN = 0.85;
const GOLDEN = 0.6180339887498949;
const GOLDEN_ANGLE = 137.50776405003785;

/** The halo behind the vinyl.
 *
 *  Built at an EIGHTH of the box's size and scaled back up, one flat colour
 *  whose ALPHA alone is blurred, and recoloured by a single `hue` rotation —
 *  every one of those is a measured saving over the first version, which
 *  worked at a quarter size, blurred all four planes, and walked the colour
 *  with three per-pixel sines. Timed on 60s of the logo leg alone: 3.95s
 *  that way, 2.88s this way, and the two halos are indistinguishable side
 *  by side — it is blurred to nothing anyway, and a per-pixel expression
 *  belongs at the smallest size that still produces the right picture, the
 *  lesson the bars' gap mask already records. `GLOW_SIGMA` is in those
 *  eighth-size pixels; `GLOW_GAIN` lifts the blurred alpha back up so the
 *  halo reads near the edge rather than fading out the instant it leaves
 *  the mark. */
const GLOW_SIGMA = 1.75;
const GLOW_GAIN = 1.6;
/** The colour the halo starts from at hit 0; each hit turns it on round the
 *  wheel. A saturated magenta, so every hue it is turned to stays vivid. */
const GLOW_COLOUR = { r: 255, g: 40, b: 200 };

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

/** The radius of the RECORD's rim from the centre of its box, at
 *  `LOGO_SIZE` — what the bounce turns round on. A circle, so it is the same
 *  at every angle. Measured off the asset: along every angle from the centre
 *  the drawing ends at the rim or, where a limb sticks out, beyond it, so
 *  the shortest of those reaches is the rim — 124.5px, against 164px for the
 *  farthest limb. `server/lofi.test.ts` measures it again from the file, so
 *  a new logo with a different record fails there. */
export const VINYL_RIM = 125;

/** How far the padded box may hang past a wall: everything outside the
 *  rim, floored to even for the overlay-offset reason. This is what makes
 *  the VINYL touch the wall at every hit rather than the box's empty corner
 *  turning round ~100px short of it.
 *
 *  It means the figure's limbs — up to 164px out, 39px past the rim — poke
 *  past the frame for a moment whenever they point at a wall, and are cut
 *  off there. Chosen over the alternative: bouncing on the limbs' reach
 *  clipped nothing, but left a gap at the hit that ran from 0 to about 70px
 *  with the angle, which read as the mark turning round in mid-air. At a
 *  smaller size the rim itself stops up to 19px short (0.15 of 125), since
 *  one travel serves every size — a travel that changed at each hit would
 *  make the position a running sum rather than a triangle wave. */
const OVERHANG = even(LOGO_BOX / 2 - VINYL_RIM);

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

/** How long the bars' rainbow takes to slide once across the band. Prime,
 *  like the mark's own periods, so it never falls into step with any of
 *  them. */
const VIZ_DRIFT_SECONDS = 23;
const VIZ_FILL = 7;

/** How fast the mark drifts, in pixels a second, on BOTH axes.
 *
 *  One speed rather than two, which is what the screensaver this imitates
 *  does: it travels at 45 degrees and the wander comes from the frame not
 *  being square, not from the axes disagreeing. Here the travel box is
 *  1670x830 — the frame less the box, plus the overhang at each end — so
 *  the two bounce periods are 44.5s and 22.1s and the PATH repeats about
 *  every hour. What a viewer watches does not repeat with it: the size and
 *  glow colour step along golden-ratio sequences keyed to the hit COUNT,
 *  which only ever grows. The first true corner hit — both walls on one
 *  frame, the screensaver's own party trick — lands at 30m46s. (Retuning
 *  the travel moves both numbers a lot: at 1590x750 the path repeated every
 *  17m40s and cornered at 8m49s.)
 *
 *  75 px/s crosses the frame in about 20 seconds, roughly the pace of the
 *  original. A lofi mix is background, and a mark that hurries competes
 *  with the bars for an attention neither of them should be asking for. */
const BOUNCE_SPEED = 75;

/** How far the box travels on each axis before it turns round: the frame
 *  less the box, PLUS an `OVERHANG` at each end.
 *
 *  It turns round on the record's RIM, not on the padded box: the box is
 *  the diagonal of the square image, and bouncing it left the drawing
 *  turning back roughly 100px short of the wall — invisible while nothing
 *  happened at a hit, glaring once the size and colour change there. See
 *  `OVERHANG` for what turning on the rim costs the limbs. */
const TRAVEL_X = WIDE.w - LOGO_BOX + 2 * OVERHANG;
const TRAVEL_Y = WIDE.h - LOGO_BOX + 2 * OVERHANG;

/** Phase offsets, in PIXELS along each axis's own sweep rather than in
 *  seconds, so they share units with the modulus they feed.
 *
 *  Chosen so the mark STARTS exactly where it used to sit — `logoAt(0)` is
 *  the old top-right corner — which keeps the opening frame of every render
 *  identical to the one it had before the mark could move. Both are
 *  measured from the overhung start of the sweep (`+ OVERHANG`), since the
 *  sweep now begins that far off-frame. `TRAVEL_X - (LOGO_X + OVERHANG)` is
 *  below the turning point, so x opens heading left; `TRAVEL_Y + (LOGO_Y +
 *  OVERHANG)` is past it, so y opens heading down. Both therefore start with
 *  the whole frame in front of them rather than bouncing immediately. */
const PHASE_X = TRAVEL_X - (LOGO_X + OVERHANG);
const PHASE_Y = TRAVEL_Y + (LOGO_Y + OVERHANG);

/** One axis of the bounce: a triangle wave over `[0, range]`.
 *
 *  `abs(mod(u, 2r) - r)` sweeps r -> 0 -> r, which is a bounce with no
 *  branching and no state — the whole reason this can be an ffmpeg
 *  expression at all. `overlay`'s `eval` defaults to `frame` (verified on
 *  this machine's build), so the two strings below are re-read every frame
 *  for the cost of two modulos. That is nothing like the per-PIXEL `geq`
 *  the bars' gap mask needs, which is the one place in this graph where an
 *  expression had to be moved to a smaller canvas to be affordable.
 *
 *  Rounded DOWN to even, for the reason every overlay offset in this
 *  codebase is: an odd offset in yuv420p lands on a half-chroma-sample
 *  boundary, and a mark that MOVES would shimmer rather than merely sit
 *  half a sample off. */
function bounce(u: number, range: number): number {
  const span = 2 * range;
  const wrapped = ((u % span) + span) % span;
  return Math.floor(Math.abs(wrapped - range) / 2) * 2;
}

/** The ffmpeg spelling of `bounce`, for `overlay`'s `x`/`y`. The two are
 *  deliberately built from the SAME constants — they are one rule in two
 *  languages, and `server/lofi.test.ts` proves they agree by cropping a
 *  real render at `logoAt(t)` and finding the mark there.
 *
 *  The caller must pass this as a QUOTED option value (`x='...'`). A
 *  filtergraph reads `,` as the separator between two filters, so the comma
 *  inside `mod(a,b)` ends the `overlay` mid-expression and ffmpeg reports
 *  `No option name near 'auto'` — an error naming the option AFTER the one
 *  that is actually broken. Quoting the value is the fix rather than
 *  backslash-escaping the comma, because an escape has to survive being a
 *  TypeScript template literal as well as a filtergraph token, and `\,` in
 *  a template literal is just a comma again. */
function bounceExpr(phase: number, range: number): string {
  return `2*floor(abs(mod(${BOUNCE_SPEED}*t+${phase},${2 * range})-${range})/2)-${OVERHANG}`;
}

/** Hits so far on one axis, counted from wherever the phase starts it: a
 *  triangle wave over `[0, range]` touches a wall each time its argument
 *  crosses a multiple of `range`. */
const axisHits = (u: number, range: number) => Math.floor(u / range);
const HITS_AT_ZERO = axisHits(PHASE_X, TRAVEL_X) + axisHits(PHASE_Y, TRAVEL_Y);

/** Wall hits since the render began, on both axes together — a corner is
 *  two at once. The TypeScript spelling of `HITS_EXPR`; the two are one
 *  rule in two languages, like `bounce` and `bounceExpr`, and
 *  `server/lofi.test.ts` checks this one steps exactly where `logoAt` turns
 *  round and that the graph's size and colour step at the same instants. */
export function hitsAt(t: number): number {
  return (
    axisHits(BOUNCE_SPEED * t + PHASE_X, TRAVEL_X) +
    axisHits(BOUNCE_SPEED * t + PHASE_Y, TRAVEL_Y) -
    HITS_AT_ZERO
  );
}
const HITS_EXPR =
  `(floor((${BOUNCE_SPEED}*t+${PHASE_X})/${TRAVEL_X})+` +
  `floor((${BOUNCE_SPEED}*t+${PHASE_Y})/${TRAVEL_Y})-${HITS_AT_ZERO})`;

/** The mark's size at `t`, as a fraction of `LOGO_SIZE`. */
export function markScaleAt(t: number): number {
  const g = hitsAt(t) * GOLDEN;
  return 1 - (1 - SIZE_MIN) * (g - Math.floor(g));
}
const SCALE_EXPR =
  `${LOGO_SIZE}*(1-${(1 - SIZE_MIN).toFixed(4)}*(${HITS_EXPR}*${GOLDEN}-floor(${HITS_EXPR}*${GOLDEN})))`;
const GLOW_HUE_EXPR = `mod(${GOLDEN_ANGLE}*${HITS_EXPR},360)`;

/** The mark's own chain, from the raw PNG to a rotated RGBA frame.
 *
 *  Four filters, and the ORDER of the middle two is load-bearing.
 *  `format=rgba` first, because `rotate`'s `c=none` fills the corners it
 *  sweeps with TRANSPARENCY and there is nowhere to put that without an
 *  alpha channel — on an opaque input the same filter fills with black and
 *  the mark arrives inside a hard square. `pad` BEFORE `rotate`, because
 *  `rotate` renders into a box the size of its input and anything past the
 *  inscribed circle is sheared off; padding to the diagonal first is what
 *  gives every angle room. The pad colour is `0x00000000` — transparent
 *  black, not black — for the same reason the format comes first.
 *
 *  The angle is an expression over the frame's own TIMESTAMP rather than a
 *  frame counter, so one turn is real seconds and stays so if `FPS` ever
 *  changes.
 *
 *  The angle is `mod`'d into ONE TURN and that is a bug fix, not tidiness.
 *  ffmpeg's `rotate` carries its angle in a fixed-point value that overflows
 *  past 2048 RADIANS, and every frame after that comes back at one frozen
 *  angle for the rest of the render. At `SPIN_SECONDS` = 10 the bare
 *  `2*PI*t/10` crosses it at t = 2048 * 10 / 2PI = 3259.49s — 54m19s in.
 *  Measured on this build: alive at t=3258, byte-identical from t=3260.48
 *  onward, and found in a real 2h44m render whose mark stopped dead there
 *  while it went on bouncing (the position expressions are `overlay`'s and
 *  were never affected). `mod` is exact rather than approximate here because
 *  `SPIN_SECONDS` IS one turn, so the wrapped angle names the same
 *  orientation the unwrapped one did, and a render shorter than 54 minutes
 *  is unchanged frame for frame.
 *
 *  The value must be QUOTED for the reason `bounceExpr` records: a
 *  filtergraph reads `,` as the separator between two filters, so the comma
 *  inside `mod(t,10)` would end the `rotate` mid-expression.
 *
 *  Exported whole rather than assembled inline so a test can run the SHIPPED
 *  filters against the asset: what goes wrong here only shows up an hour
 *  into a timeline, which is far past what a real 1920x1080 render can be
 *  asked to produce inside a test. */
const GLOW_EIGHTH = Math.floor(LOGO_BOX / 8);
export const LOGO_FILTER =
  `format=rgba,` +
  `scale=w='${SCALE_EXPR}':h='${SCALE_EXPR}':force_original_aspect_ratio=decrease:eval=frame,` +
  `pad=${LOGO_BOX}:${LOGO_BOX}:(ow-iw)/2:(oh-ih)/2:color=0x00000000:eval=frame,` +
  `split[lmark][lglow];` +
  `[lglow]scale=${GLOW_EIGHTH}:${GLOW_EIGHTH},` +
  `geq=r=${GLOW_COLOUR.r}:g=${GLOW_COLOUR.g}:b=${GLOW_COLOUR.b}:a='alpha(X,Y)',` +
  `gblur=sigma=${GLOW_SIGMA}:planes=8,colorchannelmixer=aa=${GLOW_GAIN},` +
  `hue=h='${GLOW_HUE_EXPR}',` +
  `scale=${LOGO_BOX}:${LOGO_BOX}:flags=bilinear[lhalo];` +
  `[lhalo][lmark]overlay=format=auto,` +
  `rotate=a='${SPIN_EXPR}':c=none`;

/** Where the mark's padded box is at `t` seconds — which may be partly off
 *  the frame, by up to `OVERHANG`, at a wall. Exported so the test can
 *  follow it: with the mark moving there is no longer a fixed rect to crop,
 *  and a second copy of this arithmetic in the test file would drift the
 *  first time the speed is retuned. */
export function logoAt(t: number): { x: number; y: number; side: number } {
  return {
    x: bounce(BOUNCE_SPEED * t + PHASE_X, TRAVEL_X) - OVERHANG,
    y: bounce(BOUNCE_SPEED * t + PHASE_Y, TRAVEL_Y) - OVERHANG,
    side: LOGO_BOX,
  };
}

/** Where the mark STARTS — `logoAt(0)`, the top-right corner it used to
 *  hold for the whole render. Kept under its old name because the opening
 *  frame is still exactly this and the corner is still worth asserting;
 *  every later instant comes from `logoAt`. */
export const LOGO_RECT = logoAt(0);

/** The CRT screen, laid over the WHOLE finished picture — background, bars
 *  and mark together — as the graph's last video stage.
 *
 *  Seven ingredients, all approved on a trial render before any of this was
 *  written: a soft bloom, red/blue colour fringing, the screen's bulge with
 *  black curved corners, moving grain, a faint flicker, and scanlines plus a
 *  vignette.
 *
 *  THE rule of this stage: every `blend` runs in PLANAR RGB (`gbrp`). `blend`
 *  works in whatever pixel format it is handed, and on YUV its modes apply to
 *  the two colour planes as well as to brightness — `multiply` drags them
 *  toward zero, which is green, and `screen` pushes them up, which is
 *  purple. The trial did both, a whole render green and then mauve, with no
 *  error either time. `server/lofi.test.ts` renders a flat grey through this
 *  stage and requires its three channels to stay equal.
 *
 *  Two cost decisions, both measured on 20s of 1080p:
 *
 *  - SCANLINES AND VIGNETTE ARE ONE STATIC MASK, computed once and
 *    multiplied onto every frame. Computing the scanlines per frame with a
 *    per-pixel `geq` cost 9.75s per 20s on its own — more than doubling a
 *    render — and the vignette filter another 2.3s; the mask does both for
 *    1.24s. It is converted to planar RGB BEFORE the `loop`, so that happens
 *    once rather than on every frame. Applied LAST, after the bulge, so its
 *    lines are the output's own straight rows rather than bent with the
 *    picture — a real tube's lines are straight too.
 *  - THE FLICKER RUNS AFTER THE FINAL `format=yuv420p`. `eq` does not take
 *    planar RGB, so placed among the others it forced a full-frame round trip
 *    through YUV and back on every frame; at the end the frame is already
 *    YUV for the encoder. Every other filter here takes `gbrp` natively
 *    (checked by the converters ffmpeg auto-inserts, not assumed).
 *
 *  The bulge moves every pixel inward except at the centre, the walls the
 *  mark bounces off included, so the mark still meets the (now curved) edge
 *  at a hit. The bars sit on the curved bottom edge the same way. */
const CRT_BLOOM = 0.2;
const CRT_FRINGE = 3;
const CRT_BULGE = { k1: 0.12, k2: 0.04 };
const CRT_GRAIN = 12;
const CRT_FLICKER = { depth: 0.02, hz: 7 };
const CRT_SCANLINE = 0.35;
const CRT_VIGNETTE = 0.55;

function crtLegs(src: string, dst: string): string[] {
  const { w, h } = WIDE;
  const mask =
    `color=c=white:s=${w}x${h}:d=1:r=${FPS},format=gray,` +
    `geq=lum='255*(1-${CRT_SCANLINE}*eq(mod(Y,3),0))*` +
    `(1-${CRT_VIGNETTE}*pow(hypot((X-${w / 2})/${w / 2},(Y-${h / 2})/${h / 2})/1.4142,2.2))',` +
    `format=gbrp,trim=end_frame=1,loop=loop=-1:size=1[crtmask]`;
  return [
    `[${src}]format=gbrp,split[crta][crtb]`,
    `[crtb]scale=${w / 4}:${h / 4},gblur=sigma=6,scale=${w}:${h}[crtbloom]`,
    `[crta][crtbloom]blend=all_mode=screen:all_opacity=${CRT_BLOOM},` +
      `rgbashift=rh=-${CRT_FRINGE}:bh=${CRT_FRINGE},` +
      `lenscorrection=k1=${CRT_BULGE.k1}:k2=${CRT_BULGE.k2}:i=bilinear,` +
      `noise=alls=${CRT_GRAIN}:allf=t[crtpic]`,
    mask,
    `[crtpic][crtmask]blend=all_mode=multiply:shortest=1,format=yuv420p,` +
      `eq=brightness='${CRT_FLICKER.depth}*sin(2*PI*t*${CRT_FLICKER.hz})':eval=frame[${dst}]`,
  ];
}

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

/** Seconds done, from a `-progress` file's body.
 *
 *  ffmpeg APPENDS a key/value block per update rather than rewriting, so the
 *  file is a log and the last `out_time_us` is the position. Before the
 *  first frame it writes `N/A`, which must read as 0 rather than NaN — a NaN
 *  here reaches the panel as a progress bar that renders nothing at all. */
export function parseProgress(text: string): number {
  const hits = [...text.matchAll(/out_time_us=(\d+)/g)];
  const last = hits[hits.length - 1]?.[1];
  return last === undefined ? 0 : Number(last) / 1e6;
}

/** ponytail: one global slot, the same assumption `publishProgress` already
 *  states — two lofi renders cannot overlap in the panel. Unlike publish,
 *  this route IS reachable without the panel, so two concurrent renders give
 *  the second's numbers to both pollers. That is a wrong number rather than
 *  corruption; key it by output name the day it matters. */
let prog: { phase: "music" | "render"; file: string; total: number } | null = null;

/** How far the current render has got. Reads the progress file ON DEMAND,
 *  when the client polls, rather than on a timer — so there is no interval
 *  to leak and no lifecycle to get wrong. */
export function renderProgress(): { phase: "music" | "render"; done: number; total: number } {
  if (prog === null) return { phase: "render", done: 0, total: 0 };
  let done = 0;
  try {
    done = parseProgress(readFileSync(prog.file, "utf8"));
  } catch {
    // The file does not exist until ffmpeg's first block. Not an error.
    done = 0;
  }
  return { phase: prog.phase, done, total: prog.total };
}

/** Clears the slot. The route calls this in the same `finally` that sweeps
 *  the work directory, so a failed render does not leave the panel showing a
 *  frozen bar from a run that is over. */
export function clearProgress(): void {
  prog = null;
}

/** One line of progress, for the SERVER LOG rather than for the panel.
 *
 *  The panel polls `/api/lofi/progress` and renders its own bar; this exists
 *  because that poll can stop — a closed tab, a reload, a dropped proxy
 *  connection — while the render itself carries on to the end. A render is
 *  minutes to hours of encoding, so losing all visibility into it because a
 *  browser went away is the wrong failure, and the log is the one place that
 *  cannot disconnect from the process doing the work.
 *
 *  `clock` rather than `mmss`, because `mmss` is the FILENAME spelling (no
 *  separator, and minutes past 59 rather than an hour field) and a
 *  three-hour render logs `02:41:12` here where `mmss` would say `16112`.
 *
 *  The percent is clamped at 100: ffmpeg's last block can land marginally
 *  past the duration `probeAudio` reported, and `101%` reads as a defect in
 *  the renderer rather than as the rounding it is. A `total` of 0 — what
 *  `renderProgress` reports before either function has probed anything —
 *  gives 0 rather than the NaN the division would otherwise produce. */
export function progressLine(p: {
  phase: "music" | "render";
  done: number;
  total: number;
}): string {
  const what = p.phase === "music" ? "joining tracks" : "rendering";
  const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
  return `${what} ${pct}% (${clock(p.done)}/${clock(p.total)})`;
}

/** How often the log ticker WAKES. What it prints is decided by the percent
 *  having moved, so this is a resolution floor rather than a line rate. */
const LOG_EVERY_MS = 10_000;

/** Starts logging this render's progress; returns the stop.
 *
 *  Started and stopped by the two functions that already own `prog` and the
 *  `.progress` file itself, in the same `finally` that removes it — the same
 *  "each function cleans up its own litter" rule that kept the sidecar out of
 *  `server/index.ts`. A route-level ticker would need to know when a render
 *  began, which is exactly what these two already know and nothing else does.
 *
 *  Logs only when the whole percent MOVES, so a three-hour render is about a
 *  hundred lines rather than one every ten seconds for three hours. The timer
 *  is `unref`'d: a stop that somehow never ran must not hold the process open
 *  at exit. */
function logProgress(): () => void {
  let last = -1;
  const timer = setInterval(() => {
    const p = renderProgress();
    // Before ffmpeg's first block there is nothing to report and no
    // denominator to report it against.
    if (p.total <= 0) return;
    const pct = Math.min(100, Math.round((p.done / p.total) * 100));
    if (pct === last) return;
    last = pct;
    console.warn(`vstack: lofi ${progressLine(p)}`);
  }, LOG_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** What a scanned folder offers the panel. `path` is absolute and is what
 *  `/api/lofi` is handed back — the file is never copied anywhere. */
export type ScannedFile = { name: string; path: string; seconds: number };

/** Extensions `scanFolder` will even look at.
 *
 *  An extension test rather than a probe of everything in the folder,
 *  because a real music folder holds cover art, a .DS_Store and a tracklist,
 *  and spawning an ffprobe per JPEG to learn it is a JPEG is both slow and
 *  noisy. Video extensions are here for the same reason `/api/upload-audio`
 *  accepts a video: a speech may be a screen recording, and only its audio
 *  is ever used. */
const MEDIA_EXT = new Set([
  ".aac", ".aif", ".aiff", ".flac", ".m4a", ".mp3", ".oga", ".ogg", ".opus", ".wav", ".wma",
  ".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm",
]);

/** Everything in `dir` this journey could use, with the durations probed.
 *
 *  The folder REPLACES uploading for this journey, so these paths are read
 *  in place by ffmpeg and nothing is ever copied into `media/uploads/`.
 *
 *  Sorted by name, and by codepoint rather than `localeCompare`: the panel
 *  then applies `orderByPrefix`, whose whole contract is that a `1_` file
 *  comes first, and a collation that varies with the host's ICU build would
 *  make the rest of that order differ between machines for no reason.
 *
 *  A file that carries a media extension and turns out to have no audio
 *  stream is REPORTED rather than dropped or fatal. Dropping it silently is
 *  a track missing from a render with nothing to explain it — the failure
 *  class this journey already refuses a no-audio upload to avoid — and
 *  failing the whole scan means one stray file in a folder of seventy
 *  blocks all of them. */
export async function scanFolder(dir: string): Promise<{
  files: ScannedFile[];
  skipped: string[];
}> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new Error(`Could not read the folder ${dir}.`);
  }
  const names = entries
    .filter((e) => e.isFile() && MEDIA_EXT.has(extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const files: ScannedFile[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const { seconds } = await probeAudio(path);
      if (seconds > 0) files.push({ name, path, seconds });
      else skipped.push(name);
    } catch {
      skipped.push(name);
    }
  }
  return { files, skipped };
}

/** The rate the envelope is built at. 8 kHz mono, matching what the browser
 *  decoded at before the scan existed — a rate chosen there because it is
 *  the difference between 19 MB and 230 MB for a six-minute track, and kept
 *  here so the two produce envelopes of the same shape. */
const ENV_RATE = 8000;

/** Enough for roughly a four-hour track at `ENV_RATE` in 32-bit floats. A
 *  cap, not an allocation. */
const ENV_MAX_BYTES = 512 << 20;

/** The loudness envelope `troughs`/`fill` place speeches against.
 *
 *  `peaks` is IMPORTED from `src/waveform.ts` rather than reimplemented,
 *  and that is the point of this function's shape: the browser used to build
 *  this envelope itself, and the two would otherwise be one rule in two
 *  languages — the hazard `bounce`/`bounceExpr` already carries. Sharing the
 *  bucketing leaves only the DECODE differing, and ffmpeg's resampler and
 *  WebAudio's will not agree sample for sample. That is acceptable because
 *  the envelope RANKS candidate windows by quietness rather than measuring
 *  anything: a placement can land a bucket (250 ms) from where the browser
 *  would have put it, and no assertion downstream depends on which.
 *
 *  `seconds` comes from the caller's own probe rather than being re-probed
 *  here, so the bucket count is the same number `scanFolder` already
 *  reported and the panel's timeline cannot disagree with the envelope
 *  drawn on it. */
export async function trackEnvelope(path: string, seconds: number): Promise<Float32Array> {
  const buckets = Math.max(1, Math.round(seconds * BUCKETS_PER_SEC));
  let stdout: Buffer;
  try {
    ({ stdout } = await run(
      "ffmpeg",
      [
        "-v", "error",
        "-i", path,
        "-map", "0:a:0",
        "-ac", "1",
        "-ar", String(ENV_RATE),
        "-f", "f32le",
        "-",
      ],
      { maxBuffer: ENV_MAX_BYTES, encoding: "buffer" },
    ));
  } catch (err) {
    throw toolError("ffmpeg", err);
  }
  // `slice` rather than a view over `stdout`: a Float32Array needs its byte
  // offset to be a multiple of 4, and a Buffer handed back by execFile sits
  // wherever in the pool it landed. Slicing copies into a fresh, 0-offset
  // ArrayBuffer, which is aligned by construction. The trailing remainder is
  // dropped — a partial float is not a sample.
  const usable = stdout.length - (stdout.length % 4);
  const aligned = stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + usable);
  return peaks(new Float32Array(aligned), buckets);
}

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

/** Joins the music tracks into one file and returns the path to use as the
 *  render's music.
 *
 *  **One track returns its own path and writes nothing.** That identity is
 *  the point: the existing single-track journey must not pay an extra pass,
 *  a ~1 GB temp file or a new failure mode for a feature it does not use.
 *
 *  Why a PRE-PASS rather than N inputs on the main graph. The obvious shape
 *  is `concat` inside `renderLofi`, and it works — but a three-hour render
 *  at four minutes a track is around forty-five tracks, which is forty-five
 *  more ffmpeg inputs on a graph that already carries the background, every
 *  speech, the crackle and the mark. More importantly it would make
 *  `seconds` an arithmetic SUM, and this journey's duration invariant is
 *  that nothing sums: the route probes one file and `outName` commits that
 *  number to the filename. Building the file here keeps the invariant
 *  verbatim — the duration is still the music's, by construction, and the
 *  music is now a file this function built.
 *
 *  flac, so the tracks are not lossily re-encoded twice on their way to the
 *  render's AAC. Roughly 1 GB for three hours, in the caller's temp dir.
 *
 *  The seam is a DIP ON EACH LEG, never `acrossfade`. A crossfade overlaps
 *  the legs, so the output is `(N-1) * d` shorter than the tracks sum to —
 *  and the sum is what the caller has already committed to in the filename.
 *  A dip keeps the total exact by construction. Same decision, same reason,
 *  as `stackWide`'s transition. */
export async function concatMusic(paths: string[], out: string): Promise<string> {
  const first = paths[0];
  if (first === undefined) throw new Error("concatMusic needs at least one track.");
  if (paths.length === 1) return first;

  const probed = await Promise.all(paths.map((p) => probeAudio(p)));
  const fmt = `aformat=sample_fmts=fltp:channel_layouts=stereo`;
  const legs: string[] = [];
  paths.forEach((_, i) => {
    const secs = probed[i]?.seconds ?? 0;
    // Clamped to a third of the track, the same clamp `stackWide` carries
    // and for the same two symptoms of one defect: on a track shorter than
    // `2 * TRACK_FADE` an unclamped fade-in and fade-out overlap and
    // MULTIPLY to roughly quarter level, and once the track is shorter than
    // the fade itself the fade-out's `st` goes negative and ffmpeg refuses
    // the graph outright.
    const d = Math.min(TRACK_FADE, secs / 3);
    // Only BETWEEN tracks: the mix opens on its first track and closes on
    // its last, both deliberately, and fading either is fading something
    // that already begins and ends on purpose.
    const fadeIn = i > 0 ? `afade=t=in:st=0:d=${d},` : "";
    const fadeOut = i < paths.length - 1 ? `afade=t=out:st=${secs - d}:d=${d},` : "";
    legs.push(`[${i}:a]aresample=${RATE},${fmt},${fadeIn}${fadeOut}anull[t${i}]`);
  });
  legs.push(`${paths.map((_, i) => `[t${i}]`).join("")}concat=n=${paths.length}:v=0:a=1[out]`);

  const total = probed.reduce((sum, p) => sum + p.seconds, 0);
  prog = { phase: "music", file: `${out}.progress`, total };
  const stopLog = logProgress();

  try {
    await run(
      "ffmpeg",
      [
        "-v", "error",
        ...paths.flatMap((p) => ["-i", p]),
        "-filter_complex", legs.join(";"),
        "-map", "[out]",
        "-c:a", "flac",
        "-progress", `${out}.progress`,
        "-y", out,
      ],
      { maxBuffer: 16 << 20 },
    );
  } catch (err) {
    throw toolError("ffmpeg", err);
  } finally {
    // Swept here, not by the route: `out` is the caller's own path (a temp
    // dir today), and `${out}.progress` is a name only this function ever
    // writes, so this is the one place that knows it exists at all.
    // `force: true` because ffmpeg may have died before its first block,
    // before the file was ever created — that must not raise a second error
    // masking the first.
    stopLog();
    await rm(`${out}.progress`, { force: true });
  }
  return out;
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
  /** The CRT screen over the finished picture. ALWAYS on in the app —
   *  `/api/lofi` never passes this — and it exists so the tests that measure
   *  the composition itself (the mark's position, the bars' colour, the
   *  background) can read it undistorted: the screen bends, darkens and
   *  fringes every pixel they sample. The screen has tests of its own. */
  crt?: boolean;
}): Promise<string> {
  const { background, music, cuts, out, crt = true } = opts;
  // `probeAudio`, never `probeFile`: the track has no video stream, and
  // `probeFile` throws on exactly that. Task 2's prober, imported rather
  // than duplicated — `ffmpeg.ts` is the layer below this one, so there is
  // no layering reason to re-derive it the way the ASSET path is re-derived.
  const { seconds } = await probeAudio(music);
  if (!(seconds > 0)) throw new Error(`Could not read a duration from ${music}.`);
  prog = { phase: "render", file: `${out}.progress`, total: seconds };
  const stopLog = logProgress();

  // `probeAudio` on a speech too, for the same reason it is used on the
  // track: a speech may be a bare audio file, which `probeFile` refuses
  // outright, and its pictures are not wanted even when it has them. It also
  // makes "has an audio stream" the trust boundary — a file with none throws
  // here rather than rendering as a silent stretch nobody notices until they
  // watch the output.
  const probed = await Promise.all(cuts.map((c) => probeAudio(c.path)));
  // One INPUT per unique speech FILE, not one per drop. A repeated speech —
  // a three-hour render at five-minute spacing might play four recordings
  // thirty-odd times — would otherwise put one input on this graph per drop,
  // on top of the background, the music, the crackle and the logo. This is
  // the crackle leg's own shape (one input, `asplit` into its taps) applied
  // to the speeches, computed here because the index arithmetic below needs
  // the unique count rather than the drop count.
  const uniquePaths = [...new Set(cuts.map((c) => c.path))];
  // Positional, the way `stackWide`'s inputs are: image, music, the unique
  // speech files, the crackle. There is no conditional input left in this
  // graph — the `anullsrc` stand-in went with the cut-in it stood in for —
  // so the arithmetic is now flat.
  const firstCut = 2;
  const crackleIndex = firstCut + uniquePaths.length;
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
  for (const path of uniquePaths) inputs.push("-i", path);
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

  // The mark, spinning once every `SPIN_SECONDS`. Every decision in the
  // chain itself is documented at `LOGO_FILTER`.
  legs.push(`[${logoIndex}:v]${LOGO_FILTER}[logo]`);
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
  // vanish. The colour is thrown away and replaced with a RAINBOW of this
  // graph's own — one full turn of the colour wheel across the band, sliding
  // sideways once every `VIZ_DRIFT_SECONDS` — rather than `showcqt`'s, which
  // tints by pitch class and so holds each bar to one colour forever. Free:
  // this `geq` already ran per pixel to cut the gaps, and it was already
  // writing r, g and b; they are simply expressions of `X` and `T` now
  // instead of 255.
  // The rainbow is computed on a strip ONE PIXEL PER BAR and multiplied
  // onto the white bars, rather than evaluated per pixel of the bar canvas.
  // Its colour depends only on the column and the time, never the row, so
  // spelling it in the gap mask's `geq` recomputed three sines for every one
  // of 480x360 pixels a frame for no difference — measured, that took a
  // 60s render from 19s to 35s on its own. Here it is 48 evaluations a
  // frame, and a 60s render costs about what white bars did. The price is
  // that each bar is ONE colour rather than a gradient across its own
  // width, which is the cleaner look anyway.
  const rainbow = (third: number) =>
    `'127.5+127.5*sin(2*PI*(X/W+mod(T,${VIZ_DRIFT_SECONDS})/${VIZ_DRIFT_SECONDS})+` +
    `${((2 * Math.PI * third) / 3).toFixed(4)})'`;
  const gap =
    `geq=r=255:g=255:b=255:` +
    `a='if(lt(mod(X\,${VIZ_COLS})\,${VIZ_FILL})\,` +
    `max(r(X\,Y)\,max(g(X\,Y)\,b(X\,Y)))\,0)'`;
  legs.push(
    `[aviz]showcqt=s=${VIZ_BARS}x${VIZ_HEIGHT}:sono_h=0:bar_g=${VIZ_GAMMA}:` +
      `count=6:basefreq=${VIZ_LO}:endfreq=${VIZ_HI}:fps=${FPS},split[vzraw][vztime]`,
  );
  legs.push(
    `[vztime]format=rgba,crop=${VIZ_BARS}:1:0:0,` +
      `geq=r=${rainbow(0)}:g=${rainbow(1)}:b=${rainbow(2)}:a=255,` +
      `scale=${VIZ_BARS * VIZ_COLS}:${VIZ_HEIGHT}:flags=neighbor[vzhue]`,
  );
  legs.push(
    `[vzraw]scale=${VIZ_BARS * VIZ_COLS}:${VIZ_HEIGHT}:flags=neighbor,format=rgba,` +
      `${gap}[vzwhite]`,
  );
  legs.push(
    `[vzwhite][vzhue]blend=all_mode=multiply,` +
      `scale=${WIDE.w}:${VIZ_HEIGHT}:flags=neighbor,` +
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
  legs.push(
    `[vbars][logo]overlay=x='${bounceExpr(PHASE_X, TRAVEL_X)}':` +
      `y='${bounceExpr(PHASE_Y, TRAVEL_Y)}':format=auto` +
      (crt ? `[vscene]` : `,format=yuv420p[v]`),
  );
  if (crt) legs.push(...crtLegs("vscene", "v"));

  const fmt = `aformat=sample_fmts=fltp:channel_layouts=stereo`;
  legs.push(`[1:a]aresample=${RATE},${fmt}[music]`);

  if (cuts.length === 0) {
    legs.push(`[music]anull[amix]`);
  } else {
    // Grouped by FILE rather than walked by drop: `indexOfPath` is the input
    // index each unique file landed at above, and `dropsOfPath` is which cut
    // indices share it. A single drop takes no `asplit` at all, so a
    // one-shot render's graph is byte-identical to the one it had before
    // repeats existed.
    const indexOfPath = new Map(uniquePaths.map((p, i) => [p, firstCut + i]));
    const dropsOfPath = new Map<string, number[]>();
    cuts.forEach((cut, i) => {
      const list = dropsOfPath.get(cut.path) ?? [];
      list.push(i);
      dropsOfPath.set(cut.path, list);
    });

    for (const path of uniquePaths) {
      const drops = dropsOfPath.get(path) ?? [];
      const input = indexOfPath.get(path) ?? firstCut;
      // A single drop takes no `asplit` at all, so a one-shot render's graph
      // is byte-identical to the one it had before repeats existed.
      if (drops.length > 1) {
        const taps = drops.map((i) => `[raw${i}]`).join("");
        legs.push(`[${input}:a]asplit=${drops.length}${taps}`);
      }
      for (const i of drops) {
        const cut = cuts[i];
        if (cut === undefined) continue;
        const dur = probed[i]?.seconds ?? 0;
        const src = drops.length > 1 ? `[raw${i}]` : `[${input}:a]`;
        // `atrim` bounds a speech whose container runs longer than its own
        // audio — a video file whose picture outlasts its sound is the
        // ordinary case, since `dur` here is the CONTAINER's duration.
        //
        // ponytail: no `afade` at this hard `atrim` edge. A speech recording
        // is usually near-silent at its own end, but a genuine click is
        // possible on one that does not fade out on its own — and nothing
        // covers it any more, now that the video no longer dips to black
        // over the same instant. Add `afade=t=out:st=${dur - d}:d=${d}`
        // (the `d` the crackle boost's own fades use, `Math.min(FADE, dur /
        // 3)`) the day a real render audibly clicks; not added now because
        // tuning it needs a recording to listen to, not a synthetic
        // fixture.
        //
        // The vinyl treatment runs on every speech, unconditionally. It
        // used to be skipped on a cut-in with no audio of its own, which was
        // fed digital silence by an `anullsrc` stand-in — and that skip was
        // a correctness fix rather than a saving, because some filters emit
        // NaN on a zero signal and the NaN reaches the AAC encoder as
        // `Error submitting audio frame to the encoder: Invalid argument`.
        // There is no stand-in any more: `probeAudio` above refuses a file
        // with no audio stream, so every leg here carries a real recording.
        // A recording that happens to BE silent still reaches these
        // filters, so the `mode=lin` rule on `acrusher` stays load-bearing.
        legs.push(
          `${src}atrim=0:${dur},asetpts=PTS-STARTPTS,` +
            `highpass=f=${SPEECH_HP},` +
            `acrusher=bits=${CRUSH_BITS}:mode=lin:mix=${CRUSH_MIX},` +
            `lowpass=f=${SPEECH_LP},volume=${SPEECH_GAIN},` +
            `adelay=${Math.round(cut.at * 1000)}:all=1,aresample=${RATE},${fmt}[sp${i}]`,
        );
      }
    }
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
  //
  // `apad` FIRST, and it is the `sidechaincompress` truncation one stage
  // further down — the same silent shape, arriving from a different
  // direction. `amix ... duration=first` takes the mix's length from
  // `[ducked]`, `[ducked]` takes its own from `[music]`, and a music input
  // whose decoded stream EOFs a little short of the duration `probeAudio`
  // reported for it drags the whole audio stream short with it. The
  // container and the video track stay full length throughout, so nothing
  // that reads `format.duration` can see it: measured on a three-track
  // concat, a 4.836009s audio stream inside a 6.066667s container against a
  // music file `probeAudio` reports as 6.060408s. Padding the finished mix
  // to the length this graph already probed puts the floor under every way
  // a leg can end early rather than under the one that was found first.
  //
  // The flac intermediate is NOT the cause, and swapping it for wav is not
  // the fix. The pad here leaves `concatMusic`'s codec exactly as it was and
  // closes the gap outright, which is what says the mix's own
  // `duration=first` is where this lives — a codec can only move how early a
  // stream EOFs, not whether the mix inherits that EOF. wav would also put
  // RIFF's 4 GB ceiling inside reach at `MAX_TRACKS`, on a pre-pass already
  // measured at roughly a gigabyte for three hours.
  //
  // Free on every path that did not need it: `apad` emits nothing when the
  // stream already reaches `whole_dur`, and a single-track render is
  // byte-identical with and without it — verified by hash, both with a
  // speech and with none.
  legs.push(`[amix]apad=whole_dur=${seconds},asplit=2[a][aviz]`);

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
        "-progress", `${out}.progress`,
        "-y", out,
      ],
      { maxBuffer: 16 << 20 },
    );
  } catch (err) {
    throw toolError("ffmpeg", err);
  } finally {
    // Swept HERE rather than by the route, and that placement matters more
    // for this call than for `concatMusic`'s: `out` is the partial inside
    // `OUT_DIR`, which on this machine is `~/Desktop/vstack` — a directory
    // this codebase treats as the user's own, not scratch space it already
    // sweeps wholesale the way it sweeps its temp dir. The partial itself is
    // renamed on success and unlinked on failure by the route, but neither
    // path touches `${out}.progress`, and no existing name check
    // (`isOutName`/`isCutName`) matches a `.progress` suffix — so nothing
    // else in the codebase could ever find this file to remove it. `rm`
    // creates and cleans its own litter rather than handing `server/index.ts`
    // a filename convention to keep in sync with. `force: true` for the same
    // reason as above — a render can fail before ffmpeg writes its first
    // progress block.
    stopLog();
    await rm(`${out}.progress`, { force: true });
  }
  return out;
}
