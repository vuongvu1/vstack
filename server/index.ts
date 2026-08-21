import { execFile } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { mmss, slugify } from "../src/format.ts";
import type { Rect } from "../src/geometry.ts";
import { layoutById } from "../src/layout.ts";
import { HttpError } from "./errors.ts";
import { assertBoxes, clipPath, exportClip, probeFile, reportCache } from "./ffmpeg.ts";
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

const server = createServer((req, res) => {
  void route(req, res).catch((err: Error) => {
    console.error(err);
    // Headers already sent means the response is committed: writeHead would
    // throw ERR_HTTP_HEADERS_SENT inside this callback, which nothing awaits,
    // and Node's default unhandled-rejection behaviour would kill the process.
    // Abort the socket instead — the client sees a truncated body, which is
    // the honest signal.
    if (res.headersSent) {
      res.destroy();
      return;
    }
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
    const layoutId = str(raw.layoutId, "layoutId");
    // Shape is checked here; legality (integers, per-cell ratio, in-bounds)
    // is checked below via assertBoxes/isValidBox, which safely reject null,
    // non-arrays, non-objects and non-integers instead of throwing a
    // TypeError.
    const boxes = raw.boxes as Rect[];

    if (!videoId) return send(res, 400, { error: "Bad video id." });
    if (!(end > start)) return send(res, 400, { error: "End must be after start." });
    if (start < windowStart || end > windowEnd) {
      return send(res, 400, { error: "start/end must be within the fetched window." });
    }

    // A table lookup, so nothing from the request body is ever interpolated
    // into the filter graph — the same posture as taking window bounds
    // instead of a file path.
    const layout = layoutById(layoutId);
    if (!layout) return send(res, 400, { error: `Unknown layout ${layoutId}.` });

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
      assertBoxes(layout, boxes, { w: source.width, h: source.height });
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
        layout,
        boxes,
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
      // force:true only suppresses ENOENT. A throwing finally overrides even a
      // clean completion, escaping this try/catch entirely — so this cleanup
      // must swallow its own errors rather than propagate them.
      await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
        console.error("vstack: temp dir cleanup failed:", err);
      });
    }
    return;
  }

  return send(res, 404, { error: `No route ${req.url}` });
}

await checkBinaries();
// listen() reports failure through an 'error' event, not a throw, so with no
// handler Node prints an unhandled-'error' stack dump and buries the single
// line that matters. EADDRINUSE is the common case by far — a second
// `pnpm server` started while one is already up — and for a loopback-bound
// single-user tool that is a duplicate launch, not a conflict worth
// resolving, so say which command finds the existing one.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `vstack: port ${PORT} is already in use — a vstack server is probably ` +
        `already running. Fix: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`,
    );
  } else {
    console.error(`vstack: could not listen on port ${PORT}:`, err);
  }
  process.exit(1);
});
// Loopback only: this is a local single-user tool, not deployed (see the
// design doc), and binding the unspecified address would let any device on
// the LAN POST /api/window (make this machine download video) or
// /api/export (pin its CPU).
server.listen(PORT, "127.0.0.1", () => {
  console.warn(`vstack server on http://localhost:${PORT}`);
  reportCache();
});
