import { describe, expect, it } from "vitest";
import {
  BOX_RATIO,
  MIN_BOX_H,
  boxFromHeight,
  clampToBounds,
  defaultBoxes,
  displayScale,
  fromDisplay,
  isValidBox,
  maxBox,
  moveBy,
  resizeFromCorner,
  toDisplay,
} from "./geometry.ts";
import type { Corner, Size } from "./geometry.ts";

const HD: Size = { w: 1920, h: 1080 };
const SD: Size = { w: 1280, h: 720 };
const SQUARE: Size = { w: 1000, h: 1000 };
const TALL: Size = { w: 720, h: 1280 };
const SOURCES = [HD, SD, SQUARE, TALL];
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

describe("maxBox", () => {
  it("is exact 9:8 and fits inside every source", () => {
    for (const s of SOURCES) {
      const b = maxBox(s);
      expect(b.w).toBe(Math.round(b.h * BOX_RATIO));
      expect(b.w).toBeLessThanOrEqual(s.w);
      expect(b.h).toBeLessThanOrEqual(s.h);
    }
  });

  it("fills the limiting dimension of a 16:9 source", () => {
    // 1080 * 9/8 = 1215, which fits in 1920 — so height is the limit.
    expect(maxBox(HD)).toEqual({ w: 1215, h: 1080 });
    expect(maxBox(SD)).toEqual({ w: 810, h: 720 });
  });

  it("is limited by width on a square or tall source", () => {
    // 1000 / 1.125 = 888.89 -> 888
    expect(maxBox(SQUARE)).toEqual({ w: 999, h: 888 });
    // 720 / 1.125 = 640 exactly
    expect(maxBox(TALL)).toEqual({ w: 720, h: 640 });
  });
});

describe("boxFromHeight", () => {
  it("locks aspect exactly", () => {
    for (const s of SOURCES) {
      for (const h of [MIN_BOX_H, 200, 501, 888, 10_000]) {
        const b = boxFromHeight(h, s);
        expect(b.w).toBe(Math.round(b.h * BOX_RATIO));
      }
    }
  });

  it("clamps to MIN_BOX_H below and maxBox above", () => {
    expect(boxFromHeight(1, HD).h).toBe(MIN_BOX_H);
    expect(boxFromHeight(99_999, HD)).toEqual(maxBox(HD));
  });

  it("is idempotent — re-snapping never shrinks the box", () => {
    // The whole reason size is height-driven: a width-driven round trip
    // loses a pixel per call, so a box re-snapped on every drag frame
    // would visibly shrink.
    for (const s of SOURCES) {
      let b = boxFromHeight(700, s);
      for (let i = 0; i < 20; i++) {
        const next = boxFromHeight(b.h, s);
        expect(next).toEqual(b);
        b = next;
      }
    }
  });

  it("returns integers", () => {
    const b = boxFromHeight(501, HD);
    expect(Number.isInteger(b.w)).toBe(true);
    expect(Number.isInteger(b.h)).toBe(true);
  });
});

describe("clampToBounds", () => {
  it("slides an out-of-bounds rect back in without resizing it", () => {
    const size = boxFromHeight(600, HD);
    const cases: [number, number][] = [[-500, -500], [9999, 9999], [-1, 500], [1900, -3]];
    for (const [x, y] of cases) {
      const r = clampToBounds({ x, y, ...size }, HD);
      expect(r.w).toBe(size.w);   // never shrinks — shrinking breaks 9:8
      expect(r.h).toBe(size.h);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(HD.w);
      expect(r.y + r.h).toBeLessThanOrEqual(HD.h);
    }
  });

  it("pins a max-size box at every edge without violating bounds", () => {
    const size = maxBox(HD);
    const r = clampToBounds({ x: -9999, y: -9999, ...size }, HD);
    expect(r).toEqual({ x: 0, y: 0, ...size });
  });
});

describe("moveBy", () => {
  it("keeps the box valid for arbitrary drags", () => {
    let r = { x: 100, y: 100, ...boxFromHeight(500, HD) };
    const drags: [number, number][] = [[50, 50], [-9999, 0], [0, 9999], [777, -333]];
    for (const [dx, dy] of drags) {
      r = moveBy(r, dx, dy, HD);
      expect(isValidBox(r, HD)).toBe(true);
    }
  });
});

describe("resizeFromCorner", () => {
  it("keeps the opposite corner fixed while growing", () => {
    const start = { x: 400, y: 300, ...boxFromHeight(400, HD) };
    // Dragging "se" outward must leave the nw corner where it was.
    const grown = resizeFromCorner(start, "se", 200, 200, HD);
    expect(grown.x).toBe(start.x);
    expect(grown.y).toBe(start.y);
    expect(grown.h).toBeGreaterThan(start.h);
  });

  it("keeps the se corner fixed when dragging nw", () => {
    const start = { x: 400, y: 300, ...boxFromHeight(400, HD) };
    const grown = resizeFromCorner(start, "nw", -100, -100, HD);
    expect(grown.x + grown.w).toBe(start.x + start.w);
    expect(grown.y + grown.h).toBe(start.y + start.h);
  });

  it("produces a valid box from every corner, every source, huge drags", () => {
    for (const s of SOURCES) {
      for (const c of CORNERS) {
        const start = { x: 10, y: 10, ...boxFromHeight(300, s) };
        for (const d of [-9999, -50, 0, 50, 9999]) {
          expect(isValidBox(resizeFromCorner(start, c, d, d, s), s)).toBe(true);
          expect(isValidBox(resizeFromCorner(start, c, d, -d, s), s)).toBe(true);
        }
      }
    }
  });

  it("never shrinks below MIN_BOX_H", () => {
    const start = { x: 500, y: 400, ...boxFromHeight(300, HD) };
    expect(resizeFromCorner(start, "se", -9999, -9999, HD).h).toBe(MIN_BOX_H);
  });
});

describe("defaultBoxes", () => {
  it("gives two max-size boxes, top-left and bottom-right, both valid", () => {
    for (const s of SOURCES) {
      const { top, bottom } = defaultBoxes(s);
      expect(isValidBox(top, s)).toBe(true);
      expect(isValidBox(bottom, s)).toBe(true);
      expect(top).toMatchObject(maxBox(s));
      expect(bottom).toMatchObject(maxBox(s));
      expect(top.x).toBe(0);
      expect(bottom.x + bottom.w).toBe(s.w);
    }
  });
});

describe("display conversion", () => {
  it("round-trips within a pixel", () => {
    const scale = displayScale(HD, 960);
    expect(scale).toBeCloseTo(0.5);
    const r = { x: 400, y: 300, ...boxFromHeight(600, HD) };
    const back = fromDisplay(toDisplay(r, scale), scale);
    for (const k of ["x", "y", "w", "h"] as const) {
      expect(Math.abs(back[k] - r[k])).toBeLessThanOrEqual(1);
    }
  });
});

describe("isValidBox", () => {
  it("rejects a non-integer rect", () => {
    expect(isValidBox({ x: 0.5, y: 0, w: 1215, h: 1080 }, HD)).toBe(false);
  });

  it("rejects a rect off the 9:8 lock", () => {
    expect(isValidBox({ x: 0, y: 0, w: 1200, h: 1080 }, HD)).toBe(false);
  });

  it("rejects a rect hanging over an edge", () => {
    expect(isValidBox({ x: 800, y: 0, w: 1215, h: 1080 }, HD)).toBe(false);
  });

  it("rejects a rect below MIN_BOX_H", () => {
    const h = MIN_BOX_H - 1;
    expect(isValidBox({ x: 0, y: 0, w: Math.round(h * BOX_RATIO), h }, HD)).toBe(false);
  });

  it("accepts what the constructors produce", () => {
    for (const s of SOURCES) {
      const { top, bottom } = defaultBoxes(s);
      expect(isValidBox(top, s)).toBe(true);
      expect(isValidBox(bottom, s)).toBe(true);
    }
  });
});
