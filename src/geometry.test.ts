import { describe, expect, it } from "vitest";
import {
  MIN_BOX_SIDE,
  boxFromHeight,
  clampToBounds,
  displayScale,
  fromDisplay,
  isValidBox,
  maxBox,
  moveBy,
  resizeFromCorner,
  toDisplay,
} from "./geometry.ts";
import type { Corner, Rect, Size } from "./geometry.ts";

const HD: Size = { w: 1920, h: 1080 };
const SD: Size = { w: 1280, h: 720 };
const SQUARE: Size = { w: 1000, h: 1000 };
const TALL: Size = { w: 720, h: 1280 };
const SOURCES = [HD, SD, SQUARE, TALL];
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

/** The only three cell shapes any layout produces: 1080x960 (9:8),
 *  540x960 (9:16) and 1080x480 (9:4). Asserted exhaustive by
 *  layout.test.ts, so parametrising on them here covers every real case. */
const RATIOS = [1.125, 0.5625, 2.25];

describe("maxBox", () => {
  it("locks the ratio exactly and fits inside every source, every ratio", () => {
    for (const ratio of RATIOS) {
      for (const s of SOURCES) {
        const b = maxBox(s, ratio);
        expect(b.w).toBe(Math.round(b.h * ratio));
        expect(b.w).toBeLessThanOrEqual(s.w);
        expect(b.h).toBeLessThanOrEqual(s.h);
      }
    }
  });

  it("fills the limiting dimension of a 16:9 source at 9:8", () => {
    // 1080 * 9/8 = 1215, which fits in 1920 — so height is the limit.
    expect(maxBox(HD, 1.125)).toEqual({ w: 1215, h: 1080 });
    expect(maxBox(SD, 1.125)).toEqual({ w: 810, h: 720 });
  });

  it("is limited by width on a square or tall source at 9:8", () => {
    // 1000 / 1.125 = 888.89 -> 888
    expect(maxBox(SQUARE, 1.125)).toEqual({ w: 999, h: 888 });
    // 720 / 1.125 = 640 exactly
    expect(maxBox(TALL, 1.125)).toEqual({ w: 720, h: 640 });
  });

  it("is height-limited for a tall cell and width-limited for a wide one", () => {
    // 9:16 in 16:9: the source's full height fits, width is what's spare.
    expect(maxBox(HD, 0.5625)).toEqual({ w: 608, h: 1080 });
    // 9:4 in 16:9: 1920 / 2.25 = 853.33 -> 853, so width is the limit.
    expect(maxBox(HD, 2.25)).toEqual({ w: 1919, h: 853 });
  });
});

describe("boxFromHeight", () => {
  it("locks aspect exactly, every ratio", () => {
    for (const ratio of RATIOS) {
      for (const s of SOURCES) {
        for (const h of [MIN_BOX_SIDE, 200, 501, 888, 10_000]) {
          const b = boxFromHeight(h, s, ratio);
          expect(b.w).toBe(Math.round(b.h * ratio));
        }
      }
    }
  });

  it("clamps to maxBox above", () => {
    for (const ratio of RATIOS) {
      expect(boxFromHeight(99_999, HD, ratio)).toEqual(maxBox(HD, ratio));
    }
  });

  it("is idempotent — re-snapping never shrinks the box, every ratio", () => {
    // The whole reason size is height-driven: a width-driven round trip
    // loses a pixel per call, so a box re-snapped on every drag frame
    // would visibly shrink.
    for (const ratio of RATIOS) {
      for (const s of SOURCES) {
        let b = boxFromHeight(500, s, ratio);
        for (let i = 0; i < 20; i++) {
          const next = boxFromHeight(b.h, s, ratio);
          expect(next).toEqual(b);
          b = next;
        }
      }
    }
  });

  it("returns integers", () => {
    for (const ratio of RATIOS) {
      const b = boxFromHeight(501, HD, ratio);
      expect(Number.isInteger(b.w)).toBe(true);
      expect(Number.isInteger(b.h)).toBe(true);
    }
  });
});

describe("clampToBounds", () => {
  it("slides an out-of-bounds rect back in without resizing it", () => {
    for (const ratio of RATIOS) {
      const size = boxFromHeight(400, HD, ratio);
      const cases: [number, number][] = [[-500, -500], [9999, 9999], [-1, 500], [1900, -3]];
      for (const [x, y] of cases) {
        const r = clampToBounds({ x, y, ...size }, HD);
        expect(r.w).toBe(size.w); // never shrinks — shrinking breaks the lock
        expect(r.h).toBe(size.h);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(HD.w);
        expect(r.y + r.h).toBeLessThanOrEqual(HD.h);
      }
    }
  });

  it("pins a max-size box at every edge without violating bounds", () => {
    for (const ratio of RATIOS) {
      const size = maxBox(HD, ratio);
      const r = clampToBounds({ x: -9999, y: -9999, ...size }, HD);
      expect(r).toEqual({ x: 0, y: 0, ...size });
    }
  });
});

describe("moveBy", () => {
  it("keeps the box valid for arbitrary drags, every ratio", () => {
    for (const ratio of RATIOS) {
      let r = { x: 100, y: 100, ...boxFromHeight(400, HD, ratio) };
      const drags: [number, number][] = [[50, 50], [-9999, 0], [0, 9999], [777, -333]];
      for (const [dx, dy] of drags) {
        r = moveBy(r, dx, dy, HD);
        expect(isValidBox(r, HD, ratio)).toBe(true);
      }
    }
  });
});

describe("resizeFromCorner", () => {
  it("keeps the opposite corner fixed while growing", () => {
    const start = { x: 400, y: 300, ...boxFromHeight(400, HD, 1.125) };
    // Dragging "se" outward must leave the nw corner where it was.
    const grown = resizeFromCorner(start, "se", 200, 200, HD, 1.125);
    expect(grown.x).toBe(start.x);
    expect(grown.y).toBe(start.y);
    expect(grown.h).toBeGreaterThan(start.h);
  });

  it("keeps the se corner fixed when dragging nw", () => {
    const start = { x: 400, y: 300, ...boxFromHeight(400, HD, 1.125) };
    const grown = resizeFromCorner(start, "nw", -100, -100, HD, 1.125);
    expect(grown.x + grown.w).toBe(start.x + start.w);
    expect(grown.y + grown.h).toBe(start.y + start.h);
  });

  it("produces a valid box from every corner, source, ratio, huge drags", () => {
    for (const ratio of RATIOS) {
      for (const s of SOURCES) {
        for (const c of CORNERS) {
          const start = { x: 10, y: 10, ...boxFromHeight(300, s, ratio) };
          for (const d of [-9999, -50, 0, 50, 9999]) {
            expect(isValidBox(resizeFromCorner(start, c, d, d, s, ratio), s, ratio)).toBe(true);
            expect(isValidBox(resizeFromCorner(start, c, d, -d, s, ratio), s, ratio)).toBe(true);
          }
        }
      }
    }
  });

  it("never shrinks below the effective floor", () => {
    const start = { x: 500, y: 400, ...boxFromHeight(300, HD, 1.125) };
    expect(resizeFromCorner(start, "se", -9999, -9999, HD, 1.125).h).toBe(MIN_BOX_SIDE);
  });
});

describe("display conversion", () => {
  it("round-trips within a pixel", () => {
    const scale = displayScale(HD, 960);
    expect(scale).toBeCloseTo(0.5);
    const r = { x: 400, y: 300, ...boxFromHeight(600, HD, 1.125) };
    const back = fromDisplay(toDisplay(r, scale), scale);
    for (const k of ["x", "y", "w", "h"] as const) {
      expect(Math.abs(back[k] - r[k])).toBeLessThanOrEqual(1);
    }
  });
});

describe("isValidBox", () => {
  it("rejects a non-integer rect", () => {
    expect(isValidBox({ x: 0.5, y: 0, w: 1215, h: 1080 }, HD, 1.125)).toBe(false);
  });

  it("rejects a rect off the aspect lock", () => {
    expect(isValidBox({ x: 0, y: 0, w: 1200, h: 1080 }, HD, 1.125)).toBe(false);
  });

  it("rejects a 9:8 rect measured against a 9:16 cell, and vice versa", () => {
    // The new silent-failure mode this feature introduces: a legal box for
    // the wrong cell. A 1215x1080 box is perfect 9:8 and perfectly in
    // bounds, and would preview and export as a stretched cell if the
    // validator ignored which cell it belongs to.
    const nineEight = { x: 0, y: 0, w: 1215, h: 1080 };
    expect(isValidBox(nineEight, HD, 1.125)).toBe(true);
    expect(isValidBox(nineEight, HD, 0.5625)).toBe(false);
    expect(isValidBox(nineEight, HD, 2.25)).toBe(false);
  });

  it("rejects a rect hanging over an edge", () => {
    expect(isValidBox({ x: 800, y: 0, w: 1215, h: 1080 }, HD, 1.125)).toBe(false);
  });

  it("rejects a rect below the effective floor", () => {
    const h = MIN_BOX_SIDE - 1;
    expect(isValidBox({ x: 0, y: 0, w: Math.round(h * 1.125), h }, HD, 1.125)).toBe(false);
  });

  it("rejects a missing rect instead of throwing", () => {
    const missing = undefined as unknown as Rect;
    expect(() => isValidBox(missing, HD, 1.125)).not.toThrow();
    expect(isValidBox(missing, HD, 1.125)).toBe(false);
    const nulled = null as unknown as Rect;
    expect(isValidBox(nulled, HD, 1.125)).toBe(false);
  });
});

describe("sources too small for MIN_BOX_SIDE", () => {
  it("still produces boxes isValidBox accepts, every ratio", () => {
    const tiny: Size[] = [
      { w: 100, h: 100 },
      { w: 64, h: 64 },
      { w: 320, h: 40 },
      { w: 40, h: 320 },
    ];
    for (const ratio of RATIOS) {
      for (const s of tiny) {
        // Asking for an impossibly small box must still yield a legal one.
        expect(isValidBox({ x: 0, y: 0, ...boxFromHeight(1, s, ratio) }, s, ratio)).toBe(true);
        expect(isValidBox({ x: 0, y: 0, ...maxBox(s, ratio) }, s, ratio)).toBe(true);
      }
    }
  });
});

describe("effectiveMinH via boxFromHeight — the fractional floor", () => {
  it("produces a box isValidBox accepts at the smallest size, every ratio", () => {
    // The trap: the min-side floor is MIN_BOX_SIDE / ratio, which is
    // FRACTIONAL for a tall cell -- 142 / 0.5625 = 252.444. boxFromHeight
    // rounds its clamped height, so a floor left fractional yields h = 252
    // while isValidBox compares against 252.444 and rejects it: the
    // validator refuses its own constructor's output. The floor has to be
    // an integer, and it has to be the same integer on both sides.
    // Verified: with a fractional floor this assertion fails at r = 0.5625
    // and passes at 1.125 and 2.25, which is exactly the kind of
    // one-ratio-only breakage that would slip through a 9:8-shaped test.
    for (const ratio of RATIOS) {
      for (const s of SOURCES) {
        const smallest = { x: 0, y: 0, ...boxFromHeight(1, s, ratio) };
        expect(isValidBox(smallest, s, ratio)).toBe(true);
      }
    }
  });

  it("leaves the 9:8 floor at exactly MIN_BOX_SIDE", () => {
    // max(142, 142 / 1.125) = max(142, 126.2) = 142. Today's behaviour must
    // not move by a pixel.
    expect(boxFromHeight(1, HD, 1.125).h).toBe(MIN_BOX_SIDE);
  });

  it("raises the floor for a tall cell so the box stays grabbable", () => {
    // Height-only, a 9:16 box would floor at 142x80 -- too narrow to hit
    // its own corner handles.
    const b = boxFromHeight(1, HD, 0.5625);
    expect(b.h).toBe(253);
    expect(b.w).toBe(142);
  });

  it("keeps the floor at MIN_BOX_SIDE for a wide cell", () => {
    // max(142, 142 / 2.25) = max(142, 63.1) = 142.
    const b = boxFromHeight(1, HD, 2.25);
    expect(b.h).toBe(MIN_BOX_SIDE);
    expect(b.w).toBe(320);
  });
});
