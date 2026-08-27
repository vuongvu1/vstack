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
import type { CustomBox } from "../src/custom.ts";
import {
  assertBoxes,
  assertCustoms,
  buildFilter,
  clipName,
  concatClips,
  exportClip,
  firstFrame,
  isOutName,
  outName,
  probeFile,
  segmentDigest,
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
let vert = "";
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

  // A 1080x1920 vertical source in three stacked bands, red over green over
  // blue. The middle band is 640px tall and a 16:9 crop of this is 607px of
  // source height taken around the centre, so the crop lands wholly inside
  // the green — which is what makes "every corner is green" a real assertion
  // about cropping rather than letterboxing.
  vert = join(dir, "vertical.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=red:s=1080x640:d=1:r=10",
    "-f", "lavfi", "-i", "color=c=green:s=1080x640:d=1:r=10",
    "-f", "lavfi", "-i", "color=c=blue:s=1080x640:d=1:r=10",
    "-filter_complex", "[0:v][1:v][2:v]vstack=inputs=3[v]",
    "-map", "[v]", "-pix_fmt", "yuv420p", "-y", vert,
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

  mask = await ensureMask(DEFAULT_LAYOUT, [], dir);
  mask3 = await ensureMask(byId("2v-1"), [], dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Reads one RGB pixel out of a frame of the encoded file. `width` defaults
 *  to 1080 for this file's usual fixtures; the concat tests below pass their
 *  own 320px fixture width so the row stride is right for a smaller frame. */
async function pixelAt(path: string, t: number, x: number, y: number, width = 1080) {
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

  it("is byte-identical to the no-customs string when there are none", () => {
    // The regression fence: an export with no floating pieces must produce
    // exactly the graph that shipped before this feature existed.
    expect(buildFilter(DEFAULT_LAYOUT, [TOP, BOTTOM], [])).toBe(
      buildFilter(DEFAULT_LAYOUT, [TOP, BOTTOM]),
    );
    expect(buildFilter(DEFAULT_LAYOUT, [TOP, BOTTOM])).toContain("[0:v]split=2[c0][c1]");
  });

  it("adds a leg and an overlay per floating piece, mask still last", () => {
    const custom: CustomBox = {
      out: { x: 300, y: 700, w: 480, h: 480 },
      crop: { x: 0, y: 760, w: 300, h: 300 },
    };
    const filter = buildFilter(DEFAULT_LAYOUT, [TOP, BOTTOM], [custom]);
    expect(filter).toContain("[0:v]split=3[c0][c1][k0]");
    expect(filter).toContain("[k0]crop=300:300:0:760,scale=480:480:flags=lanczos[t0]");
    expect(filter).toContain("[stack][t0]overlay=300:700[o0]");
    expect(filter.endsWith("[o0][1:v]overlay=0:0:format=auto[v]")).toBe(true);
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

describe("assertCustoms", () => {
  const custom: CustomBox = {
    out: { x: 300, y: 700, w: 480, h: 480 },
    crop: { x: 0, y: 100, w: 480, h: 480 },
  };

  it("accepts a legal box", () => {
    expect(() => assertCustoms([custom], SOURCE)).not.toThrow();
    expect(() => assertCustoms([], SOURCE)).not.toThrow();
  });

  it("rejects an odd output rect, which would misalign chroma on overlay", () => {
    expect(() => assertCustoms([{ ...custom, out: { ...custom.out, x: 301 } }], SOURCE)).toThrow();
  });

  it("rejects an output rect hanging off the frame", () => {
    expect(() => assertCustoms([{ ...custom, out: { ...custom.out, x: 800 } }], SOURCE)).toThrow();
  });

  it("rejects a crop off its own box's ratio", () => {
    // `out` stays legal on purpose: otherwise isValidCustom short-circuits
    // on the out-rect check and never reaches the ratio comparison.
    expect(() =>
      assertCustoms([{ ...custom, crop: { ...custom.crop, w: custom.crop.w + 2 } }], SOURCE),
    ).toThrow();
  });

  it("rejects more than MAX_CUSTOM", () => {
    expect(() => assertCustoms([custom, custom, custom], SOURCE)).toThrow();
  });

  it("rejects a non-array and a non-object entry instead of throwing a TypeError", () => {
    expect(() => assertCustoms(null as unknown as CustomBox[], SOURCE)).toThrow(/array/);
    expect(() => assertCustoms([null as unknown as CustomBox], SOURCE)).toThrow(/Invalid custom/);
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

    expect(await probeFile(out)).toMatchObject({ width: 1080, height: 1920 });

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

    expect(await probeFile(out)).toMatchObject({ width: 1080, height: 1920 });

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

  it("overlays a floating piece with its ring, over a cell seam", async () => {
    // bands: 1920x1080, red/green/blue horizontal thirds (360px each).
    // Layout 2v-1: cells 1080x480 at y=0, 1080x480 at y=480, 1080x960 at
    // y=960. The custom spans y 700..1180, so it crosses the 960 seam.
    const layout = byId("2v-1");
    const wide = boxFromHeight(300, SOURCE, 2.25); // 675x300
    const half = boxFromHeight(300, SOURCE, 1.125); // 338x300
    const boxes: Rect[] = [
      { x: 0, y: 30, ...wide }, //  red band
      { x: 0, y: 390, ...wide }, // green band
      { x: 0, y: 750, ...half }, // blue band
    ];
    const custom: CustomBox = {
      out: { x: 300, y: 700, w: 480, h: 480 },
      crop: { x: 0, y: 760, w: 300, h: 300 }, // wholly inside the blue band
    };

    const out = join(dir, "out-custom.mp4");
    await exportClip({
      input: bands,
      start: 0.5,
      duration: 1,
      layout,
      boxes,
      customs: [custom],
      source: SOURCE,
      mask: await ensureMask(layout, [custom.out], dir),
      out,
    });

    expect(await probeFile(out)).toMatchObject({ width: 1080, height: 1920 });

    // The piece itself: blue, from the source band its crop names.
    const inside = await pixelAt(out, 0.4, 540, 940);
    expect(inside.b).toBeGreaterThan(150);
    expect(inside.r).toBeLessThan(80);

    // The seam it straddles is inside its window, so it stays blue rather
    // than being cut by the gutter's white stripe.
    const seam = await pixelAt(out, 0.4, 540, 960);
    expect(seam.b).toBeGreaterThan(150);

    // The ring: white, half a gutter above the piece's top edge.
    const ring = await pixelAt(out, 0.4, 540, 700 - GUTTER / 2);
    expect(ring.r).toBeGreaterThan(200);
    expect(ring.g).toBeGreaterThan(200);
    expect(ring.b).toBeGreaterThan(200);

    // Just outside the ring: the cell underneath, still green.
    const under = await pixelAt(out, 0.4, 540, 700 - GUTTER - 6);
    expect(under.g).toBeGreaterThan(80);
    expect(under.b).toBeLessThan(80);
  });

  it("keeps the upper of two overlapping pieces ringed and rounded", async () => {
    // The end-to-end proof that the mask's walk is z-aware. These are the
    // two rects `+ Box` twice actually produces — 540x540 at (270, 690) and
    // its (60, 60)-offset sibling — cropped from different colour bands so
    // every probe below names which piece it is looking at.
    //
    // Before the walk existed, the mask tested ANY piece's window before
    // EVERY piece's ring: the upper piece's nub and the upper half of its
    // ring both landed inside the lower piece's window and came back
    // transparent, so the two probes marked below read the piece's own blue
    // and the lower piece's red instead of white.
    const layout = byId("2v-1");
    const wide = boxFromHeight(300, SOURCE, 2.25); // 675x300
    const half = boxFromHeight(300, SOURCE, 1.125); // 338x300
    const boxes: Rect[] = [
      { x: 0, y: 30, ...wide }, //  red band
      { x: 0, y: 390, ...wide }, // green band
      { x: 0, y: 750, ...half }, // blue band
    ];
    const lower: CustomBox = {
      out: { x: 270, y: 690, w: 540, h: 540 },
      crop: { x: 0, y: 30, w: 300, h: 300 }, // wholly inside the red band
    };
    const upper: CustomBox = {
      out: { x: 330, y: 750, w: 540, h: 540 },
      crop: { x: 0, y: 760, w: 300, h: 300 }, // wholly inside the blue band
    };

    const out = join(dir, "out-custom-pair.mp4");
    await exportClip({
      input: bands,
      start: 0.5,
      duration: 1,
      layout,
      boxes,
      customs: [lower, upper],
      source: SOURCE,
      mask: await ensureMask(layout, [lower.out, upper.out], dir),
      out,
    });

    const white = (p: { r: number; g: number; b: number }) => {
      expect(p.r).toBeGreaterThan(200);
      expect(p.g).toBeGreaterThan(200);
      expect(p.b).toBeGreaterThan(200);
    };

    // The upper piece itself, well inside both rects: its own blue.
    const inside = await pixelAt(out, 0.4, 600, 1020);
    expect(inside.b).toBeGreaterThan(150);
    expect(inside.r).toBeLessThan(80);

    // Its NW corner nub, which lies over the lower piece's window. Was blue.
    white(await pixelAt(out, 0.4, upper.out.x + 5, upper.out.y + 5));

    // Its ring above its top edge, also over the lower piece. Was red.
    white(await pixelAt(out, 0.4, 600, upper.out.y - GUTTER / 2));

    // The lower piece's own window where the upper one does not reach: red,
    // from the band its crop names.
    const below = await pixelAt(out, 0.4, 400, 720);
    expect(below.r).toBeGreaterThan(150);
    expect(below.b).toBeLessThan(80);

    // The lower piece's ring where it falls inside the upper piece's window:
    // the upper piece shows through. This is what a literal swap of the
    // mask's two tests would paint white instead.
    const striped = await pixelAt(out, 0.4, lower.out.x + lower.out.w + GUTTER / 2, 1000);
    expect(striped.b).toBeGreaterThan(150);
    expect(striped.r).toBeLessThan(80);

    // Clear of both rings: cell 2 of the layout, cropped from the green band.
    const stack = await pixelAt(out, 0.4, 540, lower.out.y - GUTTER - 6);
    expect(stack.g).toBeGreaterThan(80);
    expect(stack.b).toBeLessThan(80);
  });
});

/** Like pixelAt, but for a still of arbitrary width — the thumbnail is
 *  1280 wide, not the 1080 pixelAt's stride assumes. */
async function pixelIn(path: string, width: number, x: number, y: number) {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 64 << 20 },
  );
  const buf = stdout as unknown as Buffer;
  const i = (y * width + x) * 3;
  return { r: buf[i] ?? 0, g: buf[i + 1] ?? 0, b: buf[i + 2] ?? 0 };
}

describe("firstFrame", () => {
  // Letterboxing a vertical frame into 16:9 was the shipped bug: it put the
  // picture in a 32%-wide strip and black in the corners, which reads as a
  // blank thumbnail at the size YouTube shows one. Corners being GREEN is
  // what proves the frame was cropped full-bleed instead.
  it("crops a vertical source to a full-bleed 1280x720 JPEG when wide", async () => {
    const thumb = join(dir, "wide-thumb.jpg");
    await firstFrame(vert, thumb, "wide");

    expect(await probeFile(thumb)).toMatchObject({ width: 1280, height: 720 });

    for (const [x, y] of [[4, 4], [1275, 4], [4, 715], [1275, 715], [640, 360]]) {
      const px = await pixelIn(thumb, 1280, x ?? 0, y ?? 0);
      expect(px.g).toBeGreaterThan(120);
      expect(px.r).toBeLessThan(100);
      expect(px.b).toBeLessThan(100);
    }
  });

  // The other shape, and the reason the parameter exists: Studio's Shorts
  // thumbnail slot wants 9:16, so this one must NOT be cropped. All three
  // bands survive, which is exactly what the wide crop throws away.
  it("keeps the source's own shape when tall", async () => {
    const thumb = join(dir, "tall-thumb.jpg");
    await firstFrame(vert, thumb, "tall");

    expect(await probeFile(thumb)).toMatchObject({ width: 1080, height: 1920 });

    const top = await pixelIn(thumb, 1080, 540, 100);
    const middle = await pixelIn(thumb, 1080, 540, 960);
    const bottom = await pixelIn(thumb, 1080, 540, 1820);
    expect(top.r).toBeGreaterThan(120);
    expect(middle.g).toBeGreaterThan(120);
    expect(bottom.b).toBeGreaterThan(120);
  });

  it("writes a JPEG small enough for thumbnails.set", async () => {
    const thumb = join(dir, "magic.jpg");
    await firstFrame(src, thumb, "wide");

    // The API takes image/jpeg by MIME and validates the bytes; a PNG under a
    // .jpg name is rejected. SOI marker, not the extension.
    const bytes = await readFile(thumb);
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    // thumbnails.set caps uploads at 2 MB.
    expect((await stat(thumb)).size).toBeLessThan(2 << 20);
  });
});

describe("clipName", () => {
  it("keeps the two-number form when there is no digest", () => {
    expect(clipName(10, 40)).toBe("10-40.mp4");
    expect(clipName(10, 40, "")).toBe("10-40.mp4");
  });

  it("appends a digest as a third component", () => {
    expect(clipName(0, 35, "a1b2c3d4")).toBe("0-35-a1b2c3d4.mp4");
  });
});

describe("segmentDigest", () => {
  it("is 8 lowercase hex characters", () => {
    expect(segmentDigest([{ start: 1, end: 2 }])).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is stable for the same segments", () => {
    const segs = [{ start: 10, end: 20 }, { start: 40, end: 50 }];
    expect(segmentDigest(segs)).toBe(segmentDigest([...segs]));
  });

  it("differs for different segments that share a total duration", () => {
    // The whole reason the digest exists: 10s + 5s and 5s + 10s both name a
    // 15-second stitch, and without this they would share a cache file.
    const a = [{ start: 0, end: 10 }, { start: 20, end: 25 }];
    const b = [{ start: 0, end: 5 }, { start: 20, end: 30 }];
    expect(segmentDigest(a)).not.toBe(segmentDigest(b));
  });
});

describe("probeFile", () => {
  it("reports the video stream's dimensions", async () => {
    const p = await probeFile(src);
    expect(p.width).toBe(1920);
    expect(p.height).toBe(1080);
  });

  it("reports a duration and a frame rate", async () => {
    const p = await probeFile(src);
    expect(p.seconds).toBeGreaterThan(0);
    expect(p.fps).toMatch(/^\d+\/\d+$/);
  });

  it("reports hasAudio false for a silent file and true for a sounded one", async () => {
    // The regression this pins: reading a per-file answer out of
    // `-of default=nk=1` prints one line per STREAM, so taking the first
    // line answered "video" for every clip and made hasAudio false even for
    // clips that had sound.
    const sounded = join(dir, "sounded.mp4");
    await run("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "color=c=green:s=320x240:d=2:r=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
      "-y", sounded,
    ]);
    expect((await probeFile(src)).hasAudio).toBe(false);
    expect((await probeFile(sounded)).hasAudio).toBe(true);
  });
});

describe("concatClips", () => {
  it("stitches two ranges in order, and the output's duration is their sum", async () => {
    // A 12-second source: seconds 0-3 red, 3-6 green, 6-9 blue, 9-12 white.
    // Taking [0,2] and [6,8] must produce 4 seconds that read red then blue,
    // with the green band never appearing. Ordering is what this proves: a
    // reversed concat gives blue-then-red and the second sample fails.
    const banded = join(dir, "banded.mp4");
    await run("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i",
      "color=c=red:s=320x240:d=3:r=30[a];" +
        "color=c=green:s=320x240:d=3:r=30[b];" +
        "color=c=blue:s=320x240:d=3:r=30[c];" +
        "color=c=white:s=320x240:d=3:r=30[d];" +
        "[a][b][c][d]concat=n=4:v=1:a=0",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
      "-y", banded,
    ]);

    const out = join(dir, "stitch.mp4");
    await concatClips(
      [
        { path: banded, start: 0, end: 2 },
        { path: banded, start: 6, end: 8 },
      ],
      out,
    );

    const probed = await probeFile(out);
    expect(probed.seconds).toBeGreaterThan(3.5);
    expect(probed.seconds).toBeLessThan(4.5);
    expect(probed.hasAudio).toBe(true);

    // Thresholds, not exact equality, for the same reason every other
    // colour assertion in this file uses them: libx264 is lossy, so a
    // solid-red source frame comes back at e.g. r=254 rather than r=255.
    const early = await pixelAt(out, 1, 160, 120, 320);
    expect(early.r).toBeGreaterThan(150);
    expect(early.g).toBeLessThan(80);
    expect(early.b).toBeLessThan(80);

    const late = await pixelAt(out, 3, 160, 120, 320);
    expect(late.b).toBeGreaterThan(150);
    expect(late.r).toBeLessThan(80);
    expect(late.g).toBeLessThan(80);
  });

  it("stitches a silent part by standing silence in for it", async () => {
    // `src` is the file-level silent fixture. A missing audio leg would make
    // the concat filter's leg count disagree with n= and fail outright, so
    // this passing at all is the assertion.
    const out = join(dir, "silent-stitch.mp4");
    await concatClips(
      [
        { path: src, start: 0, end: 1 },
        { path: src, start: 1, end: 2 },
      ],
      out,
    );
    const probed = await probeFile(out);
    expect(probed.seconds).toBeGreaterThan(1.5);
    expect(probed.hasAudio).toBe(true);
  });

  it("stitches parts whose sample aspect ratios differ", async () => {
    // `concat` REFUSES a SAR mismatch — it does not pick a side, it fails
    // with "Nothing was written into output file". libx264 normalises a SAR
    // close to square back to 1:1, so the fixture uses 40:41 to reproduce
    // it, the same way server/starter.test.ts does.
    const anamorphic = join(dir, "anamorphic.mp4");
    await run("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "color=c=orange:s=320x240:d=3:r=30",
      "-vf", "setsar=40/41",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-y", anamorphic,
    ]);
    const out = join(dir, "sar-stitch.mp4");
    await concatClips(
      [
        { path: src, start: 0, end: 1 },
        { path: anamorphic, start: 0, end: 1 },
      ],
      out,
    );
    expect((await probeFile(out)).seconds).toBeGreaterThan(1.5);
  });
});
