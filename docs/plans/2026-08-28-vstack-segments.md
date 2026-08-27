# Multiple Trim Segments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the trimming phase mark up to six kept parts of a video, stitch
them into one cached clip at fetch time, and draw a live playhead on the trim
strip.

**Architecture:** The kept parts are concatenated into the cached clip file by
`/api/window`, so everything below it — the framing `<video>`, the canvas
preview, `buildFilter`, `exportClip`, the frame mask, `prependStarter`,
publish — keeps seeing one continuous video and is not modified. Each part is
fetched through the existing single-segment download path, so parts are
independently cached and re-cutting re-downloads nothing. The stitch is named
`0-<total>-<digest>.mp4`; the digest travels client→server as its own
pattern-validated field so `/api/export` still never receives a path.

**Tech Stack:** Vite + vanilla TS frontend, zero-dependency `node:http`
backend, vitest, real `ffmpeg`/`ffprobe`/`yt-dlp` subprocesses in tests.

**Spec:** `docs/specs/2026-08-28-vstack-segments-design.md`

## Global Constraints

- `import type` for type-only imports; explicit `.ts` extensions on relative imports.
- No `enum`, `namespace`, `any`, default exports, or barrel files. Node runs `server/*.ts` with type stripping, so non-erasable syntax is a **boot crash**.
- No `console.log`/`.info` — `.error`/`.warn` only.
- `strict` and `noUncheckedIndexedAccess` are on: indexing yields `T | undefined`. Guard with `?? fallback`, never `!`.
- `MAX_SEGMENTS = 6`.
- Clip cache filename forms: `<ws>-<we>.mp4` (unchanged) and `0-<total>-<digest>.mp4` where `<digest>` is exactly 8 lowercase hex characters.
- Digest = first 8 hex of `sha1` over `` `${start},${end}` `` per segment joined by `;` — the same construction `server/mask.ts:customKey` uses.
- `Bash(git add)`, `Bash(git commit *)` and `Bash(rm *)` are deny-listed. Use `git -C . add` / `git -C . commit` and Node's `fs.rm`.
- Run the full suite with `pnpm test`. It shells real ffmpeg and real VieNeu-TTS; `pnpm tts-setup` must have run.
- Visual values come from the Radix custom properties in `src/style.css`. No fresh literals.

---

### Task 1: `src/segments.ts` — the pure segment model

**Files:**
- Create: `src/segments.ts`
- Create: `src/segments.test.ts`

**Interfaces:**
- Consumes: nothing. This module imports nothing, and sits at the bottom of the layering beside `src/geometry.ts`.
- Produces:
  - `export type Segment = { start: number; end: number }`
  - `export const MAX_SEGMENTS = 6`
  - `export function normalize(segs: Segment[], duration: number): Segment[]`
  - `export function isValidSegments(segs: unknown, duration: number): segs is Segment[]`
  - `export function totalDuration(segs: Segment[]): number`

- [ ] **Step 1: Write the failing tests**

Create `src/segments.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MAX_SEGMENTS, isValidSegments, normalize, totalDuration } from "./segments.ts";
import type { Segment } from "./segments.ts";

const D = 600;

describe("normalize", () => {
  it("sorts by start", () => {
    expect(normalize([{ start: 40, end: 50 }, { start: 10, end: 20 }], D)).toEqual([
      { start: 10, end: 20 },
      { start: 40, end: 50 },
    ]);
  });

  it("clamps to [0, duration]", () => {
    expect(normalize([{ start: -5, end: 700 }], D)).toEqual([{ start: 0, end: D }]);
  });

  it("drops a segment whose end is not after its start", () => {
    expect(normalize([{ start: 10, end: 10 }, { start: 20, end: 30 }], D)).toEqual([
      { start: 20, end: 30 },
    ]);
  });

  it("merges overlapping segments", () => {
    expect(normalize([{ start: 10, end: 30 }, { start: 20, end: 40 }], D)).toEqual([
      { start: 10, end: 40 },
    ]);
  });

  it("merges a segment fully contained in another", () => {
    expect(normalize([{ start: 10, end: 60 }, { start: 20, end: 30 }], D)).toEqual([
      { start: 10, end: 60 },
    ]);
  });

  it("leaves touching-but-not-overlapping segments alone", () => {
    // Adjacent ends are a legal two-part cut: the user may have marked the
    // same instant twice on purpose, and merging them would silently drop a
    // chip from the strip.
    expect(normalize([{ start: 10, end: 20 }, { start: 20, end: 30 }], D)).toEqual([
      { start: 10, end: 20 },
      { start: 20, end: 30 },
    ]);
  });

  it("drops non-finite bounds", () => {
    expect(normalize([{ start: Number.NaN, end: 10 }, { start: 1, end: 2 }], D)).toEqual([
      { start: 1, end: 2 },
    ]);
  });

  it("is idempotent", () => {
    const messy: Segment[] = [
      { start: 40, end: 50 },
      { start: 10, end: 30 },
      { start: 20, end: 25 },
      { start: 5, end: 5 },
    ];
    const once = normalize(messy, D);
    expect(normalize(once, D)).toEqual(once);
  });
});

describe("totalDuration", () => {
  it("sums the parts", () => {
    expect(totalDuration([{ start: 10, end: 30 }, { start: 40, end: 45 }])).toBe(25);
  });

  it("is 0 for an empty list", () => {
    expect(totalDuration([])).toBe(0);
  });
});

describe("isValidSegments", () => {
  it("accepts everything normalize emits", () => {
    const cases: Segment[][] = [
      [{ start: 0, end: D }],
      [{ start: 10, end: 20 }],
      [{ start: 10, end: 20 }, { start: 40, end: 50 }],
      [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }],
    ];
    for (const segs of cases) {
      expect(isValidSegments(normalize(segs, D), D)).toBe(true);
    }
  });

  it("rejects an empty list", () => {
    expect(isValidSegments([], D)).toBe(false);
  });

  it("rejects more than MAX_SEGMENTS", () => {
    const many = Array.from({ length: MAX_SEGMENTS + 1 }, (_v, i) => ({
      start: i * 10,
      end: i * 10 + 5,
    }));
    expect(isValidSegments(many.slice(0, MAX_SEGMENTS), D)).toBe(true);
    expect(isValidSegments(many, D)).toBe(false);
  });

  it("rejects an unsorted list", () => {
    expect(isValidSegments([{ start: 40, end: 50 }, { start: 10, end: 20 }], D)).toBe(false);
  });

  it("rejects overlapping segments", () => {
    expect(isValidSegments([{ start: 10, end: 30 }, { start: 20, end: 40 }], D)).toBe(false);
  });

  it("rejects end <= start", () => {
    expect(isValidSegments([{ start: 10, end: 10 }], D)).toBe(false);
    expect(isValidSegments([{ start: 10, end: 9 }], D)).toBe(false);
  });

  it("rejects bounds outside [0, duration]", () => {
    expect(isValidSegments([{ start: -1, end: 10 }], D)).toBe(false);
    expect(isValidSegments([{ start: 10, end: D + 1 }], D)).toBe(false);
  });

  it("rejects non-finite bounds", () => {
    expect(isValidSegments([{ start: 0, end: Number.POSITIVE_INFINITY }], D)).toBe(false);
    expect(isValidSegments([{ start: Number.NaN, end: 10 }], D)).toBe(false);
  });

  it("rejects non-arrays and non-objects — it reads untrusted input", () => {
    expect(isValidSegments(null, D)).toBe(false);
    expect(isValidSegments(undefined, D)).toBe(false);
    expect(isValidSegments("[]", D)).toBe(false);
    expect(isValidSegments({ start: 0, end: 10 }, D)).toBe(false);
    expect(isValidSegments([null], D)).toBe(false);
    expect(isValidSegments([{ start: "0", end: "10" }], D)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run src/segments.test.ts`
Expected: FAIL — `Failed to resolve import "./segments.ts"`.

- [ ] **Step 3: Write `src/segments.ts`**

```ts
/** The kept parts of a video's timeline, in source seconds.
 *
 *  This module sits at the bottom of the client layering beside
 *  `geometry.ts` and imports nothing, which is what lets the server import
 *  it too — `server/ytdlp.ts` already reaches across for `PAD` the same way.
 *
 *  A single segment is not a special case anywhere: it is the general case
 *  at N = 1, and every path below `/api/window` still sees one continuous
 *  clip either way. */
export type Segment = { start: number; end: number };

/** Bounds the ffmpeg concat graph and the untrusted-input surface, the way
 *  `MAX_CUSTOM` bounds the floating pieces. Not a measured limit. */
export const MAX_SEGMENTS = 6;

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Clamps to `[0, duration]`, drops anything empty or non-finite, sorts by
 *  start, and merges overlaps.
 *
 *  Merging rather than rejecting is a UI decision: dragging one part's end
 *  past the next part's start is an ordinary editing gesture, and merging is
 *  what a cut tool does with it. Touching bounds (`a.end === b.start`) are
 *  left as two segments — the user may have marked the same instant twice on
 *  purpose, and merging would silently remove a chip from the strip.
 *
 *  Idempotent, which the drag path relies on: this runs on every mark. */
export function normalize(segs: Segment[], duration: number): Segment[] {
  const clean: Segment[] = [];
  for (const seg of segs) {
    if (!finite(seg?.start) || !finite(seg?.end)) continue;
    const start = Math.min(Math.max(0, seg.start), duration);
    const end = Math.min(Math.max(0, seg.end), duration);
    if (end > start) clean.push({ start, end });
  }
  clean.sort((a, b) => a.start - b.start);

  const merged: Segment[] = [];
  for (const seg of clean) {
    const last = merged[merged.length - 1];
    if (last !== undefined && seg.start < last.end) {
      last.end = Math.max(last.end, seg.end);
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/** The validator both sides run — `restore` on the client, `/api/window` on
 *  the server — the same split posture `isValidBox`/`assertBoxes` has for
 *  crop rects. Either side alone would let a bad selection through one door
 *  and die at the other.
 *
 *  Takes `unknown` for the reason `isOutName` does: it is called on a raw
 *  request-body field and on a `JSON.parse` result, and a `Segment[]`
 *  annotation at either site would be a compile-time claim about a value
 *  that arrives from outside the program. */
export function isValidSegments(segs: unknown, duration: number): segs is Segment[] {
  if (!Array.isArray(segs)) return false;
  if (segs.length === 0 || segs.length > MAX_SEGMENTS) return false;
  let prevEnd = Number.NEGATIVE_INFINITY;
  for (const seg of segs) {
    if (seg === null || typeof seg !== "object" || Array.isArray(seg)) return false;
    const { start, end } = seg as Segment;
    if (!finite(start) || !finite(end)) return false;
    if (start < 0 || end > duration) return false;
    if (!(end > start)) return false;
    // Sorted AND non-overlapping in one comparison: a later segment must
    // begin at or after the previous one ends.
    if (start < prevEnd) return false;
    prevEnd = end;
  }
  return true;
}

export function totalDuration(segs: Segment[]): number {
  return segs.reduce((sum, s) => sum + (s.end - s.start), 0);
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run src/segments.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git -C . add src/segments.ts src/segments.test.ts
git -C . commit -m "feat: segment model with a shared client/server validator"
```

---

### Task 2: `probeFile` grows, `clipName` takes a digest

**Files:**
- Modify: `server/ffmpeg.ts` (`clipName`, `clipPath`, `probeFile`; add `segmentDigest`)
- Modify: `server/ffmpeg.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `Segment` from Task 1.
- Produces:
  - `clipName(windowStart: number, windowEnd: number, digest?: string): string`
  - `clipPath(videoId: string, windowStart: number, windowEnd: number, digest?: string): string`
  - `probeFile(path): Promise<{ width: number; height: number; fps: string; seconds: number; hasAudio: boolean }>`
  - `segmentDigest(segs: Segment[]): string` — 8 lowercase hex characters

- [ ] **Step 1: Write the failing tests**

Append to `server/ffmpeg.test.ts` (the file already has `src`, a 1920x1080
red/blue fixture, built in its `beforeAll`):

```ts
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
```

Add `clipName` and `segmentDigest` to the existing import from `./ffmpeg.ts`
at the top of that file.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run server/ffmpeg.test.ts -t "clipName"`
Expected: FAIL — `clipName` is not exported from the test's import list / `segmentDigest` is not a function.

- [ ] **Step 3: Implement in `server/ffmpeg.ts`**

Add to the imports at the top of the file:

```ts
import { createHash } from "node:crypto";
import type { Segment } from "../src/segments.ts";
```

Replace `clipName` and `clipPath`:

```ts
/** Window bounds are integers so filenames are stable and the cache actually
 *  hits on a repeated request. `/api/export` reconstructs this exact name
 *  from videoId + window bounds (+ digest), so clipPath and the served
 *  clipUrl must derive from the same template rather than each
 *  string-building it.
 *
 *  `digest` names a *stitch* — several kept parts concatenated into one file
 *  by `fetchWindow`. Omitted (the overwhelmingly common case) the name is
 *  byte-identical to what this always emitted, so every clip already in
 *  `media/` keeps hitting. */
export function clipName(windowStart: number, windowEnd: number, digest = ""): string {
  return `${windowStart}-${windowEnd}${digest === "" ? "" : `-${digest}`}.mp4`;
}

export function clipPath(
  videoId: string,
  windowStart: number,
  windowEnd: number,
  digest = "",
): string {
  return join(MEDIA_DIR, videoId, clipName(windowStart, windowEnd, digest));
}

/** A short, stable digest of a stitch's segment bounds. Hex only, so nothing
 *  client-shaped can reach the path — the same construction, and the same
 *  reasoning, as `customKey` in `server/mask.ts`.
 *
 *  Two different segment sets can sum to the same number of seconds, so the
 *  `0-<total>` part of a stitch's name is not unique on its own. Without
 *  this, the second such cut would be served the first one's file forever. */
export function segmentDigest(segs: Segment[]): string {
  return createHash("sha1")
    .update(segs.map((s) => `${s.start},${s.end}`).join(";"))
    .digest("hex")
    .slice(0, 8);
}
```

Replace `probeFile`:

```ts
/** The clip's real shape and sound.
 *
 *  Dimensions first, because yt-dlp picks a format and the fetched
 *  resolution can differ from what --dump-json advertised — and crop rects
 *  are stored in source pixels, so framing against the wrong dimensions
 *  silently mis-crops.
 *
 *  `-of json`, never `-of default=nk=1`: that prints one line per *stream*,
 *  so reading a per-file answer out of it means guessing which line is
 *  which. Taking the first line once answered "video" for every clip, which
 *  made `hasAudio` false everywhere and replaced every export's sound with
 *  the silence stand-in while every stream-shape assertion still passed.
 *
 *  `starter.ts` keeps its own private `probeMain` rather than calling this:
 *  it sits *beside* `ffmpeg.ts` in the layering, not above it, and importing
 *  from here would be the first edge that breaks that. */
export async function probeFile(path: string): Promise<{
  width: number;
  height: number;
  fps: string;
  seconds: number;
  hasAudio: boolean;
}> {
  let stdout: string;
  try {
    ({ stdout } = await run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=width,height,codec_type,r_frame_rate:format=duration",
      "-of",
      "json",
      path,
    ]));
  } catch (err) {
    throw toolError("ffprobe", err);
  }
  const parsed = JSON.parse(stdout) as {
    streams?: { width?: number; height?: number; codec_type?: string; r_frame_rate?: string }[];
    format?: { duration?: string };
  };
  const streams = parsed.streams ?? [];
  // Selected by codec_type, NOT by index: `-select_streams v:0` is gone
  // because the audio streams are needed too, so streams[0] is no longer
  // guaranteed to be the video one.
  const video = streams.find((s) => s.codec_type === "video");
  if (!video?.width || !video?.height) {
    throw new Error(`ffprobe found no video stream in ${path}`);
  }
  return {
    width: video.width,
    height: video.height,
    fps: video.r_frame_rate ?? "30/1",
    seconds: Number(parsed.format?.duration ?? 0),
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run server/ffmpeg.test.ts`
Expected: PASS. The whole file, not just the new block — `probeFile`'s
existing callers destructure only `width`/`height` and must be unaffected.

- [ ] **Step 5: Typecheck and run the whole suite**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: no type errors; every previously-passing test still passes.

- [ ] **Step 6: Commit**

```bash
git -C . add server/ffmpeg.ts server/ffmpeg.test.ts
git -C . commit -m "feat: probeFile reports fps/duration/audio, clip names take a digest"
```

---

### Task 3: `concatClips` — the stitch pass

**Files:**
- Modify: `server/ffmpeg.ts` (add `ConcatPart`, `concatClips`)
- Modify: `server/ffmpeg.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `probeFile` from Task 2.
- Produces:
  - `export type ConcatPart = { path: string; start: number; end: number }` — `start`/`end` are offsets *within* `path`, not source-timeline seconds.
  - `export async function concatClips(parts: ConcatPart[], out: string): Promise<string>`

- [ ] **Step 1: Write the failing test**

Append to `server/ffmpeg.test.ts`:

```ts
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

    expect(await pixelAt(out, 1, 160, 120)).toEqual([255, 0, 0]);
    expect(await pixelAt(out, 3, 160, 120)).toEqual([0, 0, 255]);
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
```

`pixelAt` may already exist in this file under another name — check the
existing pixel assertions and reuse whatever helper reads a frame's RGB. If
there is none with a timestamp parameter, add:

```ts
/** One pixel's RGB at a given second, read back through ffmpeg's rawvideo
 *  output — the only way to assert what an encode actually produced. */
async function pixelAt(
  file: string,
  second: number,
  x: number,
  y: number,
): Promise<[number, number, number]> {
  const raw = join(dir, `px-${Math.random().toString(36).slice(2)}.rgb`);
  await run("ffmpeg", [
    "-v", "error",
    "-ss", String(second),
    "-i", file,
    "-frames:v", "1",
    "-vf", `crop=1:1:${x}:${y}`,
    "-f", "rawvideo", "-pix_fmt", "rgb24",
    "-y", raw,
  ]);
  const buf = await readFile(raw);
  return [buf[0] ?? -1, buf[1] ?? -1, buf[2] ?? -1];
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run server/ffmpeg.test.ts -t "concatClips"`
Expected: FAIL — `concatClips is not a function`.

- [ ] **Step 3: Implement `concatClips` in `server/ffmpeg.ts`**

```ts
/** One leg of a stitch: a cached clip, and the range *within that file* to
 *  keep. Offsets, not source-timeline seconds — the caller has already
 *  subtracted the part's own `windowStart`, which exists because every part
 *  is fetched with `PAD` around it. */
export type ConcatPart = { path: string; start: number; end: number };

// The stitch is an intermediate: `/api/export` re-encodes it. A slightly
// higher quality than the export's own crf 20 keeps this generation from
// being the one that shows.
const CONCAT_CRF = "18";
const CONCAT_RATE = 44100;

/** Concatenates the kept ranges of several clips into one continuous file.
 *
 *  Every leg is normalised before `concat` sees it, because `concat` REFUSES
 *  a mismatch rather than picking a side — a SAR difference fails with
 *  `Nothing was written into output file`, which names nothing. The same
 *  lesson `prependStarter` already carries for its three legs:
 *
 *  - `scale` + `setsar=1` + `fps` + `format=yuv420p` on video, all off part
 *    one's own probe. Parts of one video normally match, but the download
 *    ladder can land different rungs on different calls.
 *  - `aresample` + `aformat` on audio, since `concat` requires one sample
 *    rate and one channel layout across every leg too.
 *
 *  A part with no audio is given a leg cut out of a single `anullsrc` input,
 *  appended LAST so the real parts' input indices never move — the same
 *  positional rule `prependStarter`'s silence stand-in follows. */
export async function concatClips(parts: ConcatPart[], out: string): Promise<string> {
  const first = parts[0];
  if (first === undefined) throw new Error("concatClips needs at least one part.");

  const probed = await Promise.all(parts.map((p) => probeFile(p.path)));
  const shape = probed[0];
  if (shape === undefined) throw new Error("concatClips could not probe its first part.");

  const anySilent = probed.some((p) => !p.hasAudio);
  // Appended last, and only when needed, so a stitch of sounded parts has
  // exactly the inputs it did before this branch existed.
  const silenceIndex = parts.length;

  const inputs: string[] = [];
  for (const part of parts) inputs.push("-i", part.path);
  if (anySilent) {
    inputs.push("-f", "lavfi", "-i", `anullsrc=r=${CONCAT_RATE}:cl=stereo`);
  }

  const legs: string[] = [];
  const labels: string[] = [];
  parts.forEach((part, i) => {
    const p = probed[i];
    const hasAudio = p?.hasAudio === true;
    legs.push(
      `[${i}:v]trim=${part.start}:${part.end},setpts=PTS-STARTPTS,` +
        `scale=${shape.width}:${shape.height},setsar=1,fps=${shape.fps},` +
        `format=yuv420p[v${i}]`,
    );
    // A silent part's leg is cut out of the shared anullsrc input instead,
    // trimmed to this part's own length so the two streams stay in step.
    const audioSrc = hasAudio ? `${i}:a` : `${silenceIndex}:a`;
    const from = hasAudio ? part.start : 0;
    const to = hasAudio ? part.end : part.end - part.start;
    legs.push(
      `[${audioSrc}]atrim=${from}:${to},asetpts=PTS-STARTPTS,` +
        `aresample=${CONCAT_RATE},` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`,
    );
    labels.push(`[v${i}][a${i}]`);
  });
  legs.push(`${labels.join("")}concat=n=${parts.length}:v=1:a=1[v][a]`);

  try {
    await run(
      "ffmpeg",
      [
        "-v", "error",
        ...inputs,
        "-filter_complex", legs.join(";"),
        "-map", "[v]",
        "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", CONCAT_CRF,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        "-y", out,
      ],
      { maxBuffer: 16 << 20 },
    );
  } catch (err) {
    throw toolError("ffmpeg", err);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run server/ffmpeg.test.ts -t "concatClips"`
Expected: PASS, all three cases.

- [ ] **Step 5: Mutation-check the ordering assertion**

Temporarily reverse the leg order (`labels.reverse()` before the join) and
re-run. Expected: the red/blue pixel assertions FAIL. Revert the mutation.
An ordering test that passes under a reversed concat is not testing ordering.

- [ ] **Step 6: Commit**

```bash
git -C . add server/ffmpeg.ts server/ffmpeg.test.ts
git -C . commit -m "feat: concatClips stitches kept ranges into one clip"
```

---

### Task 4: `parseClipName` learns the digest; `listClips` stops rebuilding paths

**Files:**
- Modify: `server/ytdlp.ts` (`CLIP_RE`, `parseClipName`, `CachedClip`, `listClips`)
- Modify: `server/ytdlp.test.ts`

**Interfaces:**
- Consumes: `clipName`, `probeFile` from Task 2.
- Produces:
  - `parseClipName(name: string): { windowStart: number; windowEnd: number; digest: string } | null`
  - `CachedClip` gains `clipStart: number`, `clipEnd: number`, `digest: string`

- [ ] **Step 1: Write the failing tests**

Add to the `parseClipName` `describe` block in `server/ytdlp.test.ts`:

```ts
it("parses a stitch name and returns its digest", () => {
  expect(parseClipName("0-35-a1b2c3d4.mp4")).toEqual({
    windowStart: 0,
    windowEnd: 35,
    digest: "a1b2c3d4",
  });
});

it("returns an empty digest for the plain two-number form", () => {
  expect(parseClipName("10-40.mp4")).toEqual({
    windowStart: 10,
    windowEnd: 40,
    digest: "",
  });
});

it("still rejects a download partial", () => {
  // THE guard. A fetch in progress leaves `<name>.<uuid>.part.mp4` beside
  // the finished clips, and that file is truncated by definition — listing
  // it hands the framing phase a video that previews as a black canvas.
  expect(parseClipName("10-40.5f2b0c11-0000-4000-8000-000000000000.part.mp4")).toBeNull();
  expect(parseClipName("0-35-a1b2c3d4.5f2b0c11.part.mp4")).toBeNull();
});

it("rejects a digest of the wrong length or alphabet", () => {
  expect(parseClipName("0-35-a1b2c3d.mp4")).toBeNull();
  expect(parseClipName("0-35-a1b2c3d4e.mp4")).toBeNull();
  expect(parseClipName("0-35-A1B2C3D4.mp4")).toBeNull();
  expect(parseClipName("0-35-a1b2c3g4.mp4")).toBeNull();
});
```

Every existing `parseClipName` case in the file expects a two-field object
and must be updated to expect `digest: ""` as well.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run server/ytdlp.test.ts`
Expected: FAIL — the digest cases return `null`, the plain cases return an object without `digest`.

- [ ] **Step 3: Implement in `server/ytdlp.ts`**

Replace `CLIP_RE` and `parseClipName`:

```ts
/** Anchored, and deliberately narrow. The optional third group is a stitch's
 *  segment digest — exactly 8 lowercase hex characters, which is what
 *  `segmentDigest` emits and nothing else. */
const CLIP_RE = /^(\d+)-(\d+)(?:-([0-9a-f]{8}))?\.mp4$/;

/** The window bounds and optional stitch digest a cache filename encodes, or
 *  null if the name is not one `clipName` could have written.
 *
 *  This is `listClips`'s filter, and it is strict for two reasons that both
 *  fail silently. A fetch in progress leaves `<name>.<uuid>.part.mp4` beside
 *  the finished clips, and that file is truncated by definition — offering
 *  it would hand the framing phase a broken video. And the values returned
 *  here are what `/api/export` later rebuilds a path from via `clipPath`, so
 *  anything that is not two plain integers plus an optional hex digest has
 *  no business becoming a row. Names come off `readdir` and so cannot
 *  contain a separator, but the anchored pattern covers that too rather than
 *  relying on it — and a partial's extra `.` still cannot match. */
export function parseClipName(
  name: string,
): { windowStart: number; windowEnd: number; digest: string } | null {
  const m = CLIP_RE.exec(name);
  if (!m) return null;
  const windowStart = Number(m[1]);
  const windowEnd = Number(m[2]);
  // `/api/export` rejects a window whose end is not after its start, so a
  // row built from one would be dead on arrival. Nothing writes such a name;
  // a hand-dropped file could.
  if (!(windowEnd > windowStart)) return null;
  return { windowStart, windowEnd, digest: m[3] ?? "" };
}
```

Extend `CachedClip`'s source type — it is `WindowResult & { videoId: string }`,
so the new fields arrive with Task 5's `WindowResult`. For now add them to
`WindowResult` in this same file:

```ts
export type WindowResult = {
  clipUrl: string;
  windowStart: number;
  windowEnd: number;
  /** The range of the *clip file* that is the finished cut. For a single
   *  segment these are the user's marks, so the export request is
   *  unchanged; for a stitch the clip has its own timeline and these are
   *  `0` and its probed duration. `doExport` sends these, never the marks. */
  clipStart: number;
  clipEnd: number;
  /** A stitch's segment digest, `""` for an ordinary single-range clip.
   *  `/api/export` needs it to rebuild the cache path, and cannot recompute
   *  it — the `listClips` reopen path has no segments to hash. */
  digest: string;
  width: number;
  height: number;
};
```

In `listClips`, replace the path rebuild and the row:

```ts
      const bounds = parseClipName(name);
      if (!bounds) continue;
      // The name readdir handed us, NOT a rebuild from the parsed bounds:
      // clipPath(videoId, windowStart, windowEnd) silently drops a stitch's
      // digest, so every stitch would fail to probe and never be listed.
      // parseClipName has already validated this name character by
      // character, which is what makes using it directly safe.
      const path = join(MEDIA_DIR, videoId, name);
      const probed = await probeFile(path).catch(() => null);
      if (!probed) continue;
      const { mtimeMs } = await stat(path).catch(() => ({ mtimeMs: 0 }));
      clips.push({
        videoId,
        clipUrl: `/media/${videoId}/${name}`,
        ...bounds,
        // The marks cover the whole cached clip: framing has no marking
        // controls, so the alternative is a window whose edges the user
        // cannot reach. For a stitch that is its entire timeline anyway.
        clipStart: bounds.windowStart,
        clipEnd: bounds.windowEnd,
        width: probed.width,
        height: probed.height,
        mtime: mtimeMs,
      });
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run server/ytdlp.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: errors only in `fetchWindow` / `server/index.ts` / `src/*`, which
Tasks 5–8 fix. Note them; do not patch them here.

- [ ] **Step 6: Commit**

```bash
git -C . add server/ytdlp.ts server/ytdlp.test.ts
git -C . commit -m "feat: clip names carry an optional stitch digest"
```

---

### Task 5: `fetchWindow` takes segments

**Files:**
- Modify: `server/ytdlp.ts` (`fetchWindow`; extract `fetchOne`)

**Interfaces:**
- Consumes: `Segment`, `totalDuration` (Task 1); `concatClips`, `segmentDigest`, `clipName`, `clipPath`, `probeFile` (Tasks 2–3); `parseClipName` (Task 4).
- Produces: `fetchWindow(videoId: string, segments: Segment[], duration: number): Promise<WindowResult>`

- [ ] **Step 1: Extract today's body as `fetchOne`**

Rename the existing `fetchWindow` to `fetchOne`, keep it **module-private**,
keep its `(videoId, start, end, duration)` signature and its entire body
unchanged except for the return, which gains the three new fields:

```ts
  const { width, height } = await probeFile(path);
  return {
    clipUrl: `/media/${videoId}/${clipName(windowStart, windowEnd)}`,
    windowStart,
    windowEnd,
    // A single range's clip IS a contiguous slice of the source, so clip
    // time and source time differ by the constant `windowStart` that
    // /api/export already subtracts. These are the marks, and the export
    // request is byte-identical to what it was before segments existed.
    clipStart: start,
    clipEnd: end,
    digest: "",
    width,
    height,
  };
```

- [ ] **Step 2: Add the new `fetchWindow` above it**

```ts
/** Fetches (and caches) the clip the framing phase will crop.
 *
 *  One segment is today's path exactly — same PAD, same download ladder,
 *  same `<windowStart>-<windowEnd>.mp4` name, so every clip already in
 *  `media/` still hits and the common case cannot regress into the new
 *  code at all.
 *
 *  Several segments are fetched as several ordinary clips and then stitched.
 *  Fetching each part through `fetchOne` rather than pulling the whole span
 *  between the first and last mark is what keeps two ten-second parts an
 *  hour apart from downloading an hour of video — and it means each part is
 *  independently cached and shared with a plain single-range fetch of the
 *  same bounds, so re-cutting re-downloads nothing.
 *
 *  Callers must have validated `segments` with `isValidSegments` first;
 *  `/api/window` does, before any subprocess spawns. */
export async function fetchWindow(
  videoId: string,
  segments: Segment[],
  duration: number,
): Promise<WindowResult> {
  const only = segments[0];
  if (only === undefined) {
    throw new HttpError(400, "At least one segment is required.");
  }
  if (segments.length === 1) return fetchOne(videoId, only.start, only.end, duration);

  const parts: ConcatPart[] = [];
  for (const seg of segments) {
    const part = await fetchOne(videoId, seg.start, seg.end, duration);
    // Offsets within the part file: every part carries PAD around its own
    // bounds, and the stitch must not.
    parts.push({
      path: clipPath(videoId, part.windowStart, part.windowEnd),
      start: seg.start - part.windowStart,
      end: seg.end - part.windowStart,
    });
  }

  const digest = segmentDigest(segments);
  // Math.ceil, not round: `clipEnd` below is clamped to this number, and a
  // name that rounded *down* would shave a fraction of a second off the cut
  // it names. The filename is an identifier either way — the probed
  // duration is the measurement.
  const total = Math.ceil(totalDuration(segments));
  const path = clipPath(videoId, 0, total, digest);

  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true });
    // Written under a partial and renamed on success, the same as the
    // download above and for the same two reasons: existsSync(path) must
    // never be true for a half-written clip, and a UUID (not process.pid,
    // which is constant for the life of this one server) keeps two
    // concurrent stitches of the same cut off each other's open fd.
    const partial = `${path}.${randomUUID()}.part.mp4`;
    try {
      await concatClips(parts, partial);
      await rename(partial, path);
    } finally {
      await rm(partial, { force: true });
    }
    reportCache();
  }

  const probed = await probeFile(path);
  return {
    clipUrl: `/media/${videoId}/${clipName(0, total, digest)}`,
    windowStart: 0,
    windowEnd: total,
    clipStart: 0,
    // Clamped to the name's own number: /api/export rejects an `end` past
    // `windowEnd`, and the concat's real duration can land a few
    // milliseconds either side of the sum.
    clipEnd: Math.min(probed.seconds, total),
    digest,
    width: probed.width,
    height: probed.height,
  };
}
```

Add to this file's imports:

```ts
import { concatClips, segmentDigest } from "./ffmpeg.ts";
import type { ConcatPart } from "./ffmpeg.ts";
import { totalDuration } from "../src/segments.ts";
import type { Segment } from "../src/segments.ts";
```

(`clipName`, `clipPath`, `probeFile`, `MEDIA_DIR`, `reportCache` are already imported.)

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: remaining errors only in `server/index.ts` and `src/*`.

- [ ] **Step 4: Verify the single-segment path by hand**

Run `pnpm server` in one terminal, then:

```bash
curl -s localhost:8787/api/window -H 'content-type: application/json' \
  -d '{"videoId":"dQw4w9WgXcQ","segments":[{"start":30,"end":40}],"duration":213}' | head -c 400
```

Expected: this 400s with a validator error until Task 6 lands — that is
correct. What must hold *now* is `pnpm exec tsc --noEmit` and that
`media/` gained nothing.

- [ ] **Step 5: Commit**

```bash
git -C . add server/ytdlp.ts
git -C . commit -m "feat: fetchWindow stitches multiple segments into one clip"
```

---

### Task 6: The two routes

**Files:**
- Modify: `server/index.ts` (`/api/window`, `/api/export`)

**Interfaces:**
- Consumes: `isValidSegments`, `MAX_SEGMENTS` (Task 1); `fetchWindow` (Task 5); `clipPath` (Task 2).
- Produces: `/api/window` body `{ videoId, segments, duration }`; `/api/export` body gains optional `digest`.

- [ ] **Step 1: Rewrite the `/api/window` handler**

```ts
  if (req.url === "/api/window") {
    const body = await json<Record<string, unknown>>(req);
    const videoId = videoIdFrom(str(body.videoId, "videoId"));
    const duration = num(body.duration, "duration");
    if (!videoId) return send(res, 400, { error: "Bad video id." });
    // Shape and legality in one call, before any subprocess spawns — this is
    // the same split validator `restore` runs on the client, so a selection
    // that reaches here has already been checked once and is checked again
    // because localStorage and the wire are both untrusted input.
    if (!isValidSegments(body.segments, duration)) {
      return send(res, 400, {
        error:
          `Segments must be 1 to ${MAX_SEGMENTS} non-overlapping ranges, ` +
          `in order, inside [0, ${duration}].`,
      });
    }
    return send(res, 200, await fetchWindow(videoId, body.segments, duration));
  }
```

- [ ] **Step 2: Add the digest to `/api/export`**

Beside the other body reads:

```ts
    // The one client-supplied component of a cache path this route accepts,
    // and it is not a path: exactly 8 lowercase hex characters, which cannot
    // traverse, cannot escape MEDIA_DIR, and is still assembled into a path
    // by clipPath rather than used as one. It exists because a stitch's
    // filename carries a component window bounds do not — and the server
    // cannot recompute it, because the `listClips` reopen path has no
    // segments to hash. Same posture as `isOutName`, narrower alphabet.
    const digestRaw = raw.digest ?? "";
    if (typeof digestRaw !== "string" || (digestRaw !== "" && !/^[0-9a-f]{8}$/.test(digestRaw))) {
      return send(res, 400, { error: "Bad digest." });
    }
    const digest = digestRaw;
```

Then change the input path:

```ts
    const input = clipPath(videoId, windowStart, windowEnd, digest);
```

and the 404 message:

```ts
      return send(res, 404, {
        error:
          `Window ${windowStart}-${windowEnd}${digest === "" ? "" : `-${digest}`} ` +
          `for ${videoId} is not cached. Re-fetch it via /api/window before exporting.`,
      });
```

Add `isValidSegments, MAX_SEGMENTS` to the import from `../src/segments.ts`.

- [ ] **Step 3: Typecheck and boot the server**

Run: `pnpm exec tsc --noEmit`
Expected: errors only under `src/`.

Run: `pnpm server`
Expected: it boots and prints its usual cache/asset lines with no crash.
(Type stripping means a non-erasable construct here is a boot crash, not a
compile error — booting is the real check.)

- [ ] **Step 4: Exercise both branches by hand**

With the server running:

```bash
# rejected: overlapping
curl -s localhost:8787/api/window -H 'content-type: application/json' \
  -d '{"videoId":"dQw4w9WgXcQ","segments":[{"start":10,"end":30},{"start":20,"end":40}],"duration":213}'
# rejected: too many
curl -s localhost:8787/api/window -H 'content-type: application/json' \
  -d '{"videoId":"dQw4w9WgXcQ","segments":[{"start":0,"end":1},{"start":2,"end":3},{"start":4,"end":5},{"start":6,"end":7},{"start":8,"end":9},{"start":10,"end":11},{"start":12,"end":13}],"duration":213}'
# accepted: two parts (downloads — slow)
curl -s localhost:8787/api/window -H 'content-type: application/json' \
  -d '{"videoId":"dQw4w9WgXcQ","segments":[{"start":30,"end":40},{"start":60,"end":70}],"duration":213}'
```

Expected: two 400s naming the rule, then a 200 whose `digest` is 8 hex
characters, `windowStart` 0, `clipEnd` ≈ 20. Confirm `media/dQw4w9WgXcQ/`
holds `25-45.mp4`, `55-75.mp4` and `0-20-<digest>.mp4`, and no `.part.mp4`.

- [ ] **Step 5: Commit**

```bash
git -C . add server/index.ts
git -C . commit -m "feat: /api/window takes segments, /api/export takes a digest"
```

---

### Task 7: Client state — `segments`, `clipStart`/`clipEnd`/`clipDigest`, migration

**Files:**
- Modify: `src/state.ts`
- Modify: `src/state.test.ts`

**Interfaces:**
- Consumes: `Segment`, `isValidSegments`, `MAX_SEGMENTS` from Task 1.
- Produces: `AppState.segments: Segment[]`, `AppState.clipStart`, `AppState.clipEnd`, `AppState.clipDigest`. `AppState.start` and `AppState.end` are **removed**.

- [ ] **Step 1: Write the failing tests**

Add to `src/state.test.ts`:

```ts
describe("segments", () => {
  it("round-trips a multi-segment selection", () => {
    setState({ videoId: "vid00000001", duration: 600, segments: [
      { start: 10, end: 20 },
      { start: 40, end: 50 },
    ] });
    save();
    expect(restore("vid00000001", null).segments).toEqual([
      { start: 10, end: 20 },
      { start: 40, end: 50 },
    ]);
  });

  it("migrates a pre-segments {start, end} record into one segment", () => {
    localStorage.setItem(
      "vstack:vid00000002",
      JSON.stringify({ start: 12, end: 34, starterTitle: "x" }),
    );
    expect(restore("vid00000002", null).segments).toEqual([{ start: 12, end: 34 }]);
  });

  it("migrates a record marked at the very start of the video", () => {
    // The case a truthiness check gets wrong: `s.start ?? s.end` reads a
    // stored `start: 0` as "nothing here" and drops a real mark. Pressing
    // Set Start without moving the playhead produces exactly this record.
    localStorage.setItem("vstack:vid00000003", JSON.stringify({ start: 0, end: 34 }));
    expect(restore("vid00000003", null).segments).toEqual([{ start: 0, end: 34 }]);
  });

  it("drops a stored selection that is not valid", () => {
    localStorage.setItem(
      "vstack:vid00000004",
      JSON.stringify({ segments: [{ start: 40, end: 20 }] }),
    );
    expect(restore("vid00000004", null).segments).toBeUndefined();
  });

  it("drops a stored selection with more than MAX_SEGMENTS parts", () => {
    // localStorage is untrusted input. A hand-edited record with twenty
    // individually legal parts would otherwise reach fetchWindow and fire
    // twenty downloads before the server's own check ever ran.
    const many = Array.from({ length: MAX_SEGMENTS + 1 }, (_v, i) => ({
      start: i * 10,
      end: i * 10 + 5,
    }));
    localStorage.setItem("vstack:vid00000005", JSON.stringify({ segments: many }));
    expect(restore("vid00000005", null).segments).toBeUndefined();
  });

  it("never persists clipStart, clipEnd or clipDigest", () => {
    // They belong to a fetched window, not to the video — the same reason
    // clipUrl and windowStart are absent from the record.
    setState({ videoId: "vid00000006", duration: 600, segments: [{ start: 1, end: 2 }],
      clipStart: 0, clipEnd: 1, clipDigest: "a1b2c3d4" });
    save();
    const raw = readRaw("vid00000006") as Record<string, unknown>;
    expect(raw).not.toHaveProperty("clipStart");
    expect(raw).not.toHaveProperty("clipEnd");
    expect(raw).not.toHaveProperty("clipDigest");
  });
});
```

Add `MAX_SEGMENTS` to the test file's imports, from `./segments.ts`.
Every existing test in this file that sets or asserts `start`/`end` must be
rewritten in terms of `segments`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run src/state.test.ts`
Expected: FAIL — `segments` is not a property of `AppState`.

- [ ] **Step 3: Update `src/state.ts`**

Imports:

```ts
import { MAX_SEGMENTS, isValidSegments } from "./segments.ts";
import type { Segment } from "./segments.ts";
```

In `AppState`, replace `start: number; end: number;` with:

```ts
  /** The kept parts of the source timeline, in source seconds. Always at
   *  least one; one segment is exactly the old `start`/`end` pair. These are
   *  what the trimming strip draws and what "Back to trim" restores — they
   *  are NOT what `/api/export` receives, because a stitch's clip has its
   *  own timeline. See `clipStart`/`clipEnd`. */
  segments: Segment[];
  /** The range of the fetched clip file that is the finished cut, reported
   *  by `/api/window`. For one segment these equal the marks; for a stitch
   *  they are `0` and the clip's probed duration. `doExport` sends these. */
  clipStart: number;
  clipEnd: number;
  /** A stitch's segment digest, `""` for an ordinary clip. `/api/export`
   *  needs it to rebuild the cache path. Not persisted — it belongs to a
   *  fetched window, like `clipUrl`. */
  clipDigest: string;
```

In `initial`, replace `start: 0, end: 0,` with:

```ts
  segments: [{ start: 0, end: 0 }],
  clipStart: 0,
  clipEnd: 0,
  clipDigest: "",
```

In `Saved`, replace `start: number; end: number;` with `segments: Segment[];`
and extend `Legacy`:

```ts
/** The pre-layouts and pre-segments stored shapes. Records in a real user's
 *  localStorage predate both features, and dropping them would silently
 *  un-frame — or un-mark — every video already worked on. */
type Legacy = {
  boxTop?: Rect | null;
  boxBottom?: Rect | null;
  start?: number;
  end?: number;
};
```

In `readSaved`, add the migration beside the boxes one and return `segments`:

```ts
  // Migration: a record with no `segments` but with the old pair is a
  // pre-segments save, and that pair is by definition one segment.
  //
  // Tested on `!== undefined`, NOT on truthiness: a record marked from the
  // very start of the video stores `start: 0`, and `s.start ?? s.end` would
  // read that as "nothing here" and drop a real mark. The one case a
  // truthiness check gets wrong is the one a user hits by pressing Set Start
  // without moving the playhead.
  const legacySegments: Segment[] | null =
    s.segments === undefined && (s.start !== undefined || s.end !== undefined)
      ? [{ start: s.start ?? 0, end: s.end ?? 0 }]
      : null;

  return {
    segments: legacySegments ?? (Array.isArray(s.segments) ? s.segments : []),
    // …the rest unchanged…
  };
```

In `save()`, replace `start: state.start, end: state.end,` with
`segments: state.segments,` — unconditional, like the marks it replaces and
for the same reason: it always reflects the current session.

In `restore()`, replace the two `Number.isFinite` mark lines with:

```ts
    // The same validator the server runs on the wire. The count is bounded
    // as well as each element's shape, the way the boxes above are bounded
    // by their layout's cell count: a hand-edited record with twenty legal
    // parts would otherwise mount, preview, and fire twenty downloads
    // before /api/window's own check ever ran. `undefined` — not a
    // fallback — so main.ts's `?? initial` decides what an unusable record
    // means, which is what every other field here already does.
    segments: isValidSegments(s.segments, Number.POSITIVE_INFINITY)
      ? s.segments
      : undefined,
```

Note the `POSITIVE_INFINITY`: `restore` does not know the video's duration
(it is called before probe on the cached-clip path), and an upper bound is
not what this check is for — `openWindow` clamps against the real duration,
and the server re-validates against it. `MAX_SEGMENTS` is imported for the
count check inside `isValidSegments`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run src/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C . add src/state.ts src/state.test.ts
git -C . commit -m "feat: AppState holds segments, with a migration from start/end"
```

---

### Task 8: Wire the client — `api.ts`, and every `s.start`/`s.end` in `main.ts`

**Files:**
- Modify: `src/api.ts` (`fetchWindow`, `exportClip`, `WindowResult`)
- Modify: `src/main.ts` (`load`, `openWindow`, `openClip`, `doExport`, `renderFraming`)

**Interfaces:**
- Consumes: everything from Tasks 1 and 7.
- Produces: nothing new; this task makes the app compile and run again.

- [ ] **Step 1: Update `src/api.ts`**

```ts
export async function fetchWindow(
  videoId: string,
  segments: Segment[],
  duration: number,
): Promise<WindowResult> {
  return (await post("/api/window", { videoId, segments, duration }))
    .json() as Promise<WindowResult>;
}
```

Import `type { Segment } from "./segments.ts"`. Add `clipStart: number`,
`clipEnd: number`, `digest: string` to whatever declares `WindowResult` in
this file, and add to `exportClip`'s body type:

```ts
  /** A stitch's segment digest, `""` for an ordinary clip. The server
   *  rebuilds the cache path from window bounds plus this — it is 8 hex
   *  characters, never a path. */
  digest: string;
```

- [ ] **Step 2: Update the four state-writing paths in `main.ts`**

In `load`'s short-video branch:

```ts
      const win = await api.fetchWindow(
        info.videoId,
        [{ start: 0, end: info.duration }],
        info.duration,
      );
      // …
      setState({
        videoId: info.videoId,
        title: info.title,
        duration: info.duration,
        segments: [{ start: 0, end: info.duration }],
        clipUrl: win.clipUrl,
        windowStart: win.windowStart,
        windowEnd: win.windowEnd,
        clipStart: win.clipStart,
        clipEnd: win.clipEnd,
        clipDigest: win.digest,
        source,
        // …unchanged…
      });
```

In `load`'s trimming branch:

```ts
      segments: saved.segments ?? [{ start: 0, end: info.duration }],
```

In `openWindow`:

```ts
    const w = await api.fetchWindow(s.videoId, s.segments, s.duration);
    const source = { w: w.width, h: w.height };
    const saved = restore(s.videoId, source);
    setState({
      clipUrl: w.clipUrl,
      windowStart: w.windowStart,
      windowEnd: w.windowEnd,
      clipStart: w.clipStart,
      clipEnd: w.clipEnd,
      clipDigest: w.digest,
      source,
      // …unchanged…
    });
```

In `openClip`:

```ts
    duration: c.windowEnd,
    segments: [{ start: c.windowStart, end: c.windowEnd }],
    clipUrl: c.clipUrl,
    windowStart: c.windowStart,
    windowEnd: c.windowEnd,
    clipStart: c.clipStart,
    clipEnd: c.clipEnd,
    clipDigest: c.digest,
```

In `doExport`:

```ts
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      // Clip time, not the marks: a stitch's clip has its own timeline. For
      // a single segment these ARE the marks, so this request is unchanged.
      start: s.clipStart,
      end: s.clipEnd,
      digest: s.clipDigest,
```

- [ ] **Step 3: Add the two read helpers near the top of `main.ts`**

```ts
/** The first mark and the last, for the read-only places that describe the
 *  cut as a span — badges, the over-3-minutes warning, the strip's own
 *  extent. Under `noUncheckedIndexedAccess` both ends need a fallback; an
 *  empty `segments` is unreachable (state starts with one and `− Part` is
 *  disabled at one) but is not worth an assertion. */
function firstMark(s: AppState): number {
  return s.segments[0]?.start ?? 0;
}

function lastMark(s: AppState): number {
  return s.segments[s.segments.length - 1]?.end ?? 0;
}

/** The kept length — what actually decides whether this is too long for a
 *  Short. NOT `lastMark − firstMark`: a two-part cut with a two-minute gap
 *  between the parts spans four minutes and keeps forty seconds. */
function keptLength(s: AppState): number {
  return totalDuration(s.segments);
}
```

Import `totalDuration` from `./segments.ts` and `type { AppState }` from
`./state.ts`.

- [ ] **Step 4: Replace the read sites in `renderFraming`**

```ts
  const exportable = (text: string) =>
    keptLength(s) > 0 && text.trim() !== "" && !s.busy;

  const long = keptLength(s) > SHORTS_MAX_S;
```

and the badge:

```ts
        el("span", {
          className: "badge",
          textContent:
            s.segments.length === 1
              ? `${clock(firstMark(s))} → ${clock(lastMark(s))}`
              : `${s.segments.length} parts · ${clock(keptLength(s))}`,
        }),
```

- [ ] **Step 5: Update `ensureSourcePlayer`'s initial seek**

```ts
      if (firstMark(cur) > 0) p.seekTo(firstMark(cur));
```

- [ ] **Step 6: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: errors only in `renderTrimming`, which Task 9 rewrites. If any
other site still reads `s.start`/`s.end`, fix it here.

- [ ] **Step 7: Commit**

```bash
git -C . add src/api.ts src/main.ts
git -C . commit -m "feat: client sends segments and clip-timeline export bounds"
```

---

### Task 9: The trimming UI — playhead, square ends, multiple parts

**Files:**
- Modify: `src/player.ts` (`renderStrip`)
- Modify: `src/style.css` (`.strip`, `.strip-range`, add `.strip-head`, `.strip-range.is-active`)
- Modify: `src/main.ts` (`renderTrimming`)

**Interfaces:**
- Consumes: everything above.
- Produces: `renderStrip(opts): { el: HTMLElement; stop(): void }` — note this is no longer a bare element.

- [ ] **Step 1: Rewrite `renderStrip` in `src/player.ts`**

```ts
/** A trim you cannot see is a trim you cannot verify, so the kept ranges are
 *  drawn, not just stored. Clicking the strip seeks.
 *
 *  Returns a handle rather than a bare element because it now owns a rAF
 *  loop for the playhead — the same `{ …, stop }` shape `mountEditor`
 *  returns, and for the same reason. A caller that drops the handle without
 *  calling `stop()` leaves a loop reading a detached node forever. */
export function renderStrip(opts: {
  duration: number;
  segments: { start: number; end: number }[];
  /** Which segment the marking controls are aimed at, drawn brighter. */
  active: number;
  /** The playhead's position in source seconds, read every frame. A
   *  callback rather than a value: this module knows nothing about the
   *  caller's player handle, and a value would be stale by the next frame. */
  head(): number;
  onSeek(s: number): void;
}): { el: HTMLElement; stop(): void } {
  const strip = document.createElement("div");
  strip.className = "strip";

  const pct = (s: number) => `${(100 * s) / Math.max(1, opts.duration)}%`;
  opts.segments.forEach((seg, i) => {
    const range = document.createElement("div");
    range.className = i === opts.active ? "strip-range is-active" : "strip-range";
    range.style.left = pct(seg.start);
    range.style.width = pct(Math.max(0, seg.end - seg.start));
    strip.append(range);
  });

  const head = document.createElement("div");
  head.className = "strip-head";
  strip.append(head);

  let frame = 0;
  let last = -1;
  const tick = () => {
    const t = opts.head();
    // Only touched when it actually moves: a style write per frame on a
    // paused player is pure layout churn.
    if (t !== last) {
      last = t;
      head.style.left = pct(t);
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  strip.onclick = (e) => {
    const box = strip.getBoundingClientRect();
    const frac = (e.clientX - box.left) / Math.max(1, box.width);
    opts.onSeek(frac * opts.duration);
  };
  return {
    el: strip,
    stop: () => cancelAnimationFrame(frame),
  };
}
```

- [ ] **Step 2: Update `src/style.css`**

```css
/* Slider track + kept ranges + playhead */
.strip {
  position: relative;
  flex: 1 1 240px;
  height: 12px;
  min-width: 160px;
  border-radius: var(--radius-3);
  background: var(--slate-a4);
  cursor: pointer;
  /* The ranges inside are square-cornered, so a part marked at 0 or at the
     video's end would otherwise paint its corner outside this track's
     rounded one — a 6px notch of blue sticking past the grey, at exactly
     the two positions a user is most likely to mark. */
  overflow: hidden;
}

/* No radius, deliberately. A cut boundary is a position, and a rounded end
   reads as a fade — at 12px tall a 6px radius makes the range a full pill,
   so its ends become the least precise part of the control the user is
   being precise with. Square ends are also what makes several ranges
   legible side by side. */
.strip-range {
  position: absolute;
  inset-block: 0;
  border-radius: 0;
  background: var(--blue-8);
}

/* The part the marking controls are aimed at. */
.strip-range.is-active { background: var(--blue-9); }

/* Where the player actually is. Above the ranges, and `pointer-events: none`
   so it never eats the strip's own click-to-seek. */
.strip-head {
  position: absolute;
  inset-block: 0;
  width: 2px;
  margin-left: -1px;
  background: var(--slate-12);
  pointer-events: none;
}
```

- [ ] **Step 3: Add the active-segment state and the part controls in `renderTrimming`**

Above `renderTrimming`, beside `stampText`:

```ts
// Which segment Set Start / Set End write to. Module-scoped for the reason
// `stampText` is: nothing about it is persisted, and `barSlot` is rebuilt on
// every render — so it has to survive that rebuild without ever causing one.
let activeSegment = 0;

// renderTrimming replaces the strip on every render, and the strip owns a
// rAF loop now. Stopping the old one before building the new one is what
// keeps a loop from reading a detached node for the life of the session.
let strip: { el: HTMLElement; stop(): void } | null = null;
```

Inside `renderTrimming`, replace the two mark handlers:

```ts
  // Clamped to the active segment's own index, not to the array: a render
  // can arrive after `− Part` shrank it.
  const active = Math.min(activeSegment, s.segments.length - 1);

  /** Rewrites one bound of the active segment and re-normalises the whole
   *  set — dragging a mark past a neighbour is an ordinary editing gesture,
   *  and `normalize` merges rather than rejecting it.
   *
   *  Reads live state via getState(), never `s`: every path that writes
   *  segments goes through setState today, but this is the same hazard
   *  `+ Box` hit, and the cost of getting it wrong is a silently reverted
   *  edit persisted by the save() on the next line. */
  const setMark = (which: "start" | "end") => {
    if (!player) return;
    const cur = getState();
    const t = clampMark(player.currentTime(), cur.duration);
    const next = cur.segments.map((seg, i) => (i === active ? { ...seg, [which]: t } : seg));
    setState({ segments: normalize(next, cur.duration) });
    save();
  };

  const setStart = el("button", { textContent: "Set Start", disabled: !ready });
  setStart.onclick = () => setMark("start");

  const setEnd = el("button", { textContent: "Set End", disabled: !ready });
  setEnd.onclick = () => setMark("end");
```

Add the part controls:

```ts
  // A five-second default rather than an empty range: every intermediate
  // state stays valid, so Continue never has to explain itself.
  const addPart = el("button", {
    textContent: "+ Part",
    title: "Keep another range, starting at the playhead",
    disabled: !ready || s.segments.length >= MAX_SEGMENTS,
  });
  addPart.onclick = () => {
    if (!player) return;
    const cur = getState();
    const t = clampMark(player.currentTime(), cur.duration);
    const next = normalize(
      [...cur.segments, { start: t, end: Math.min(t + 5, cur.duration) }],
      cur.duration,
    );
    // Found by identity of the bounds rather than by position: normalize
    // sorts, so the new part is rarely last.
    activeSegment = Math.max(0, next.findIndex((seg) => seg.start === t));
    setState({ segments: next });
    save();
  };

  const dropPart = el("button", {
    className: "btn-gray",
    textContent: "− Part",
    title: "Drop the selected range",
    disabled: !ready || s.segments.length <= 1,
  });
  dropPart.onclick = () => {
    const cur = getState();
    if (cur.segments.length <= 1) return;
    const next = cur.segments.filter((_seg, i) => i !== active);
    activeSegment = Math.max(0, Math.min(active, next.length - 1));
    setState({ segments: next });
    save();
  };

  // One chip per part, switching which one the marking controls aim at.
  const chips = el("div", { className: "nudges", ariaLabel: "Select part" });
  chips.setAttribute("role", "group");
  s.segments.forEach((seg, i) => {
    const chip = el("button", {
      className: i === active ? "" : "btn-gray",
      textContent: String(i + 1),
      title: `${clock(seg.start)} → ${clock(seg.end)}`,
      disabled: !ready,
    });
    chip.onclick = () => {
      activeSegment = i;
      // A seek, not just a selection: switching parts is almost always a
      // prelude to looking at that part. Deliberately no pause — the same
      // reasoning as the jump-to-mark buttons.
      player?.seekTo(seg.start);
      setState({});
    };
    chips.append(chip);
  });
```

Replace the jump buttons' targets and the badges:

```ts
  const activeSeg = s.segments[active] ?? { start: 0, end: 0 };
  const toStart = jump("⇤ Start", activeSeg.start, true);
  const toEnd = jump("End ⇥", activeSeg.end, activeSeg.end > 0);

  const marks = el("span", {
    className: "badge",
    textContent:
      s.segments.length === 1
        ? `${clock(activeSeg.start)} → ${clock(activeSeg.end)}`
        : `${s.segments.length} parts · ${clock(keptLength(s))} kept`,
  });

  const long = keptLength(s) > SHORTS_MAX_S;
```

and Continue's gate:

```ts
  const go = el("button", {
    className: "btn-solid",
    textContent: "Continue",
    disabled: !ready || !isValidSegments(s.segments, s.duration),
  });
```

- [ ] **Step 4: Rebuild the strip row**

```ts
  strip?.stop();
  strip = renderStrip({
    duration: s.duration,
    segments: s.segments,
    active,
    head: () => player?.currentTime() ?? 0,
    onSeek: (t) => player?.seekTo(t),
  });

  return [
    el("div", { className: "bar-row" }, strip.el, marks),
    el("div", { className: "bar-row" }, toggle, toStart, toEnd, nudges),
    el("div", { className: "bar-row" }, chips, addPart, dropPart),
    el(
      "div",
      { className: "bar-row" },
      ...controls,
      ...stamp,
      el("div", { className: "bar-end" }, warn, go),
    ),
  ];
```

Add to `main.ts`'s imports: `MAX_SEGMENTS, isValidSegments, normalize` from
`./segments.ts`.

- [ ] **Step 5: Typecheck, build, and run the suite**

Run: `pnpm exec tsc --noEmit && pnpm build && pnpm test`
Expected: no errors, build succeeds, every test passes.

- [ ] **Step 6: Verify by hand in a real browser**

`pnpm server` and `pnpm dev`, then at `localhost:5173`:

1. Paste a video over 180s. In trimming, confirm a dark vertical line tracks playback across the strip and stops when the player pauses.
2. Confirm the blue range's ends are square, and that marking a part at 0 shows no blue outside the track's rounded corner.
3. `+ Part` twice, mark each part with Set Start / Set End, confirm three chips, three separate blue blocks, and that the badge reads `3 parts · MM:SS kept`.
4. Click chip 2, confirm it seeks and that Set Start now moves *that* block.
5. `− Part`, confirm the chip and block disappear and the button disables at one part.
6. Drag one part's end past the next part's start (Set End past it) and confirm the two merge into one chip.
7. Continue. Confirm the framing `<video>` plays the parts back to back with no gap, and the canvas preview matches.
8. Export. Confirm the finished file in `~/Desktop/vstack/` contains the same cut, and `media/<id>/` holds one `0-<total>-<digest>.mp4` plus one plain clip per part.
9. Reload the page mid-session and reopen the same video; confirm the parts restore.

- [ ] **Step 7: Commit**

```bash
git -C . add src/player.ts src/style.css src/main.ts
git -C . commit -m "feat: playhead, square range ends, and multi-part trimming"
```

---

### Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the spec-pointer paragraph**

Add `docs/specs/2026-08-28-vstack-segments-design.md` to the chain at the
top, noting that it supersedes the 2026-08-20 doc's one-`start`/`end`-pair
trimming phase and `/api/window` body, and supersedes the custom-boxes doc's
`/api/export` body once more (`digest` on top of everything else).

- [ ] **Step 2: Update the architecture map**

Add `src/segments.ts` (`Segment`, `MAX_SEGMENTS`, `normalize`,
`isValidSegments`, `totalDuration`) beside `src/geometry.ts`, and note it in
the layering sentence: it sits at the bottom, imports nothing, and is
imported by the server the same way `geometry.ts` is.

Add `concatClips`/`segmentDigest` to the `server/ffmpeg.ts` line.

- [ ] **Step 3: Amend three invariants**

- **`/api/export` takes window bounds, never a file path** — amend to "window bounds plus an optional 8-hex `digest`, still never a path", and say why the server cannot recompute it (the `listClips` reopen path has no segments to hash).
- **`listClips` must never offer a download partial** — amend to describe the widened `CLIP_RE` and add the new rule: `listClips` uses `readdir`'s own name and must never rebuild the path from parsed bounds, because that silently drops a stitch's digest.
- Add a new invariant: **the framing phase must never learn that segments exist.** The cut is baked into the cached clip by `/api/window`; carrying segments to `/api/export` instead would leave the framing `<video>` playing footage the export drops.

- [ ] **Step 4: Update the testing-posture paragraph**

Add `src/segments.test.ts` to the exhaustively-covered list beside
`geometry.ts`, `layout.ts` and `custom.ts`, and note `server/ffmpeg.test.ts`
now covers a real two-range concat (ordering mutation-tested), a silent part,
and a SAR mismatch.

- [ ] **Step 5: Commit**

```bash
git -C . add CLAUDE.md
git -C . commit -m "docs: record the segment model and its invariants"
```

---

## Self-review notes

**Spec coverage.** `src/segments.ts` → Task 1. `probeFile`/`clipName`/digest →
Task 2. The concat pass → Task 3. `CLIP_RE`/`parseClipName`/`listClips` →
Task 4. `fetchWindow` → Task 5. Both routes → Task 6. State + migration →
Task 7. `api.ts`/`main.ts` wiring → Task 8. Playhead, square ends, part
controls → Task 9. CLAUDE.md → Task 10.

**Two decisions this plan makes that the spec left open.**

1. `restore` validates segments against `POSITIVE_INFINITY` rather than a
   duration, because it is called before probe on the cached-clip path and
   has no duration to check against. The bound that matters —
   `MAX_SEGMENTS`, ordering, `end > start` — is enforced either way, and
   `/api/window` re-validates against the real duration.
2. `keptLength` (the sum) rather than `lastMark − firstMark` decides the
   over-3-minutes warning and the Export gate. A two-part cut with a gap
   between the parts spans more than it keeps, and the span is not what
   YouTube measures.
