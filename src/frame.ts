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

/** The frame overlay as a raw RGBA buffer, `OUTPUT.w * OUTPUT.h * 4` bytes:
 *  opaque white where the composite must be covered, transparent where it
 *  must show, antialiased on every arc by `SUB * SUB` coverage sampling.
 *
 *  Three rules in priority order, because the overlay is applied AFTER the
 *  floating pieces are composited and therefore has to arbitrate between
 *  them and the gutters:
 *
 *    transparent  inside a custom's window   — the piece shows
 *    opaque       inside a custom's ring∪nub — draws the ring, cuts the
 *                                              piece's square corners
 *    opaque       outside every cell window  — today's gutters and margin
 *    transparent  otherwise
 *
 *  The first rule is what lets a piece straddle a cell seam without the
 *  seam's white stripe crossing it; the second is what stops the piece's
 *  square corner showing wherever it happens to sit over a cell window.
 *  With no customs this reduces exactly to the previous behaviour.
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
          if (customs.some((c) => insideRounded(c, CORNER_RADIUS, px, py))) continue;
          if (
            rings.some((r) => insideRounded(r, CORNER_RADIUS + GUTTER, px, py)) ||
            !windows.some((w) => insideRounded(w, CORNER_RADIUS, px, py))
          ) {
            opaque++;
          }
        }
      }
      const transparent = SUB * SUB - opaque;
      if (transparent === 0) continue;
      buf[(y * OUTPUT.w + x) * 4 + 3] = 255 - Math.round((transparent * 255) / (SUB * SUB));
    }
  }
  return buf;
}
