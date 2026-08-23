import { execFile, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Rect } from "../src/geometry.ts";
import { layoutById } from "../src/layout.ts";
import { HttpError } from "./errors.ts";
import {
  OUT_DIR,
  assertBoxes,
  clipPath,
  exportClip,
  isOutName,
  outName,
  outPath,
  probeFile,
  reportCache,
} from "./ffmpeg.ts";
import { ensureMask } from "./mask.ts";
import { checkStarter, prependStarter, speak } from "./starter.ts";
import { buildSnippet, checkYouTube, publishProgress, uploadVideo } from "./youtube.ts";
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

/** The starter screen's title. Trimmed here so the same string is what gets
 *  spoken, and length-capped because it is handed to `say`, which will
 *  cheerfully read a novel. */
const TITLE_MAX = 200;

export function readTitle(v: unknown): string {
  const text = str(v, "starterTitle").trim();
  if (text === "") throw new HttpError(400, "starterTitle must not be blank.");
  if (text.length > TITLE_MAX) {
    throw new HttpError(400, `starterTitle must be at most ${TITLE_MAX} characters.`);
  }
  return text;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A 1080x1920 title overlay is tens of KB. The cap is three orders of
 *  magnitude of headroom and exists only so a bad request can't be a
 *  memory-sized one. */
const PNG_MAX = 8 << 20;

/** The client renders the title to a PNG because this machine's ffmpeg has no
 *  `drawtext` (no libfreetype in the build), so unlike the frame mask this
 *  image arrives over the wire. It is written to a temp file and handed to
 *  ffmpeg as an input, so the signature is checked rather than trusted: the
 *  decoded bytes are the one part of an export ffmpeg parses as a container. */
export function png(v: unknown, name: string): Buffer {
  const b64 = str(v, name);
  if (b64.length > PNG_MAX) throw new HttpError(400, `${name} is too large.`);
  // Buffer.from(..., "base64") never throws — it stops at the first invalid
  // character — so the signature check is what rejects a non-PNG body, not
  // the decode.
  const buf = Buffer.from(b64, "base64");
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new HttpError(400, `${name} is not a PNG.`);
  }
  return buf;
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
    const starterTitle = readTitle(raw.starterTitle);
    const titlePng = png(raw.titlePng, "titlePng");
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
    // Named after the starter title, not YouTube's: it is what the screen
    // says and reads aloud, so it is what the file is *about*.
    const name = outName(starterTitle, start, end);
    await mkdir(OUT_DIR, { recursive: true });
    const out = join(OUT_DIR, name);
    // Written under a partial name and renamed on success, the same way
    // fetchWindow does. Two reasons: a half-written file must never be
    // servable under a name the client can request, and the rename has to
    // stay on one volume — $TMPDIR is a different filesystem on macOS, so
    // rendering into the temp dir and renaming into the project risks EXDEV.
    const partial = out.replace(/\.mp4$/, ".part.mp4");
    // The composite lands here first; the starter screen is prepended onto
    // it in a second pass.
    const body = join(dir, "body.mp4");
    const art = join(dir, "title.png");

    try {
      await writeFile(art, titlePng);
      await exportClip({
        input,
        start: start - windowStart,
        duration: end - start,
        layout,
        boxes,
        source: { w: source.width, h: source.height },
        // Rendered on first export of each layout and cached from then on,
        // keyed on the layout id plus GUTTER and CORNER_RADIUS.
        mask: await ensureMask(layout),
        out: body,
      });
      const voice = join(dir, "voice.aiff");
      await prependStarter({
        main: body,
        title: art,
        voice,
        voiceSeconds: await speak(starterTitle, dir, voice),
        out: partial,
      });
      await rename(partial, out);
      const { size, mtimeMs } = statSync(out);
      console.warn(`vstack: exported out/${name} (${Math.round(size / 1e6)} MB)`);
      // Nothing streams any more, so the whole headers-already-sent dance
      // this route used to need is gone with it.
      return send(res, 200, {
        name,
        // The mtime is load-bearing, not decoration. The name is stable
        // across re-exports, so without a cache-buster the <video> would
        // re-show the previous render and a crop fix would look like it did
        // nothing.
        url: `/out/${name}?t=${Math.round(mtimeMs)}`,
        size,
      });
    } finally {
      // force:true only suppresses ENOENT. A throwing finally overrides even
      // a clean completion, escaping this route entirely — so this cleanup
      // must swallow its own errors rather than propagate them. The partial
      // is removed here rather than in a catch: on the success path the
      // rename already took it away, so one cleanup covers both.
      await rm(partial, { force: true }).catch((err: unknown) => {
        console.error("vstack: partial cleanup failed:", err);
      });
      await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
        console.error("vstack: temp dir cleanup failed:", err);
      });
    }
  }

  if (req.url === "/api/reveal") {
    const body = await json<Record<string, unknown>>(req);
    // The name is validated, not reconstructed — see isOutName. This is the
    // only path component this API takes from a client.
    if (!isOutName(body.name)) return send(res, 400, { error: "Bad output name." });
    const path = outPath(body.name);
    if (!existsSync(path)) return send(res, 404, { error: `${body.name} is not in out/.` });
    // Fire and forget: `open` has done its job by the time it exits, and
    // revealing a file is not worth an error banner. macOS is already a hard
    // dependency here — `say` and the Linh voice.
    execFile("open", ["-R", path], (err) => {
      if (err) console.warn(`vstack: could not reveal ${path}:`, err);
    });
    return send(res, 200, { ok: true });
  }

  if (req.url === "/api/publish") {
    const body = await json<Record<string, unknown>>(req);
    if (!isOutName(body.name)) return send(res, 400, { error: "Bad output name." });
    const path = outPath(body.name);
    if (!existsSync(path)) return send(res, 404, { error: `${body.name} is not in out/.` });
    const video = buildSnippet({
      title: str(body.title, "title"),
      description: str(body.description, "description"),
      tags: str(body.tags, "tags"),
    });
    // After buildSnippet, not before: it is what trims, so a title of nothing
    // but spaces has to be caught on the other side of it.
    if (video.snippet.title === "") return send(res, 400, { error: "title must not be blank." });
    const videoId = await uploadVideo({ path, size: statSync(path).size, video });
    console.warn(`vstack: uploaded ${body.name} as ${videoId} (private)`);
    return send(res, 200, {
      videoId,
      url: `https://studio.youtube.com/video/${videoId}/edit`,
    });
  }

  // Polled twice a second by the client while an upload runs. Exact string
  // equality above means this never shadows /api/publish and vice versa.
  if (req.url === "/api/publish/progress") return send(res, 200, publishProgress());

  return send(res, 404, { error: `No route ${req.url}` });
}

await checkBinaries();
await checkStarter();
// Soft, unlike the two above: no Google credentials means Publish does not
// work, not that vstack refuses to boot.
checkYouTube();
// SIGTERMs whatever vstack server already holds PORT, and reports whether it
// found one. Node has no way to ask who owns a port, hence lsof — the same
// command the old error message told the user to run by hand. The `ps` check
// is the whole safety margin: a stranger's process on 8787 did not ask to be
// killed, so only a command line pointing at this server qualifies.
function killOldServer(): boolean {
  const listeners = spawnSync(
    "lsof",
    ["-t", `-iTCP:${PORT}`, "-sTCP:LISTEN"],
    { encoding: "utf8" },
  );
  const pids = (listeners.stdout ?? "")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => pid > 0 && pid !== process.pid)
    .filter((pid) =>
      (
        spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
          encoding: "utf8",
        }).stdout ?? ""
      ).includes("server/index.ts"),
    );
  let killed = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      killed += 1;
    } catch (err) {
      console.error(`vstack: could not stop pid ${pid}:`, err);
    }
  }
  return killed > 0;
}

// listen() reports failure through an 'error' event, not a throw, so with no
// handler Node prints an unhandled-'error' stack dump and buries the single
// line that matters. EADDRINUSE is the common case by far — a second
// `pnpm server` started while one is already up — and for a loopback-bound
// single-user tool that is a duplicate launch, so the newer process wins:
// stop the old one and take the port. Only once; if the port is still busy
// on the retry, whoever holds it is not ours to evict.
let retried = false;
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    if (!retried && killOldServer()) {
      retried = true;
      console.warn(`vstack: replaced the server already on port ${PORT}`);
      // SIGTERM has no handler over there, so that process is gone almost at
      // once; the wait is for the kernel to hand the socket back.
      setTimeout(() => server.listen(PORT, "127.0.0.1"), 300);
      return;
    }
    console.error(
      `vstack: port ${PORT} is already in use, and the process holding it is ` +
        `not a vstack server. Fix: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`,
    );
  } else {
    console.error(`vstack: could not listen on port ${PORT}:`, err);
  }
  process.exit(1);
});
// Registered as its own handler rather than as listen()'s callback because
// the retry above calls listen() a second time — a callback passed to the
// first call would have to be repeated there to survive.
server.on("listening", () => {
  console.warn(`vstack server on http://localhost:${PORT}`);
  reportCache();
});
// Loopback only: this is a local single-user tool, not deployed (see the
// design doc), and binding the unspecified address would let any device on
// the LAN POST /api/window (make this machine download video) or
// /api/export (pin its CPU).
server.listen(PORT, "127.0.0.1");
