import { describe, expect, it } from "vitest";
import { OUTPUT, isValidBox, maxBox } from "./geometry.ts";
import type { Rect, Size } from "./geometry.ts";
import {
  DEFAULT_LAYOUT,
  DEFAULT_LAYOUT_ID,
  LAYOUTS,
  cellsOf,
  defaultBoxes,
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

describe("defaultBoxes", () => {
  const SOURCES: Size[] = [
    { w: 1920, h: 1080 },
    { w: 1280, h: 720 },
    { w: 1000, h: 1000 },
    { w: 720, h: 1280 },
    { w: 100, h: 100 },
  ];

  it("reproduces today's exact left/right pin for 1-1, on a widescreen source", () => {
    // The regression fence. Before layouts existed, defaultBoxes put both
    // halves at max size, top pinned left and bottom pinned right, both
    // vertically centred — one drag from the facecam case.
    //
    // Scoped to sources at least as wide as the cell's own 9:8 ratio,
    // matching defaultBoxes' own doc comment ("For 1-1 on a 16:9 source").
    // For those, the 9:8 box is *height*-limited, so all the slack sits on
    // x and the ratio group spreads there — bit-identical to the old
    // formula. A source narrower than 9:8 (square, portrait) flips which
    // axis has more slack, and defaultBoxes deliberately follows it there
    // too (see its doc comment): correct for the general multi-cell
    // feature this task exists to enable, but not a pixel-for-pixel match
    // with the old two-box formula. SQUARE/TALL/tiny are still exercised,
    // just by the shape-agnostic checks below (valid, max-size,
    // non-coincident), not by a literal position match.
    const widescreen = SOURCES.filter((s) => s.w / s.h >= 1.125);
    for (const s of widescreen) {
      const boxes = defaultBoxes(s, DEFAULT_LAYOUT);
      const size = maxBox(s, 1.125);
      const y = Math.round((s.h - size.h) / 2);
      expect(boxes).toEqual([
        { x: 0, y, ...size },
        { x: s.w - size.w, y, ...size },
      ]);
    }
  });

  it("returns one box per cell, each valid against its own cell ratio", () => {
    for (const l of LAYOUTS) {
      const cells = cellsOf(l);
      for (const s of SOURCES) {
        const boxes = defaultBoxes(s, l);
        expect(boxes).toHaveLength(cells.length);
        cells.forEach((cell, i) => {
          const box = boxes[i];
          if (!box) throw new Error("defaultBoxes returned a hole");
          expect(isValidBox(box, s, ratioOf(cell))).toBe(true);
        });
      }
    }
  });

  it("gives every box the maximum size for its cell", () => {
    // Safe across every source in SOURCES, unconditionally: defaultBoxes
    // assigns size = maxBox(source, ratio) and only ever clampToBounds's
    // it afterwards, which slides but never resizes. No position is
    // asserted here, so nothing about source shape can break this one.
    for (const l of LAYOUTS) {
      const cells = cellsOf(l);
      for (const s of SOURCES) {
        const boxes = defaultBoxes(s, l);
        cells.forEach((cell, i) => {
          expect(boxes[i]).toMatchObject(maxBox(s, ratioOf(cell)));
        });
      }
    }
  });

  it("does not stack boxes of the same shape on top of each other", () => {
    // Boxes are grouped by cell ratio and each group spreads along whichever
    // source axis has slack for that group's box size. A single global
    // spread axis would be wrong for one group or the other in the mixed
    // layouts, and spreading 9:4 boxes on x — where they are already as wide
    // as the source — would leave them all at x = 0, perfectly coincident.
    for (const l of LAYOUTS) {
      const cells = cellsOf(l);
      for (const s of SOURCES) {
        const boxes = defaultBoxes(s, l);
        for (let i = 0; i < cells.length; i++) {
          for (let j = i + 1; j < cells.length; j++) {
            const ci = cells[i];
            const cj = cells[j];
            const bi = boxes[i];
            const bj = boxes[j];
            if (!ci || !cj || !bi || !bj) throw new Error("hole");
            if (ratioOf(ci) !== ratioOf(cj)) continue; // different groups may overlap
            // Separation is only possible where the group has slack on at
            // least one axis. TALL (720x1280) against a 9:16 cell is the one
            // case among these fixtures where it doesn't: maxBox(TALL, 9/16)
            // is 720x1280, the whole source, so slackX and slackY are both
            // 0 and every box in that group is forced to {0,0} — the
            // assertion below is about the spread logic having room to work,
            // not about an impossible placement, so skip where there's no
            // room to spread into.
            const size = maxBox(s, ratioOf(ci));
            const noSlack = s.w - size.w === 0 && s.h - size.h === 0;
            if (noSlack) continue;
            expect(`${bi.x},${bi.y}`).not.toBe(`${bj.x},${bj.y}`);
          }
        }
      }
    }
  });
});
