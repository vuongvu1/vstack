import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { PAD } from "../src/geometry.ts";
import { HttpError, toolError } from "./errors.ts";
import { clipName, clipPath, probeFile, reportCache } from "./ffmpeg.ts";

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

/** Fetches (and caches) `[start − PAD, end + PAD]` clamped to the video's
 *  own bounds, then reports the clip's *actual* dimensions via ffprobe —
 *  yt-dlp picks a format, so the fetched resolution can differ from what
 *  --dump-json advertised, and crop rects are stored in source pixels. */
export async function fetchWindow(
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
    width,
    height,
  };
}
