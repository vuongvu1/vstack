import { OUTPUT } from "./geometry.ts";
import type { Rect } from "./geometry.ts";
import { cellsOf } from "./layout.ts";
import type { Layout } from "./layout.ts";

/** Output px of white between pieces, and around the frame.
 *
 *  Must be even: internal edges are inset by half a gutter each so two
 *  neighbours give up the same amount of the seam, and a fractional window
 *  offset does not survive ffmpeg's overlay.
 *
 *  Both constants live here rather than in `geometry.ts` because they are
 *  *output-space decoration only*. Nothing in this file may ever reach
 *  `ratioOf` or a crop rect — see the doc comment on `windowsOf`. */
export const GUTTER = 10;

/** Output px. Corner radius of each piece. */
export const CORNER_RADIUS = 24;

/** The visible window of a cell: the cell inset by a gutter where it meets
 *  the frame edge and half a gutter where it meets a neighbour. Because
 *  cells tile the frame exactly, two neighbours each give up half the seam,
 *  so every internal seam is `GUTTER` wide and so is every frame margin.
 *
 *  Windows are decoration, not geometry. `cellsOf` still tiles 1080x1920
 *  exactly and `ratioOf` still reports 1.125 / 0.5625 / 2.25, so every
 *  stored crop box stays valid. The gutter is painted *over* the finished
 *  composite, which trims a few px off each piece rather than squeezing it —
 *  insetting the cell instead would change its ratio, invalidate every saved
 *  box, and stretch the export by the gutter's fraction of the cell.
 *
 *  Per-cell rather than per-layout so the preview, which already holds
 *  `cells`, can map over them instead of accepting a second parallel array
 *  that could disagree with the one the mask was rendered from. */
export function windowOf(cell: Rect): Rect {
  const half = GUTTER / 2;
  const left = cell.x === 0 ? GUTTER : half;
  const top = cell.y === 0 ? GUTTER : half;
  const right = cell.x + cell.w === OUTPUT.w ? GUTTER : half;
  const bottom = cell.y + cell.h === OUTPUT.h ? GUTTER : half;
  return {
    x: cell.x + left,
    y: cell.y + top,
    w: cell.w - left - right,
    h: cell.h - top - bottom,
  };
}

/** Every cell's window, parallel to `cellsOf` in the same order — the order
 *  boxes are stored in, the editor numbers, the canvas draws and `xstack`
 *  composes. */
export function windowsOf(layout: Layout): Rect[] {
  return cellsOf(layout).map(windowOf);
}

/** Standard rounded-rect containment: clamp the point into the rect the four
 *  arc centres span, then compare the distance to that clamped point against
 *  the radius. On a straight edge the clamp collapses one axis, so the test
 *  degenerates to the flat edge for free.
 *
 *  Takes the radius rather than reading CORNER_RADIUS directly because the
 *  ring around a floating piece is rounded at CORNER_RADIUS + GUTTER, so its
 *  outer edge stays concentric with the piece's own corners. */
function insideRounded(r: Rect, radius: number, px: number, py: number): boolean {
  if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) return false;
  const cx = Math.min(Math.max(px, r.x + radius), r.x + r.w - radius);
  const cy = Math.min(Math.max(py, r.y + radius), r.y + r.h - radius);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** The white ring around a floating piece: its window expanded by one gutter
 *  on every side, so the piece reads with the same visual weight as a seam
 *  between two cells. Exported because the canvas preview paints the same
 *  region and must derive it the same way rather than recompute it. */
export function ringOf(out: Rect): Rect {
  return {
    x: out.x - GUTTER,
    y: out.y - GUTTER,
    w: out.w + 2 * GUTTER,
    h: out.h + 2 * GUTTER,
  };
}

const SUB = 4;

/** Whether one sample of the overlay is opaque white.
 *
 *  The overlay is composited AFTER the floating pieces, so it has to
 *  arbitrate between them and the gutters — and, once there is more than one
 *  piece, between the pieces themselves. It does that by walking them from
 *  topmost down, which is the compositing order `buildFilter`'s chained
 *  `overlay` already uses: the first piece whose ring rect contains the
 *  sample owns it outright and the walk stops.
 *
 *    inside customs[j]'s ring rect, outside its window  → opaque
 *        that piece's ring, or a nub cutting its square corner
 *    inside customs[j]'s ring rect, inside its window   → transparent
 *        that piece's window — it shows, even over a cell seam
 *    inside no piece's ring rect                        → opaque iff the
 *        sample is outside every cell window: today's gutters and margin
 *
 *  A piece's window is always inside its own ring rect (they are concentric
 *  and the ring is a gutter larger on every side), so "inside a window" is
 *  always reached by that piece's own branch and never falls through.
 *
 *  Testing *any* piece's window before *every* piece's ring — which is what
 *  this did before it was z-aware — is indistinguishable from the walk for
 *  zero or one piece, and wrong for two: the upper piece loses its ring and
 *  its rounded corners wherever it overlaps the lower one. Swapping the two
 *  tests instead is worse, not better: ring∪nub-beats-everything paints the
 *  LOWER piece's ring across the UPPER one. */
function opaqueAt(windows: Rect[], customs: Rect[], rings: Rect[], px: number, py: number): boolean {
  for (let j = customs.length - 1; j >= 0; j--) {
    const ring = rings[j];
    const custom = customs[j];
    // Parallel arrays by construction; noUncheckedIndexedAccess wants the
    // guard, and skipping a hole is the only sane reading of one.
    if (!ring || !custom) continue;
    if (!insideRounded(ring, CORNER_RADIUS + GUTTER, px, py)) continue;
    return !insideRounded(custom, CORNER_RADIUS, px, py);
  }
  for (const w of windows) {
    if (insideRounded(w, CORNER_RADIUS, px, py)) return false;
  }
  return true;
}

/** The frame overlay as a raw RGBA buffer, `OUTPUT.w * OUTPUT.h * 4` bytes:
 *  opaque white where the composite must be covered, transparent where it
 *  must show, antialiased on every arc by `SUB * SUB` coverage sampling.
 *
 *  `customs` are the floating pieces' output rects in *array order* — the
 *  same z order `buildFilter` overlays them in, last on top. See `opaqueAt`
 *  for the per-sample rule; with no customs it reduces to "opaque outside
 *  every cell window", which is what this rendered before pieces existed.
 *
 *  White in all three channels everywhere, including where alpha is 0, so a
 *  partially covered arc pixel can only ever blend towards white. */
export function maskRgba(windows: Rect[], customs: Rect[] = []): Uint8Array {
  const buf = new Uint8Array(OUTPUT.w * OUTPUT.h * 4);
  buf.fill(255);
  const rings = customs.map(ringOf);
  for (let y = 0; y < OUTPUT.h; y++) {
    for (let x = 0; x < OUTPUT.w; x++) {
      let opaque = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const px = x + (sx + 0.5) / SUB;
          const py = y + (sy + 0.5) / SUB;
          if (opaqueAt(windows, customs, rings, px, py)) opaque++;
        }
      }
      const transparent = SUB * SUB - opaque;
      if (transparent === 0) continue;
      buf[(y * OUTPUT.w + x) * 4 + 3] = 255 - Math.round((transparent * 255) / (SUB * SUB));
    }
  }
  return buf;
}
