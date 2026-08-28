import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { PAD } from "../src/geometry.ts";
import { totalDuration } from "../src/segments.ts";
import type { Segment } from "../src/segments.ts";
import { HttpError, toolError } from "./errors.ts";
import {
  MEDIA_DIR,
  clipName,
  clipPath,
  concatClips,
  probeFile,
  reportCache,
  segmentDigest,
} from "./ffmpeg.ts";
import type { ConcatPart } from "./ffmpeg.ts";

const run = promisify(execFile);
const BIG = 64 << 20; // yt-dlp --dump-json on a long video is multi-MB

export type ProbeResult = {
  videoId: string;
  duration: number;
  width: number;
  height: number;
  title: string;
  isLive: boolean;
};

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

const HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

/** Accepts watch?v=, youtu.be/, /shorts/, /live/ and /embed/ forms.
 *  Returns null for anything that is not an 11-char YouTube id, so a bad
 *  URL is rejected before any process is spawned. */
export function videoIdFrom(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return ID_RE.test(url.trim()) ? url.trim() : null;
  }
  if (!HOSTS.has(parsed.hostname)) return null;
  const fromQuery = parsed.searchParams.get("v");
  const last = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
  const candidate = fromQuery ?? last;
  return ID_RE.test(candidate) ? candidate : null;
}

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export async function probe(videoId: string): Promise<ProbeResult> {
  let stdout: string;
  let j: Record<string, unknown>;
  try {
    ({ stdout } = await run(
      "yt-dlp",
      ["--dump-json", "--no-warnings", "--no-playlist", watchUrl(videoId)],
      { maxBuffer: BIG },
    ));
    j = JSON.parse(stdout) as Record<string, unknown>;
  } catch (err) {
    throw toolError("yt-dlp", err);
  }
  return {
    videoId,
    duration: Number(j.duration ?? 0),
    width: Number(j.width ?? 0),
    height: Number(j.height ?? 0),
    title: String(j.title ?? videoId),
    isLive: Boolean(j.is_live),
  };
}

export type WindowResult = {
  clipUrl: string;
  windowStart: number;
  windowEnd: number;
  /** The range of the *clip file* that is the finished cut. For a single
   *  segment these are the user's marks, so the export request is
   *  unchanged; for a stitch the clip has its own timeline and these are
   *  `0` and its probed duration. `doExport` sends these, never the marks. */
  clipStart: number;
  clipEnd: number;
  /** A stitch's segment digest, `""` for an ordinary single-range clip.
   *  `/api/export` needs it to rebuild the cache path, and cannot recompute
   *  it — the `listClips` reopen path has no segments to hash. */
  digest: string;
  width: number;
  height: number;
};

const DASH = "bv*[height<=1080]+ba[ext=m4a]/bv*[height<=1080]+ba";

/** One rung of the download ladder: a format selector, and optionally the
 *  yt-dlp extractor client to ask for formats as. `client` omitted means
 *  yt-dlp's default, which on 2026.07.04 is ANDROID_VR. */
type Attempt = { format: string; client?: string };

/** Tried in order — complementary, not redundant. yt-dlp's own `/` fallback
 *  inside a single selector cannot cover these, because the 403 happens at
 *  *download* time, after yt-dlp has committed to a format — so the retry
 *  has to live here. Every rung caps at 1080p so a 4K source doesn't pull
 *  far more than a 1080-wide output needs.
 *
 *  Rung 1 (web_embedded) is first because it is the only client measured to
 *  deliver 1080p on *both* test videos. The default ANDROID_VR client 403s
 *  at download time on both, so leading with it meant every fetch paid two
 *  doomed attempts — minutes of throttled transfer — before reaching a rung
 *  that works.
 *
 *  Rungs 2 and 3 are kept as fallbacks, not because they are better, but
 *  because web_embedded is one client and YouTube breaks clients one at a
 *  time; rung 3 in particular still covers videos whose only muxed
 *  rendition is progressive itag 18.
 *
 *  Clients ruled out by measurement against 1Q12mcu4JTs (a 4h video with no
 *  HLS rendition at all — every PROTO is https, so `best` can only reach
 *  itag 18): `mweb` downloads, but exposes *only* 640x360, and crop rects
 *  are stored in source pixels, so a 360p clip silently degrades every
 *  export; `tv_embedded` advertises 1080p then 403s; `android`, `tv_simply`
 *  cap at 360p; `web`, `web_safari`, `ios` return no usable formats; `tv`
 *  demands a reload; `web_creator` demands sign-in.
 *
 *  Verified directly against `yt-dlp` on the CLI, independent of this
 *  codebase. Revisit once yt-dlp/YouTube compatibility catches up. */
const ATTEMPTS: Attempt[] = [
  { format: DASH, client: "web_embedded" },
  { format: DASH },
  { format: "best[height<=1080]/best" },
];

/** One already-fetched clip in `media/`, in exactly the shape `fetchWindow`
 *  answers with plus the id its directory is named after — so the idle
 *  screen's "open a cached clip" path lands in framing through the same
 *  client code a fresh download does. */
export type CachedClip = WindowResult & { videoId: string };

/** Anchored, and deliberately narrow. The optional third group is a stitch's
 *  segment digest — exactly 8 lowercase hex characters, which is what
 *  `segmentDigest` emits and nothing else. */
const CLIP_RE = /^(\d+)-(\d+)(?:-([0-9a-f]{8}))?\.mp4$/;

/** The window bounds and optional stitch digest a cache filename encodes, or
 *  null if the name is not one `clipName` could have written.
 *
 *  This is `listClips`'s filter, and it is strict for two reasons that both
 *  fail silently. A fetch in progress leaves `<name>.<uuid>.part.mp4` beside
 *  the finished clips, and that file is truncated by definition — offering
 *  it would hand the framing phase a broken video. And the values returned
 *  here are what `/api/export` later rebuilds a path from via `clipPath`, so
 *  anything that is not two plain integers plus an optional hex digest has
 *  no business becoming a row. Names come off `readdir` and so cannot
 *  contain a separator, but the anchored pattern covers that too rather than
 *  relying on it — and a partial's extra `.` still cannot match. */
export function parseClipName(
  name: string,
): { windowStart: number; windowEnd: number; digest: string } | null {
  const m = CLIP_RE.exec(name);
  if (!m) return null;
  const windowStart = Number(m[1]);
  const windowEnd = Number(m[2]);
  // `/api/export` rejects a window whose end is not after its start, so a
  // row built from one would be dead on arrival. Nothing writes such a name;
  // a hand-dropped file could.
  if (!(windowEnd > windowStart)) return null;
  return { windowStart, windowEnd, digest: m[3] ?? "" };
}

/** Every clip already in the cache, newest first.
 *
 *  Dimensions come from `probeFile`, not from the filename or the browser:
 *  crop rects are stored in the delivered clip's own pixels, so this has to
 *  agree with what `fetchWindow` reports for the same file.
 *
 *  ponytail: one ffprobe per clip on every call, and the route is called once
 *  per page load. Fine at the dozens of clips a `media/` directory holds in
 *  practice (~30ms each); cache on mtime if it ever grows to hundreds. */
export async function listClips(): Promise<CachedClip[]> {
  const dirs = await readdir(MEDIA_DIR, { withFileTypes: true }).catch(() => []);
  const clips: (CachedClip & { mtime: number })[] = [];
  for (const dir of dirs) {
    // The id check drops `masks/` for free, and keeps a stray directory from
    // reaching clipPath.
    if (!dir.isDirectory() || !ID_RE.test(dir.name)) continue;
    const videoId = dir.name;
    const names = await readdir(join(MEDIA_DIR, videoId)).catch(() => []);
    for (const name of names) {
      const bounds = parseClipName(name);
      if (!bounds) continue;
      // The name readdir handed us, NOT a rebuild from the parsed bounds:
      // clipPath(videoId, windowStart, windowEnd) silently drops a stitch's
      // digest, so every stitch would fail to probe and never be listed.
      // parseClipName has already validated this name character by
      // character, which is what makes using it directly safe.
      const path = join(MEDIA_DIR, videoId, name);
      const probed = await probeFile(path).catch(() => null);
      if (!probed) continue;
      const { mtimeMs } = await stat(path).catch(() => ({ mtimeMs: 0 }));
      clips.push({
        videoId,
        clipUrl: `/media/${videoId}/${name}`,
        ...bounds,
        // The marks cover the whole cached clip: framing has no marking
        // controls, so the alternative is a window whose edges the user
        // cannot reach. For a stitch that is its entire timeline anyway.
        clipStart: bounds.windowStart,
        // Clamped to the probed file, NOT the filename's own windowEnd —
        // the same reason `fetchWindow`'s stitch leg clamps `clipEnd` to
        // `probed.seconds` rather than trusting the ceil'd total the name
        // carries. `probed` is already in hand from the probeFile call
        // above, so this costs nothing extra. Skipping it broke `outName`'s
        // "re-exporting overwrites rather than accumulating": a segment sum
        // just under a whole second (e.g. 34.2s, filename `0-35`) would
        // export `-0035.mp4` on a fresh cut but `-0034.mp4` on export after
        // reopening this same row, since only the reopen path clamped to the
        // probe. This formula covers a plain clip too — its probed duration
        // is ~`windowEnd - windowStart`, so `windowStart + probed.seconds`
        // lands at ~`windowEnd` and only bites if the fetched file actually
        // came up short.
        clipEnd: Math.min(bounds.windowEnd, bounds.windowStart + probed.seconds),
        width: probed.width,
        height: probed.height,
        mtime: mtimeMs,
      });
    }
  }
  // Newest first: the clip you just fetched is the one you are most likely
  // to reopen.
  clips.sort((a, b) => b.mtime - a.mtime);
  return clips.map(({ mtime: _mtime, ...clip }) => clip);
}

/** Fetches (and caches) `[start − PAD, end + PAD]` clamped to the video's
 *  own bounds, then reports the clip's *actual* dimensions via ffprobe —
 *  yt-dlp picks a format, so the fetched resolution can differ from what
 *  --dump-json advertised, and crop rects are stored in source pixels.
 *
 *  Module-private: `fetchWindow` below is the only public entry point, and
 *  calls this once per segment. */
async function fetchOne(
  videoId: string,
  start: number,
  end: number,
  duration: number,
): Promise<WindowResult> {
  const windowStart = Math.max(0, Math.floor(start - PAD));
  const windowEnd = Math.min(
    Math.ceil(end + PAD),
    Math.ceil(duration) || Number.POSITIVE_INFINITY,
  );
  if (windowEnd <= windowStart) {
    throw new HttpError(
      400,
      `Requested window [${windowStart}, ${windowEnd}] is empty for a ${duration}s video.`,
    );
  }
  const path = clipPath(videoId, windowStart, windowEnd);

  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true });
    // Download to a `.part` sibling and rename only on success. --downloader
    // ffmpeg writes straight to -o with no .part convention of its own, so
    // without this a killed or failed fetch leaves a truncated mp4 at the
    // exact cache path — existsSync(path) must never be true for a
    // half-written clip, or the next request serves it as a broken cache hit.
    // Must end in .mp4: with --merge-output-format mp4, yt-dlp appends the
    // container extension whenever -o does not already carry it, which
    // would otherwise put the real output at `<path>.part.mp4` while this
    // code renamed from `<path>.part` — a mismatch that silently masked a
    // successful download as a failed one.
    // A per-call random suffix — NOT `process.pid` — keeps two concurrent
    // fetches of the same window (e.g. a reload mid-fetch followed by
    // pressing Continue again) from writing the same `.part.mp4`. This was
    // verified against a real race: `process.pid` is the *Node server's*
    // pid, constant for the life of the process, and F4's loopback bind
    // means exactly one such process can ever hold this port — so two
    // concurrent requests for the same window are two concurrent calls
    // *inside that one process*, both computing the identical
    // `${path}.${process.pid}.part.mp4` and stepping on each other's
    // partial (reproduced live: yt-dlp errored on a file the other
    // request's yt-dlp had already moved past). Without a per-call
    // identifier, the first to finish renames over a still-being-written
    // file and existsSync(path) then serves that corrupt clip forever —
    // precisely the poisoned cache the .part convention exists to
    // prevent. Last-writer-wins on the rename is fine once each writer has
    // its own, complete, partial file.
    const partial = `${path}.${randomUUID()}.part.mp4`;
    // Every selector's failure is kept, not just the last one. The formats
    // fail for *different* reasons — DASH 403 vs progressive-itag-18 403 —
    // so reporting only the final attempt hides the half that says whether
    // this video is genuinely unsupported or the extractor has gone stale.
    // Diagnosing a real 403 meant re-running both selectors by hand on the
    // CLI purely to recover the error this loop had already seen.
    const failures: string[] = [];
    let fetched = false;
    for (const { format, client } of ATTEMPTS) {
      // Spelled out per rung rather than appended conditionally to a shared
      // array, so one rung's args can never leak into the next iteration.
      const clientArgs = client
        ? ["--extractor-args", `youtube:player_client=${client}`]
        : [];
      try {
        await run(
          "yt-dlp",
          [
            ...clientArgs,
            "-f",
            format,
            "--download-sections",
            `*${windowStart}-${windowEnd}`,
            "--downloader",
            "ffmpeg",
            "--merge-output-format",
            "mp4",
            "--no-playlist",
            "--no-warnings",
            "-o",
            partial,
            watchUrl(videoId),
          ],
          { maxBuffer: BIG },
        );
        await rename(partial, path);
        console.warn(
          `vstack: fetched ${videoId} ${windowStart}-${windowEnd} using ` +
            `format "${format}"${client ? ` (player_client=${client})` : ""}`,
        );
        fetched = true;
        break;
      } catch (err) {
        // The selector goes in the tool name so toolError's stderr-tail
        // handling is reused verbatim rather than reimplemented here.
        failures.push(
          toolError(
            `yt-dlp -f ${format}${client ? ` (player_client=${client})` : ""}`,
            err,
          ).message,
        );
        // Each attempt cleans up its own partial before the next one starts
        // — otherwise a stale partial from a failed attempt could be renamed
        // as if a later attempt had succeeded.
        await rm(partial, { force: true });
      }
    }
    if (!fetched) {
      throw new Error(
        `Could not fetch ${videoId} [${windowStart}-${windowEnd}] — ` +
          `all ${ATTEMPTS.length} download attempts failed.\n\n` +
          failures.join("\n\n"),
      );
    }

    // Check the assumption rather than trusting it: a silent mismatch
    // between where yt-dlp actually wrote the file and where this code
    // looked for it is exactly what hid the .part/.part.mp4 bug above, and
    // would hide the next one just as quietly.
    if (!existsSync(path)) {
      const dirEntries = await readdir(dirname(path)).catch(() => []);
      throw new Error(
        `yt-dlp reported success but ${path} does not exist. ` +
          `Directory contents: ${dirEntries.join(", ") || "(empty)"}`,
      );
    }
    // Reported again here, not just at server boot — a long session that
    // only logged the cache size once would grow it silently until the
    // next restart.
    reportCache();
  }

  const { width, height } = await probeFile(path);
  return {
    clipUrl: `/media/${videoId}/${clipName(windowStart, windowEnd)}`,
    windowStart,
    windowEnd,
    // A single range's clip IS a contiguous slice of the source, so clip
    // time and source time differ by the constant `windowStart` that
    // /api/export already subtracts. These are the marks, and the export
    // request is byte-identical to what it was before segments existed.
    clipStart: start,
    clipEnd: end,
    digest: "",
    width,
    height,
  };
}

/** Fetches (and caches) the clip the framing phase will crop.
 *
 *  One segment is today's path exactly — same PAD, same download ladder,
 *  same `<windowStart>-<windowEnd>.mp4` name, so every clip already in
 *  `media/` still hits and the common case cannot regress into the new
 *  code at all.
 *
 *  Several segments are fetched as several ordinary clips and then stitched.
 *  Fetching each part through `fetchOne` rather than pulling the whole span
 *  between the first and last mark is what keeps two ten-second parts an
 *  hour apart from downloading an hour of video — and it means each part is
 *  independently cached and shared with a plain single-range fetch of the
 *  same bounds, so re-cutting re-downloads nothing.
 *
 *  Callers must have validated `segments` with `isValidSegments` first;
 *  `/api/window` does, before any subprocess spawns. */
export async function fetchWindow(
  videoId: string,
  segments: Segment[],
  duration: number,
): Promise<WindowResult> {
  const only = segments[0];
  if (only === undefined) {
    throw new HttpError(400, "At least one segment is required.");
  }
  if (segments.length === 1) return fetchOne(videoId, only.start, only.end, duration);

  const parts: ConcatPart[] = [];
  for (const seg of segments) {
    const part = await fetchOne(videoId, seg.start, seg.end, duration);
    // Offsets within the part file: every part carries PAD around its own
    // bounds, and the stitch must not.
    parts.push({
      path: clipPath(videoId, part.windowStart, part.windowEnd),
      start: seg.start - part.windowStart,
      end: seg.end - part.windowStart,
    });
  }

  const digest = segmentDigest(segments);
  // Math.ceil, not round: `clipEnd` below is clamped to this number, and a
  // name that rounded *down* would shave a fraction of a second off the cut
  // it names. The filename is an identifier either way — the probed
  // duration is the measurement.
  const total = Math.ceil(totalDuration(segments));
  const path = clipPath(videoId, 0, total, digest);

  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true });
    // Written under a partial and renamed on success, the same as the
    // download above and for the same two reasons: existsSync(path) must
    // never be true for a half-written clip, and a UUID (not process.pid,
    // which is constant for the life of this one server) keeps two
    // concurrent stitches of the same cut off each other's open fd.
    const partial = `${path}.${randomUUID()}.part.mp4`;
    try {
      await concatClips(parts, partial);
      await rename(partial, path);
    } finally {
      await rm(partial, { force: true });
    }
    reportCache();
  }

  const probed = await probeFile(path);
  return {
    clipUrl: `/media/${videoId}/${clipName(0, total, digest)}`,
    windowStart: 0,
    windowEnd: total,
    clipStart: 0,
    // Clamped to the name's own number: /api/export rejects an `end` past
    // `windowEnd`, and the concat's real duration can land a few
    // milliseconds either side of the sum.
    clipEnd: Math.min(probed.seconds, total),
    digest,
    width: probed.width,
    height: probed.height,
  };
}
