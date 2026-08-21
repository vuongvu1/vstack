export type Size = { w: number; h: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type Corner = "nw" | "ne" | "sw" | "se";

export const OUTPUT: Size = { w: 1080, h: 1920 };

/** Source px, applied to the box's *shorter* axis. 142 * 9/8 = 160 wide at
 *  9:8 — small enough to be useful, large enough that a box can still be
 *  grabbed and dragged.
 *
 *  Renamed from MIN_BOX_H because a height-only floor stopped being enough
 *  once cells came in three shapes: a 9:16 cell floored at h = 142 is only
 *  80px wide, too narrow to hit its own corner handles. */
export const MIN_BOX_SIDE = 142;

/** Seconds. Videos shorter than this skip the trim phase entirely. */
export const SKIP_TRIM_UNDER = 180;

/** Seconds. The soft-warning threshold for "longer than a YouTube Short".
 *  Numerically equal to SKIP_TRIM_UNDER but a different meaning — one means
 *  "short enough to skip trimming", this means "long enough to warn about"
 *  — so it is its own named constant rather than the two call sites
 *  reusing SKIP_TRIM_UNDER by coincidence. */
export const SHORTS_MAX_S = 180;

/** Seconds of slack fetched either side of the marked range. Absorbs
 *  keyframe-sloppy stream-copy edges and lets the export seek accurately. */
export const PAD = 5;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** MIN_BOX_SIDE is the preferred floor on both axes, so for a cell narrower
 *  than it is tall the height floor has to rise to keep the width legal. A
 *  source too small to contain it cannot honour it — the effective floor is
 *  whichever is smaller. Both boxFromHeight and isValidBox read this, so the
 *  validator can never reject what the constructors produce.
 *
 *  Math.ceil is load-bearing, not cosmetic — what matters is that the floor
 *  is an INTEGER. MIN_BOX_SIDE / ratio is fractional for a tall cell
 *  (142 / 0.5625 = 252.444) and boxFromHeight *rounds* its clamped height,
 *  so leaving the floor fractional makes the smallest constructible box
 *  h = 252 while isValidBox compares it against 252.444 and rejects it: the
 *  validator refuses its own constructor's output, at 9:16 only. An integer
 *  floor is also what makes boxFromHeight's round-after-clamp unable to
 *  escape the range at all. Ceil over round because a floor should never
 *  round *below* the minimum it names. */
function effectiveMinH(source: Size, ratio: number): number {
  const floor = Math.ceil(Math.max(MIN_BOX_SIDE, MIN_BOX_SIDE / ratio));
  return Math.min(floor, maxBox(source, ratio).h);
}

/** Largest box of the given aspect that fits. Height is derived first,
 *  because deriving width first can round up past the source edge. */
export function maxBox(source: Size, ratio: number): Size {
  const h = Math.floor(Math.min(source.h, source.w / ratio));
  return { w: Math.round(h * ratio), h };
}

/** Canonical box construction: integer height, width derived exactly.
 *  `ratio` is the target cell's w/h — 1.125, 0.5625 or 2.25 (see
 *  layout.ts's ratioOf). */
export function boxFromHeight(h: number, source: Size, ratio: number): Size {
  const height = Math.round(clamp(h, effectiveMinH(source, ratio), maxBox(source, ratio).h));
  return { w: Math.round(height * ratio), h: height };
}

/** Slides a rect back inside the source. Never resizes it — shrinking would
 *  break the 9:8 lock, and a box off 9:8 produces a stretched output half
 *  that goes unnoticed until export. Safe because every constructor caps
 *  size at maxBox, so sliding is always sufficient. */
export function clampToBounds(rect: Rect, source: Size): Rect {
  return {
    w: rect.w,
    h: rect.h,
    x: clamp(Math.round(rect.x), 0, source.w - rect.w),
    y: clamp(Math.round(rect.y), 0, source.h - rect.h),
  };
}

export function moveBy(rect: Rect, dx: number, dy: number, source: Size): Rect {
  return clampToBounds({ ...rect, x: rect.x + dx, y: rect.y + dy }, source);
}

/** Resizes about the opposite corner. The dragged corner's displacement
 *  gives a desired width and height; whichever implies the larger box wins,
 *  so diagonal drags feel right and the aspect lock is never fought. */
export function resizeFromCorner(
  rect: Rect,
  corner: Corner,
  dx: number,
  dy: number,
  source: Size,
  ratio: number,
): Rect {
  const west = corner === "nw" || corner === "sw";
  const north = corner === "nw" || corner === "ne";

  const anchorX = west ? rect.x + rect.w : rect.x;
  const anchorY = north ? rect.y + rect.h : rect.y;

  const draggedX = (west ? rect.x : rect.x + rect.w) + dx;
  const draggedY = (north ? rect.y : rect.y + rect.h) + dy;

  // Clamp the SIGNED extent at 0. Math.abs here would flip a corner dragged
  // past its anchor into a huge box instead of collapsing it to the minimum.
  const wantW = Math.max(0, west ? anchorX - draggedX : draggedX - anchorX);
  const wantH = Math.max(0, north ? anchorY - draggedY : draggedY - anchorY);

  const size = boxFromHeight(Math.max(wantH, wantW / ratio), source, ratio);

  return clampToBounds(
    {
      x: west ? anchorX - size.w : anchorX,
      y: north ? anchorY - size.h : anchorY,
      ...size,
    },
    source,
  );
}

export function displayScale(source: Size, displayW: number): number {
  return displayW / source.w;
}

export function toDisplay(rect: Rect, scale: number): Rect {
  return { x: rect.x * scale, y: rect.y * scale, w: rect.w * scale, h: rect.h * scale };
}

export function fromDisplay(rect: Rect, scale: number): Rect {
  return {
    x: Math.round(rect.x / scale),
    y: Math.round(rect.y / scale),
    w: Math.round(rect.w / scale),
    h: Math.round(rect.h / scale),
  };
}

/** One definition of a legal rect, shared by the client editor and the
 *  server's pre-ffmpeg validation. `ratio` is the ratio of the *cell this
 *  box feeds*, which is why it is a parameter and not a constant: a box can
 *  be a flawless 9:8 rect and still be illegal for a 540x960 cell. */
export function isValidBox(rect: Rect, source: Size, ratio: number): boolean {
  // Guarded because this validates values arriving from untrusted JSON at
  // runtime, whatever the parameter type claims at compile time.
  if (typeof rect !== "object" || rect === null) return false;
  const ints = [rect.x, rect.y, rect.w, rect.h].every(Number.isInteger);
  return (
    ints &&
    rect.w === Math.round(rect.h * ratio) &&
    rect.h >= effectiveMinH(source, ratio) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.w <= source.w &&
    rect.y + rect.h <= source.h
  );
}
