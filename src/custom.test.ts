import { describe, expect, it } from "vitest";
import { OUTPUT, isValidBox } from "./geometry.ts";
import type { Corner, Rect, Size } from "./geometry.ts";
import {
  MAX_CUSTOM,
  MIN_OUT_SIDE,
  clampOut,
  defaultCustom,
  isValidCustom,
  isValidOut,
  moveOut,
  outRatio,
  resizeOut,
  resnapCrop,
} from "./custom.ts";

const HD: Size = { w: 1920, h: 1080 };
const SD: Size = { w: 1280, h: 720 };
const TALL: Size = { w: 720, h: 1280 };
const SOURCES = [HD, SD, TALL];
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
const OUT: Rect = { x: 300, y: 700, w: 480, h: 480 };

function assertLegalOut(r: Rect): void {
  expect([r.x, r.y, r.w, r.h].every(Number.isInteger)).toBe(true);
  expect([r.x, r.y, r.w, r.h].every((n) => n % 2 === 0)).toBe(true);
  expect(r.w).toBeGreaterThanOrEqual(MIN_OUT_SIDE);
  expect(r.h).toBeGreaterThanOrEqual(MIN_OUT_SIDE);
  expect(r.x).toBeGreaterThanOrEqual(0);
  expect(r.y).toBeGreaterThanOrEqual(0);
  expect(r.x + r.w).toBeLessThanOrEqual(OUTPUT.w);
  expect(r.y + r.h).toBeLessThanOrEqual(OUTPUT.h);
}

describe("MAX_CUSTOM / MIN_OUT_SIDE", () => {
  it("keeps the floor even, so clamping to it cannot break evenness", () => {
    // Every out field is even because an overlay at an odd offset in
    // yuv420p lands on a half-chroma-sample boundary. An odd floor would
    // make the smallest legal box unreachable by the even-snapping helpers.
    expect(MIN_OUT_SIDE % 2).toBe(0);
    expect(MAX_CUSTOM).toBeGreaterThan(0);
  });
});

describe("clampOut", () => {
  it("returns a legal rect for anything, including fractional input", () => {
    const inputs: Rect[] = [
      { x: 10.4, y: 20.7, w: 481.3, h: 300.9 },
      { x: -500, y: -500, w: 5000, h: 5000 },
      { x: 1079, y: 1919, w: 2, h: 2 },
      OUT,
    ];
    for (const r of inputs) assertLegalOut(clampOut(r));
  });

  it("is idempotent, so re-snapping every drag frame cannot drift", () => {
    const once = clampOut({ x: 101, y: 203, w: 305, h: 407 });
    expect(clampOut(once)).toEqual(once);
  });
});

describe("moveOut", () => {
  it("slides without resizing", () => {
    const moved = moveOut(OUT, -1000, 5000);
    expect(moved.w).toBe(OUT.w);
    expect(moved.h).toBe(OUT.h);
    assertLegalOut(moved);
    expect(moved.x).toBe(0);
    expect(moved.y).toBe(OUTPUT.h - OUT.h);
  });
});

describe("resizeOut", () => {
  it("keeps the opposite corner anchored", () => {
    const se = resizeOut(OUT, "se", 100, 40);
    expect(se.x).toBe(OUT.x);
    expect(se.y).toBe(OUT.y);
    const nw = resizeOut(OUT, "nw", -100, -40);
    expect(nw.x + nw.w).toBe(OUT.x + OUT.w);
    expect(nw.y + nw.h).toBe(OUT.y + OUT.h);
  });

  it("changes the ratio freely — that is the whole point of a custom box", () => {
    const wide = resizeOut(OUT, "se", 400, -200);
    expect(outRatio(wide)).toBeGreaterThan(outRatio(OUT));
    assertLegalOut(wide);
  });

  it("floors each side and never leaves the frame, from every corner", () => {
    for (const corner of CORNERS) {
      const collapsed = resizeOut(OUT, corner, -5000, -5000);
      assertLegalOut(collapsed);
      const blown = resizeOut(OUT, corner, 5000, 5000);
      assertLegalOut(blown);
    }
  });
});

describe("resnapCrop", () => {
  it("rebuilds the width for the new ratio and keeps the aspect exact", () => {
    const crop: Rect = { x: 400, y: 200, w: 600, h: 600 };
    const wider: Rect = { x: 300, y: 700, w: 960, h: 480 };
    const next = resnapCrop(crop, HD, wider);
    expect(next.w).toBe(Math.round(next.h * outRatio(wider)));
    expect(isValidBox(next, HD, outRatio(wider))).toBe(true);
  });

  it("is idempotent, so a per-frame re-snap does not shrink the crop", () => {
    const crop: Rect = { x: 400, y: 200, w: 600, h: 600 };
    const once = resnapCrop(crop, HD, OUT);
    expect(resnapCrop(once, HD, OUT)).toEqual(once);
  });

  it("survives an extreme ratio on every source", () => {
    // boxFromHeight already clamps between effectiveMinH and maxBox, so a
    // very wide out yields a shorter crop rather than an invalid one.
    const strip: Rect = { x: 0, y: 0, w: 1080, h: 160 };
    for (const source of SOURCES) {
      const crop = resnapCrop({ x: 0, y: 0, w: 200, h: 200 }, source, strip);
      expect(isValidBox(crop, source, outRatio(strip))).toBe(true);
    }
  });
});

describe("isValidOut", () => {
  it("accepts what clampOut emits and rejects everything illegal", () => {
    expect(isValidOut(clampOut(OUT))).toBe(true);
    expect(isValidOut({ ...OUT, x: 301 })).toBe(false); // odd
    expect(isValidOut({ ...OUT, w: 100 })).toBe(false); // under the floor
    expect(isValidOut({ ...OUT, x: 900 })).toBe(false); // off the frame
    expect(isValidOut({ ...OUT, h: Number.NaN })).toBe(false);
    expect(isValidOut(null)).toBe(false);
    expect(isValidOut("nope")).toBe(false);
  });
});

describe("isValidCustom", () => {
  it("accepts defaultCustom for every source and index", () => {
    for (const source of SOURCES) {
      for (let i = 0; i < MAX_CUSTOM; i++) {
        expect(isValidCustom(defaultCustom(source, i), source)).toBe(true);
      }
    }
  });

  it("rejects a crop that is off the box's own ratio", () => {
    // The custom-box version of "a box is only legal for its own cell": a
    // perfect square crop under a 2:1 out would export stretched.
    const custom = defaultCustom(HD, 0);
    const stretched = { out: { ...custom.out, w: custom.out.w * 2 }, crop: custom.crop };
    expect(isValidCustom(stretched, HD)).toBe(false);
  });

  it("rejects a crop hanging over the source edge", () => {
    const custom = defaultCustom(HD, 0);
    expect(isValidCustom({ ...custom, crop: { ...custom.crop, x: 1900 } }, HD)).toBe(false);
  });

  it("rejects non-objects without throwing", () => {
    expect(isValidCustom(null, HD)).toBe(false);
    expect(isValidCustom([], HD)).toBe(false);
    expect(isValidCustom({ out: null, crop: null }, HD)).toBe(false);
  });
});

describe("defaultCustom", () => {
  it("offsets the second box so its handles are not buried", () => {
    const first = defaultCustom(HD, 0);
    const second = defaultCustom(HD, 1);
    expect(second.out.x).not.toBe(first.out.x);
    expect(second.out.y).not.toBe(first.out.y);
  });
});
