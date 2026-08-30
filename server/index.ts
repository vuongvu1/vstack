import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Rect } from "../src/geometry.ts";
import { layoutById } from "../src/layout.ts";
import type { CustomBox } from "../src/custom.ts";
import { MAX_SEGMENTS, isValidSegments } from "../src/segments.ts";
import { HttpError } from "./errors.ts";
import {
  OUT_DIR,
  assertBoxes,
  assertCustoms,
  clipPath,
  exportClip,
  firstFrame,
  isOutName,
  outName,
  outPath,
  probeFile,
  removeExport,
  reportCache,
  stillPath,
} from "./ffmpeg.ts";
import { ensureMask } from "./mask.ts";
import { VOICE, checkStarter, knownVoices, prependStarter, speak } from "./starter.ts";
import {
  buildSnippet,
  checkYouTube,
  publishProgress,
  setThumbnail,
  uploadVideo,
} from "./youtube.ts";
import { fetchWindow, listClips, probe, videoIdFrom } from "./ytdlp.ts";

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
 *  spoken, and length-capped because it is handed to a speech engine that
 *  will cheerfully read a novel. */
const TITLE_MAX = 200;

export function readTitle(v: unknown, name = "starterTitle"): string {
  const text = str(v, name).trim();
  if (text === "") throw new HttpError(400, `${name} must not be blank.`);
  if (text.length > TITLE_MAX) {
    throw new HttpError(400, `${name} must be at most ${TITLE_MAX} characters.`);
  }
  return text;
}

/** What the starter screen *reads aloud*, which need not be what it shows: a
 *  title written for the eye reads badly, and the displayed one still names
 *  the file and prefills the upload. Absent, null or blank means "say the
 *  displayed title", so the common case sends nothing and every record and
 *  request written before this field existed keeps working. When it is
 *  present it goes through the same validator, because it reaches the same
 *  engine. */
export function readVoiceTitle(v: unknown, fallback: string): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "string" && v.trim() === "") return fallback;
  return readTitle(v, "voiceTitle");
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

/** Publishes the export's own first frame as the video's thumbnail — which
 *  for a vstack output is the starter screen, blurred background and title
 *  already composited, so there is nothing to render.
 *
 *  Best-effort by design, and the return value says which: by the time this
 *  runs the video is uploaded and visible in Studio, so a thumbnail refusal
 *  must not turn a successful publish into an error. The common refusal is a
 *  403 on a channel that was never phone-verified, which blocks custom
 *  thumbnails account-wide.
 *
 *  The JPEG goes to a temp dir, never OUT_DIR: everything in there is
 *  servable under a name the client can ask for, and nothing sweeps it. */
async function applyThumbnail(video: string, videoId: string): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "vstack-thumb-"));
  try {
    await setThumbnail(videoId, await firstFrame(video, join(dir, "thumb.jpg"), "wide"));
    console.warn(`vstack: set the starter screen as ${videoId}'s thumbnail`);
    return true;
  } catch (err) {
    console.warn(`vstack: could not set a thumbnail for ${videoId}:`, err);
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
      console.error("vstack: thumbnail temp dir cleanup failed:", err);
    });
  }
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

/** Saves the export's opening frame beside it as a vertical JPEG.
 *
 *  Studio's *Shorts* thumbnail slot is 9:16 and no Data API v3 method fills
 *  it, so that upload is a manual job — this is the file to drag into it,
 *  already sitting next to the video in Finder. Deliberately NOT the same
 *  shape as the one `applyThumbnail` sends: that one is cropped to 16:9 for
 *  `thumbnails.set`, this one is left vertical for the Shorts slot.
 *
 *  Best-effort. The video is the product; a still that fails to extract is
 *  not worth failing an export that already succeeded. `isOutName` matches
 *  `.mp4` only, so this file is never servable over `/out/` — it exists for
 *  Finder, not the browser. */
async function saveStill(video: string): Promise<void> {
  const still = stillPath(video);
  try {
    await firstFrame(video, still, "tall");
  } catch (err) {
    console.warn(`vstack: could not save a still beside ${video}:`, err);
    await rm(still, { force: true }).catch(() => undefined);
  }
}

/** Export partials being written right now.
 *
 *  `pnpm server` runs under `node --watch`, so every edit to a server file
 *  SIGTERMs this process — and a killed process never reaches the `finally`
 *  that removes its partial. The ffmpeg it spawned is a separate process and
 *  outlives it, so without the handler below an edit during a render leaves a
 *  multi-MB `<name>.<uuid>.part.mp4` in OUT_DIR, which nothing sweeps. */
const inFlight = new Set<string>();

// `unlinkSync`, not `rm`: a signal handler has no time for a promise. Note
// this gives the process a SIGTERM handler it did not have before —
// killOldServer's comment says the old server "is gone almost at once", and
// that stays true, since this does a handful of sync unlinks and exits.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const partial of inFlight) {
      try {
        unlinkSync(partial);
      } catch {
        /* already renamed, or never created */
      }
    }
    process.exit(0);
  });
}

/** `bytes=a-b`, `bytes=a-` and `bytes=-n` — the three forms a browser sends. */
const RANGE = /^bytes=(\d*)-(\d*)$/;

/** Streams a finished export.
 *
 *  The only GET this server answers, and it exists because OUT_DIR moved out
 *  of the project root: Vite serves the root statically, which is how
 *  `/media/<id>/<clip>.mp4` reaches the browser with no route, but a Desktop
 *  path is outside that root. Vite proxies `/out` here instead.
 *
 *  Byte ranges are not optional. A <video> asks for one the moment it seeks,
 *  and answering 200 with the whole file to a Range request leaves scrubbing
 *  silently broken — the element loads but the timeline does nothing.
 *
 *  `isOutName` is the whole guard, and it is doing more work than it used to:
 *  it now stands between a request and the user's home directory. */
function serveOut(req: IncomingMessage, res: ServerResponse): void {
  // The URL carries the mtime cache-buster as a query string; the name is
  // everything before it.
  const raw = (req.url ?? "").slice("/out/".length).split("?")[0] ?? "";
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // decodeURIComponent throws on a malformed escape — a bad name, not a 500.
    return send(res, 400, { error: "Bad output name." });
  }
  if (!isOutName(name)) return send(res, 400, { error: "Bad output name." });
  const path = outPath(name);
  if (!existsSync(path)) return send(res, 404, { error: `${name} is not in out/.` });

  const { size } = statSync(path);
  const match = RANGE.exec(req.headers.range ?? "");

  if (!match) {
    res.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": size,
      "accept-ranges": "bytes",
    });
    pipeOut(createReadStream(path), res);
    return;
  }

  const from = match[1] ?? "";
  const to = match[2] ?? "";
  // `bytes=-500` means the LAST 500 bytes, not "0 through 500" — reading it
  // as the latter serves the wrong part of the file to a seeking player.
  const start = from === "" ? Math.max(0, size - Number(to)) : Number(from);
  const end = from === "" || to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0) {
    res.writeHead(416, { "content-range": `bytes */${size}` });
    res.end();
    return;
  }

  res.writeHead(206, {
    "content-type": "video/mp4",
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${size}`,
    "accept-ranges": "bytes",
  });
  pipeOut(createReadStream(path, { start, end }), res);
}

/** A player that seeks abandons the previous response mid-flight, so both
 *  ends of this pipe fail routinely. Neither is worth a stack trace, and an
 *  unhandled stream error would take the process down. */
function pipeOut(file: ReturnType<typeof createReadStream>, res: ServerResponse): void {
  file.on("error", () => res.destroy());
  res.on("close", () => file.destroy());
  file.pipe(res);
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Above the POST-only guard, and deliberately the only thing that is.
  if (req.method === "GET" && (req.url ?? "").startsWith("/out/")) return serveOut(req, res);
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
    const duration = num(body.duration, "duration");
    if (!videoId) return send(res, 400, { error: "Bad video id." });
    // Shape and legality in one call, before any subprocess spawns — this is
    // the same split validator `restore` runs on the client, so a selection
    // that reaches here has already been checked once and is checked again
    // because localStorage and the wire are both untrusted input.
    const segments = body.segments;
    if (!isValidSegments(segments, duration)) {
      return send(res, 400, {
        error:
          `Segments must be 1 to ${MAX_SEGMENTS} non-overlapping ranges, ` +
          `in order, inside [0, ${duration}].`,
      });
    }
    return send(res, 200, await fetchWindow(videoId, segments, duration));
  }

  // The idle screen's second way in: everything already in `media/`, so a
  // clip fetched in an earlier session can be reframed without touching the
  // network. No request body at all — there is nothing here for a caller to
  // supply, so nothing to validate.
  if (req.url === "/api/clips") return send(res, 200, { clips: await listClips() });

  if (req.url === "/api/export") {
    const raw = await json<Record<string, unknown>>(req);
    const videoId = videoIdFrom(str(raw.videoId, "videoId"));
    const windowStart = num(raw.windowStart, "windowStart");
    const windowEnd = num(raw.windowEnd, "windowEnd");
    const start = num(raw.start, "start");
    const end = num(raw.end, "end");
    const starterTitle = readTitle(raw.starterTitle);
    const voiceTitle = readVoiceTitle(raw.voiceTitle, starterTitle);
    const titlePng = png(raw.titlePng, "titlePng");
    const layoutId = str(raw.layoutId, "layoutId");
    const voiceName = str(raw.voice, "voice");
    // The one client-supplied component of a cache path this route accepts,
    // and it is not a path: exactly 8 lowercase hex characters, which cannot
    // traverse, cannot escape MEDIA_DIR, and is still assembled into a path
    // by clipPath rather than used as one. It exists because a stitch's
    // filename carries a component window bounds do not — and the server
    // cannot recompute it, because the `listClips` reopen path has no
    // segments to hash. Same posture as `isOutName`, narrower alphabet.
    const digestRaw = raw.digest ?? "";
    if (typeof digestRaw !== "string" || (digestRaw !== "" && !/^[0-9a-f]{8}$/.test(digestRaw))) {
      return send(res, 400, { error: "Bad digest." });
    }
    const digest = digestRaw;
    // The render this one replaces, deleted once the new file is safely in
    // place. The third client-supplied string this API acts on, and the only
    // one that names a file to *destroy* — so it goes through the same
    // `isOutName` the `/out/` side uses, never a looser check. Absent, null
    // and blank all mean "nothing to sweep", which is the first export of a
    // session and every body written before this field existed.
    const prevRaw = raw.prev ?? "";
    if (typeof prevRaw !== "string" || (prevRaw !== "" && !isOutName(prevRaw))) {
      return send(res, 400, { error: "Bad prev name." });
    }
    const prev = prevRaw;
    // Shape is checked here; legality (integers, per-cell ratio, in-bounds)
    // is checked below via assertBoxes/isValidBox, which safely reject null,
    // non-arrays, non-objects and non-integers instead of throwing a
    // TypeError.
    const boxes = raw.boxes as Rect[];
    // Same posture as boxes: shape here, legality below via assertCustoms.
    // Absent means none, so a body from a client that predates this feature
    // still exports.
    const customs = (raw.customs ?? []) as CustomBox[];

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

    // The voice reaches a subprocess as argv, so it is checked against the
    // engine's own preset table rather than pattern-matched — the same
    // posture as the layout lookup above and `isOutName` below. Voice, the
    // out name and the `digest` block above are the only client-supplied
    // strings this API acts on.
    if (!knownVoices().some((v) => v.name === voiceName)) {
      return send(res, 400, { error: `Unknown voice ${voiceName}.` });
    }

    // Window bounds in, never a path: the cache filename is reconstructed
    // here from videoId + window bounds, so there is no client-supplied
    // path to validate for traversal.
    const input = clipPath(videoId, windowStart, windowEnd, digest);
    if (!existsSync(input)) {
      return send(res, 404, {
        error:
          `Window ${windowStart}-${windowEnd}${digest === "" ? "" : `-${digest}`} ` +
          `for ${videoId} is not cached. Re-fetch it via /api/window before exporting.`,
      });
    }
    const source = await probeFile(input);

    // Validated up front so a bad box is a clean 400 from this route rather
    // than the plain Error assertBoxes throws (which the top-level handler
    // would otherwise map to a 500 — right for a genuine ffmpeg failure,
    // wrong for a client-supplied box).
    try {
      assertBoxes(layout, boxes, { w: source.width, h: source.height });
      assertCustoms(customs, { w: source.width, h: source.height });
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
    // fetchWindow does. Three reasons: a half-written file must never be
    // servable under a name the client can request; the rename has to stay
    // on one volume — $TMPDIR is a different filesystem on macOS, so
    // rendering into the temp dir and renaming into the project risks EXDEV;
    // and `out`'s name is deterministic (from the starter title and the
    // marks), so two concurrent exports of the same range — two tabs, or a
    // re-export fired before the first finishes — would otherwise share one
    // partial and each ffmpeg would write into the other's open fd. A UUID
    // per call, not `process.pid`, for the same reason fetchWindow's partial
    // carries one: the pid is constant for the life of this one process, so
    // it can't tell two concurrent calls in it apart.
    const partial = out.replace(/\.mp4$/, `.${randomUUID()}.part.mp4`);
    // The composite lands here first; the starter screen is prepended onto
    // it in a second pass.
    const body = join(dir, "body.mp4");
    const art = join(dir, "title.png");

    inFlight.add(partial);
    try {
      await writeFile(art, titlePng);
      await exportClip({
        input,
        start: start - windowStart,
        duration: end - start,
        layout,
        boxes,
        customs,
        source: { w: source.width, h: source.height },
        // Rendered on first export of each layout+pieces combination and
        // cached from then on, keyed on the layout id, GUTTER, CORNER_RADIUS
        // and a digest of the pieces' output rects.
        mask: await ensureMask(layout, customs.map((c) => c.out)),
        out: body,
      });
      const voicePath = join(dir, "voice.wav");
      await prependStarter({
        main: body,
        title: art,
        voice: voicePath,
        voiceSeconds: await speak(voiceTitle, dir, voicePath, voiceName),
        out: partial,
      });
      await rename(partial, out);
      await saveStill(out);
      // Only now, and only if the edit actually moved the name: `outName` is
      // deterministic in title and marks, so an unchanged range already
      // overwrote itself above and `prev` names the file just written.
      // After the rename, never before — a failed export must leave the
      // render it was replacing intact. Best-effort for the same reason
      // `saveStill` is: the new video is the product, and a stale file left
      // on the Desktop is not worth failing an export that succeeded.
      if (prev !== "" && prev !== name) {
        await removeExport(outPath(prev)).catch((err: unknown) => {
          console.warn(`vstack: could not remove the previous out/${prev}:`, err);
        });
      }
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
      inFlight.delete(partial);
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
    // only path component this API takes from a client on the `/out/` side
    // — `/api/export`'s `digest` is the analogous case on the `/media/`
    // side, thirty-ish lines above in that route.
    if (!isOutName(body.name)) return send(res, 400, { error: "Bad output name." });
    const path = outPath(body.name);
    if (!existsSync(path)) return send(res, 404, { error: `${body.name} is not in out/.` });
    // Fire and forget: `open` has done its job by the time it exits, and
    // revealing a file is not worth an error banner. This is now one of only
    // two macOS-only calls left — the other is `afplay` in `pnpm voices` —
    // since the voice moved off `say` onto VieNeu-TTS.
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
      thumbnail: await applyThumbnail(path, videoId),
    });
  }

  // Polled twice a second by the client while an upload runs. Exact string
  // equality above means this never shadows /api/publish and vice versa.
  if (req.url === "/api/publish/progress") return send(res, 200, publishProgress());

  // The framing bar's voice dropdown. Served from the boot cache, so it costs
  // nothing and cannot disagree with what /api/export will accept.
  if (req.url === "/api/voices") return send(res, 200, { voices: knownVoices(), default: VOICE });

  // The Try button beside that dropdown: the real title in the real voice,
  // without paying for an export. Answers the WAV itself rather than writing
  // it anywhere servable — a sample is not an artifact, and `out/` is for
  // things the user meant to keep.
  if (req.url === "/api/say") {
    const raw = await json<Record<string, unknown>>(req);
    // The same two validators /api/export runs, for the same two reasons: the
    // title reaches an engine that would read a novel, and the voice reaches
    // a subprocess as argv.
    const starterTitle = readTitle(raw.starterTitle);
    const voiceTitle = readVoiceTitle(raw.voiceTitle, starterTitle);
    const voiceName = str(raw.voice, "voice");
    if (!knownVoices().some((v) => v.name === voiceName)) {
      return send(res, 400, { error: `Unknown voice ${voiceName}.` });
    }
    const dir = await mkdtemp(join(tmpdir(), "vstack-say-"));
    // ponytail: not tracked in `inFlight` like the export partials are. A
    // server killed mid-sample does strand this directory, but unlike a
    // partial it is in $TMPDIR, is not servable, and carries no name a client
    // could ask for — the three reasons that Set exists. macOS sweeps it.
    try {
      const out = join(dir, "voice.wav");
      await speak(voiceTitle, dir, out, voiceName);
      const wav = await readFile(out);
      res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length });
      return void res.end(wav);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

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
