import { OUTPUT } from "./geometry.ts";

/** The starter screen's typeface. A stack, not one name: Comic Sans MS is
 *  the funny one and carries Vietnamese, Chalkboard is macOS' own and does
 *  too, and `cursive` is whatever the browser has left. Per-glyph fallback
 *  means a missing diacritic borrows from the next font rather than dropping. */
export const TITLE_FONT = '"Comic Sans MS", "Chalkboard SE", Chalkboard, cursive';

const MARGIN = 96;
/** The title block is capped at half the frame so it reads as a title
 *  centred in the screen rather than a wall of text. */
const MAX_BLOCK_H = OUTPUT.h / 2;
const MAX_SIZE = 150;
const MIN_SIZE = 48;
const SIZE_STEP = 6;
const LINE_HEIGHT = 1.2;
/** Relative to the font size, so the outline stays proportional as the text
 *  shrinks to fit. */
const STROKE = 0.16;

/** Greedy word wrap at a given font size. `ctx.font` must already be set. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  // ponytail: a word wider than the frame gets its own line and overflows
  // rather than being broken mid-word. Hyphenate if a real title ever needs it.
  for (const word of text.trim().split(/\s+/)) {
    const next = line === "" ? word : `${line} ${word}`;
    if (line !== "" && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** Renders the title as a transparent 1080x1920 PNG and returns it as bare
 *  base64 (no data: prefix).
 *
 *  Client-side because this machine's ffmpeg has no `drawtext` — no
 *  libfreetype in the build — so the server cannot rasterise a glyph at all.
 *  The server treats this exactly like the frame mask: an RGBA image it
 *  overlays, never something it computes. */
export async function renderTitleArt(title: string): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT.w;
  canvas.height = OUTPUT.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");

  const maxWidth = OUTPUT.w - 2 * MARGIN;
  let size = MIN_SIZE;
  let lines: string[] = [];
  // Largest size that fits both ways. Height is checked as well as width
  // because wrapping a long title inside the width alone would happily
  // stack twenty lines past the top and bottom of the frame.
  for (size = MAX_SIZE; size > MIN_SIZE; size -= SIZE_STEP) {
    ctx.font = `bold ${size}px ${TITLE_FONT}`;
    lines = wrapLines(ctx, title, maxWidth);
    const fits = lines.every((l) => ctx.measureText(l).width <= maxWidth);
    if (fits && lines.length * size * LINE_HEIGHT <= MAX_BLOCK_H) break;
  }
  ctx.font = `bold ${size}px ${TITLE_FONT}`;
  if (lines.length === 0) lines = wrapLines(ctx, title, maxWidth);

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
  const top = OUTPUT.h / 2 - ((lines.length - 1) * step) / 2;
  lines.forEach((line, i) => {
    ctx.strokeText(line, OUTPUT.w / 2, top + i * step);
  });
  // Fills in a second pass, after every outline: a per-line stroke-then-fill
  // lets the next line's outline overlap the previous line's fill.
  ctx.shadowColor = "transparent";
  lines.forEach((line, i) => {
    ctx.fillText(line, OUTPUT.w / 2, top + i * step);
  });

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
