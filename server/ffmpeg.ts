import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MEDIA_DIR = join(ROOT, "media");

/** Window bounds are integers so filenames are stable and the cache
 *  actually hits on a repeated request. */
export function clipPath(videoId: string, windowStart: number, windowEnd: number): string {
  return join(MEDIA_DIR, videoId, `${windowStart}-${windowEnd}.mp4`);
}

/** The fetched clip's real dimensions. yt-dlp picks a format, so these can
 *  differ from what --dump-json advertised — and since crop rects are stored
 *  in source pixels, framing against the wrong dimensions silently
 *  mis-crops. This is the number geometry must use. */
export async function probeFile(path: string): Promise<{ width: number; height: number }> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    path,
  ]);
  const stream = (JSON.parse(stdout) as { streams?: { width: number; height: number }[] })
    .streams?.[0];
  if (!stream?.width || !stream?.height) {
    throw new Error(`ffprobe found no video stream in ${path}`);
  }
  return { width: stream.width, height: stream.height };
}
