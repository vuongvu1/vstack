import { describe, expect, it } from "vitest";
import { bucketAt, peaks } from "./waveform.ts";

describe("peaks", () => {
  it("takes the maximum absolute amplitude per bucket", () => {
    // Eighths throughout: these round-trip through Float32Array exactly, so
    // the assertion can stay an exact toEqual. 0.9 and 0.3 do not — they
    // come back as 0.8999999761581421 and 0.30000001192092896.
    const s = new Float32Array([0.125, 0.875, -0.25, 0.375, -1, 0.5]);
    expect(Array.from(peaks(s, 3))).toEqual([0.875, 0.375, 1]);
  });

  it("uses absolute value, so a negative trough is a peak", () => {
    expect(Array.from(peaks(new Float32Array([-0.75, 0.25]), 1))).toEqual([0.75]);
  });

  it("returns exactly `buckets` entries when the length does not divide evenly", () => {
    // 7 samples into 3 buckets: edges are computed from the index rather
    // than by accumulating a float stride, which would drift and leave the
    // last bucket reading past the end or stopping short of it.
    const s = new Float32Array([1, 2, 3, 4, 5, 6, 7]);
    const out = peaks(s, 3);
    expect(out.length).toBe(3);
    expect(Array.from(out)).toEqual([2, 4, 7]);
  });

  it("never leaves a bucket empty when there are more buckets than samples", () => {
    // Every bucket must still report something, or the strip draws gaps at
    // a zoom the user did not ask for.
    const out = peaks(new Float32Array([0.5, 0.25]), 4);
    expect(out.length).toBe(4);
    expect(Array.from(out).every((v) => v > 0)).toBe(true);
  });

  it("returns zeros for a silent clip rather than an empty array", () => {
    expect(Array.from(peaks(new Float32Array([0, 0, 0]), 2))).toEqual([0, 0]);
  });

  it("returns an empty array for zero or negative buckets", () => {
    expect(peaks(new Float32Array([1]), 0).length).toBe(0);
    expect(peaks(new Float32Array([1]), -3).length).toBe(0);
  });

  it("returns zeros when there are no samples at all", () => {
    // A clip with no audio track decodes to nothing; the strip must stay
    // flat rather than throw.
    expect(Array.from(peaks(new Float32Array([]), 3))).toEqual([0, 0, 0]);
  });
});

describe("bucketAt", () => {
  it("reduces exactly to a plain x→bucket map when the clip fills the strip", () => {
    // The single-range case, which is every clip that is not a stitch. This
    // is the identity any rework has to preserve: `span` and the decoded
    // duration agree to within a few milliseconds there, and the mapping
    // must stay byte-for-byte what it was before the stitch case existed.
    const w = 640;
    const buckets = 900;
    for (let x = 0; x < w; x++) {
      expect(bucketAt(x, w, 30, 30, buckets)).toBe(Math.floor((x * buckets) / w));
    }
  });

  it("maps a stitch's shorter file onto the strip's longer axis", () => {
    // A stitch is named `0-<ceil(sum)>`, so `windowEnd - windowStart` is up
    // to a second longer than the file it names. The envelope has to be laid
    // out on the strip's axis rather than stretched across its full width,
    // or the waveform pulls away from the playhead and the handles — by
    // ~11% on a short two-part cut, growing toward the right edge.
    const w = 100;
    // Clip is 9s of audio on a 10s axis: the clip owns the first 90% only.
    expect(bucketAt(0, w, 10, 9, 10)).toBe(0);
    expect(bucketAt(45, w, 10, 9, 10)).toBe(5);
    expect(bucketAt(89, w, 10, 9, 10)).toBe(9);
  });

  it("reports -1 for the phantom tail past the end of the decoded audio", () => {
    // Those columns are strip time the file does not reach. Painting them
    // would be inventing audio; they stay blank.
    const w = 100;
    expect(bucketAt(90, w, 10, 9, 10)).toBe(-1);
    expect(bucketAt(99, w, 10, 9, 10)).toBe(-1);
  });

  it("never returns a bucket past the end of the envelope", () => {
    // Float division at the very last column must not index off the array.
    const cases: [number, number][] = [
      [10, 9],
      [56, 55.733],
      [13, 12.1],
      [30, 30],
    ];
    for (const [span, clip] of cases) {
      for (let x = 0; x < 200; x++) {
        const b = bucketAt(x, 200, span, clip, 900);
        expect(b).toBeLessThan(900);
        expect(b).toBeGreaterThanOrEqual(-1);
      }
    }
  });

  it("returns -1 for degenerate inputs rather than NaN", () => {
    // The strip renders before the decode finishes and while the bar is
    // still being laid out, so every one of these is reachable.
    expect(bucketAt(0, 0, 10, 10, 900)).toBe(-1);
    expect(bucketAt(0, 100, 0, 10, 900)).toBe(-1);
    expect(bucketAt(0, 100, 10, 0, 900)).toBe(-1);
    expect(bucketAt(0, 100, 10, 10, 0)).toBe(-1);
  });
});
