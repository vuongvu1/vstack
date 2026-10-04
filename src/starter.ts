import type { Size } from "./geometry.ts";

/** The starter screen's typeface. A stack, not one name: Comic Sans MS is
 *  the funny one and carries Vietnamese, Chalkboard is macOS' own and does
 *  too, and `cursive` is whatever the browser has left. Per-glyph fallback
 *  means a missing diacritic borrows from the next font rather than dropping. */
export const TITLE_FONT = '"Comic Sans MS", "Chalkboard SE", Chalkboard, cursive';

const MARGIN = 96;
const SIZE_STEP = 6;
const LINE_HEIGHT = 1.2;
/** Relative to the font size, so the outline stays proportional as the text
 *  shrinks to fit. */
const STROKE = 0.16;

/** How big a title may be, and how small it may get, in one frame. */
export type TitleRules = {
  maxSize: number;
  minSize: number;
  maxLines: number;
  maxBlockH: number;
  maxWidth: number;
};

/** Tall is today's rules exactly: a phone-sized screen, where shrinking a
 *  long title to 48px still reads, and the block is capped at half the frame
 *  so it reads as a title centred in the screen rather than a wall of text.
 *  Wide is a THUMBNAIL — its smallest common surface is a ~168x94 tile, a
 *  0.087 scale of a 1080-tall frame, so 48px would land at ~4px there. 120px
 *  lands at ~10.5px, the legibility floor, and it is a floor: a title that
 *  does not fit at it is reported (`fits`), never shrunk past it. */
export function titleRules(frame: Size): TitleRules {
  const maxWidth = frame.w - 2 * MARGIN;
  return frame.w > frame.h
    ? { maxSize: 220, minSize: 120, maxLines: 3, maxBlockH: Math.round(frame.h * 0.7), maxWidth }
    : { maxSize: 150, minSize: 48, maxLines: Number.POSITIVE_INFINITY, maxBlockH: frame.h / 2, maxWidth };
}

/** A text's width at a size. Injected so the fit is testable without a DOM. */
export type Measure = (text: string, size: number) => number;

export type TitleFit = { size: number; lines: string[]; fits: boolean };

/** Greedy word wrap at a given font size. */
function wrapLines(measure: Measure, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  // ponytail: a word wider than the frame gets its own line and overflows
  // rather than being broken mid-word. Hyphenate if a real title ever needs it.
  for (const word of text.trim().split(/\s+/)) {
    const next = line === "" ? word : `${line} ${word}`;
    if (line !== "" && measure(next, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** The largest size, stepping down from `maxSize`, at which the title wraps
 *  inside the width, the line cap and the block height. Below every size
 *  that fits it returns `minSize` — never smaller — with `fits` saying
 *  whether even that worked, and the lines capped at `maxLines`.
 *
 *  The loop's bounds are today's (`size > minSize`), so a tall title gets
 *  the size it always got. The one difference is the floor itself: the
 *  lines are now wrapped AT `minSize` rather than reusing the last size
 *  tried above it. */
export function fitTitle(measure: Measure, title: string, rules: TitleRules): TitleFit {
  const fitsAt = (lines: string[], size: number) =>
    lines.length <= rules.maxLines &&
    lines.every((l) => measure(l, size) <= rules.maxWidth) &&
    lines.length * size * LINE_HEIGHT <= rules.maxBlockH;
  for (let size = rules.maxSize; size > rules.minSize; size -= SIZE_STEP) {
    const lines = wrapLines(measure, title, size, rules.maxWidth);
    if (fitsAt(lines, size)) return { size, lines, fits: true };
  }
  const lines = wrapLines(measure, title, rules.minSize, rules.maxWidth);
  const fits = fitsAt(lines, rules.minSize);
  return { size: rules.minSize, lines: fits ? lines : lines.slice(0, rules.maxLines), fits };
}

/** `ctx.measureText` in `Measure`'s shape. Sets `ctx.font`, so callers that
 *  care about drawing state save and restore around it. */
function canvasMeasure(ctx: CanvasRenderingContext2D): Measure {
  return (text, size) => {
    ctx.font = `bold ${size}px ${TITLE_FONT}`;
    return ctx.measureText(text).width;
  };
}

let measurer: CanvasRenderingContext2D | null = null;

/** Whether the title fits its frame's rules — the framing bar's too-long
 *  badge. One scratch canvas, made on first use. */
export function titleFits(title: string, frame: Size): boolean {
  measurer ??= document.createElement("canvas").getContext("2d");
  if (!measurer) return true;
  return fitTitle(canvasMeasure(measurer), title, titleRules(frame)).fits;
}

/** Lays the title out and paints it into `ctx`, which must be a canvas the
 *  size of `frame`. Leaves no drawing state behind.
 *
 *  Separate from `renderTitleArt` so that the framing phase's thumbnail can
 *  paint the title straight onto the composite canvas rather than going
 *  through a PNG. Sharing the *draw* rather than the bytes is what makes the
 *  preview track the title field per keystroke: there is nothing to re-encode
 *  and nothing to re-decode, so the rAF loop simply reads the current string.
 *  It is also tighter than sharing the image was — the previewed title and
 *  the exported one are now the same code path, not the same output. */
export function drawTitle(ctx: CanvasRenderingContext2D, title: string, frame: Size): void {
  ctx.save();
  const { size, lines } = fitTitle(canvasMeasure(ctx), title, titleRules(frame));
  ctx.font = `bold ${size}px ${TITLE_FONT}`;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = size * STROKE;
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#fff";
  // Under the outline, not the fill: a shadow on both passes doubles up and
  // reads as a smear.
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = size * 0.22;
  ctx.shadowOffsetY = size * 0.06;

  const step = size * LINE_HEIGHT;
  const top = frame.h / 2 - ((lines.length - 1) * step) / 2;
  lines.forEach((line, i) => {
    ctx.strokeText(line, frame.w / 2, top + i * step);
  });
  // Fills in a second pass, after every outline: a per-line stroke-then-fill
  // lets the next line's outline overlap the previous line's fill.
  ctx.shadowColor = "transparent";
  lines.forEach((line, i) => {
    ctx.fillText(line, frame.w / 2, top + i * step);
  });
  ctx.restore();
}

/** Renders the title as a transparent PNG the size of `frame` and returns it as bare
 *  base64 (no data: prefix).
 *
 *  Client-side because this machine's ffmpeg has no `drawtext` — no
 *  libfreetype in the build — so the server cannot rasterise a glyph at all.
 *  The server treats this exactly like the frame mask: an RGBA image it
 *  overlays, never something it computes. */
export async function renderTitleArt(title: string, frame: Size): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = frame.w;
  canvas.height = frame.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  drawTitle(ctx, title, frame);

  return pngBase64(canvas);
}

/** A canvas as bare base64 PNG — what every client-rendered image this
 *  server takes arrives as. */
export async function pngBase64(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not render the title image.");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the title image."));
    reader.readAsDataURL(blob);
  });
  // The server takes bare base64 and checks the PNG signature itself, so the
  // "data:image/png;base64," preamble is dropped here rather than parsed there.
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}
