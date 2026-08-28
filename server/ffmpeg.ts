import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { OUTPUT, isValidBox } from "../src/geometry.ts";
import type { Rect, Size } from "../src/geometry.ts";
import { cellsOf, ratioOf } from "../src/layout.ts";
import type { Layout } from "../src/layout.ts";
import { mmss, slugify } from "../src/format.ts";
import { MAX_CUSTOM, MIN_OUT_SIDE, isValidCustom } from "../src/custom.ts";
import type { CustomBox } from "../src/custom.ts";
import type { Segment } from "../src/segments.ts";
import { toolError } from "./errors.ts";

const run = promisify(execFile);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MEDIA_DIR = join(ROOT, "media");

/** Window bounds are integers so filenames are stable and the cache actually
 *  hits on a repeated request. `/api/export` reconstructs this exact name
 *  from videoId + window bounds (+ digest), so clipPath and the served
 *  clipUrl must derive from the same template rather than each
 *  string-building it.
 *
 *  `digest` names a *stitch* — several kept parts concatenated into one file
 *  by `fetchWindow`. Omitted (the overwhelmingly common case) the name is
 *  byte-identical to what this always emitted, so every clip already in
 *  `media/` keeps hitting. */
export function clipName(windowStart: number, windowEnd: number, digest = ""): string {
  return `${windowStart}-${windowEnd}${digest === "" ? "" : `-${digest}`}.mp4`;
}

export function clipPath(
  videoId: string,
  windowStart: number,
  windowEnd: number,
  digest = "",
): string {
  return join(MEDIA_DIR, videoId, clipName(windowStart, windowEnd, digest));
}

/** A short, stable digest of a stitch's segment bounds. Hex only, so nothing
 *  client-shaped can reach the path — the same construction, and the same
 *  reasoning, as `customKey` in `server/mask.ts`.
 *
 *  Two different segment sets can sum to the same number of seconds, so the
 *  `0-<total>` part of a stitch's name is not unique on its own. Without
 *  this, the second such cut would be served the first one's file forever. */
export function segmentDigest(segs: Segment[]): string {
  return createHash("sha1")
    .update(segs.map((s) => `${s.start},${s.end}`).join(";"))
    .digest("hex")
    .slice(0, 8);
}

/** Finished shorts. Outside the repo on purpose — these are products, not
 *  build artefacts, and the user sweeps them up by hand.
 *
 *  This is why `/out/<name>` needs a real route. `media/` reaches the browser
 *  for free because Vite serves the project ROOT statically; a Desktop path
 *  is outside that root, so `index.ts` serves this directory itself and Vite
 *  proxies `/out` to it. That route's only guard is `isOutName`, which now
 *  stands between a request and the user's home directory rather than
 *  between a request and the repo. */
export const OUT_DIR = process.env.VSTACK_OUT_DIR ?? join(homedir(), "Desktop", "vstack");

/** The exported short's filename — deterministic in title and range, so
 *  re-exporting the same clip after a crop tweak overwrites rather than
 *  accumulating. `isOutName` below is anchored to exactly what this emits. */
export function outName(title: string, start: number, end: number): string {
  return `${slugify(title)}-${mmss(start)}-${mmss(end)}.mp4`;
}

export function outPath(name: string): string {
  return join(OUT_DIR, name);
}

/** Anchored to what `slugify` (emits dash-separated alphanumeric groups,
 *  never leading or trailing dash, never empty — collapses runs of dashes
 *  to one) and `mmss` (four or more digits, but four is the floor) can
 *  produce together. */
const OUT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d{4,}-\d{4,}\.mp4$/;

/** The one client-supplied path component on the `/out/` side of this API.
 *  `/api/export` deliberately takes window bounds and reconstructs the cache
 *  filename itself, so there is nothing to validate there; preview breaks
 *  that, because publish and reveal both name a file that already exists. So
 *  the name is validated rather than reconstructed. No slash, no dot-dot, no
 *  backslash, no absolute path and no non-ASCII survives the pattern.
 *  `/api/export`'s `digest` is the analogous case on the `/media/` side —
 *  narrower, eight lowercase hex characters rather than a full name, but
 *  validated for the identical reason (see `server/index.ts`).
 *
 *  Takes `unknown`: it is called on a raw request-body field, and a
 *  `string` annotation there would be a compile-time claim about a value
 *  that arrives from the wire. */
export function isOutName(name: unknown): name is string {
  return typeof name === "string" && OUT_NAME.test(name);
}

function cacheSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? cacheSize(p) : statSync(p).size;
  }
  return total;
}

// ponytail: no eviction, just visibility. Add an LRU when this gets annoying.
/** Logs the media cache's total size. Called once at server boot and again
 *  after every successful fetch — a long session that only logged at boot
 *  would grow the cache silently until the next restart. */
export function reportCache(): void {
  try {
    if (!existsSync(MEDIA_DIR)) return;
    const mb = Math.round(cacheSize(MEDIA_DIR) / 1e6);
    if (mb > 0) console.warn(`vstack: media cache is ${mb} MB (media/)`);
  } catch (err) {
    console.warn("vstack: could not compute media cache size:", err);
  }
}

/** The clip's real shape and sound.
 *
 *  Dimensions first, because yt-dlp picks a format and the fetched
 *  resolution can differ from what --dump-json advertised — and crop rects
 *  are stored in source pixels, so framing against the wrong dimensions
 *  silently mis-crops.
 *
 *  `-of json`, never `-of default=nk=1`: that prints one line per *stream*,
 *  so reading a per-file answer out of it means guessing which line is
 *  which. Taking the first line once answered "video" for every clip, which
 *  made `hasAudio` false everywhere and replaced every export's sound with
 *  the silence stand-in while every stream-shape assertion still passed.
 *
 *  `starter.ts` keeps its own private `probeMain` rather than calling this:
 *  it sits *beside* `ffmpeg.ts` in the layering, not above it, and importing
 *  from here would be the first edge that breaks that. */
export async function probeFile(path: string): Promise<{
  width: number;
  height: number;
  fps: string;
  seconds: number;
  hasAudio: boolean;
}> {
  let stdout: string;
  try {
    ({ stdout } = await run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=width,height,codec_type,r_frame_rate:format=duration",
      "-of",
      "json",
      path,
    ]));
  } catch (err) {
    throw toolError("ffprobe", err);
  }
  const parsed = JSON.parse(stdout) as {
    streams?: { width?: number; height?: number; codec_type?: string; r_frame_rate?: string }[];
    format?: { duration?: string };
  };
  const streams = parsed.streams ?? [];
  // Selected by codec_type, NOT by index: `-select_streams v:0` is gone
  // because the audio streams are needed too, so streams[0] is no longer
  // guaranteed to be the video one.
  const video = streams.find((s) => s.codec_type === "video");
  if (!video?.width || !video?.height) {
    throw new Error(`ffprobe found no video stream in ${path}`);
  }
  return {
    width: video.width,
    height: video.height,
    fps: video.r_frame_rate ?? "30/1",
    seconds: Number(parsed.format?.duration ?? 0),
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

export type ExportOpts = {
  input: string;
  start: number;
  duration: number;
  layout: Layout;
  boxes: Rect[];
  /** Floating pieces, composited over the finished stack in array order —
   *  last on top. Optional so every existing caller and test is unchanged. */
  customs?: CustomBox[];
  source: Size;
  /** The frame overlay PNG for `layout`, from `ensureMask`. Passed in rather
   *  than resolved here so `mask.ts` — which needs `MEDIA_DIR` from this
   *  module — can sit above it and the server layering stays acyclic. */
  mask: string;
  out: string;
};

/** One decode, split N ways, each leg cropped and scaled to its cell, then
 *  composed, then the frame mask overlaid on top.
 *
 *  A single xstack rather than hstack-per-row-then-vstack: it needs no
 *  special case for single-column rows, and its `layout=` string comes
 *  straight out of cellsOf, so the composition can't drift from the cells
 *  the preview and the editor use. For the 1-1 layout it emits
 *  `layout=0_0|0_960`, which is pixel-identical to the vstack this
 *  replaced.
 *
 *  The white gutters and rounded corners arrive last, as one overlay of the
 *  RGBA mask on input 1 (`ensureMask`). ffmpeg has no rounded-rect filter,
 *  and a per-frame `geq` alpha would cost more than the encode — a
 *  pre-rendered mask is a single blend per frame. Crucially the overlay is
 *  *on top of* an edge-to-edge composite, so `crop=` and `scale=` never see
 *  the gutter and the stored boxes stay exact. */
export function buildFilter(layout: Layout, boxes: Rect[], customs: CustomBox[] = []): string {
  const cells = cellsOf(layout);
  const legs = cells.map((cell, i) => {
    const r = boxes[i];
    // Thrown, not defaulted: a missing box means the caller and the layout
    // disagree, and a zero-size fallback would emit a filter graph ffmpeg
    // fails on unreadably. assertBoxes normally catches this first.
    if (r === undefined) {
      throw new Error(
        `buildFilter: layout ${layout.id} needs ${cells.length} boxes, got ${boxes.length}.`,
      );
    }
    return (
      `[c${i}]crop=${r.w}:${r.h}:${r.x}:${r.y},` +
      `scale=${cell.w}:${cell.h}:flags=lanczos[s${i}]`
    );
  });
  const inputs = cells.map((_, i) => `[c${i}]`).join("");
  const customInputs = customs.map((_, j) => `[k${j}]`).join("");
  const scaled = cells.map((_, i) => `[s${i}]`).join("");
  const positions = cells.map((c) => `${c.x}_${c.y}`).join("|");

  // One leg per floating piece, cropped from the same decode and scaled to
  // its own output rect — the crop is source pixels and the scale is output
  // pixels, exactly as for a cell, with no conversion between them.
  const customLegs = customs.map(
    (c, j) =>
      `[k${j}]crop=${c.crop.w}:${c.crop.h}:${c.crop.x}:${c.crop.y},` +
      `scale=${c.out.w}:${c.out.h}:flags=lanczos[t${j}]`,
  );

  // Chained overlays rather than a second xstack: xstack composes a tiling,
  // and a floating piece is an overlap by definition. Array order is z
  // order, last on top.
  let base = "[stack]";
  const overlays = customs.map((c, j) => {
    const step = `${base}[t${j}]overlay=${c.out.x}:${c.out.y}[o${j}]`;
    base = `[o${j}]`;
    return step;
  });

  return [
    `[0:v]split=${cells.length + customs.length}${inputs}${customInputs}`,
    ...legs,
    `${scaled}xstack=inputs=${cells.length}:layout=${positions}[stack]`,
    ...customLegs,
    ...overlays,
    // The frame overlay is still last: it arbitrates between the pieces and
    // the gutters (see maskRgba's priority order), so it must see the
    // finished composite including the floating pieces.
    `${base}[1:v]overlay=0:0:format=auto[v]`,
  ].join(";");
}

/** Numbers are the one thing interpolated into the filter string, and a NaN
 *  or out-of-bounds rect makes ffmpeg fail unreadably. Same isValidBox the
 *  client editor uses, so there is one definition of a legal rect — checked
 *  per box against *its own cell's* ratio, because a flawless 9:8 rect is
 *  still illegal for a 540x960 cell and would export stretched. */
export function assertBoxes(layout: Layout, boxes: Rect[], source: Size): void {
  const cells = cellsOf(layout);
  if (!Array.isArray(boxes) || boxes.length !== cells.length) {
    throw new Error(
      `Layout ${layout.id} needs ${cells.length} boxes, got ` +
        `${Array.isArray(boxes) ? String(boxes.length) : typeof boxes}.`,
    );
  }
  cells.forEach((cell, i) => {
    const rect = boxes[i];
    const ratio = ratioOf(cell);
    if (rect === undefined || !isValidBox(rect, source, ratio)) {
      throw new Error(
        `Invalid box ${i + 1} ${JSON.stringify(rect)} for source ` +
          `${source.w}x${source.h}: must be integers, ${cell.w}:${cell.h} ` +
          `(w = round(h * ${ratio})), and fully inside the frame.`,
      );
    }
  });
}

/** The floating pieces' version of assertBoxes, and for the same reason:
 *  numbers are the one thing interpolated into the filter string. Legality
 *  is `isValidCustom` — the same predicate `restore` runs on the client — so
 *  a box cannot preview cleanly and die at export. */
export function assertCustoms(customs: CustomBox[], source: Size): void {
  if (!Array.isArray(customs)) {
    throw new Error(`customs must be an array, got ${typeof customs}.`);
  }
  if (customs.length > MAX_CUSTOM) {
    throw new Error(`At most ${MAX_CUSTOM} custom boxes, got ${customs.length}.`);
  }
  customs.forEach((custom, i) => {
    if (!isValidCustom(custom, source)) {
      throw new Error(
        `Invalid custom box ${i + 1} ${JSON.stringify(custom)} for source ` +
          `${source.w}x${source.h}: out must be even integers, at least ` +
          `${MIN_OUT_SIDE} per side, inside ${OUTPUT.w}x${OUTPUT.h}; crop must ` +
          `be integers matching that box's own ratio and inside the source.`,
      );
    }
  });
}

export async function exportClip(opts: ExportOpts): Promise<string> {
  assertBoxes(opts.layout, opts.boxes, opts.source);
  assertCustoms(opts.customs ?? [], opts.source);
  if (!Number.isFinite(opts.start) || opts.start < 0) {
    throw new Error(`Invalid start ${opts.start}: must be a non-negative number of seconds.`);
  }
  if (!Number.isFinite(opts.duration) || opts.duration <= 0) {
    throw new Error(`Invalid duration ${opts.duration}: must be a positive number of seconds.`);
  }
  try {
    await run(
      "ffmpeg",
      [
        "-v", "error",
        "-i", opts.input,
        // Input 1, the frame overlay. -loop 1 makes the single PNG frame an
        // endless stream so overlay has something for every main frame; the
        // output -t is what bounds it. Both inputs must be declared before
        // -ss, or -ss would attach to this one as an input option instead of
        // staying an output option on the clip.
        "-loop", "1", "-i", opts.mask,
        // -ss AFTER -i is frame-accurate. Before -i it snaps to a keyframe
        // and drifts up to ~2s; decoding the pad is what buys the accuracy.
        "-ss", String(opts.start),
        // -t (duration) not -to, which is ambiguous after a seek.
        "-t", String(opts.duration),
        "-filter_complex", buildFilter(opts.layout, opts.boxes, opts.customs ?? []),
        "-map", "[v]",
        // The ? makes audio optional so a silent source still exports.
        "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        "-y", opts.out,
      ],
      { maxBuffer: 16 << 20 },
    );
  } catch (err) {
    throw toolError("ffmpeg", err);
  }
  return opts.out;
}

/** One leg of a stitch: a cached clip, and the range *within that file* to
 *  keep. Offsets, not source-timeline seconds — the caller has already
 *  subtracted the part's own `windowStart`, which exists because every part
 *  is fetched with `PAD` around it. */
export type ConcatPart = { path: string; start: number; end: number };

// The stitch is an intermediate: `/api/export` re-encodes it. A slightly
// higher quality than the export's own crf 20 keeps this generation from
// being the one that shows.
const CONCAT_CRF = "18";
const CONCAT_RATE = 44100;

/** Concatenates the kept ranges of several clips into one continuous file.
 *
 *  Every leg is normalised before `concat` sees it, because `concat` REFUSES
 *  a mismatch rather than picking a side — a SAR difference fails with
 *  `Nothing was written into output file`, which names nothing. The same
 *  lesson `prependStarter` already carries for its three legs:
 *
 *  - `scale` + `setsar=1` + `fps` + `format=yuv420p` on video, all off part
 *    one's own probe. Parts of one video normally match, but the download
 *    ladder can land different rungs on different calls.
 *  - `aresample` + `aformat` on audio, since `concat` requires one sample
 *    rate and one channel layout across every leg too.
 *
 *  A part with no audio is given a leg cut out of a single `anullsrc` input,
 *  appended LAST so the real parts' input indices never move — the same
 *  positional rule `prependStarter`'s silence stand-in follows. */
export async function concatClips(parts: ConcatPart[], out: string): Promise<string> {
  const first = parts[0];
  if (first === undefined) throw new Error("concatClips needs at least one part.");

  const probed = await Promise.all(parts.map((p) => probeFile(p.path)));
  const shape = probed[0];
  if (shape === undefined) throw new Error("concatClips could not probe its first part.");

  const anySilent = probed.some((p) => !p.hasAudio);
  // Appended last, and only when needed, so a stitch of sounded parts has
  // exactly the inputs it did before this branch existed.
  const silenceIndex = parts.length;

  const inputs: string[] = [];
  for (const part of parts) inputs.push("-i", part.path);
  if (anySilent) {
    inputs.push("-f", "lavfi", "-i", `anullsrc=r=${CONCAT_RATE}:cl=stereo`);
  }

  const legs: string[] = [];
  const labels: string[] = [];
  parts.forEach((part, i) => {
    const p = probed[i];
    const hasAudio = p?.hasAudio === true;
    legs.push(
      `[${i}:v]trim=${part.start}:${part.end},setpts=PTS-STARTPTS,` +
        `scale=${shape.width}:${shape.height},setsar=1,fps=${shape.fps},` +
        `format=yuv420p[v${i}]`,
    );
    // A silent part's leg is cut out of the shared anullsrc input instead,
    // trimmed to this part's own length so the two streams stay in step.
    const audioSrc = hasAudio ? `${i}:a` : `${silenceIndex}:a`;
    const from = hasAudio ? part.start : 0;
    const to = hasAudio ? part.end : part.end - part.start;
    legs.push(
      `[${audioSrc}]atrim=${from}:${to},asetpts=PTS-STARTPTS,` +
        `aresample=${CONCAT_RATE},` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`,
    );
    labels.push(`[v${i}][a${i}]`);
  });
  legs.push(`${labels.join("")}concat=n=${parts.length}:v=1:a=1[v][a]`);

  try {
    await run(
      "ffmpeg",
      [
        "-v", "error",
        ...inputs,
        "-filter_complex", legs.join(";"),
        "-map", "[v]",
        "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", CONCAT_CRF,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        "-y", out,
      ],
      { maxBuffer: 16 << 20 },
    );
  } catch (err) {
    throw toolError("ffmpeg", err);
  }
  return out;
}

/** The first frame of a finished export, as a 1280x720 JPEG — which for a
 *  vstack output is the starter screen: the blurred opening frame with the
 *  title over it. There is nothing to render here, only a frame to lift and
 *  reshape.
 *
 *  Two shapes, because YouTube wants two different pictures:
 *
 *  - `"wide"` — 1280x720, scaled to *cover* and cropped. This is what
 *    `thumbnails.set` takes. Uploading the raw 1080x1920 frame instead gets
 *    it pillarboxed into a 32%-wide strip with black either side, which at
 *    the tile size a thumbnail is actually viewed reads as blank.
 *  - `"tall"` — the source's own shape, untouched. This is the one saved
 *    beside the export, because Studio's *Shorts* thumbnail slot is 9:16 and
 *    no Data API v3 method can fill it — that upload is a manual job, and
 *    this is the file to drag into it.
 *
 *  Cropping is safe because `renderTitleArt` centres the title block
 *  vertically (`OUTPUT.h / 2`), and the crop is 607px of source height taken
 *  around that same centre. Its limit: lines are 180px at `MAX_SIZE`, so a
 *  title of four or more lines loses its outer lines from the *thumbnail*.
 *  The video itself is untouched either way.
 *
 *  `-q:v 3` rather than lossless because `thumbnails.set` refuses anything
 *  over 2 MB.
 *
 *  The caller owns `out` and must put it somewhere disposable — never in
 *  OUT_DIR, which is servable and is swept by nothing. */
export async function firstFrame(
  input: string,
  out: string,
  shape: "wide" | "tall",
): Promise<string> {
  // increase + crop, not decrease + pad: cover the 16:9 box and trim the
  // overflow, rather than fitting inside it and filling the rest with bars.
  const wide = ["-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720"];
  try {
    await run(
      "ffmpeg",
      [
        "-v", "error",
        "-i", input,
        "-frames:v", "1",
        ...(shape === "wide" ? wide : []),
        "-q:v", "3",
        "-y", out,
      ],
      { maxBuffer: 16 << 20 },
    );
  } catch (err) {
    throw toolError("ffmpeg", err);
  }
  return out;
}
