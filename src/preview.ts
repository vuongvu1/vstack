import { HALF, OUTPUT } from "./geometry.ts";
import type { Rect } from "./geometry.ts";

/** The whole composite: one decode, two draws. Boxes are read through a
 *  getter each frame so a drag needs no re-subscription.
 *
 *  ponytail: the loop runs unconditionally, which is what makes
 *  redraw-on-seek and redraw-on-drag need no wiring at all. Gate it on
 *  !video.paused if battery ever matters. */
export function startPreview(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  boxes: () => { top: Rect; bottom: Rect },
): () => void {
  canvas.width = OUTPUT.w;
  canvas.height = OUTPUT.h;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("2d context unavailable");

  let raf = 0;
  const frame = () => {
    if (video.readyState >= 2) {
      const { top, bottom } = boxes();
      ctx.drawImage(video, top.x, top.y, top.w, top.h, 0, 0, HALF.w, HALF.h);
      ctx.drawImage(video, bottom.x, bottom.y, bottom.w, bottom.h, 0, HALF.h, HALF.w, HALF.h);
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
