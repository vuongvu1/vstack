import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeFile } from "./ffmpeg.ts";
import { stackWide } from "./longform.ts";

const run = promisify(execFile);

let dir = "";
let red = "";
let blue = "";
let wide = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vstack-long-"));

  // Two 1080x1920 vertical parts in different colours, both with audio. The
  // colours are what make the leg ORDER testable: reversing the concat gives
  // blue-then-red and the second sample fails.
  red = join(dir, "red.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=red:s=1080x1920:d=2:r=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-y", red,
  ]);

  // Deliberately silent: the anullsrc stand-in is exercised by the first
  // test rather than by one of its own, because a missing audio leg makes
  // the concat filter's leg count disagree with n= and fail outright.
  blue = join(dir, "blue.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=blue:s=1080x1920:d=2:r=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-y", blue,
  ]);

  // A 16:9 part, to prove an upload that is NOT vertical still lands inside
  // the frame rather than overflowing it.
  wide = join(dir, "wide.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=green:s=1920x1080:d=2:r=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-y", wide,
  ]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** One frame at `t`, decoded to raw RGB, sampled at (x, y). Thresholds
 *  rather than equality everywhere it is used: libx264 is lossy, so a solid
 *  red source frame comes back at r=254 rather than r=255. */
async function pixelAt(path: string, t: number, x: number, y: number, width = 1920) {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-ss", String(t), "-i", path, "-frames:v", "1",
     "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 64 << 20 },
  );
  const buf = stdout as unknown as Buffer;
  const i = (y * width + x) * 3;
  return { r: buf[i] ?? 0, g: buf[i + 1] ?? 0, b: buf[i + 2] ?? 0 };
}

describe("stackWide", () => {
  it("widens two vertical parts onto their own blurred backgrounds, in order", async () => {
    const out = join(dir, "stack.mp4");
    await stackWide([red, blue], out);

    const probed = await probeFile(out);
    expect(probed.width).toBe(1920);
    expect(probed.height).toBe(1080);
    expect(probed.seconds).toBeGreaterThan(3.5);
    expect(probed.seconds).toBeLessThan(4.5);
    // The second part is silent, so this is also the anullsrc stand-in's
    // assertion: without it the concat filter's leg count disagrees with n=.
    expect(probed.hasAudio).toBe(true);

    // Centre of the frame is the letterboxed foreground at full saturation.
    const early = await pixelAt(out, 1, 960, 540);
    expect(early.r).toBeGreaterThan(150);
    expect(early.g).toBeLessThan(80);
    expect(early.b).toBeLessThan(80);

    // ORDER. Reversing stackWide's legs gives blue here and fails.
    const late = await pixelAt(out, 3, 960, 540);
    expect(late.b).toBeGreaterThan(150);
    expect(late.r).toBeLessThan(80);
    expect(late.g).toBeLessThan(80);

    // A 1080x1920 part fits 1920x1080 as 608x1080 centred, so x=20 is
    // background. NOT BLACK is the whole point: if the blur leg were
    // dropped the graph would pillarbox and these would all be near zero.
    // Each edge carrying its OWN part's colour is what proves the
    // background tracks the part it belongs to rather than being shared.
    const edgeEarly = await pixelAt(out, 1, 20, 540);
    expect(edgeEarly.r).toBeGreaterThan(80);

    const edgeLate = await pixelAt(out, 3, 20, 540);
    expect(edgeLate.b).toBeGreaterThan(80);
  }, 120_000);

  it("fits a part that is not vertical instead of overflowing the frame", async () => {
    const out = join(dir, "mixed.mp4");
    await stackWide([red, wide], out);

    const probed = await probeFile(out);
    expect(probed.width).toBe(1920);
    expect(probed.height).toBe(1080);

    // A 16:9 part fills the frame edge to edge, so the centre is its colour.
    const mid = await pixelAt(out, 3, 960, 540);
    expect(mid.g).toBeGreaterThan(100);
    expect(mid.r).toBeLessThan(90);
  }, 120_000);

  it("refuses an empty part list", async () => {
    await expect(stackWide([], join(dir, "never.mp4"))).rejects.toThrow(/at least one/);
  });
});
