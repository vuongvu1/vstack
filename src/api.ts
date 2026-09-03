import type { Rect } from "./geometry.ts";
import type { CustomBox } from "./custom.ts";
import type { Segment } from "./segments.ts";
import { UPLOAD_MAX_BYTES } from "./defaults.ts";

export type ProbeResult = {
  videoId: string;
  duration: number;
  width: number;
  height: number;
  title: string;
  liveStatus: string;
};

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

// Both "nothing answered" and "the proxy answered for a backend that isn't
// there" have the same fix, so they share one message.
const BACKEND_DOWN =
  "Backend not reachable \u2014 start it with `pnpm server` in a second terminal.";

/** Everything both senders share: the network-down translation and the
 *  server's own error body. Extracted from `post` when `upload` arrived —
 *  it sends raw bytes rather than JSON but wants identical failure
 *  reporting, and duplicating this is how the two would drift. */
async function send(path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    // Nothing answered at all — no dev server, or it refused the connection.
    // fetch() rejects with an opaque "TypeError: Failed to fetch" that means
    // nothing to a user, so this replaces it with something actionable.
    throw new Error(BACKEND_DOWN);
  }
  if (!res.ok) {
    // The server hands back yt-dlp/ffmpeg output verbatim; show it verbatim.
    const text = await res.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* not JSON — use the raw text */
    }
    // Every backend failure answers through send(res, code, { error }), so a
    // failure carrying no body at all did not come from the backend: it is
    // Vite's dev proxy reporting it has nothing to forward to. Naming that
    // matters — "Request failed: 502 Bad Gateway" sends you reading app code
    // when the fix is starting a process. An empty `message` also renders as
    // a falsy state.error, so the busy spinner would vanish showing nothing.
    if (!message) {
      throw new Error(
        res.status >= 502 && res.status <= 504
          ? BACKEND_DOWN
          : `Request failed: ${res.status} ${res.statusText}`,
      );
    }
    throw new Error(message);
  }
  return res;
}

async function post(path: string, body: unknown): Promise<Response> {
  return send(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export type UploadResult = { id: string; duration: number; width: number; height: number };

/** Sends one file's raw bytes to `/api/upload`.
 *
 *  Not `post`: the body is the file itself, not JSON. `multipart/form-data`
 *  would need a parser on the other end that this dependency-free server
 *  does not have, and buys nothing for a single file over loopback — the
 *  platform streams a `File` body for free.
 *
 *  The size check is here as well as on the server, and the split is
 *  deliberate: the server DESTROYS the socket past the cap (answering
 *  politely would mean reading the whole thing first, which is the cost the
 *  cap exists to avoid), and a destroyed socket surfaces as `BACKEND_DOWN`
 *  — "start the backend" for a file that is simply too big. This is what
 *  turns that into a sentence the user can act on. The server's check is
 *  still the actual boundary. */
export async function upload(file: File): Promise<UploadResult> {
  if (file.size > UPLOAD_MAX_BYTES) {
    throw new Error(
      `${file.name} is ${(file.size / 1e6).toFixed(0)} MB — the limit is ` +
        `${Math.round(UPLOAD_MAX_BYTES / 1e6)} MB.`,
    );
  }
  const res = await send("/api/upload", {
    method: "POST",
    headers: { "content-type": "video/mp4" },
    body: file,
  });
  return res.json() as Promise<UploadResult>;
}

/** What `/api/stack` answers with — the same three fields `/api/export`
 *  returns. `url` already carries the file's mtime as a cache-buster, for
 *  the same reason the export's does.
 *
 *  The server also sends `duration`, which this type omits: nothing on the
 *  client consumes it today. Extra JSON properties are ignored, so adding it
 *  back is a one-line change the day something wants to show it. */
export type StackResult = { name: string; url: string; size: number };

/** Renders the uploaded parts, in the order given, into one horizontal
 *  video. `ids` are the UUIDs `upload` returned — never paths, and never
 *  the local filenames, which the server has no idea about. */
export async function stack(body: { ids: string[]; title: string }): Promise<StackResult> {
  return (await post("/api/stack", body)).json() as Promise<StackResult>;
}

export async function probe(url: string): Promise<ProbeResult> {
  return (await post("/api/probe", { url })).json() as Promise<ProbeResult>;
}

export async function fetchWindow(
  videoId: string,
  segments: Segment[],
  duration: number,
): Promise<WindowResult> {
  return (await post("/api/window", { videoId, segments, duration }))
    .json() as Promise<WindowResult>;
}

/** One clip already in `media/`. Same shape `fetchWindow` answers with plus
 *  the id, so opening a cached clip reaches framing through the same fields a
 *  fresh download does. */
export type CachedClip = WindowResult & { videoId: string };

/** Everything in the media cache, newest first — the idle screen's second way
 *  in. Nothing to send: the server scans its own cache directory. */
export async function clips(): Promise<CachedClip[]> {
  const body = (await (await post("/api/clips", {})).json()) as { clips: CachedClip[] };
  return body.clips;
}

/** What `/api/export` answers with now that it leaves the file on disk
 *  instead of streaming it back. `url` already carries the file's mtime as a
 *  cache-buster — the name is stable across re-exports, so re-showing the
 *  previous render is otherwise exactly what a <video> would do. */
export type ExportResult = { name: string; url: string; size: number };

export async function exportClip(body: {
  videoId: string;
  windowStart: number;
  windowEnd: number;
  start: number;
  end: number;
  /** A stitch's segment digest, `""` for an ordinary clip. The server
   *  rebuilds the cache path from window bounds plus this — it is 8 hex
   *  characters, never a path. */
  digest: string;
  /** The starter screen's title. Spoken aloud by the server, names the
   *  downloaded file, and required. */
  starterTitle: string;
  /** What to read aloud instead of `starterTitle`. `""` means "read
   *  `starterTitle`" — the fallback is applied server-side, so this side
   *  sends the field raw rather than resolving it twice. */
  voiceTitle: string;
  /** The same title as a transparent 1080x1920 PNG, bare base64. Rendered
   *  here because the server's ffmpeg has no `drawtext` — see
   *  `renderTitleArt` in `starter.ts`. */
  titlePng: string;
  layoutId: string;
  boxes: Rect[];
  /** Floating pieces over the layout, in z order — last on top. Always
   *  sent, empty when there are none. */
  customs: CustomBox[];
  /** Which preset reads the title. Validated server-side against the engine's
   *  own table — it reaches a subprocess as argv. */
  voice: string;
  /** The render this one replaces, deleted server-side once the new file is
   *  in place — so a re-export after a mark or title edit leaves one final
   *  version rather than two. `""` on the first export of a session. */
  prev: string;
}): Promise<ExportResult> {
  return (await post("/api/export", body)).json() as Promise<ExportResult>;
}

export type Voice = { name: string; gender: string; region: string; style: string };

/** The speech presets, for the framing bar's dropdown. Answered from the
 *  server's boot cache, so it cannot disagree with what `exportClip` accepts. */
export async function voices(): Promise<{ voices: Voice[]; default: string }> {
  return (await post("/api/voices", {})).json() as Promise<{
    voices: Voice[];
    default: string;
  }>;
}

/** The title spoken in one voice, as a WAV, for the Try button. A blob rather
 *  than a URL because the sample is never written anywhere servable — the
 *  route answers the bytes and keeps nothing. */
export async function say(body: {
  starterTitle: string;
  voiceTitle: string;
  voice: string;
}): Promise<Blob> {
  return (await post("/api/say", body)).blob();
}

export async function reveal(name: string): Promise<void> {
  await post("/api/reveal", { name });
}

export async function publish(body: {
  name: string;
  title: string;
  description: string;
  tags: string;
  /** Whether this upload is a Short. `#shorts` in the description is what
   *  classifies it, and a long-form compilation carrying that tag is
   *  misfiled at the platform level — so this is `false` for a stack and
   *  `true` for everything the short journey produces. Required here rather
   *  than optional: the caller always knows which journey it is on, and a
   *  default would let a new call site get it wrong silently. */
  shorts: boolean;
}): Promise<{ videoId: string; url: string; thumbnail: boolean }> {
  return (await post("/api/publish", body)).json() as Promise<{
    videoId: string;
    url: string;
    /** Whether the starter screen was accepted as the video's thumbnail.
     *  False is not a failed publish — the video is up either way; the
     *  usual cause is a channel that was never phone-verified. */
    thumbnail: boolean;
  }>;
}

export async function publishProgress(): Promise<{ sent: number; total: number }> {
  return (await post("/api/publish/progress", {})).json() as Promise<{
    sent: number;
    total: number;
  }>;
}
