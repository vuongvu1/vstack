import { BADGE } from "./defaults.ts";
import type { Segment, Speed, SpeedRange } from "./segments.ts";
import { TITLE_FONT, pngBase64 } from "./starter.ts";

/** The speed playing at clip time `t`, or null. Cut beats speed — the same
 *  rule `planLegs` holds — so a cut inside a speed range reads as no speed. */
export function speedAt(speeds: SpeedRange[], cuts: Segment[], t: number): Speed | null {
  if (cuts.some((c) => t >= c.start && t < c.end)) return null;
  return speeds.find((r) => t >= r.start && t < r.end)?.speed ?? null;
}

/** `▶▶ x4` as outlined white text hugging the BADGE box's top-right corner,
 *  top-left of the box at (x, y). The title's own recipe (round-joined black
 *  stroke under a white fill, a shadow on the stroke pass only), and the SAME
 *  draw the export's PNG is encoded from, so the preview's badge is exact. */
export function drawBadge(ctx: CanvasRenderingContext2D, speed: Speed, x: number, y: number): void {
  const size = Math.round(BADGE.h * 0.62);
  const right = x + BADGE.w - size * 0.3;
  const mid = y + BADGE.h / 2;
  const text = `▶▶ x${speed}`;
  ctx.save();
  ctx.font = `bold ${size}px ${TITLE_FONT}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = size * 0.2;
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = size * 0.22;
  ctx.shadowOffsetY = size * 0.06;
  ctx.strokeText(text, right, mid);
  ctx.shadowColor = "transparent";
  ctx.fillText(text, right, mid);
  ctx.restore();
}

/** The badge as the bare base64 PNG `/api/export`'s `badgePngs` takes. */
export async function renderBadge(speed: Speed): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = BADGE.w;
  canvas.height = BADGE.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  drawBadge(ctx, speed, 0, 0);
  return pngBase64(canvas);
}
