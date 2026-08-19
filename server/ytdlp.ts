import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
  const fromQuery = parsed.searchParams.get("v");
  const last = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
  const candidate = fromQuery ?? last;
  return ID_RE.test(candidate) ? candidate : null;
}

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Wraps a failed spawn so the route can hand the raw tool output to the
 *  user. yt-dlp's own messages track YouTube's changes better than any
 *  taxonomy of ours would. */
export function toolError(name: string, err: unknown): Error {
  const e = err as { stderr?: string; message?: string };
  const tail = (e.stderr ?? e.message ?? "")
    .trim()
    .split("\n")
    .slice(-5)
    .join("\n");
  return new Error(`${name} failed:\n${tail}`);
}

export async function probe(videoId: string): Promise<ProbeResult> {
  let stdout: string;
  try {
    ({ stdout } = await run(
      "yt-dlp",
      ["--dump-json", "--no-warnings", "--no-playlist", watchUrl(videoId)],
      { maxBuffer: BIG },
    ));
  } catch (err) {
    throw toolError("yt-dlp", err);
  }
  const j = JSON.parse(stdout) as Record<string, unknown>;
  return {
    videoId,
    duration: Number(j.duration ?? 0),
    width: Number(j.width ?? 0),
    height: Number(j.height ?? 0),
    title: String(j.title ?? videoId),
    isLive: Boolean(j.is_live),
  };
}
