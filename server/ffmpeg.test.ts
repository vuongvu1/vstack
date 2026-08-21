import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boxFromHeight } from "../src/geometry.ts";
import type { Rect, Size } from "../src/geometry.ts";
import { assertBoxes, buildFilter, exportClip, probeFile } from "./ffmpeg.ts";

const run = promisify(execFile);

// A 1920x1080 source: left half pure red, right half pure blue. Boxes placed
// entirely inside one half must produce an output half of that solid colour.
const SOURCE: Size = { w: 1920, h: 1080 };
const size = boxFromHeight(800, SOURCE, 1.125); // 900x800
const TOP: Rect = { x: 0, y: 100, ...size };            // 0..899   -> all red
const BOTTOM: Rect = { x: 1020, y: 100, ...size };      // 1020..1919 -> all blue

let dir = "";
let src = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vstack-"));
  src = join(dir, "src.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=red:s=960x1080:d=2:r=10",
    "-f", "lavfi", "-i", "color=c=blue:s=960x1080:d=2:r=10",
    "-filter_complex", "[0:v][1:v]hstack=inputs=2[v]",
    "-map", "[v]", "-pix_fmt", "yuv420p", "-y", src,
  ]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Reads one RGB pixel out of a frame of the encoded file. */
async function pixelAt(path: string, t: number, x: number, y: number) {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-ss", String(t), "-i", path, "-frames:v", "1",
     "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 64 << 20 },
  );
  const buf = stdout as unknown as Buffer;
  const i = (y * 1080 + x) * 3;
  return { r: buf[i] ?? 0, g: buf[i + 1] ?? 0, b: buf[i + 2] ?? 0 };
}

describe("buildFilter", () => {
  it("crops each box and stacks them, both legs scaled to 1080x960", () => {
    const f = buildFilter(TOP, BOTTOM);
    expect(f).toContain("crop=900:800:0:100");
    expect(f).toContain("crop=900:800:1020:100");
    expect(f).toContain("scale=1080:960:flags=lanczos");
    expect(f).toContain("vstack=inputs=2");
    expect(f).toContain("split=2");
  });
});

describe("assertBoxes", () => {
  it("accepts valid boxes", () => {
    expect(() => assertBoxes(TOP, BOTTOM, SOURCE)).not.toThrow();
  });

  it("rejects a box off the aspect lock", () => {
    expect(() => assertBoxes({ ...TOP, w: 888 }, BOTTOM, SOURCE)).toThrow(/top box/i);
  });

  it("rejects a box hanging over the edge", () => {
    expect(() => assertBoxes(TOP, { ...BOTTOM, x: 1900 }, SOURCE)).toThrow(/bottom box/i);
  });

  it("rejects NaN", () => {
    expect(() => assertBoxes({ ...TOP, x: Number.NaN }, BOTTOM, SOURCE)).toThrow();
  });
});

describe("exportClip", () => {
  it("writes a 1080x1920 file whose halves match the boxes' colours", async () => {
    const out = join(dir, "out.mp4");
    await exportClip({
      input: src,
      start: 0.5,
      duration: 1,
      top: TOP,
      bottom: BOTTOM,
      source: SOURCE,
      out,
    });

    expect(await probeFile(out)).toEqual({ width: 1080, height: 1920 });

    // Centre of the top half must be red; centre of the bottom half blue.
    const top = await pixelAt(out, 0.4, 540, 480);
    expect(top.r).toBeGreaterThan(150);
    expect(top.g).toBeLessThan(80);
    expect(top.b).toBeLessThan(80);

    const bottom = await pixelAt(out, 0.4, 540, 1440);
    expect(bottom.b).toBeGreaterThan(150);
    expect(bottom.r).toBeLessThan(80);
    expect(bottom.g).toBeLessThan(80);
  });

  it("rejects a negative start", async () => {
    const out = join(dir, "out-neg-start.mp4");
    await expect(
      exportClip({
        input: src,
        start: -1,
        duration: 1,
        top: TOP,
        bottom: BOTTOM,
        source: SOURCE,
        out,
      }),
    ).rejects.toThrow(/start/i);
  });

  it("rejects a zero or negative duration", async () => {
    const out = join(dir, "out-zero-duration.mp4");
    await expect(
      exportClip({
        input: src,
        start: 0,
        duration: 0,
        top: TOP,
        bottom: BOTTOM,
        source: SOURCE,
        out,
      }),
    ).rejects.toThrow(/duration/i);
  });
});
