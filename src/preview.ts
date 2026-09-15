import { CORNER_RADIUS, GUTTER, ringOf, windowOf } from "./frame.ts";
import { OUTPUT } from "./geometry.ts";
import { drawTitle } from "./starter.ts";
import { THUMB } from "./thumb.ts";
import type { Rect } from "./geometry.ts";
import type { CustomBox } from "./custom.ts";

/** The starter screen's look, mirrored from `server/starter.ts`'s
 *  SCREEN_FILTER so the framing phase can show the thumbnail without paying
 *  for an export.
 *
 *  Approximate in exactly one thing — the blur. CSS `blur(Npx)` is a Gaussian
 *  with standard deviation N, the same as `gblur=sigma=N`, but the two
 *  implementations round differently and this one runs on the composite
 *  canvas rather than on the decoded frame. Everything that DECIDES anything
 *  is exact: the title is the same PNG the export overlays, and the crop
 *  guide is arithmetic.
 *
 *  ponytail: four constants copied across the client/server line. They only
 *  move together when the screen is retuned. The exact fix is a `/api/still`
 *  route running the real pipeline; worth it the day the blur misleads
 *  someone about the screen rather than about the title. */
const BLUR_SIGMA = 30;
const SCRIM = 0.65;
const BAND_H = 820;
const BAND_FEATHER = 60;

/** How far past each edge the composite is stretched before it is blurred.
 *
 *  Load-bearing, not polish: a canvas blur of an edge-to-edge image bleeds
 *  ALPHA inward at the frame's borders, so the band's left and right ends
 *  would come back semi-transparent and the sharp composite would show
 *  through them — a defect ffmpeg's `gblur` does not have, since it clamps.
 *  Drawing the source 3 sigma oversized puts real pixels under every sample.
 *  The ~17% scale-up is invisible in a picture whose whole purpose is to be
 *  out of focus, the same trade `stackWide` makes by blurring at 480x270. */
const EDGE = BLUR_SIGMA * 3;

/** The 16:9 crop `firstFrame("wide")` takes, in output pixels. It scales to
 *  COVER 1280x720 and trims the overflow, so the full width survives and the
 *  height is whatever 16:9 makes of it, centred — which is why a title of
 *  four or more lines loses its outer lines from the thumbnail but never
 *  from the video. Showing that line is the whole point of the preview. */
const CROP_H = Math.round((OUTPUT.w * THUMB.h) / THUMB.w);

/** A full-frame scratch canvas. Two of these are ~16 MB of backing store, so
 *  they are built on the first thumbnail frame rather than with the loop. */
function offscreen(): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT.w;
  canvas.height = OUTPUT.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  return ctx;
}

/** Narrows the current clip to everything OUTSIDE one piece's rounded
 *  window. `clip()` intersects, so applying this once per piece leaves the
 *  complement of the union of those pieces' windows — the canvas's answer to
 *  the containment tests `maskRgba` runs per sample. */
function clipOutside(ctx: CanvasRenderingContext2D, out: Rect): void {
  ctx.beginPath();
  ctx.rect(0, 0, OUTPUT.w, OUTPUT.h);
  ctx.roundRect(out.x, out.y, out.w, out.h, CORNER_RADIUS);
  ctx.clip("evenodd");
}

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
 *  first, then a white pass that cannot touch a piece's window. The clips
 *  below are the canvas spelling of maskRgba's z-aware walk — the gutter
 *  fill is kept out of every piece's window, and each piece's ring fill is
 *  additionally kept out of the windows of the pieces ABOVE it, so an upper
 *  piece keeps its ring and its rounded corners over a lower one.
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
  still: () => string | null,
): () => void {
  canvas.width = OUTPUT.w;
  canvas.height = OUTPUT.h;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("2d context unavailable");

  // Derived from the cells rather than passed in, so these are necessarily
  // the same windows the export's mask was rendered from.
  const windows = cells.map(windowOf);

  // Built on the first thumbnail frame, then kept. A session that never opens
  // the thumbnail allocates neither.
  let soft: CanvasRenderingContext2D | null = null;
  let band: CanvasRenderingContext2D | null = null;
  let mask: CanvasGradient | null = null;

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

      ctx.fillStyle = "#fff";
      ctx.save();
      // Nothing white may enter a piece's window — the rule that lets a
      // piece straddle a cell seam. One clip per piece, not one combined
      // path: clip() intersects, and "frame minus this piece" intersected
      // per piece is the complement of the UNION of the pieces. A single
      // even-odd path would instead test parity, and two overlapping pieces
      // would cancel each other back to unprotected.
      for (const c of cs) clipOutside(ctx, c.out);
      // The gutters and rounded corners, painted over the finished composite
      // exactly as ffmpeg overlays its mask: full-frame white with the
      // windows punched out of it by the even-odd rule. Drawing it every
      // frame costs one fill and needs no invalidation when the layout
      // changes, because `windows` is rebuilt with the preview.
      ctx.beginPath();
      ctx.rect(0, 0, OUTPUT.w, OUTPUT.h);
      for (const w of windows) ctx.roundRect(w.x, w.y, w.w, w.h, CORNER_RADIUS);
      ctx.fill("evenodd");
      ctx.restore();
      // Each piece's ring, which also cuts its square corners. Clipped out of
      // its own window (the ring is the expanded rect MINUS the piece) and
      // out of the windows of every piece above it — the canvas spelling of
      // maskRgba walking the pieces from topmost down. Without the second
      // half a lower piece's ring would be painted across an upper one,
      // which is the exact failure swapping the mask's two tests produces.
      cs.forEach((c, j) => {
        ctx.save();
        for (let k = j; k < cs.length; k++) {
          const above = cs[k];
          if (above) clipOutside(ctx, above.out);
        }
        const r = ringOf(c.out);
        ctx.beginPath();
        ctx.roundRect(r.x, r.y, r.w, r.h, CORNER_RADIUS + GUTTER);
        ctx.fill();
        ctx.restore();
      });

      // The starter screen, painted over the finished composite in the same
      // order the export builds it: treated background, then the title. This
      // frame IS the export's thumbnail — `prependStarter` lifts body.mp4's
      // first frame and `firstFrame` crops this picture — so the caller seeks
      // the video to `clipStart` before switching this on.
      const art = still();
      if (art) {
        if (!soft || !band || !mask) {
          soft = offscreen();
          band = offscreen();
          // Each draw replaces what is under it: the blur leaves
          // semi-transparent pixels and a plain source-over blit would
          // composite this frame on top of the last one.
          soft.globalCompositeOperation = "copy";
          soft.filter = `blur(${BLUR_SIGMA}px) brightness(${SCRIM})`;
          // The feathered band's alpha, and the canvas spelling of
          // SCREEN_FILTER's `clip(min(Y-(H-BAND_H)/2, (H+BAND_H)/2-Y)/
          // BAND_FEATHER, 0, 1)` — ramping 0 to 1 across BAND_FEATHER pixels
          // at each edge of a band centred on the frame, which is where
          // `renderTitleArt` centres the title block.
          const top = (OUTPUT.h - BAND_H) / 2;
          mask = band.createLinearGradient(0, top, 0, top + BAND_H);
          const ramp = BAND_FEATHER / BAND_H;
          mask.addColorStop(0, "rgba(0,0,0,0)");
          mask.addColorStop(ramp, "rgba(0,0,0,1)");
          mask.addColorStop(1 - ramp, "rgba(0,0,0,1)");
          mask.addColorStop(1, "rgba(0,0,0,0)");
        }
        soft.drawImage(canvas, -EDGE, -EDGE, OUTPUT.w + 2 * EDGE, OUTPUT.h + 2 * EDGE);
        band.globalCompositeOperation = "copy";
        band.drawImage(soft.canvas, 0, 0);
        band.globalCompositeOperation = "destination-in";
        band.fillStyle = mask;
        band.fillRect(0, 0, OUTPUT.w, OUTPUT.h);

        ctx.drawImage(band.canvas, 0, 0);
        // The same function `renderTitleArt` encodes for the export, drawn
        // straight onto the composite — so a keystroke in the title field
        // reaches this frame with nothing to re-encode or re-decode.
        drawTitle(ctx, art);

        // What `thumbnails.set` actually gets. Two strokes because this line
        // has to read over both a bright title and dark video: black under,
        // white dashed over.
        const y = (OUTPUT.h - CROP_H) / 2;
        ctx.save();
        ctx.lineWidth = 10;
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.strokeRect(0, y, OUTPUT.w, CROP_H);
        ctx.lineWidth = 6;
        ctx.strokeStyle = "#fff";
        ctx.setLineDash([36, 28]);
        ctx.strokeRect(0, y, OUTPUT.w, CROP_H);
        ctx.restore();
      }
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
