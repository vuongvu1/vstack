export type Size = { w: number; h: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type Corner = "nw" | "ne" | "sw" | "se";

export const OUTPUT: Size = { w: 1080, h: 1920 };
export const HALF: Size = { w: 1080, h: 960 };
export const BOX_RATIO = 9 / 8;

/** Source px. 142 * 9/8 ≈ 160 wide — small enough to be useful, large
 *  enough that a box can still be grabbed and dragged. */
export const MIN_BOX_H = 142;

/** Seconds. Videos shorter than this skip the trim phase entirely. */
export const SKIP_TRIM_UNDER = 180;

/** Seconds of slack fetched either side of the marked range. Absorbs
 *  keyframe-sloppy stream-copy edges and lets the export seek accurately. */
export const PAD = 5;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Largest 9:8 box that fits. Height is derived first, because deriving
 *  width first can round up past the source edge. */
export function maxBox(source: Size): Size {
  const h = Math.floor(Math.min(source.h, source.w / BOX_RATIO));
  return { w: Math.round(h * BOX_RATIO), h };
}

/** MIN_BOX_H is the preferred floor, but a source too small to contain it
 *  cannot honour it — the effective floor is whichever is smaller. Both
 *  boxFromHeight and isValidBox read it, so the validator can never reject
 *  what the constructors produce. */
function effectiveMinH(source: Size): number {
  return Math.min(MIN_BOX_H, maxBox(source).h);
}

/** Canonical box construction: integer height, width derived exactly. */
export function boxFromHeight(h: number, source: Size): Size {
  const height = Math.round(clamp(h, effectiveMinH(source), maxBox(source).h));
  return { w: Math.round(height * BOX_RATIO), h: height };
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

  const size = boxFromHeight(Math.max(wantH, wantW / BOX_RATIO), source);

  return clampToBounds(
    {
      x: west ? anchorX - size.w : anchorX,
      y: north ? anchorY - size.h : anchorY,
      ...size,
    },
    source,
  );
}

/** Both boxes at max size, top pinned left and bottom pinned right,
 *  vertically centred. That frames a two-speaker wide shot correctly with
 *  zero clicks, and is one drag from the facecam case. */
export function defaultBoxes(source: Size): { top: Rect; bottom: Rect } {
  const size = maxBox(source);
  const y = Math.round((source.h - size.h) / 2);
  return {
    top: clampToBounds({ x: 0, y, ...size }, source),
    bottom: clampToBounds({ x: source.w - size.w, y, ...size }, source),
  };
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
 *  server's pre-ffmpeg validation. */
export function isValidBox(rect: Rect, source: Size): boolean {
  const ints = [rect.x, rect.y, rect.w, rect.h].every(Number.isInteger);
  return (
    ints &&
    rect.w === Math.round(rect.h * BOX_RATIO) &&
    rect.h >= effectiveMinH(source) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.w <= source.w &&
    rect.y + rect.h <= source.h
  );
}
