import { execFile } from "node:child_process";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { mmss, slugify } from "../src/format.ts";
import type { Rect } from "../src/geometry.ts";
import { HttpError } from "./errors.ts";
import { assertBoxes, clipPath, exportClip, MEDIA_DIR, probeFile } from "./ffmpeg.ts";
import { fetchWindow, probe, videoIdFrom } from "./ytdlp.ts";

const run = promisify(execFile);
const PORT = 8787;

const REQUIRED: ReadonlyArray<readonly [string, string, string]> = [
  ["yt-dlp", "--version", "brew install yt-dlp"],
  ["ffmpeg", "-version", "brew install ffmpeg"],
  ["ffprobe", "-version", "brew install ffmpeg"],
];

async function checkBinaries(): Promise<void> {
  for (const [bin, flag, hint] of REQUIRED) {
    try {
      await run(bin, [flag]);
    } catch {
      console.error(`vstack: "${bin}" not found on PATH. Fix: ${hint}`);
      process.exit(1);
    }
  }
}

export async function json<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body is not valid JSON.");
  }
  // `null` and arrays are valid JSON but not request bodies; destructuring
  // either downstream would throw a TypeError as a 500.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Body must be a JSON object.");
  }
  return parsed as T;
}

export function send(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Request bodies are untrusted JSON. A TypeScript annotation is a
 *  compile-time claim about a value that arrives from the wire, so every
 *  field crossing this boundary is checked, not just declared. */
export function str(v: unknown, name: string): string {
  if (typeof v !== "string") throw new HttpError(400, `Expected ${name} to be a string.`);
  return v;
}

export function num(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new HttpError(400, `Expected ${name} to be a finite number.`);
  }
  return v;
}

// ponytail: no eviction, just visibility. Add an LRU when this gets annoying.
function cacheSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? cacheSize(p) : statSync(p).size;
  }
  return total;
}

function reportCache(): void {
  try {
    if (!existsSync(MEDIA_DIR)) return;
    const mb = Math.round(cacheSize(MEDIA_DIR) / 1e6);
    if (mb > 0) console.warn(`vstack: media cache is ${mb} MB (media/)`);
  } catch (err) {
    console.warn("vstack: could not compute media cache size:", err);
  }
}

const server = createServer((req, res) => {
  void route(req, res).catch((err: Error) => {
    console.error(err);
    const status = err instanceof HttpError ? err.status : 500;
    send(res, status, { error: err.message });
  });
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });

  if (req.url === "/api/probe") {
    const body = await json<Record<string, unknown>>(req);
    const url = str(body.url, "url");
    const videoId = videoIdFrom(url);
    if (!videoId) return send(res, 400, { error: "Not a YouTube video URL." });
    const result = await probe(videoId);
    if (result.isLive) {
      return send(res, 400, {
        error: "This is an ongoing live stream — a section of it is not well-defined.",
      });
    }
    return send(res, 200, result);
  }

  if (req.url === "/api/window") {
    const body = await json<Record<string, unknown>>(req);
    const videoId = videoIdFrom(str(body.videoId, "videoId"));
    const start = num(body.start, "start");
    const end = num(body.end, "end");
    const duration = num(body.duration, "duration");
    if (!videoId) return send(res, 400, { error: "Bad video id." });
    if (!(end > start)) return send(res, 400, { error: "End must be after start." });
    return send(res, 200, await fetchWindow(videoId, start, end, duration));
  }

  if (req.url === "/api/export") {
    const raw = await json<Record<string, unknown>>(req);
    const videoId = videoIdFrom(str(raw.videoId, "videoId"));
    const windowStart = num(raw.windowStart, "windowStart");
    const windowEnd = num(raw.windowEnd, "windowEnd");
    const start = num(raw.start, "start");
    const end = num(raw.end, "end");
    const title = str(raw.title, "title");
    // Shape is checked here; legality (integers, 9:8 ratio, in-bounds) is
    // checked below via assertBoxes/isValidBox, which safely reject null,
    // non-objects, and non-integers instead of throwing a TypeError.
    const boxTop = raw.boxTop as Rect;
    const boxBottom = raw.boxBottom as Rect;

    if (!videoId) return send(res, 400, { error: "Bad video id." });
    if (!(end > start)) return send(res, 400, { error: "End must be after start." });
    if (start < windowStart || end > windowEnd) {
      return send(res, 400, { error: "start/end must be within the fetched window." });
    }

    // Window bounds in, never a path: the cache filename is reconstructed
    // here from videoId + window bounds, so there is no client-supplied
    // path to validate for traversal.
    const input = clipPath(videoId, windowStart, windowEnd);
    if (!existsSync(input)) {
      return send(res, 404, {
        error:
          `Window ${windowStart}-${windowEnd} for ${videoId} is not cached. ` +
          "Re-fetch it via /api/window before exporting.",
      });
    }
    const source = await probeFile(input);

    // Validated up front so a bad box is a clean 400 from this route rather
    // than the plain Error assertBoxes throws (which the top-level handler
    // would otherwise map to a 500 — right for a genuine ffmpeg failure,
    // wrong for a client-supplied box).
    try {
      assertBoxes(boxTop, boxBottom, { w: source.width, h: source.height });
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }

    const dir = await mkdtemp(join(tmpdir(), "vstack-out-"));
    const name = `${slugify(title)}-${mmss(start)}-${mmss(end)}.mp4`;
    const out = join(dir, name);

    try {
      await exportClip({
        input,
        start: start - windowStart,
        duration: end - start,
        top: boxTop,
        bottom: boxBottom,
        source: { w: source.width, h: source.height },
        out,
      });
      const { size } = statSync(out);
      res.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": size,
        "content-disposition": `attachment; filename="${name}"`,
      });
      await pipeline(createReadStream(out), res);
    } catch (err) {
      // exportClip failures land here before any header is written, so the
      // top-level handler's send() is still safe. A failure *during*
      // streaming happens after headers are already sent, and a JSON error
      // body at that point would corrupt the response — so that case is
      // handled here instead of being rethrown.
      if (res.headersSent) {
        console.error("vstack: export stream failed after headers were sent:", err);
        res.destroy();
        return;
      }
      throw err;
    } finally {
      // Runs only after the try above has fully settled — including after
      // `await pipeline(...)` resolves or rejects — so this never deletes
      // the file out from under an in-flight response.
      await rm(dir, { recursive: true, force: true });
    }
    return;
  }

  return send(res, 404, { error: `No route ${req.url}` });
}

await checkBinaries();
server.listen(PORT, () => {
  console.warn(`vstack server on http://localhost:${PORT}`);
  reportCache();
});
