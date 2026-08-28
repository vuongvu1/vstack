import { describe, expect, it } from "vitest";
import { peaks } from "./waveform.ts";

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
