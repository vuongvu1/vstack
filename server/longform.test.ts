import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeFile } from "./ffmpeg.ts";
import { MIN_KEPT, keptSeconds, stackWide } from "./longform.ts";

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

describe("keptSeconds", () => {
  it("leaves the last part whole", () => {
    expect(keptSeconds(30, true, 5.04)).toBe(30);
  });

  it("takes the tail off every other part", () => {
    expect(keptSeconds(30, false, 5.04)).toBeCloseTo(24.96, 5);
  });

  it("is a no-op at tail 0, which is what every existing caller passes", () => {
    expect(keptSeconds(30, false, 0)).toBe(30);
    expect(keptSeconds(30, true, 0)).toBe(30);
  });

  // The guard. An upload this app did not produce has no outro to strip, and
  // a part shorter than the cut would come back at zero or negative seconds
  // — which ffmpeg reads as "no frames" and the concat reads as a missing
  // leg. Keeping it whole is the only answer that renders.
  it("keeps a part too short to survive the cut", () => {
    expect(keptSeconds(5, false, 5.04)).toBe(5);
    expect(keptSeconds(1, false, 5.04)).toBe(1);
    expect(keptSeconds(0, false, 5.04)).toBe(0);
  });

  it("floors at MIN_KEPT rather than at zero", () => {
    // 6 - 5.04 = 0.96, under the floor: whole part.
    expect(keptSeconds(6, false, 5.04)).toBe(6);
    // 6.04 - 5.04 = 1.0, exactly the floor: cut.
    expect(keptSeconds(6.04, false, 5.04)).toBeCloseTo(MIN_KEPT, 5);
  });
});

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

  // Pins the anySilent === false branch: no anullsrc input is appended at
  // all, so every leg's audio comes straight from its own part (`i:a`).
  // This is the PRODUCTION-COMMON case — every part vstack itself exports
  // has audio — and the one that fails if the no-anullsrc input-index
  // arithmetic is ever broken.
  it("stacks two sounded parts with no anullsrc input at all", async () => {
    const out = join(dir, "both-sound.mp4");
    await stackWide([red, red], out);

    const probed = await probeFile(out);
    expect(probed.width).toBe(1920);
    expect(probed.height).toBe(1080);
    expect(probed.hasAudio).toBe(true);
    expect(probed.seconds).toBeGreaterThan(3.5);
    expect(probed.seconds).toBeLessThan(4.5);
  }, 120_000);

  // Pins the shared-anullsrc branch with MORE THAN ONE silent leg: both
  // parts' audio legs reference the same anullsrc input label. This is the
  // case that fails if the shared label cannot be referenced twice.
  it("stacks two silent parts off one shared anullsrc input", async () => {
    const out = join(dir, "both-silent.mp4");
    await stackWide([blue, blue], out);

    const probed = await probeFile(out);
    expect(probed.width).toBe(1920);
    expect(probed.height).toBe(1080);
    expect(probed.hasAudio).toBe(true);
    expect(probed.seconds).toBeGreaterThan(3.5);
    expect(probed.seconds).toBeLessThan(4.5);
  }, 120_000);

  // The outro strip. Both parts are 2s; a 0.8s tail leaves 1.2 + 2 = 3.2.
  // The two failure modes this pins are both a whole tail away: not
  // stripping at all is 4.0, and stripping the LAST part too is 2.4.
  it("takes the tail off every part but the last", async () => {
    const out = join(dir, "stripped.mp4");
    await stackWide([red, red], out, 0.8);

    const probed = await probeFile(out);
    expect(probed.seconds).toBeGreaterThan(3.0);
    expect(probed.seconds).toBeLessThan(3.4);
  }, 120_000);

  // A single part is the last part, so there is nothing to strip — the tail
  // must not shorten a one-part stack.
  it("leaves a lone part whole however big the tail", async () => {
    const out = join(dir, "lone.mp4");
    await stackWide([red], out, 0.8);

    const probed = await probeFile(out);
    expect(probed.seconds).toBeGreaterThan(1.8);
    expect(probed.seconds).toBeLessThan(2.2);
  }, 120_000);

  it("refuses an empty part list", async () => {
    await expect(stackWide([], join(dir, "never.mp4"))).rejects.toThrow(/at least one/);
  });
});
