import { describe, expect, it } from "vitest";
import { MAX_SEGMENTS, isValidSegments, keepRanges, normalize, totalDuration } from "./segments.ts";
import type { Segment } from "./segments.ts";

const D = 600;

describe("normalize", () => {
  it("sorts by start", () => {
    expect(normalize([{ start: 40, end: 50 }, { start: 10, end: 20 }], D)).toEqual([
      { start: 10, end: 20 },
      { start: 40, end: 50 },
    ]);
  });

  it("clamps to [0, duration]", () => {
    expect(normalize([{ start: -5, end: 700 }], D)).toEqual([{ start: 0, end: D }]);
  });

  it("drops a segment whose end is not after its start", () => {
    expect(normalize([{ start: 10, end: 10 }, { start: 20, end: 30 }], D)).toEqual([
      { start: 20, end: 30 },
    ]);
  });

  it("merges overlapping segments", () => {
    expect(normalize([{ start: 10, end: 30 }, { start: 20, end: 40 }], D)).toEqual([
      { start: 10, end: 40 },
    ]);
  });

  it("merges a segment fully contained in another", () => {
    expect(normalize([{ start: 10, end: 60 }, { start: 20, end: 30 }], D)).toEqual([
      { start: 10, end: 60 },
    ]);
  });

  it("leaves touching-but-not-overlapping segments alone", () => {
    // Adjacent ends are a legal two-part cut: the user may have marked the
    // same instant twice on purpose, and merging them would silently drop a
    // chip from the strip.
    expect(normalize([{ start: 10, end: 20 }, { start: 20, end: 30 }], D)).toEqual([
      { start: 10, end: 20 },
      { start: 20, end: 30 },
    ]);
  });

  it("drops non-finite bounds", () => {
    expect(normalize([{ start: Number.NaN, end: 10 }, { start: 1, end: 2 }], D)).toEqual([
      { start: 1, end: 2 },
    ]);
  });

  it("is idempotent", () => {
    const messy: Segment[] = [
      { start: 40, end: 50 },
      { start: 10, end: 30 },
      { start: 20, end: 25 },
      { start: 5, end: 5 },
    ];
    const once = normalize(messy, D);
    expect(normalize(once, D)).toEqual(once);
  });
});

describe("totalDuration", () => {
  it("sums the parts", () => {
    expect(totalDuration([{ start: 10, end: 30 }, { start: 40, end: 45 }])).toBe(25);
  });

  it("is 0 for an empty list", () => {
    expect(totalDuration([])).toBe(0);
  });
});

describe("isValidSegments", () => {
  it("accepts everything normalize emits", () => {
    const cases: Segment[][] = [
      [{ start: 0, end: D }],
      [{ start: 10, end: 20 }],
      [{ start: 10, end: 20 }, { start: 40, end: 50 }],
      [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }],
    ];
    for (const segs of cases) {
      expect(isValidSegments(normalize(segs, D), D)).toBe(true);
    }
  });

  it("rejects an empty list", () => {
    expect(isValidSegments([], D)).toBe(false);
  });

  it("rejects more than MAX_SEGMENTS", () => {
    const many = Array.from({ length: MAX_SEGMENTS + 1 }, (_v, i) => ({
      start: i * 10,
      end: i * 10 + 5,
    }));
    expect(isValidSegments(many.slice(0, MAX_SEGMENTS), D)).toBe(true);
    expect(isValidSegments(many, D)).toBe(false);
  });

  it("rejects an unsorted list", () => {
    expect(isValidSegments([{ start: 40, end: 50 }, { start: 10, end: 20 }], D)).toBe(false);
  });

  it("rejects overlapping segments", () => {
    expect(isValidSegments([{ start: 10, end: 30 }, { start: 20, end: 40 }], D)).toBe(false);
  });

  it("rejects end <= start", () => {
    expect(isValidSegments([{ start: 10, end: 10 }], D)).toBe(false);
    expect(isValidSegments([{ start: 10, end: 9 }], D)).toBe(false);
  });

  it("rejects bounds outside [0, duration]", () => {
    expect(isValidSegments([{ start: -1, end: 10 }], D)).toBe(false);
    expect(isValidSegments([{ start: 10, end: D + 1 }], D)).toBe(false);
  });

  it("rejects non-finite bounds", () => {
    expect(isValidSegments([{ start: 0, end: Number.POSITIVE_INFINITY }], D)).toBe(false);
    expect(isValidSegments([{ start: Number.NaN, end: 10 }], D)).toBe(false);
  });

  it("rejects non-arrays and non-objects — it reads untrusted input", () => {
    expect(isValidSegments(null, D)).toBe(false);
    expect(isValidSegments(undefined, D)).toBe(false);
    expect(isValidSegments("[]", D)).toBe(false);
    expect(isValidSegments({ start: 0, end: 10 }, D)).toBe(false);
    expect(isValidSegments([null], D)).toBe(false);
    expect(isValidSegments([{ start: "0", end: "10" }], D)).toBe(false);
  });
});

describe("keepRanges", () => {
  it("returns the whole range when there are no cuts", () => {
    expect(keepRanges(10, 40, [])).toEqual([{ start: 10, end: 40 }]);
  });

  it("punches a hole in the middle", () => {
    expect(keepRanges(0, 30, [{ start: 10, end: 20 }])).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]);
  });

  it("shaves an end when a cut is flush with it", () => {
    expect(keepRanges(0, 30, [{ start: 0, end: 10 }])).toEqual([{ start: 10, end: 30 }]);
    expect(keepRanges(0, 30, [{ start: 20, end: 30 }])).toEqual([{ start: 0, end: 20 }]);
  });

  it("clips a cut that overhangs either bound", () => {
    expect(keepRanges(10, 30, [{ start: 0, end: 15 }])).toEqual([{ start: 15, end: 30 }]);
    expect(keepRanges(10, 30, [{ start: 25, end: 99 }])).toEqual([{ start: 10, end: 25 }]);
  });

  it("returns nothing when a cut covers the range", () => {
    expect(keepRanges(10, 30, [{ start: 0, end: 40 }])).toEqual([]);
    expect(keepRanges(10, 30, [{ start: 10, end: 30 }])).toEqual([]);
  });

  it("ignores cuts wholly outside the range", () => {
    expect(keepRanges(10, 30, [{ start: 0, end: 5 }, { start: 40, end: 50 }])).toEqual([
      { start: 10, end: 30 },
    ]);
    // Touching a bound is outside, not a zero-length keep.
    expect(keepRanges(10, 30, [{ start: 30, end: 40 }])).toEqual([{ start: 10, end: 30 }]);
  });

  it("handles several cuts", () => {
    expect(
      keepRanges(0, 60, [
        { start: 10, end: 15 },
        { start: 20, end: 25 },
        { start: 50, end: 55 },
      ]),
    ).toEqual([
      { start: 0, end: 10 },
      { start: 15, end: 20 },
      { start: 25, end: 50 },
      { start: 55, end: 60 },
    ]);
  });

  it("agrees with totalDuration on what is left", () => {
    const cuts = [
      { start: 10, end: 15 },
      { start: 20, end: 25 },
    ];
    expect(totalDuration(keepRanges(0, 60, cuts))).toBe(50);
  });

  it("drops a keep too short to survive a cut against its neighbour", () => {
    // Back-to-back cuts leave no gap, not a zero-length range.
    expect(
      keepRanges(0, 30, [
        { start: 10, end: 20 },
        { start: 20, end: 25 },
      ]),
    ).toEqual([
      { start: 0, end: 10 },
      { start: 25, end: 30 },
    ]);
  });
});
