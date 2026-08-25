import { OUTPUT, boxFromHeight, clampToBounds, isValidBox, maxBox } from "./geometry.ts";
import type { Corner, Rect, Size } from "./geometry.ts";

/** A piece that floats over the preset layout. `out` is where it lands in
 *  the 1080x1920 frame; `crop` is the region of the source it shows. Both
 *  are stored raw, with zero conversion between them — the invariant that
 *  makes canvas drawImage and ffmpeg's crop= agree for the preset cells
 *  applies here unchanged.
 *
 *  Custom boxes are deliberately NOT extra cells: `Layout` is authored as
 *  rows so that a hand-written cell list cannot express a seam or an
 *  overlap, and a floating box is an overlap by construction. */
export type CustomBox = { out: Rect; crop: Rect };

/** Two. Each one costs a decode leg, an overlay, a mask window, a node on
 *  each of the two editor overlays and a colour in the box scale. */
export const MAX_CUSTOM = 2;

/** Output px. Small enough to be a corner inset, large enough to grab by
 *  its handles. Even, so clamping to it cannot break the evenness rule. */
export const MIN_OUT_SIDE = 160;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Rounds DOWN to an even number. Every `out` field is even because an
 *  overlay at an odd offset in yuv420p lands on a half-chroma-sample
 *  boundary. Down rather than nearest so a value already clamped to a
 *  maximum cannot round back past it. */
const even = (n: number) => Math.floor(n / 2) * 2;

/** The aspect this box's crop must hold — the box's own, never a cell's.
 *  This is the value that goes into `isValidBox`'s `ratio` parameter, which
 *  is exactly the case that parameter exists for. */
export function outRatio(out: Rect): number {
  return out.w / out.h;
}

/** The nearest legal output rect: even on all four fields, at least
 *  MIN_OUT_SIDE per side, wholly inside the frame inset by `margin` on all
 *  four edges. Idempotent, because it runs on every frame of a drag.
 *
 *  `margin` is how the piece's own white ring is kept on the frame rather
 *  than off it. A ring is one gutter wide, so bounding placement by a
 *  gutter lands it exactly on the frame's white margin — same band width,
 *  no doubling, nothing clipped — and a piece dragged into a corner reads
 *  like a cell's own window. It must be EVEN for the same reason every
 *  field here is: `even()` rounds down, so an odd lower bound would floor
 *  back underneath itself.
 *
 *  Defaulted to 0 rather than baked in, because it is `frame.ts`'s `GUTTER`
 *  — output-space decoration, which sits above this module in the layering
 *  and must not be imported into it. The caller that knows about rings
 *  passes it; the validators deliberately do not (see `isValidOut`). */
export function clampOut(rect: Rect, margin = 0): Rect {
  const w = even(clamp(rect.w, MIN_OUT_SIDE, OUTPUT.w - 2 * margin));
  const h = even(clamp(rect.h, MIN_OUT_SIDE, OUTPUT.h - 2 * margin));
  return {
    w,
    h,
    x: even(clamp(rect.x, margin, OUTPUT.w - margin - w)),
    y: even(clamp(rect.y, margin, OUTPUT.h - margin - h)),
  };
}

/** Slides an output rect, never resizing it — the same discipline
 *  `clampToBounds` keeps on the source side. */
export function moveOut(rect: Rect, dx: number, dy: number, margin = 0): Rect {
  return clampOut({ ...rect, x: rect.x + dx, y: rect.y + dy }, margin);
}

/** Free resize about the opposite corner: `resizeFromCorner`'s shape minus
 *  the aspect lock, because a custom box's aspect is the thing being chosen
 *  here. Each side is capped at the anchor's own distance to the inset frame
 *  edge, so a growing drag stops with the piece's ring on the frame's white
 *  margin rather than off the frame.
 *
 *  The cap is floored at MIN_OUT_SIDE and the result passed through
 *  `clampOut`, for one case only: a rect stored before this bound existed
 *  can sit flush at 0, putting the anchor itself inside the margin, where
 *  the raw cap would be negative and `clamp`'s `hi < lo` would emit a rect
 *  under the floor. For an already-inset rect the cap is never binding and
 *  `clampOut` is a no-op, so the anchor stays under the pointer. */
export function resizeOut(rect: Rect, corner: Corner, dx: number, dy: number, margin = 0): Rect {
  const west = corner === "nw" || corner === "sw";
  const north = corner === "nw" || corner === "ne";

  const anchorX = west ? rect.x + rect.w : rect.x;
  const anchorY = north ? rect.y + rect.h : rect.y;
  const draggedX = (west ? rect.x : rect.x + rect.w) + dx;
  const draggedY = (north ? rect.y : rect.y + rect.h) + dy;

  const maxW = Math.max(MIN_OUT_SIDE, west ? anchorX - margin : OUTPUT.w - margin - anchorX);
  const maxH = Math.max(MIN_OUT_SIDE, north ? anchorY - margin : OUTPUT.h - margin - anchorY);

  const w = even(clamp(west ? anchorX - draggedX : draggedX - anchorX, MIN_OUT_SIDE, maxW));
  const h = even(clamp(north ? anchorY - draggedY : draggedY - anchorY, MIN_OUT_SIDE, maxH));

  return clampOut({ x: west ? anchorX - w : anchorX, y: north ? anchorY - h : anchorY, w, h }, margin);
}

/** The crop that follows an `out` whose ratio just changed: same height,
 *  same centre, width rebuilt from the new ratio. Height-driven like every
 *  other constructor in this codebase, so re-snapping on every drag frame
 *  does not shrink the crop a pixel at a time, and `boxFromHeight`'s own
 *  clamp covers an extreme ratio without a special case. */
export function resnapCrop(crop: Rect, source: Size, out: Rect): Rect {
  const cx = crop.x + crop.w / 2;
  const cy = crop.y + crop.h / 2;
  const size = boxFromHeight(crop.h, source, outRatio(out));
  return clampToBounds(
    { x: Math.round(cx - size.w / 2), y: Math.round(cy - size.h / 2), ...size },
    source,
  );
}

/** Takes `unknown` because it validates values arriving from localStorage
 *  and from a request body, whatever the parameter type claims at compile
 *  time — the same posture as `isValidBox`.
 *
 *  Deliberately bounds the WHOLE frame, not the gutter-inset frame the drag
 *  path clamps to: the inset is a placement preference, not a legality rule.
 *  Keeping it out of here means every record written before the inset
 *  existed still restores, an older client's body still exports, and a piece
 *  flush to the edge renders exactly as it always did — one that a drag then
 *  pulls inside. Validators stay a superset of what the constructors emit,
 *  never the reverse. */
export function isValidOut(out: unknown): out is Rect {
  if (typeof out !== "object" || out === null) return false;
  const r = out as Rect;
  if (![r.x, r.y, r.w, r.h].every(Number.isInteger)) return false;
  return (
    r.x % 2 === 0 &&
    r.y % 2 === 0 &&
    r.w % 2 === 0 &&
    r.h % 2 === 0 &&
    r.w >= MIN_OUT_SIDE &&
    r.h >= MIN_OUT_SIDE &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.x + r.w <= OUTPUT.w &&
    r.y + r.h <= OUTPUT.h
  );
}

/** One definition of a legal custom box, shared by `restore` on the client
 *  and `assertCustoms` on the server — the split `isValidBox` already has
 *  for the preset cells. Either side alone would let a bad box preview
 *  cleanly and die only at export. */
export function isValidCustom(custom: unknown, source: Size): custom is CustomBox {
  if (typeof custom !== "object" || custom === null || Array.isArray(custom)) return false;
  const c = custom as CustomBox;
  return isValidOut(c.out) && isValidBox(c.crop, source, outRatio(c.out));
}

/** A fresh box: a 540x540 square in the middle of the frame showing the
 *  largest square the source holds, offset per index so a second box's
 *  handles do not land exactly under the first's. */
export function defaultCustom(source: Size, index: number): CustomBox {
  const side = 540;
  const offset = index * 60;
  const out = clampOut({
    x: (OUTPUT.w - side) / 2 + offset,
    y: (OUTPUT.h - side) / 2 + offset,
    w: side,
    h: side,
  });
  const size = maxBox(source, outRatio(out));
  const crop = clampToBounds(
    { x: Math.round((source.w - size.w) / 2), y: Math.round((source.h - size.h) / 2), ...size },
    source,
  );
  return { out, crop };
}
