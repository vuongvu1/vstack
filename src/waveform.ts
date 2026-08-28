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
