import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { probe, videoIdFrom } from "./ytdlp.ts";

const run = promisify(execFile);
const PORT = 8787;

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

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
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "Body is not valid JSON.");
  }
}

export function send(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

const server = createServer((req, res) => {
  void route(req, res).catch((err: Error) => {
    console.error(err);
    const status = err instanceof HttpError ? err.status : 500;
    send(res, status, { error: err.message });
  });
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });

  if (req.url === "/api/probe") {
    const { url } = await json<{ url?: unknown }>(req);
    if (typeof url !== "string") return send(res, 400, { error: "Expected a JSON body with a url string." });
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

  return send(res, 404, { error: `No route ${req.url}` });
}

await checkBinaries();
server.listen(PORT, () => {
  console.warn(`vstack server on http://localhost:${PORT}`);
});
