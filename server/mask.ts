import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { OUTPUT } from "../src/geometry.ts";
import type { Rect } from "../src/geometry.ts";
import { CORNER_RADIUS, GUTTER, maskRgba, windowsOf } from "../src/frame.ts";
import type { Layout } from "../src/layout.ts";
import { MEDIA_DIR } from "./ffmpeg.ts";
import { toolError } from "./errors.ts";

const run = promisify(execFile);

export const MASK_DIR = join(MEDIA_DIR, "masks");

/** A short, stable digest of the floating pieces' output rects. Hex only,
 *  so nothing client-shaped can reach the path — though by the time this
 *  runs the rects are validated integers anyway. */
function customKey(customs: Rect[]): string {
  if (customs.length === 0) return "";
  const digest = createHash("sha1")
    .update(customs.map((r) => `${r.x},${r.y},${r.w},${r.h}`).join(";"))
    .digest("hex")
    .slice(0, 8);
  return `-c${digest}`;
}

/** The cache file for a layout's frame overlay.
 *
 *  Both constants are in the name on purpose: the mask outlives the process,
 *  so a filename keyed on the layout alone would keep serving the old border
 *  to exports after `GUTTER` or `CORNER_RADIUS` changed, while the preview —
 *  which computes the overlay every frame — showed the new one. The custom
 *  boxes are in it for exactly the same reason, and only when there are any,
 *  so today's cached files keep hitting. Layout ids come from the `LAYOUTS`
 *  table and the digest is hex, so nothing attacker-controlled reaches this
 *  path. */
export function maskPath(layout: Layout, customs: Rect[] = [], dir: string = MASK_DIR): string {
  return join(dir, `${layout.id}-g${GUTTER}-r${CORNER_RADIUS}${customKey(customs)}.png`);
}

/** Renders the layout's frame overlay to a cached PNG and returns its path.
 *
 *  Raw RGBA out of `maskRgba`, then ffmpeg's rawvideo demuxer encodes it —
 *  which is why there is no PNG encoder here and no dependency to add.
 *  Writing the PNG rather than keeping the 8 MB raw buffer means `exportClip`
 *  can hand it to ffmpeg as an ordinary looped image input.
 *
 *  Both intermediates carry a UUID and the result lands by rename, so two
 *  concurrent exports of the same layout cannot leave a half-written mask in
 *  the cache — the same discipline `fetchWindow` uses for clips. */
export async function ensureMask(
  layout: Layout,
  customs: Rect[] = [],
  dir: string = MASK_DIR,
): Promise<string> {
  const path = maskPath(layout, customs, dir);
  if (existsSync(path)) return path;

  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const raw = join(dir, `${id}.rgba`);
  const partial = join(dir, `${id}.part.png`);
  try {
    await writeFile(raw, maskRgba(windowsOf(layout), customs));
    await run("ffmpeg", [
      "-v", "error",
      "-f", "rawvideo",
      "-pixel_format", "rgba",
      "-video_size", `${OUTPUT.w}x${OUTPUT.h}`,
      "-i", raw,
      "-frames:v", "1",
      "-y", partial,
    ]);
    await rename(partial, path);
  } catch (err) {
    await rm(partial, { force: true });
    throw toolError("ffmpeg", err);
  } finally {
    await rm(raw, { force: true });
  }
  return path;
}
