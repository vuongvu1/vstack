import { describe, expect, it } from "vitest";
import { OUTPUT } from "./geometry.ts";
import type { Rect } from "./geometry.ts";
import { CORNER_RADIUS, GUTTER, maskRgba, windowOf, windowsOf } from "./frame.ts";
import { DEFAULT_LAYOUT, LAYOUTS, cellsOf, layoutById } from "./layout.ts";

/** `layoutById` returns `Layout | null` by design. Tests know their ids
 *  exist, so they throw rather than reach for `!`, which the project bans. */
function byId(id: string) {
  const layout = layoutById(id);
  if (!layout) throw new Error(`test asked for unknown layout ${id}`);
  return layout;
}

function alphaAt(mask: Uint8Array, x: number, y: number): number {
  return mask[(y * OUTPUT.w + x) * 4 + 3] ?? -1;
}

function rgbAt(mask: Uint8Array, x: number, y: number) {
  const i = (y * OUTPUT.w + x) * 4;
  return { r: mask[i] ?? -1, g: mask[i + 1] ?? -1, b: mask[i + 2] ?? -1 };
}

/** Gap between two rects along the axis on which they face each other, or
 *  null when they are diagonal neighbours that share no edge at all.
 *
 *  Adjacency is decided on the *cells*, never on the windows: cells tile the
 *  frame exactly, so a shared edge is a gap of 0, whereas every pair of
 *  windows has a positive gap and "which pairs should be one gutter apart"
 *  would be unanswerable from the windows alone. */
function gapBetween(a: Rect, b: Rect): number | null {
  const overlapsX = a.x < b.x + b.w && b.x < a.x + a.w;
  const overlapsY = a.y < b.y + b.h && b.y < a.y + a.h;
  if (overlapsX && !overlapsY) return Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
  if (overlapsY && !overlapsX) return Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
  return null;
}

describe("GUTTER", () => {
  it("is even, so the half-gutter internal inset stays an integer", () => {
    // windowsOf insets internal edges by GUTTER / 2 so that two neighbours
    // each give up half the seam. An odd gutter would put a fractional x on
    // a window, and a fractional overlay offset does not survive ffmpeg.
    expect(GUTTER % 2).toBe(0);
    expect(GUTTER).toBeGreaterThan(0);
  });
});

describe("windowOf", () => {
  it("is the per-cell rule windowsOf maps over", () => {
    // The preview already holds `cells`, so it derives its windows the same
    // way rather than taking a second parallel array that could disagree
    // with the one the mask was rendered from.
    for (const l of LAYOUTS) {
      expect(cellsOf(l).map(windowOf)).toEqual(windowsOf(l));
    }
  });
});

describe("windowsOf", () => {
  it("returns one window per cell, in cellsOf order", () => {
    for (const l of LAYOUTS) {
      expect(windowsOf(l)).toHaveLength(cellsOf(l).length);
    }
  });

  it("insets 1-1's two halves by a full gutter outside and half inside", () => {
    expect(windowsOf(DEFAULT_LAYOUT)).toEqual([
      { x: 10, y: 10, w: 1060, h: 945 },
      { x: 10, y: 965, w: 1060, h: 945 },
    ]);
  });

  it("keeps every window strictly inside its own cell", () => {
    for (const l of LAYOUTS) {
      const cells = cellsOf(l);
      const windows = windowsOf(l);
      cells.forEach((cell, i) => {
        const w = windows[i];
        if (!w) throw new Error("windowsOf returned a hole");
        expect(w.x).toBeGreaterThan(cell.x - 1);
        expect(w.y).toBeGreaterThan(cell.y - 1);
        expect(w.x + w.w).toBeLessThan(cell.x + cell.w + 1);
        expect(w.y + w.h).toBeLessThan(cell.y + cell.h + 1);
        expect(w.w).toBeLessThan(cell.w);
        expect(w.h).toBeLessThan(cell.h);
      });
    }
  });

  it("leaves exactly one gutter around the frame", () => {
    for (const l of LAYOUTS) {
      const windows = windowsOf(l);
      expect(Math.min(...windows.map((w) => w.x))).toBe(GUTTER);
      expect(Math.min(...windows.map((w) => w.y))).toBe(GUTTER);
      expect(Math.max(...windows.map((w) => w.x + w.w))).toBe(OUTPUT.w - GUTTER);
      expect(Math.max(...windows.map((w) => w.y + w.h))).toBe(OUTPUT.h - GUTTER);
    }
  });

  it("leaves exactly one gutter between adjacent windows", () => {
    // The whole point of the feature: a seam that is 5px on one side and
    // 10px on the other reads as a mistake, and half-gutter-per-side is the
    // only inset rule that makes every internal seam identical.
    for (const l of LAYOUTS) {
      const cells = cellsOf(l);
      const windows = windowsOf(l);
      let adjacencies = 0;
      for (let i = 0; i < cells.length; i++) {
        for (let j = i + 1; j < cells.length; j++) {
          const ca = cells[i];
          const cb = cells[j];
          const wa = windows[i];
          const wb = windows[j];
          if (!ca || !cb || !wa || !wb) throw new Error("hole");
          if (gapBetween(ca, cb) !== 0) continue; // not edge-sharing
          adjacencies++;
          expect(gapBetween(wa, wb)).toBe(GUTTER);
        }
      }
      expect(adjacencies).toBeGreaterThanOrEqual(1);
    }
  });

  it("produces integer windows with room for the corner radius", () => {
    for (const l of LAYOUTS) {
      for (const w of windowsOf(l)) {
        for (const k of ["x", "y", "w", "h"] as const) {
          expect(Number.isInteger(w[k])).toBe(true);
        }
        // Two radii have to fit on both axes or the arcs cross and the
        // rounded rect degenerates.
        expect(Math.min(w.w, w.h)).toBeGreaterThanOrEqual(2 * CORNER_RADIUS);
      }
    }
  });
});

describe("maskRgba", () => {
  const mask = maskRgba(windowsOf(DEFAULT_LAYOUT));
  const [top] = windowsOf(DEFAULT_LAYOUT);
  if (!top) throw new Error("1-1 has no first window");

  it("is an RGBA buffer the size of the output frame", () => {
    expect(mask).toHaveLength(OUTPUT.w * OUTPUT.h * 4);
  });

  it("is white everywhere, so partial alpha never bleeds a colour", () => {
    expect(rgbAt(mask, 0, 0)).toEqual({ r: 255, g: 255, b: 255 });
    expect(rgbAt(mask, 540, 480)).toEqual({ r: 255, g: 255, b: 255 });
    expect(rgbAt(mask, OUTPUT.w - 1, OUTPUT.h - 1)).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("is transparent inside a window", () => {
    expect(alphaAt(mask, 540, 480)).toBe(0);
    expect(alphaAt(mask, 540, 1440)).toBe(0);
  });

  it("is opaque in the frame margin and in the seam", () => {
    expect(alphaAt(mask, 0, 0)).toBe(255);
    expect(alphaAt(mask, 540, 2)).toBe(255);
    // The seam between 1-1's two halves runs y 955..964.
    expect(alphaAt(mask, 540, 960)).toBe(255);
  });

  it("is opaque at a window's square corner, proving the corner is rounded", () => {
    // The bounding-box corner of the window sits outside the arc — a
    // radius of 0 would make this transparent.
    expect(alphaAt(mask, top.x, top.y)).toBe(255);
    expect(alphaAt(mask, top.x + top.w - 1, top.y)).toBe(255);
    expect(alphaAt(mask, top.x, top.y + top.h - 1)).toBe(255);
    expect(alphaAt(mask, top.x + top.w - 1, top.y + top.h - 1)).toBe(255);
  });

  it("is transparent along a window's straight edge between the arcs", () => {
    expect(alphaAt(mask, top.x + (top.w >> 1), top.y)).toBe(0);
    expect(alphaAt(mask, top.x, top.y + (top.h >> 1))).toBe(0);
  });

  it("antialiases the arc rather than stepping it", () => {
    // Somewhere in the corner's radius square the arc must cross a pixel
    // partially. A hard-edged mask jags visibly at 1080 wide.
    let partial = 0;
    for (let y = top.y; y < top.y + CORNER_RADIUS; y++) {
      for (let x = top.x; x < top.x + CORNER_RADIUS; x++) {
        const a = alphaAt(mask, x, y);
        if (a > 0 && a < 255) partial++;
      }
    }
    expect(partial).toBeGreaterThan(0);
  });
});
