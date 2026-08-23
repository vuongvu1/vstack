import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boxFromHeight } from "../src/geometry.ts";
import type { Rect, Size } from "../src/geometry.ts";
import { CORNER_RADIUS, GUTTER, windowsOf } from "../src/frame.ts";
import { DEFAULT_LAYOUT, cellsOf, layoutById } from "../src/layout.ts";
import type { Layout } from "../src/layout.ts";
import {
  assertBoxes,
  buildFilter,
  exportClip,
  firstFrame,
  isOutName,
  outName,
  probeFile,
} from "./ffmpeg.ts";
import { ensureMask } from "./mask.ts";

const run = promisify(execFile);

// A 1920x1080 source: left half pure red, right half pure blue. Boxes placed
// entirely inside one half must produce an output half of that solid colour.
const SOURCE: Size = { w: 1920, h: 1080 };
const size = boxFromHeight(800, SOURCE, 1.125); // 900x800
const TOP: Rect = { x: 0, y: 100, ...size };            // 0..899   -> all red
const BOTTOM: Rect = { x: 1020, y: 100, ...size };      // 1020..1919 -> all blue

let dir = "";
let src = "";
let bands = "";
let mask = "";
let mask3 = "";

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

  // Three horizontal bands, 1920x360 each: red on top, green in the middle,
  // blue at the bottom. A 9:4 crop is 675x300 at h=300, which fits inside a
  // single 360px band — that is what makes a per-cell colour assertion
  // possible for a 3-cell layout.
  bands = join(dir, "bands.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=red:s=1920x360:d=2:r=10",
    "-f", "lavfi", "-i", "color=c=green:s=1920x360:d=2:r=10",
    "-f", "lavfi", "-i", "color=c=blue:s=1920x360:d=2:r=10",
    "-filter_complex", "[0:v][1:v][2:v]vstack=inputs=3[v]",
    "-map", "[v]", "-pix_fmt", "yuv420p", "-y", bands,
  ]);

  mask = await ensureMask(DEFAULT_LAYOUT, dir);
  mask3 = await ensureMask(byId("2v-1"), dir);
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

/** `layoutById` returns `Layout | null` by design. Tests know their ids
 *  exist, so they throw rather than reach for `!`. */
function byId(id: string): Layout {
  const layout = layoutById(id);
  if (!layout) throw new Error(`test asked for unknown layout ${id}`);
  return layout;
}

describe("outName", () => {
  it("slugs a Vietnamese title and pads both marks", () => {
    expect(outName("Ăn cơm chưa", 90, 125)).toBe("an-com-chua-0130-0205.mp4");
  });

  it("falls back to `clip` when a title slugs to nothing", () => {
    expect(outName("!!!???", 0, 30)).toBe("clip-0000-0030.mp4");
  });

  it("produces a name that isOutName accepts", () => {
    expect(isOutName(outName("Hôm nay trời đẹp quá", 3661, 3700))).toBe(true);
  });

  it("accepts an all-digit slug, which backtracking makes ambiguous", () => {
    expect(isOutName(outName("2024", 0, 30))).toBe(true);
  });
});

// The one place this API takes a client-supplied path component. Everything
// else reconstructs paths from window bounds, so this is the check that
// decides which file a subprocess touches — it gets the same exhaustive
// treatment videoIdFrom gets.
describe("outName — the traversal guard", () => {
  it("accepts what outName emits", () => {
    expect(isOutName("an-com-chua-0130-0205.mp4")).toBe(true);
    expect(isOutName("clip-0000-0030.mp4")).toBe(true);
    expect(isOutName("a-0000-0001.mp4")).toBe(true);
  });

  it("rejects traversal", () => {
    expect(isOutName("../secret-0000-0001.mp4")).toBe(false);
    expect(isOutName("a/b-0000-0001.mp4")).toBe(false);
    expect(isOutName("a\\b-0000-0001.mp4")).toBe(false);
    expect(isOutName("/etc/passwd")).toBe(false);
    expect(isOutName("..")).toBe(false);
  });

  it("rejects anything slugify could not have produced", () => {
    expect(isOutName("An-Com-0130-0205.mp4")).toBe(false); // uppercase
    expect(isOutName("ăn-cơm-0130-0205.mp4")).toBe(false); // diacritics
    expect(isOutName("-lead-0000-0001.mp4")).toBe(false); // leading dash
    expect(isOutName("has space-0000-0001.mp4")).toBe(false);
    expect(isOutName("a--b-0000-0001.mp4")).toBe(false); // slugify collapses runs to one dash
    expect(isOutName("ab--0000-0001.mp4")).toBe(false);
  });

  it("rejects a malformed range or extension", () => {
    expect(isOutName("clip-130-205.mp4")).toBe(false); // mmss is 4 digits
    expect(isOutName("clip-0000-0030.mp4.txt")).toBe(false);
    expect(isOutName("clip-0000-0030.mov")).toBe(false);
    expect(isOutName("clip-0000-0030")).toBe(false);
  });

  it("rejects non-strings without throwing", () => {
    expect(isOutName(null)).toBe(false);
    expect(isOutName(42)).toBe(false);
    expect(isOutName(undefined)).toBe(false);
    expect(isOutName({ toString: () => "clip-0000-0030.mp4" })).toBe(false);
  });
});

describe("buildFilter", () => {
  it("crops each box and composes them, every leg scaled to its cell", () => {
    const f = buildFilter(DEFAULT_LAYOUT, [TOP, BOTTOM]);
    expect(f).toContain("split=2");
    expect(f).toContain("crop=900:800:0:100");
    expect(f).toContain("crop=900:800:1020:100");
    expect(f).toContain("scale=1080:960:flags=lanczos");
    // 1-1 is the regression fence: two 1080x960 cells at y 0 and y 960,
    // which is exactly what vstack produced before layouts existed.
    expect(f).toContain("xstack=inputs=2:layout=0_0|0_960");
  });

  it("scales each leg to its own cell for a mixed layout", () => {
    const layout = byId("2h-2v");
    const cells = cellsOf(layout);
    const boxes = cells.map((c) => ({ x: 0, y: 0, ...boxFromHeight(300, SOURCE, c.w / c.h) }));
    const f = buildFilter(layout, boxes);
    expect(f).toContain("split=4");
    expect(f).toContain("scale=540:960:flags=lanczos");
    expect(f).toContain("scale=1080:480:flags=lanczos");
    expect(f).toContain("xstack=inputs=4:layout=0_0|540_0|0_960|0_1440");
  });

  it("refuses a box count that does not match the layout", () => {
    expect(() => buildFilter(byId("2v-1"), [TOP, BOTTOM])).toThrow(/3 boxes/);
  });

  it("overlays the frame mask on top of the finished composite", () => {
    // The gutters and rounded corners are painted over the composite, never
    // built into it: xstack still tiles the frame edge to edge, so the crop
    // rects and the cell scales are untouched by the border.
    const f = buildFilter(DEFAULT_LAYOUT, [TOP, BOTTOM]);
    expect(f).toContain("xstack=inputs=2:layout=0_0|0_960[stack]");
    expect(f).toContain("[stack][1:v]overlay=0:0:format=auto[v]");
    // Exactly one [v]: the overlay owns the graph's output now.
    expect(f.match(/\[v\]/g)).toHaveLength(1);
  });
});

describe("assertBoxes", () => {
  it("accepts valid boxes", () => {
    expect(() => assertBoxes(DEFAULT_LAYOUT, [TOP, BOTTOM], SOURCE)).not.toThrow();
  });

  it("rejects a box off the aspect lock", () => {
    expect(() => assertBoxes(DEFAULT_LAYOUT, [{ ...TOP, w: 888 }, BOTTOM], SOURCE)).toThrow(
      /box 1/i,
    );
  });

  it("rejects a box hanging over the edge", () => {
    expect(() => assertBoxes(DEFAULT_LAYOUT, [TOP, { ...BOTTOM, x: 1900 }], SOURCE)).toThrow(
      /box 2/i,
    );
  });

  it("rejects NaN", () => {
    expect(() => assertBoxes(DEFAULT_LAYOUT, [{ ...TOP, x: Number.NaN }, BOTTOM], SOURCE)).toThrow();
  });

  it("rejects the wrong number of boxes", () => {
    expect(() => assertBoxes(byId("2v-1"), [TOP, BOTTOM], SOURCE)).toThrow(/3 boxes/);
    expect(() => assertBoxes(DEFAULT_LAYOUT, [TOP], SOURCE)).toThrow(/2 boxes/);
  });

  it("rejects a non-array instead of throwing a TypeError", () => {
    const notAnArray = null as unknown as Rect[];
    expect(() => assertBoxes(DEFAULT_LAYOUT, notAnArray, SOURCE)).toThrow(/boxes/i);
  });

  it("rejects a perfect 9:8 box aimed at a 9:16 cell", () => {
    // The silent-failure mode layouts introduce: 2h-1's first two cells are
    // 540x960, so a flawless 9:8 crop there would export stretched.
    const layout = byId("2h-1");
    expect(() => assertBoxes(layout, [TOP, BOTTOM, TOP], SOURCE)).toThrow(/box 1/i);
  });
});

describe("exportClip", () => {
  it("writes a 1080x1920 file whose halves match the boxes' colours", async () => {
    const out = join(dir, "out.mp4");
    await exportClip({
      input: src,
      start: 0.5,
      duration: 1,
      layout: DEFAULT_LAYOUT,
      boxes: [TOP, BOTTOM],
      source: SOURCE,
      mask,
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

  it("paints a white gutter and rounds each piece's corners", async () => {
    // The other half of the preview/export agreement: the canvas punches the
    // same rounded windows out of a white frame that this mask does, so if
    // these pixels disagree with the preview the border is the reason.
    const out = join(dir, "out-border.mp4");
    await exportClip({
      input: src,
      start: 0.5,
      duration: 1,
      layout: DEFAULT_LAYOUT,
      boxes: [TOP, BOTTOM],
      source: SOURCE,
      mask,
      out,
    });

    const [top] = windowsOf(DEFAULT_LAYOUT);
    if (!top) throw new Error("1-1 has no first window");
    const white = (p: { r: number; g: number; b: number }) => {
      expect(p.r).toBeGreaterThan(200);
      expect(p.g).toBeGreaterThan(200);
      expect(p.b).toBeGreaterThan(200);
    };

    // Frame margin, and the seam between the two halves (y 955..964).
    white(await pixelAt(out, 0.4, 540, 2));
    white(await pixelAt(out, 0.4, 2, 480));
    white(await pixelAt(out, 0.4, 540, 960));

    // Halfway along the diagonal of the top-left corner's cut. Square
    // corners would put the source's red here instead — this is the
    // assertion that fails if CORNER_RADIUS goes to 0.
    const cut = Math.round(top.x + CORNER_RADIUS * (Math.SQRT2 - 1) / 2);
    white(await pixelAt(out, 0.4, cut, cut));

    // Just inside the piece, past the gutter: still the source's red. Fails
    // if the gutter is painted wider than GUTTER.
    const inside = await pixelAt(out, 0.4, 540, top.y + GUTTER);
    expect(inside.r).toBeGreaterThan(150);
    expect(inside.g).toBeLessThan(80);
    expect(inside.b).toBeLessThan(80);
  });

  it("rejects a negative start", async () => {
    const out = join(dir, "out-neg-start.mp4");
    await expect(
      exportClip({
        input: src,
        start: -1,
        duration: 1,
        layout: DEFAULT_LAYOUT,
        boxes: [TOP, BOTTOM],
        source: SOURCE,
        mask,
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
        layout: DEFAULT_LAYOUT,
        boxes: [TOP, BOTTOM],
        source: SOURCE,
        mask,
        out,
      }),
    ).rejects.toThrow(/duration/i);
  });

  it("composes a 3-cell layout into the right cells in the right order", async () => {
    // This is what proves xstack's `layout=` ordering, the way the vstack
    // leg-swap assertion proved it when there were only two cells. Swap two
    // entries in the layout string and these three assertions fail.
    const layout = byId("2v-1");
    const wide = boxFromHeight(300, SOURCE, 2.25); // 675x300
    const half = boxFromHeight(300, SOURCE, 1.125); // 338x300
    const boxes: Rect[] = [
      { x: 0, y: 30, ...wide }, //  30..329  -> inside the red band
      { x: 0, y: 390, ...wide }, // 390..689 -> inside the green band
      { x: 0, y: 750, ...half }, // 750..1049 -> inside the blue band
    ];

    const out = join(dir, "out-3cell.mp4");
    await exportClip({
      input: bands,
      start: 0.5,
      duration: 1,
      layout,
      boxes,
      source: SOURCE,
      mask: mask3,
      out,
    });

    expect(await probeFile(out)).toEqual({ width: 1080, height: 1920 });

    // Cell centres: 1080x480 at y 0, 1080x480 at y 480, 1080x960 at y 960.
    const first = await pixelAt(out, 0.4, 540, 240);
    expect(first.r).toBeGreaterThan(150);
    expect(first.g).toBeLessThan(80);
    expect(first.b).toBeLessThan(80);

    const second = await pixelAt(out, 0.4, 540, 720);
    expect(second.g).toBeGreaterThan(80);
    expect(second.r).toBeLessThan(80);
    expect(second.b).toBeLessThan(80);

    const third = await pixelAt(out, 0.4, 540, 1440);
    expect(third.b).toBeGreaterThan(150);
    expect(third.r).toBeLessThan(80);
    expect(third.g).toBeLessThan(80);
  });
});

describe("firstFrame", () => {
  // The published thumbnail is this call's output, so the two things YouTube
  // refuses are what get asserted: a non-JPEG body and anything over 2 MB.
  it("writes the source's first frame as a JPEG at the source's size", async () => {
    const thumb = join(dir, "thumb.jpg");
    await firstFrame(src, thumb);

    const { width, height } = await probeFile(thumb);
    expect({ width, height }).toEqual({ width: 1920, height: 1080 });

    // The API takes image/jpeg by MIME and validates the bytes; a PNG under a
    // .jpg name is rejected. SOI marker, not the extension.
    const bytes = await readFile(thumb);
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    // thumbnails.set caps uploads at 2 MB. This is what the quality flag is
    // for — a lossless still of a 1080p frame would clear it easily.
    expect((await stat(thumb)).size).toBeLessThan(2 << 20);
  });
});
