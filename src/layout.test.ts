import { describe, expect, it } from "vitest";
import { OUTPUT } from "./geometry.ts";
import type { Rect } from "./geometry.ts";
import {
  DEFAULT_LAYOUT,
  DEFAULT_LAYOUT_ID,
  LAYOUTS,
  cellsOf,
  layoutById,
  ratioOf,
} from "./layout.ts";

/** `layoutById` returns `Layout | null` on purpose — an unknown id from
 *  storage or the wire must be representable. Tests know their ids exist, so
 *  they throw rather than reach for `!`, which the project bans. */
function byId(id: string) {
  const layout = layoutById(id);
  if (!layout) throw new Error(`test asked for unknown layout ${id}`);
  return layout;
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

describe("LAYOUTS", () => {
  it("has nine presets with unique ids", () => {
    expect(LAYOUTS).toHaveLength(9);
    expect(new Set(LAYOUTS.map((l) => l.id)).size).toBe(9);
  });

  it("exposes the default as a real value and as a resolvable id", () => {
    expect(DEFAULT_LAYOUT.id).toBe(DEFAULT_LAYOUT_ID);
    expect(byId(DEFAULT_LAYOUT_ID)).toBe(DEFAULT_LAYOUT);
    // 1-1 is the regression fence for the whole feature: it must stay first
    // so a stored record with no layoutId migrates onto today's behaviour.
    expect(DEFAULT_LAYOUT_ID).toBe("1-1");
  });

  it("labels say stacked / side by side, never vertical / horizontal", () => {
    // "vertical" is ambiguous for a split — it can name the divider or the
    // arrangement. The ids abbreviate; the labels must not.
    for (const l of LAYOUTS) {
      expect(l.label.toLowerCase()).not.toMatch(/vertical|horizontal/);
    }
  });

  it("has rows that fill the output height at full width", () => {
    for (const l of LAYOUTS) {
      expect(l.rows.reduce((n, r) => n + r.h, 0)).toBe(OUTPUT.h);
      for (const r of l.rows) {
        expect(Number.isInteger(r.h)).toBe(true);
        expect(r.cols).toBeGreaterThanOrEqual(1);
        expect(OUTPUT.w % r.cols).toBe(0);
      }
    }
  });

  it("returns null for an unknown id instead of throwing", () => {
    expect(layoutById("nope")).toBeNull();
    expect(layoutById("")).toBeNull();
  });
});

describe("cellsOf", () => {
  it("tiles the output frame exactly for every preset", () => {
    for (const l of LAYOUTS) {
      const cells = cellsOf(l);
      expect(cells.length).toBeGreaterThanOrEqual(2);
      expect(cells.length).toBeLessThanOrEqual(4);

      let area = 0;
      for (const c of cells) {
        for (const k of ["x", "y", "w", "h"] as const) {
          expect(Number.isInteger(c[k])).toBe(true);
        }
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.x + c.w).toBeLessThanOrEqual(OUTPUT.w);
        expect(c.y + c.h).toBeLessThanOrEqual(OUTPUT.h);
        area += c.w * c.h;
      }
      // Area sum + zero pairwise overlap + in-bounds together mean an exact
      // tiling: no seam, no double-covered pixel.
      expect(area).toBe(OUTPUT.w * OUTPUT.h);
      for (let i = 0; i < cells.length; i++) {
        for (let j = i + 1; j < cells.length; j++) {
          const a = cells[i];
          const b = cells[j];
          if (!a || !b) throw new Error("cellsOf returned a hole");
          expect(overlapArea(a, b)).toBe(0);
        }
      }
    }
  });

  it("is row-major: row by row, left to right", () => {
    expect(cellsOf(byId("2h-1"))).toEqual([
      { x: 0, y: 0, w: 540, h: 960 },
      { x: 540, y: 0, w: 540, h: 960 },
      { x: 0, y: 960, w: 1080, h: 960 },
    ]);
    expect(cellsOf(byId("2v-1"))).toEqual([
      { x: 0, y: 0, w: 1080, h: 480 },
      { x: 0, y: 480, w: 1080, h: 480 },
      { x: 0, y: 960, w: 1080, h: 960 },
    ]);
    expect(cellsOf(byId("2h-2v"))).toEqual([
      { x: 0, y: 0, w: 540, h: 960 },
      { x: 540, y: 0, w: 540, h: 960 },
      { x: 0, y: 960, w: 1080, h: 480 },
      { x: 0, y: 1440, w: 1080, h: 480 },
    ]);
  });

  it("reproduces today's two 1080x960 halves for 1-1", () => {
    expect(cellsOf(DEFAULT_LAYOUT)).toEqual([
      { x: 0, y: 0, w: 1080, h: 960 },
      { x: 0, y: 960, w: 1080, h: 960 },
    ]);
  });

  it("only ever produces the three documented cell shapes", () => {
    const shapes = new Set(LAYOUTS.flatMap((l) => cellsOf(l)).map((c) => `${c.w}x${c.h}`));
    expect([...shapes].sort()).toEqual(["1080x480", "1080x960", "540x960"]);
  });

  it("produces only even cell dimensions, so yuv420p is satisfiable", () => {
    for (const l of LAYOUTS) {
      for (const c of cellsOf(l)) {
        expect(c.w % 2).toBe(0);
        expect(c.h % 2).toBe(0);
      }
    }
  });
});

describe("ratioOf", () => {
  it("gives the three cell ratios", () => {
    expect(ratioOf({ x: 0, y: 0, w: 1080, h: 960 })).toBeCloseTo(1.125);
    expect(ratioOf({ x: 0, y: 0, w: 540, h: 960 })).toBeCloseTo(0.5625);
    expect(ratioOf({ x: 0, y: 0, w: 1080, h: 480 })).toBeCloseTo(2.25);
  });
});
