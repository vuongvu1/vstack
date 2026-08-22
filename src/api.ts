import type { Rect } from "./geometry.ts";

export type ProbeResult = {
  videoId: string;
  duration: number;
  width: number;
  height: number;
  title: string;
  isLive: boolean;
};

export type WindowResult = {
  clipUrl: string;
  windowStart: number;
  windowEnd: number;
  width: number;
  height: number;
};

// Both "nothing answered" and "the proxy answered for a backend that isn't
// there" have the same fix, so they share one message.
const BACKEND_DOWN =
  "Backend not reachable \u2014 start it with `pnpm server` in a second terminal.";

async function post(path: string, body: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
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

export async function probe(url: string): Promise<ProbeResult> {
  return (await post("/api/probe", { url })).json() as Promise<ProbeResult>;
}

export async function fetchWindow(
  videoId: string,
  start: number,
  end: number,
  duration: number,
): Promise<WindowResult> {
  return (await post("/api/window", { videoId, start, end, duration }))
    .json() as Promise<WindowResult>;
}

export async function exportClip(body: {
  videoId: string;
  windowStart: number;
  windowEnd: number;
  start: number;
  end: number;
  /** The starter screen's title. Spoken aloud by the server, names the
   *  downloaded file, and required. */
  starterTitle: string;
  /** The same title as a transparent 1080x1920 PNG, bare base64. Rendered
   *  here because the server's ffmpeg has no `drawtext` — see
   *  `renderTitleArt` in `starter.ts`. */
  titlePng: string;
  layoutId: string;
  boxes: Rect[];
}): Promise<Blob> {
  return (await post("/api/export", body)).blob();
}
