import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { toolError } from "./errors.ts";

const run = promisify(execFile);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MEDIA_DIR = join(ROOT, "media");

/** Window bounds are integers so filenames are stable and the cache
 *  actually hits on a repeated request. Task 6 reconstructs this exact name
 *  from videoId + window bounds, so clipPath and the served clipUrl must
 *  derive from the same template rather than each string-building it. */
export function clipName(windowStart: number, windowEnd: number): string {
  return `${windowStart}-${windowEnd}.mp4`;
}

export function clipPath(videoId: string, windowStart: number, windowEnd: number): string {
  return join(MEDIA_DIR, videoId, clipName(windowStart, windowEnd));
}

/** The fetched clip's real dimensions. yt-dlp picks a format, so these can
 *  differ from what --dump-json advertised — and since crop rects are stored
 *  in source pixels, framing against the wrong dimensions silently
 *  mis-crops. This is the number geometry must use. */
export async function probeFile(path: string): Promise<{ width: number; height: number }> {
  let stdout: string;
  try {
    ({ stdout } = await run("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      path,
    ]));
  } catch (err) {
    throw toolError("ffprobe", err);
  }
  const stream = (JSON.parse(stdout) as { streams?: { width: number; height: number }[] })
    .streams?.[0];
  if (!stream?.width || !stream?.height) {
    throw new Error(`ffprobe found no video stream in ${path}`);
  }
  return { width: stream.width, height: stream.height };
}
