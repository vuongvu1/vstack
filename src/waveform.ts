import type { Segment } from "./segments.ts";

/** Peak-per-bucket reduction over one decoded audio channel.
 *
 *  This module imports nothing and knows nothing about Web Audio, which is
 *  the whole point: `decodeAudioData` does not exist under vitest's `node`
 *  environment, so taking a bare `Float32Array` rather than an `AudioBuffer`
 *  is what keeps the one piece of arithmetic here testable at all. The
 *  caller owns the decode and the drawing.
 *
 *  Peak, not RMS. At the zoom a framing clip is viewed at — marks plus two
 *  PADs, so tens of seconds — peaks are what make the gaps between phrases
 *  legible. Peak is the wrong statistic over a whole multi-hour video, where
 *  continuous speech saturates every bucket, but nothing here ever sees one:
 *  the clip is bounded by the trimming phase before it is fetched. */
export function peaks(samples: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(Math.max(0, buckets));
  if (out.length === 0 || samples.length === 0) return out;
  for (let b = 0; b < out.length; b++) {
    // Edges from the index, never an accumulated float stride: a stride
    // added `buckets` times drifts, and the final bucket ends up reading
    // past the end of the array or stopping short of it. `to` is floored to
    // at least `from + 1` so a bucket count above the sample count still
    // reports the sample it lands on instead of an empty range reading 0.
    const from = Math.floor((b * samples.length) / out.length);
    const to = Math.max(from + 1, Math.floor(((b + 1) * samples.length) / out.length));
    let max = 0;
    for (let i = from; i < to && i < samples.length; i++) {
      const v = samples[i] ?? 0;
      const abs = v < 0 ? -v : v;
      if (abs > max) max = abs;
    }
    out[b] = max;
  }
  return out;
}

/** Which envelope bucket the pixel column `x` shows, or -1 when that column
 *  is strip time the decoded audio does not reach.
 *
 *  The strip's axis is `span` — `windowEnd - windowStart`, the same
 *  coordinate system the handles and the playhead are placed in — while the
 *  envelope covers `clipSeconds`, the file's own decoded duration. For a
 *  single range those agree to a few milliseconds and this reduces exactly
 *  to `floor(x * buckets / width)`, which is what it always was.
 *
 *  A stitch is the case that needs the conversion. Its clip is named
 *  `0-<ceil(sum)>`, and `/api/export` rebuilds the cache path from that
 *  name, so `windowEnd` has to stay the ceil'd total — which leaves the
 *  strip's axis up to a second longer than the file it names. Spreading the
 *  envelope across the full width regardless is what pulled the waveform
 *  away from the playhead: ~0.5% on a 56s stitch, but ~11% on a short
 *  two-part cut, and progressive, so the drift is worst exactly where a
 *  user is checking the out-point. */
export function bucketAt(
  x: number,
  width: number,
  span: number,
  clipSeconds: number,
  buckets: number,
): number {
  if (!(width > 0) || !(span > 0) || !(clipSeconds > 0) || !(buckets > 0)) return -1;
  const t = (x * span) / width;
  // Not `>`: at t === clipSeconds the sample is one past the last one the
  // file has, and the floor below would land on `buckets` exactly.
  if (t >= clipSeconds) return -1;
  return Math.min(buckets - 1, Math.floor((t * buckets) / clipSeconds));
}

/** The quantile of the envelope taken as the file's noise floor. A low
 *  percentile rather than a median: a recording that is mostly speech drags
 *  a median up to speech level, and the floor is meant to describe the gaps
 *  between takes rather than the takes. */
const FLOOR_PCTILE = 0.1;

/** How far over that floor a bucket has to sit to count as speech. */
const OVER_FLOOR = 4;

/** The band the threshold is clamped into, as a fraction of the file's own
 *  peak. Both halves are load-bearing and each guards a different file.
 *
 *  The lower bound guards a clean recording whose gaps are true digital
 *  zero: the floor is then 0, `floor * OVER_FLOOR` is 0, and every bucket
 *  including the silent ones clears it — one range over the whole file.
 *
 *  The upper bound guards the opposite, a file that is speech almost
 *  throughout: the floor percentile lands ON speech, the threshold goes
 *  above the peak, and nothing is found at all. */
const MIN_FRAC = 0.05;
const MAX_FRAC = 0.5;

/** The quietest peak a file must reach before any of it is called speech.
 *  Roughly -26 dBFS.
 *
 *  This is the one ABSOLUTE gate here and it is what separates the two flat
 *  envelopes the relative band cannot tell apart: a file that is nothing but
 *  noise floor, and a file that is speech from end to end. Both have almost
 *  no dynamic range; only their level says which is which. */
const MIN_LEVEL = 0.05;

/** The longest quiet gap bridged rather than split on. A breath between
 *  words is not a range boundary. */
const BRIDGE = 0.6;

/** The shortest run kept. Below this it is a click, a chair or a lip
 *  smack, and a range that short is not worth a file. */
const MIN_SPEECH = 1;

/** Room left at each edge of a range, so the threshold crossing does not
 *  clip the first consonant or the tail of the last word. */
const EDGE = 0.15;

/** The loud stretches of `env`, as ranges in the file's own seconds — the
 *  cutter's "possibly speech here" guess.
 *
 *  Amplitude, not voice: loud music reads as speech, and that is the known
 *  ceiling. `ponytail:` the upgrade path is ffmpeg's `silencedetect` behind
 *  a route, which costs a pass over the file and an upload round trip for a
 *  guess the user is going to adjust on the playhead anyway.
 *
 *  Resolution is the envelope's — `decodeTrack` buckets at 4 a second — so
 *  an edge lands within 250ms and `EDGE` pads outward rather than inward on
 *  purpose: a range that starts a shade early costs a moment of room tone,
 *  where one that starts late costs a word. `ponytail:` decode the cutter's
 *  envelope finer than the lofi journey's the day that is not enough.
 *
 *  Takes the envelope rather than an AudioBuffer for the reason `peaks`
 *  does: the caller owns the decode, so this stays testable under vitest's
 *  `node` environment. */
export function speechRanges(env: Float32Array, seconds: number, max: number): Segment[] {
  const n = env.length;
  if (n === 0 || !(seconds > 0) || !(max > 0)) return [];

  const sorted = Float32Array.from(env).sort();
  const peak = sorted[n - 1] ?? 0;
  if (peak < MIN_LEVEL) return [];
  const floor = sorted[Math.min(n - 1, Math.floor(n * FLOOR_PCTILE))] ?? 0;
  const thresh = Math.min(Math.max(floor * OVER_FLOOR, peak * MIN_FRAC), peak * MAX_FRAC);

  // Seconds per bucket, from the file's own length rather than an assumed
  // rate: `speechRanges` is handed whatever `decodeTrack` produced.
  const per = seconds / n;
  const runs: Segment[] = [];
  let from = -1;
  // `<= n` so a run still open at the last bucket is closed by the walk
  // rather than needing a second close after it.
  for (let b = 0; b <= n; b++) {
    const loud = b < n && (env[b] ?? 0) >= thresh;
    if (loud && from < 0) from = b;
    if (!loud && from >= 0) {
      runs.push({ start: from * per, end: b * per });
      from = -1;
    }
  }

  const merged: Segment[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last !== undefined && run.start - last.end < BRIDGE) last.end = run.end;
    else merged.push({ ...run });
  }

  // Length is measured BEFORE the pad, so `MIN_SPEECH` describes how much
  // sound there is rather than how much sound plus padding.
  const kept = merged
    .filter((r) => r.end - r.start >= MIN_SPEECH)
    .map((r) => ({ start: Math.max(0, r.start - EDGE), end: Math.min(seconds, r.end + EDGE) }));

  // Longest first, then back into time order. Keeping the first `max` by
  // TIME instead would throw away the takes and keep whatever throat-clear
  // opened the file.
  kept.sort((a, b) => b.end - b.start - (a.end - a.start));
  return kept.slice(0, max).sort((a, b) => a.start - b.start);
}

/** `env` with `cut` seconds taken off its end, rounded to whole buckets.
 *
 *  What the cutter's Detect runs before `speechRanges`, to keep a vstack
 *  short's bundled outro out of the answer: that asset is a fixed length and
 *  is loud right up to its last sample, so it is detected as speech every
 *  time and it is never what the user is cutting for.
 *
 *  The cut is rounded to a bucket and the reported duration follows it,
 *  rather than the envelope being rescaled to an arbitrary length: that
 *  keeps seconds-per-bucket EXACTLY what it was, so every range
 *  `speechRanges` then finds sits on the file's own grid. Rescaling instead
 *  would move every range by up to one bucket, and only on files that were
 *  trimmed — a drift that looks like the detector being imprecise rather
 *  than like this function.
 *
 *  A view rather than a copy, so trimming a five-minute envelope is free,
 *  and the identity at `cut <= 0` so an untrimmed Detect is the exact call
 *  it was before this existed. */
export function trimTail(
  env: Float32Array,
  seconds: number,
  cut: number,
): { env: Float32Array; seconds: number } {
  const n = env.length;
  if (!(cut > 0) || n === 0 || !(seconds > 0)) return { env, seconds };
  const keep = Math.max(0, n - Math.round((cut * n) / seconds));
  return { env: env.subarray(0, keep), seconds: (keep * seconds) / n };
}
