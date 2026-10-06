import { describe, expect, it } from "vitest";
import {
  MAX_SEGMENTS,
  MAX_SPEEDS,
  editMark,
  isSpeed,
  isValidSegments,
  isValidSpeeds,
  keepRanges,
  legsDuration,
  normalize,
  normalizeSpeeds,
  planLegs,
  speedGain,
  speedWindows,
  totalDuration,
} from "./segments.ts";
import type { Leg, Segment, Speed, SpeedRange } from "./segments.ts";

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

describe("editMark", () => {
  const part: Segment = { start: 100, end: 105 };

  it("moves the aimed bound and leaves the other one alone", () => {
    expect(editMark(part, "start", 102, D, false)).toEqual({ start: 102, end: 105 });
    expect(editMark(part, "end", 140, D, false)).toEqual({ start: 100, end: 140 });
  });

  // THE bug: `+ Part` defaults a new range to five seconds, so aiming Set
  // Start after rolling forward always overshoots that end. Refusing there
  // left the button dead and the following Set End then measured the part
  // from the `+ Part` playhead instead of from the aimed start.
  it("carries an un-aimed end when the start overshoots it", () => {
    expect(editMark(part, "start", 140, D, false)).toEqual({ start: 140, end: 145 });
  });

  it("keeps the part's own length when it carries the end", () => {
    expect(editMark({ start: 10, end: 40 }, "start", 200, D, false)).toEqual({
      start: 200,
      end: 230,
    });
  });

  it("clamps a carried end to the duration", () => {
    expect(editMark(part, "start", D - 2, D, false)).toEqual({ start: D - 2, end: D });
  });

  it("refuses rather than overwriting an end the user aimed", () => {
    expect(editMark(part, "start", 140, D, true)).toBeNull();
  });

  it("refuses a start with nowhere left to carry the end to", () => {
    expect(editMark(part, "start", D, D, false)).toBeNull();
  });

  // The half that must NOT change: `normalize` drops a segment whose end is
  // not after its start, so this would delete the part being edited.
  it("refuses an end at or before the part's start", () => {
    expect(editMark(part, "end", 100, D, false)).toBeNull();
    expect(editMark(part, "end", 90, D, false)).toBeNull();
  });

  it("does not carry anything when the end is aimed at", () => {
    expect(editMark(part, "end", 140, D, true)).toEqual({ start: 100, end: 140 });
  });
});

describe("planLegs", () => {
  it("is keepRanges with every leg at speed 1 when there are no speeds", () => {
    // The identity that keeps every cut test describing live behaviour.
    const cuts = [{ start: 12, end: 14 }, { start: 20, end: 21 }];
    expect(planLegs(10, 30, cuts, [])).toEqual(
      keepRanges(10, 30, cuts).map((k) => ({ ...k, speed: 1 })),
    );
  });

  it("splits a keep around a speed range inside it", () => {
    expect(planLegs(0, 10, [], [{ start: 2, end: 5, speed: 4 }])).toEqual([
      { start: 0, end: 2, speed: 1 },
      { start: 2, end: 5, speed: 4 },
      { start: 5, end: 10, speed: 1 },
    ]);
  });

  it("lets a cut win where it overlaps a speed range", () => {
    expect(planLegs(0, 10, [{ start: 3, end: 4 }], [{ start: 2, end: 6, speed: 2 }])).toEqual([
      { start: 0, end: 2, speed: 1 },
      { start: 2, end: 3, speed: 2 },
      { start: 4, end: 6, speed: 2 },
      { start: 6, end: 10, speed: 1 },
    ]);
  });

  it("drops a speed range a cut swallows whole", () => {
    // Review focus 1: no leg carries x8, so no x8 badge may be asked for.
    expect(planLegs(0, 10, [{ start: 2, end: 6 }], [{ start: 3, end: 5, speed: 8 }])).toEqual([
      { start: 0, end: 2, speed: 1 },
      { start: 6, end: 10, speed: 1 },
    ]);
  });

  it("joins touching speed ranges of equal speed into one leg", () => {
    expect(
      planLegs(0, 10, [], [
        { start: 2, end: 4, speed: 4 },
        { start: 4, end: 6, speed: 4 },
      ]),
    ).toEqual([
      { start: 0, end: 2, speed: 1 },
      { start: 2, end: 6, speed: 4 },
      { start: 6, end: 10, speed: 1 },
    ]);
  });

  it("keeps touching ranges of different speeds as separate legs", () => {
    expect(
      planLegs(0, 10, [], [
        { start: 2, end: 4, speed: 2 },
        { start: 4, end: 6, speed: 8 },
      ]),
    ).toEqual([
      { start: 0, end: 2, speed: 1 },
      { start: 2, end: 4, speed: 2 },
      { start: 4, end: 6, speed: 8 },
      { start: 6, end: 10, speed: 1 },
    ]);
  });

  it("clips a speed range that starts before the outer bounds", () => {
    expect(planLegs(2, 8, [], [{ start: 0, end: 4, speed: 4 }])).toEqual([
      { start: 2, end: 4, speed: 4 },
      { start: 4, end: 8, speed: 1 },
    ]);
  });
});

describe("normalizeSpeeds", () => {
  it("sorts and merges overlaps, keeping the earlier range's speed", () => {
    expect(
      normalizeSpeeds([
        { start: 4, end: 8, speed: 2 },
        { start: 1, end: 5, speed: 16 },
      ], 0, 100),
    ).toEqual([{ start: 1, end: 8, speed: 16 }]);
  });

  it("does not merge ranges that only touch", () => {
    expect(
      normalizeSpeeds([
        { start: 1, end: 2, speed: 2 },
        { start: 2, end: 3, speed: 4 },
      ], 0, 100),
    ).toEqual([
      { start: 1, end: 2, speed: 2 },
      { start: 2, end: 3, speed: 4 },
    ]);
  });

  it("drops empties and illegal speeds", () => {
    expect(
      normalizeSpeeds([
        { start: 1, end: 1, speed: 4 },
        { start: 2, end: 3, speed: 3 as Speed },
        { start: Number.NaN, end: 3, speed: 4 },
      ], 0, 100),
    ).toEqual([]);
  });

  it("clamps to the bounds it is given", () => {
    // Review focus 2: the outer handles moved inward past a range.
    expect(normalizeSpeeds([{ start: 0, end: 10, speed: 4 }], 2, 6)).toEqual([
      { start: 2, end: 6, speed: 4 },
    ]);
    expect(normalizeSpeeds([{ start: 0, end: 1, speed: 4 }], 2, 6)).toEqual([]);
  });
});

describe("isValidSpeeds", () => {
  it("accepts an empty list and whatever normalizeSpeeds emits", () => {
    expect(isValidSpeeds([], 0, 10)).toBe(true);
    const norm = normalizeSpeeds([
      { start: 6, end: 9, speed: 16 },
      { start: 1, end: 3, speed: 2 },
    ], 0, 10);
    expect(isValidSpeeds(norm, 0, 10)).toBe(true);
  });

  it("rejects everything illegal", () => {
    const ok = { start: 1, end: 2, speed: 4 };
    expect(isValidSpeeds(null, 0, 10)).toBe(false);
    expect(isValidSpeeds("x", 0, 10)).toBe(false);
    expect(isValidSpeeds([null], 0, 10)).toBe(false);
    expect(isValidSpeeds([[1, 2]], 0, 10)).toBe(false);
    expect(isValidSpeeds(Array.from({ length: MAX_SPEEDS + 1 }, (_, i) => ({ start: i, end: i + 0.5, speed: 2 })), 0, 10)).toBe(false);
    expect(isValidSpeeds([{ ...ok, speed: 3 }], 0, 10)).toBe(false);
    expect(isValidSpeeds([{ ...ok, start: -1 }], 0, 10)).toBe(false);
    expect(isValidSpeeds([{ ...ok, end: 11 }], 0, 10)).toBe(false);
    expect(isValidSpeeds([{ ...ok, end: 1 }], 0, 10)).toBe(false);
    expect(isValidSpeeds([{ ...ok, start: Number.NaN }], 0, 10)).toBe(false);
    expect(isValidSpeeds([{ start: 3, end: 4, speed: 2 }, ok], 0, 10)).toBe(false);
    expect(isValidSpeeds([{ start: 1, end: 3, speed: 2 }, { start: 2, end: 4, speed: 2 }], 0, 10)).toBe(false);
  });
});

describe("legsDuration", () => {
  it("divides each leg by its speed", () => {
    expect(legsDuration([{ start: 0, end: 2, speed: 1 }, { start: 2, end: 6, speed: 4 }])).toBe(3);
  });
});

describe("speedWindows", () => {
  it("places each sped leg in OUTPUT time", () => {
    expect(
      speedWindows([
        { start: 0, end: 2, speed: 1 },
        { start: 2, end: 6, speed: 4 },
        { start: 6, end: 7, speed: 1 },
        { start: 8, end: 10, speed: 2 },
      ]),
    ).toEqual([
      { at: 2, until: 3, speed: 4 },
      { at: 4, until: 5, speed: 2 },
    ]);
  });

  it("keeps touching legs of different speeds as two windows", () => {
    expect(
      speedWindows([
        { start: 2, end: 4, speed: 2 },
        { start: 4, end: 8, speed: 8 },
      ]),
    ).toEqual([
      { at: 0, until: 1, speed: 2 },
      { at: 1, until: 1.5, speed: 8 },
    ]);
  });
});

describe("speedGain", () => {
  it("keeps full sound at x1, x2 and x4", () => {
    for (const sp of [1, 2, 4]) expect(speedGain(sp)).toBe(1);
  });
  it("turns x8 and x16 down — fast speech is a warble, not words", () => {
    for (const sp of [8, 16]) {
      expect(speedGain(sp)).toBeGreaterThan(0);
      expect(speedGain(sp)).toBeLessThan(0.5);
    }
  });
});

