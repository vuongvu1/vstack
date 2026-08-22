import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { OUTPUT } from "../src/geometry.ts";
import { CORNER_RADIUS, GUTTER, maskRgba, windowsOf } from "../src/frame.ts";
import type { Layout } from "../src/layout.ts";
import { MEDIA_DIR } from "./ffmpeg.ts";
import { toolError } from "./errors.ts";

const run = promisify(execFile);

export const MASK_DIR = join(MEDIA_DIR, "masks");

/** The cache file for a layout's frame overlay.
 *
 *  Both constants are in the name on purpose: the mask outlives the process,
 *  so a filename keyed on the layout alone would keep serving the old border
 *  to exports after `GUTTER` or `CORNER_RADIUS` changed, while the preview —
 *  which computes the overlay every frame — showed the new one. Layout ids
 *  come from the `LAYOUTS` table, never from a request, so nothing
 *  attacker-controlled reaches this path. */
export function maskPath(layout: Layout, dir: string = MASK_DIR): string {
  return join(dir, `${layout.id}-g${GUTTER}-r${CORNER_RADIUS}.png`);
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
export async function ensureMask(layout: Layout, dir: string = MASK_DIR): Promise<string> {
  const path = maskPath(layout, dir);
  if (existsSync(path)) return path;

  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const raw = join(dir, `${id}.rgba`);
  const partial = join(dir, `${id}.part.png`);
  try {
    await writeFile(raw, maskRgba(windowsOf(layout)));
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
