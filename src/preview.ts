import { CORNER_RADIUS, GUTTER, ringOf, windowOf } from "./frame.ts";
import { OUTPUT } from "./geometry.ts";
import type { Rect } from "./geometry.ts";
import type { CustomBox } from "./custom.ts";

/** The whole composite: one decode, one draw per cell, then one per floating
 *  piece, then the white decoration. Boxes and pieces are read through
 *  getters each frame so a drag needs no re-subscription.
 *
 *  `cells` and `boxes()` are parallel arrays in cellsOf order — the same
 *  order the editor numbers them and xstack composes them. drawImage's
 *  source rect is the box in *source* pixels and its destination rect is
 *  the cell in *output* pixels, with no conversion between them: that is
 *  the invariant that keeps this canvas and ffmpeg's crop= agreeing. A
 *  floating piece works the same way, with its own `out` as the destination.
 *
 *  The decoration is painted in exactly the order ffmpeg applies it: pieces
 *  first, then one white pass that cannot touch a piece's window. That is
 *  why the clip below is set up before either fill — it is the canvas
 *  spelling of maskRgba's priority order, and painting the two fills in the
 *  other order would put a seam's white stripe across a piece.
 *
 *  ponytail: the loop runs unconditionally, which is what makes
 *  redraw-on-seek and redraw-on-drag need no wiring at all. Gate it on
 *  !video.paused if battery ever matters. */
export function startPreview(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  cells: Rect[],
  boxes: () => Rect[],
  customs: () => CustomBox[],
): () => void {
  canvas.width = OUTPUT.w;
  canvas.height = OUTPUT.h;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("2d context unavailable");

  // Derived from the cells rather than passed in, so these are necessarily
  // the same windows the export's mask was rendered from.
  const windows = cells.map(windowOf);

  let raf = 0;
  const frame = () => {
    if (video.readyState >= 2) {
      const bs = boxes();
      cells.forEach((cell, i) => {
        const b = bs[i];
        // A cell with no box yet is skipped, not drawn from a zero rect:
        // drawImage with sw/sh of 0 throws in some browsers, and the
        // previous frame's pixels are a better placeholder than a stripe of
        // whatever the canvas last held.
        if (!b) return;
        ctx.drawImage(video, b.x, b.y, b.w, b.h, cell.x, cell.y, cell.w, cell.h);
      });

      // Floating pieces, drawn as plain rects in array order — last on top,
      // exactly as the overlay chain composes them. Their square corners are
      // cut by the ring fill below.
      const cs = customs();
      for (const c of cs) {
        ctx.drawImage(video, c.crop.x, c.crop.y, c.crop.w, c.crop.h, c.out.x, c.out.y, c.out.w, c.out.h);
      }

      ctx.save();
      // Nothing white may enter a piece's window — the first rule of the
      // mask's priority order, and what lets a piece straddle a cell seam.
      // One clip per piece, not one combined path: clip() intersects, and
      // "frame minus this piece" intersected per piece is the complement of
      // the UNION, which is what maskRgba's customs.some(...) computes. A
      // single even-odd path would instead test parity, and two overlapping
      // pieces would cancel each other back to unprotected.
      for (const c of cs) {
        ctx.beginPath();
        ctx.rect(0, 0, OUTPUT.w, OUTPUT.h);
        ctx.roundRect(c.out.x, c.out.y, c.out.w, c.out.h, CORNER_RADIUS);
        ctx.clip("evenodd");
      }
      ctx.fillStyle = "#fff";
      // The gutters and rounded corners, painted over the finished composite
      // exactly as ffmpeg overlays its mask: full-frame white with the
      // windows punched out of it by the even-odd rule. Drawing it every
      // frame costs one fill and needs no invalidation when the layout
      // changes, because `windows` is rebuilt with the preview.
      ctx.beginPath();
      ctx.rect(0, 0, OUTPUT.w, OUTPUT.h);
      for (const w of windows) ctx.roundRect(w.x, w.y, w.w, w.h, CORNER_RADIUS);
      ctx.fill("evenodd");
      // Each piece's ring, which also cuts its square corners. The clip
      // keeps this out of the piece itself.
      for (const c of cs) {
        const r = ringOf(c.out);
        ctx.beginPath();
        ctx.roundRect(r.x, r.y, r.w, r.h, CORNER_RADIUS + GUTTER);
        ctx.fill();
      }
      ctx.restore();
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
