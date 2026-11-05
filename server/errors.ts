export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Wraps a failed spawn so the route can hand the raw tool output to the
 *  user. yt-dlp's own messages track YouTube's changes better than any
 *  taxonomy of ours would. */
export function toolError(name: string, err: unknown): Error {
  if (err === null || err === undefined) {
    return new Error(`${name} failed: unknown error`);
  }
  const e = err as { stderr?: string; message?: string };
  // `||`, not `??`: execFile reports a silent failure (signal, maxBuffer,
  // bad JSON) with `stderr: ""`, which `??` would print as nothing.
  const tail = (e.stderr?.trim() || e.message || "unknown error")
    .trim()
    .split("\n")
    .slice(-5)
    .join("\n");
  return new Error(`${name} failed:\n${tail}`);
}
