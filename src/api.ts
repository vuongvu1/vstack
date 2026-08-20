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

async function post(path: string, body: unknown): Promise<Response> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // The server hands back yt-dlp/ffmpeg output verbatim; show it verbatim.
    const text = await res.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* not JSON — use the raw text */
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
  title: string;
  boxTop: Rect;
  boxBottom: Rect;
}): Promise<Blob> {
  return (await post("/api/export", body)).blob();
}
