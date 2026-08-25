import { describe, expect, it } from "vitest";
import { OUTPUT } from "./geometry.ts";
import type { Rect } from "./geometry.ts";
import { CORNER_RADIUS, GUTTER, maskRgba, ringOf, windowOf, windowsOf } from "./frame.ts";
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

describe("maskRgba — floating custom boxes", () => {
  // A box straddling the 1-1 layout's seam at y = 960, well inside the
  // frame on x. Everything below is asserted against these numbers.
  const CUSTOM: Rect = { x: 300, y: 700, w: 480, h: 480 };
  const windows = windowsOf(DEFAULT_LAYOUT);

  it("cuts a transparent window where the piece is drawn", () => {
    const mask = maskRgba(windows, [CUSTOM]);
    expect(alphaAt(mask, CUSTOM.x + CUSTOM.w / 2, CUSTOM.y + CUSTOM.h / 2)).toBe(0);
  });

  it("paints an opaque white ring one gutter wide around it", () => {
    const mask = maskRgba(windows, [CUSTOM]);
    const midX = CUSTOM.x + CUSTOM.w / 2;
    // Half a gutter above the top edge: inside the ring band.
    expect(alphaAt(mask, midX, CUSTOM.y - GUTTER / 2)).toBe(255);
    expect(rgbAt(mask, midX, CUSTOM.y - GUTTER / 2)).toEqual({ r: 255, g: 255, b: 255 });
    // Two px beyond the ring: back to the cell's own content.
    expect(alphaAt(mask, midX, CUSTOM.y - GUTTER - 2)).toBe(0);
  });

  it("keeps the corner nub opaque even where it sits over a cell window", () => {
    // The failure this prevents: the piece is drawn as a plain rect, so its
    // square corner would show through wherever the mask is transparent.
    // MUTATION TEST: drop the ring∪nub rule and this drops to 0.
    const mask = maskRgba(windows, [CUSTOM]);
    expect(alphaAt(mask, CUSTOM.x + 1, CUSTOM.y + 1)).toBe(255);
  });

  it("lets a piece straddle a cell seam without a white stripe through it", () => {
    // The 1-1 layout's two windows are one gutter apart around y = 960, so
    // that row is opaque white with no customs — and must not be, inside a
    // custom's window.
    // MUTATION TEST: let the gutter rule win over customs and this is 255.
    const bare = maskRgba(windows);
    expect(alphaAt(bare, CUSTOM.x + CUSTOM.w / 2, 960)).toBe(255);
    const mask = maskRgba(windows, [CUSTOM]);
    expect(alphaAt(mask, CUSTOM.x + CUSTOM.w / 2, 960)).toBe(0);
  });

  it("leaves the frame margin and the rest of the gutters alone", () => {
    const mask = maskRgba(windows, [CUSTOM]);
    expect(alphaAt(mask, 2, 2)).toBe(255);
    expect(alphaAt(mask, 100, 960)).toBe(255);
    expect(alphaAt(mask, 540, 480)).toBe(0);
  });
});

describe("maskRgba — two overlapping pieces", () => {
  // Exactly what two clicks of `+ Box` produce: defaultCustom's 540x540 at
  // (270, 690) and its (60, 60)-offset sibling, overlapping by 480x480. The
  // default two-piece state was the defect state, so it is the fixture.
  const LOWER: Rect = { x: 270, y: 690, w: 540, h: 540 };
  const UPPER: Rect = { x: 330, y: 750, w: 540, h: 540 };
  const windows = windowsOf(DEFAULT_LAYOUT);
  const mask = maskRgba(windows, [LOWER, UPPER]);

  it("keeps the upper piece's corner nub opaque over the lower piece", () => {
    // MUTATION TEST: this is 0 unless the walk is z-aware. Testing any
    // piece's window before every piece's ring — which is what this did
    // before — finds the LOWER piece's window here and calls it transparent,
    // so the upper piece shows a square corner over its neighbour.
    expect(alphaAt(mask, UPPER.x + 1, UPPER.y + 1)).toBe(255);
    // The same nub outside the lower piece was always opaque — the control
    // that shows the two differ only where the pieces overlap.
    expect(alphaAt(mask, UPPER.x + UPPER.w - 1, UPPER.y + UPPER.h - 1)).toBe(255);
  });

  it("keeps the upper piece's ring opaque over the lower piece", () => {
    // MUTATION TEST: 0 without the z-aware walk, for the same reason — the
    // upper piece loses the whole top and left of its ring, which is the
    // half that happens to sit over its neighbour.
    expect(alphaAt(mask, 600, UPPER.y - GUTTER / 2)).toBe(255);
    expect(rgbAt(mask, 600, UPPER.y - GUTTER / 2)).toEqual({ r: 255, g: 255, b: 255 });
    // Below the upper piece, clear of the lower one: opaque either way.
    expect(alphaAt(mask, 600, UPPER.y + UPPER.h + GUTTER / 2)).toBe(255);
  });

  it("hides the lower piece's ring inside the upper piece's window", () => {
    // The other half of z-awareness, and why the fix is not simply swapping
    // the two tests: ring∪nub-beats-everything would paint this white and
    // stripe the lower piece's ring across the upper piece.
    expect(alphaAt(mask, LOWER.x + LOWER.w + GUTTER / 2, 1000)).toBe(0);
    // Where the two windows overlap, the upper piece just shows.
    expect(alphaAt(mask, 600, 1000)).toBe(0);
  });

  it("leaves the gutters and the pieces' own windows alone", () => {
    expect(alphaAt(mask, 2, 2)).toBe(255);
    expect(alphaAt(mask, 100, 960)).toBe(255);
    // Inside the lower piece, clear of the upper one.
    expect(alphaAt(mask, 300, 720)).toBe(0);
  });
});

describe("ringOf", () => {
  it("is the box expanded by exactly one gutter on every side", () => {
    const out: Rect = { x: 300, y: 700, w: 480, h: 480 };
    expect(ringOf(out)).toEqual({
      x: out.x - GUTTER,
      y: out.y - GUTTER,
      w: out.w + 2 * GUTTER,
      h: out.h + 2 * GUTTER,
    });
  });
});
