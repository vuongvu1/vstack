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
