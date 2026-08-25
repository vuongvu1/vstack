# Custom Floating Boxes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add up to two user-placed pieces that float over the preset layout — output rect dragged on the composite preview, crop rect dragged on the source video, white ring and rounded corners like every other piece.

**Architecture:** Custom boxes are a parallel array (`customs: { out, crop }[]`), never extra cells: `cellsOf`, `ratioOf` and `xstack` keep tiling 1080×1920 exactly. Each custom is an extra decode leg `overlay`'d onto the finished stack, and the single frame-overlay mask — still applied last — gains a per-pixel priority order that draws the ring, cuts the corners and lets a custom straddle a cell seam. Zero customs produces byte-identical filter strings and mask filenames to today, so the feature is inert until used.

**Tech Stack:** TypeScript (strict, `erasableSyntaxOnly`, `noUncheckedIndexedAccess`), vanilla DOM, `node:http`, vitest (`environment: "node"`), real `ffmpeg`/`ffprobe` in tests.

**Spec:** `docs/specs/2026-08-25-vstack-custom-boxes-design.md`

## Global Constraints

- `import type` for type-only imports; explicit `.ts` extensions on relative imports.
- No `enum`, `namespace`, `any`, default exports, or barrel files. Node runs `server/*.ts` with type stripping, so non-erasable syntax is a boot crash.
- `strict` + `noUncheckedIndexedAccess`: indexing yields `T | undefined`; guard with `?? fallback`, never `!`.
- No `console.log`/`.info` — `.error`/`.warn` only.
- Client layering stays acyclic: `geometry ← {layout, custom} ← frame ← everything`. `src/custom.ts` imports **only** `geometry.ts`.
- Server layering stays acyclic: `errors ← {ffmpeg, starter, youtube} ← {ytdlp, mask} ← index`.
- Crop rects stay in **source pixels**, plain integers, zero conversion. Output rects stay in **output pixels** and are **even on all four fields**.
- `GUTTER` (10) and `CORNER_RADIUS` (24) are output-space decoration and must never reach `ratioOf` or a crop rect.
- Visual values come from the `@radix-ui/colors` custom properties imported in `style.css`; import each solid scale together with its `-alpha` companion.
- `Bash(git add)`, `Bash(git commit *)` and `Bash(rm *)` are deny-listed in this environment: use `git -C . add` / `git -C . commit` and Node's `fs.rm`.
- Full suite: `pnpm test` (166 tests today, shells real ffmpeg **and** real VieNeu-TTS — `pnpm tts-setup` must have run). Single file: `pnpm vitest run <path>`.

---

## File Structure

**Create:**
- `src/custom.ts` — the `CustomBox` type, its constants, its output-rect math (`clampOut`, `moveOut`, `resizeOut`), the crop re-snap, and the validators. Sits beside `layout.ts` above `geometry.ts`; imports only `geometry.ts`.
- `src/custom.test.ts` — exhaustive coverage of the above, matching `geometry.test.ts`'s posture (this module's bugs are silent).

**Modify:**
- `src/frame.ts` — `insideRounded` (generalised from `insideWindow`), new `ringOf`, `maskRgba(windows, customs = [])` with the priority order.
- `src/frame.test.ts` — ring/window/nub/seam assertions, two of them mutation-tested.
- `server/mask.ts` — `maskPath`/`ensureMask` take the custom out-rects and hash them into the filename.
- `server/mask.test.ts` — call-site updates plus the hash assertions.
- `server/ffmpeg.ts` — `buildFilter(layout, boxes, customs = [])`, new `assertCustoms`, `ExportOpts.customs`.
- `server/ffmpeg.test.ts` — call-site updates, filter-string assertions, one real-ffmpeg export with a custom.
- `server/index.ts` — `/api/export` reads and validates `customs`, passes them to `ensureMask` and `exportClip`.
- `src/api.ts` — `exportClip` body type gains `customs`.
- `src/state.ts` — `AppState.customs`, `Saved.customs`, save gating, restore validation.
- `src/state.test.ts` — customs round-trip and gating.
- `src/preview.ts` — draws customs, then the ring∪nub fill, with custom windows clipped out of both white fills.
- `src/editor.ts` — generalised: any host element, injected move/resize strategies, per-index label offset.
- `src/main.ts` — the second (output) overlay, `+ Box` / `×`, remount key, export payload.
- `src/style.css` — `box-c4`/`box-c5` tints and the `×` control.
- `CLAUDE.md`, `docs/specs/2026-08-25-vstack-custom-boxes-design.md` — docs, last.

---

### Task 1: The custom-box model and its math

**Files:**
- Create: `src/custom.ts`
- Create: `src/custom.test.ts`

**Interfaces:**
- Consumes: `OUTPUT`, `boxFromHeight`, `clampToBounds`, `isValidBox`, `maxBox`, types `Corner`/`Rect`/`Size` from `src/geometry.ts`.
- Produces:
  - `type CustomBox = { out: Rect; crop: Rect }`
  - `const MAX_CUSTOM = 2`, `const MIN_OUT_SIDE = 160`
  - `outRatio(out: Rect): number`
  - `clampOut(rect: Rect): Rect`
  - `moveOut(rect: Rect, dx: number, dy: number): Rect`
  - `resizeOut(rect: Rect, corner: Corner, dx: number, dy: number): Rect`
  - `resnapCrop(crop: Rect, source: Size, out: Rect): Rect`
  - `isValidOut(out: unknown): out is Rect`
  - `isValidCustom(custom: unknown, source: Size): custom is CustomBox`
  - `defaultCustom(source: Size, index: number): CustomBox`

- [ ] **Step 1: Write the failing test**

Create `src/custom.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { OUTPUT, isValidBox } from "./geometry.ts";
import type { Corner, Rect, Size } from "./geometry.ts";
import {
  MAX_CUSTOM,
  MIN_OUT_SIDE,
  clampOut,
  defaultCustom,
  isValidCustom,
  isValidOut,
  moveOut,
  outRatio,
  resizeOut,
  resnapCrop,
} from "./custom.ts";

const HD: Size = { w: 1920, h: 1080 };
const SD: Size = { w: 1280, h: 720 };
const TALL: Size = { w: 720, h: 1280 };
const SOURCES = [HD, SD, TALL];
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
const OUT: Rect = { x: 300, y: 700, w: 480, h: 480 };

function assertLegalOut(r: Rect): void {
  expect([r.x, r.y, r.w, r.h].every(Number.isInteger)).toBe(true);
  expect([r.x, r.y, r.w, r.h].every((n) => n % 2 === 0)).toBe(true);
  expect(r.w).toBeGreaterThanOrEqual(MIN_OUT_SIDE);
  expect(r.h).toBeGreaterThanOrEqual(MIN_OUT_SIDE);
  expect(r.x).toBeGreaterThanOrEqual(0);
  expect(r.y).toBeGreaterThanOrEqual(0);
  expect(r.x + r.w).toBeLessThanOrEqual(OUTPUT.w);
  expect(r.y + r.h).toBeLessThanOrEqual(OUTPUT.h);
}

describe("MAX_CUSTOM / MIN_OUT_SIDE", () => {
  it("keeps the floor even, so clamping to it cannot break evenness", () => {
    // Every out field is even because an overlay at an odd offset in
    // yuv420p lands on a half-chroma-sample boundary. An odd floor would
    // make the smallest legal box unreachable by the even-snapping helpers.
    expect(MIN_OUT_SIDE % 2).toBe(0);
    expect(MAX_CUSTOM).toBeGreaterThan(0);
  });
});

describe("clampOut", () => {
  it("returns a legal rect for anything, including fractional input", () => {
    const inputs: Rect[] = [
      { x: 10.4, y: 20.7, w: 481.3, h: 300.9 },
      { x: -500, y: -500, w: 5000, h: 5000 },
      { x: 1079, y: 1919, w: 2, h: 2 },
      OUT,
    ];
    for (const r of inputs) assertLegalOut(clampOut(r));
  });

  it("is idempotent, so re-snapping every drag frame cannot drift", () => {
    const once = clampOut({ x: 101, y: 203, w: 305, h: 407 });
    expect(clampOut(once)).toEqual(once);
  });
});

describe("moveOut", () => {
  it("slides without resizing", () => {
    const moved = moveOut(OUT, -1000, 5000);
    expect(moved.w).toBe(OUT.w);
    expect(moved.h).toBe(OUT.h);
    assertLegalOut(moved);
    expect(moved.x).toBe(0);
    expect(moved.y).toBe(OUTPUT.h - OUT.h);
  });
});

describe("resizeOut", () => {
  it("keeps the opposite corner anchored", () => {
    const se = resizeOut(OUT, "se", 100, 40);
    expect(se.x).toBe(OUT.x);
    expect(se.y).toBe(OUT.y);
    const nw = resizeOut(OUT, "nw", -100, -40);
    expect(nw.x + nw.w).toBe(OUT.x + OUT.w);
    expect(nw.y + nw.h).toBe(OUT.y + OUT.h);
  });

  it("changes the ratio freely — that is the whole point of a custom box", () => {
    const wide = resizeOut(OUT, "se", 400, -200);
    expect(outRatio(wide)).toBeGreaterThan(outRatio(OUT));
    assertLegalOut(wide);
  });

  it("floors each side and never leaves the frame, from every corner", () => {
    for (const corner of CORNERS) {
      const collapsed = resizeOut(OUT, corner, -5000, -5000);
      assertLegalOut(collapsed);
      const blown = resizeOut(OUT, corner, 5000, 5000);
      assertLegalOut(blown);
    }
  });
});

describe("resnapCrop", () => {
  it("rebuilds the width for the new ratio and keeps the aspect exact", () => {
    const crop: Rect = { x: 400, y: 200, w: 600, h: 600 };
    const wider: Rect = { x: 300, y: 700, w: 960, h: 480 };
    const next = resnapCrop(crop, HD, wider);
    expect(next.w).toBe(Math.round(next.h * outRatio(wider)));
    expect(isValidBox(next, HD, outRatio(wider))).toBe(true);
  });

  it("is idempotent, so a per-frame re-snap does not shrink the crop", () => {
    const crop: Rect = { x: 400, y: 200, w: 600, h: 600 };
    const once = resnapCrop(crop, HD, OUT);
    expect(resnapCrop(once, HD, OUT)).toEqual(once);
  });

  it("survives an extreme ratio on every source", () => {
    // boxFromHeight already clamps between effectiveMinH and maxBox, so a
    // very wide out yields a shorter crop rather than an invalid one.
    const strip: Rect = { x: 0, y: 0, w: 1080, h: 160 };
    for (const source of SOURCES) {
      const crop = resnapCrop({ x: 0, y: 0, w: 200, h: 200 }, source, strip);
      expect(isValidBox(crop, source, outRatio(strip))).toBe(true);
    }
  });
});

describe("isValidOut", () => {
  it("accepts what clampOut emits and rejects everything illegal", () => {
    expect(isValidOut(clampOut(OUT))).toBe(true);
    expect(isValidOut({ ...OUT, x: 301 })).toBe(false); // odd
    expect(isValidOut({ ...OUT, w: 100 })).toBe(false); // under the floor
    expect(isValidOut({ ...OUT, x: 900 })).toBe(false); // off the frame
    expect(isValidOut({ ...OUT, h: Number.NaN })).toBe(false);
    expect(isValidOut(null)).toBe(false);
    expect(isValidOut("nope")).toBe(false);
  });
});

describe("isValidCustom", () => {
  it("accepts defaultCustom for every source and index", () => {
    for (const source of SOURCES) {
      for (let i = 0; i < MAX_CUSTOM; i++) {
        expect(isValidCustom(defaultCustom(source, i), source)).toBe(true);
      }
    }
  });

  it("rejects a crop that is off the box's own ratio", () => {
    // The custom-box version of "a box is only legal for its own cell": a
    // perfect square crop under a 2:1 out would export stretched.
    const custom = defaultCustom(HD, 0);
    const stretched = { out: { ...custom.out, w: custom.out.w * 2 }, crop: custom.crop };
    expect(isValidCustom(stretched, HD)).toBe(false);
  });

  it("rejects a crop hanging over the source edge", () => {
    const custom = defaultCustom(HD, 0);
    expect(isValidCustom({ ...custom, crop: { ...custom.crop, x: 1900 } }, HD)).toBe(false);
  });

  it("rejects non-objects without throwing", () => {
    expect(isValidCustom(null, HD)).toBe(false);
    expect(isValidCustom([], HD)).toBe(false);
    expect(isValidCustom({ out: null, crop: null }, HD)).toBe(false);
  });
});

describe("defaultCustom", () => {
  it("offsets the second box so its handles are not buried", () => {
    const first = defaultCustom(HD, 0);
    const second = defaultCustom(HD, 1);
    expect(second.out.x).not.toBe(first.out.x);
    expect(second.out.y).not.toBe(first.out.y);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/custom.test.ts`
Expected: FAIL — `Failed to resolve import "./custom.ts"`.

- [ ] **Step 3: Write the implementation**

Create `src/custom.ts`:

```ts
import { OUTPUT, boxFromHeight, clampToBounds, isValidBox, maxBox } from "./geometry.ts";
import type { Corner, Rect, Size } from "./geometry.ts";

/** A piece that floats over the preset layout. `out` is where it lands in
 *  the 1080x1920 frame; `crop` is the region of the source it shows. Both
 *  are stored raw, with zero conversion between them — the invariant that
 *  makes canvas drawImage and ffmpeg's crop= agree for the preset cells
 *  applies here unchanged.
 *
 *  Custom boxes are deliberately NOT extra cells: `Layout` is authored as
 *  rows so that a hand-written cell list cannot express a seam or an
 *  overlap, and a floating box is an overlap by construction. */
export type CustomBox = { out: Rect; crop: Rect };

/** Two. Each one costs a decode leg, an overlay, a mask window, a node on
 *  each of the two editor overlays and a colour in the box scale. */
export const MAX_CUSTOM = 2;

/** Output px. Small enough to be a corner inset, large enough to grab by
 *  its handles. Even, so clamping to it cannot break the evenness rule. */
export const MIN_OUT_SIDE = 160;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Rounds DOWN to an even number. Every `out` field is even because an
 *  overlay at an odd offset in yuv420p lands on a half-chroma-sample
 *  boundary. Down rather than nearest so a value already clamped to a
 *  maximum cannot round back past it. */
const even = (n: number) => Math.floor(n / 2) * 2;

/** The aspect this box's crop must hold — the box's own, never a cell's.
 *  This is the value that goes into `isValidBox`'s `ratio` parameter, which
 *  is exactly the case that parameter exists for. */
export function outRatio(out: Rect): number {
  return out.w / out.h;
}

/** The nearest legal output rect: even on all four fields, at least
 *  MIN_OUT_SIDE per side, wholly inside the frame. Idempotent, because it
 *  runs on every frame of a drag. */
export function clampOut(rect: Rect): Rect {
  const w = even(clamp(rect.w, MIN_OUT_SIDE, OUTPUT.w));
  const h = even(clamp(rect.h, MIN_OUT_SIDE, OUTPUT.h));
  return {
    w,
    h,
    x: even(clamp(rect.x, 0, OUTPUT.w - w)),
    y: even(clamp(rect.y, 0, OUTPUT.h - h)),
  };
}

/** Slides an output rect, never resizing it — the same discipline
 *  `clampToBounds` keeps on the source side. */
export function moveOut(rect: Rect, dx: number, dy: number): Rect {
  return clampOut({ ...rect, x: rect.x + dx, y: rect.y + dy });
}

/** Free resize about the opposite corner: `resizeFromCorner`'s shape minus
 *  the aspect lock, because a custom box's aspect is the thing being chosen
 *  here. Each side is capped at the anchor's own distance to the frame edge,
 *  so the result is inside the frame without a follow-up clamp that could
 *  slide the anchor out from under the pointer. */
export function resizeOut(rect: Rect, corner: Corner, dx: number, dy: number): Rect {
  const west = corner === "nw" || corner === "sw";
  const north = corner === "nw" || corner === "ne";

  const anchorX = west ? rect.x + rect.w : rect.x;
  const anchorY = north ? rect.y + rect.h : rect.y;
  const draggedX = (west ? rect.x : rect.x + rect.w) + dx;
  const draggedY = (north ? rect.y : rect.y + rect.h) + dy;

  const w = even(
    clamp(west ? anchorX - draggedX : draggedX - anchorX, MIN_OUT_SIDE, west ? anchorX : OUTPUT.w - anchorX),
  );
  const h = even(
    clamp(north ? anchorY - draggedY : draggedY - anchorY, MIN_OUT_SIDE, north ? anchorY : OUTPUT.h - anchorY),
  );

  return { x: west ? anchorX - w : anchorX, y: north ? anchorY - h : anchorY, w, h };
}

/** The crop that follows an `out` whose ratio just changed: same height,
 *  same centre, width rebuilt from the new ratio. Height-driven like every
 *  other constructor in this codebase, so re-snapping on every drag frame
 *  does not shrink the crop a pixel at a time, and `boxFromHeight`'s own
 *  clamp covers an extreme ratio without a special case. */
export function resnapCrop(crop: Rect, source: Size, out: Rect): Rect {
  const cx = crop.x + crop.w / 2;
  const cy = crop.y + crop.h / 2;
  const size = boxFromHeight(crop.h, source, outRatio(out));
  return clampToBounds(
    { x: Math.round(cx - size.w / 2), y: Math.round(cy - size.h / 2), ...size },
    source,
  );
}

/** Takes `unknown` because it validates values arriving from localStorage
 *  and from a request body, whatever the parameter type claims at compile
 *  time — the same posture as `isValidBox`. */
export function isValidOut(out: unknown): out is Rect {
  if (typeof out !== "object" || out === null) return false;
  const r = out as Rect;
  if (![r.x, r.y, r.w, r.h].every(Number.isInteger)) return false;
  return (
    r.x % 2 === 0 &&
    r.y % 2 === 0 &&
    r.w % 2 === 0 &&
    r.h % 2 === 0 &&
    r.w >= MIN_OUT_SIDE &&
    r.h >= MIN_OUT_SIDE &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.x + r.w <= OUTPUT.w &&
    r.y + r.h <= OUTPUT.h
  );
}

/** One definition of a legal custom box, shared by `restore` on the client
 *  and `assertCustoms` on the server — the split `isValidBox` already has
 *  for the preset cells. Either side alone would let a bad box preview
 *  cleanly and die only at export. */
export function isValidCustom(custom: unknown, source: Size): custom is CustomBox {
  if (typeof custom !== "object" || custom === null || Array.isArray(custom)) return false;
  const c = custom as CustomBox;
  return isValidOut(c.out) && isValidBox(c.crop, source, outRatio(c.out));
}

/** A fresh box: a 540x540 square in the middle of the frame showing the
 *  largest square the source holds, offset per index so a second box's
 *  handles do not land exactly under the first's. */
export function defaultCustom(source: Size, index: number): CustomBox {
  const side = 540;
  const offset = index * 60;
  const out = clampOut({
    x: (OUTPUT.w - side) / 2 + offset,
    y: (OUTPUT.h - side) / 2 + offset,
    w: side,
    h: side,
  });
  const size = maxBox(source, outRatio(out));
  const crop = clampToBounds(
    { x: Math.round((source.w - size.w) / 2), y: Math.round((source.h - size.h) / 2), ...size },
    source,
  );
  return { out, crop };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/custom.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git -C . add src/custom.ts src/custom.test.ts
git -C . commit -m "feat: custom box model and its output-rect math

A floating piece is { out, crop }: out is even-snapped output pixels
clamped inside the frame, crop is source pixels locked to out's own
ratio. resnapCrop is height-driven so a per-frame re-snap during a
preview resize cannot drift.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The mask's priority order

**Files:**
- Modify: `src/frame.ts`
- Modify: `src/frame.test.ts`

**Interfaces:**
- Consumes: `Rect` from `src/geometry.ts`; `CustomBox` is *not* used here — this module takes bare out-rects, because the mask has no business knowing about crops.
- Produces:
  - `ringOf(out: Rect): Rect`
  - `maskRgba(windows: Rect[], customs?: Rect[]): Uint8Array` (second parameter defaults to `[]`, so every existing call site is unchanged)

- [ ] **Step 1: Write the failing test**

Append to `src/frame.test.ts` (the file already defines `byId`, `alphaAt` and `rgbAt` at the top — reuse them):

```ts
describe("maskRgba — floating custom boxes", () => {
  // A box straddling the 1-1 layout's seam at y = 960, well inside the
  // frame on x. Everything below is asserted against these numbers.
  const CUSTOM: Rect = { x: 300, y: 700, w: 480, h: 480 };
  const windows = windowsOf(DEFAULT_LAYOUT);

  it("cuts a transparent window where the piece is drawn", () => {
    const mask = maskRgba(windows, [CUSTOM]);
    expect(alphaAt(mask, CUSTOM.x + CUSTOM.w / 2, CUSTOM.y + CUSTOM.h / 2)).toBe(0);
  });

  it("paints an opaque white ring one gutter wide around it", () => {
    const mask = maskRgba(windows, [CUSTOM]);
    const midX = CUSTOM.x + CUSTOM.w / 2;
    // Half a gutter above the top edge: inside the ring band.
    expect(alphaAt(mask, midX, CUSTOM.y - GUTTER / 2)).toBe(255);
    expect(rgbAt(mask, midX, CUSTOM.y - GUTTER / 2)).toEqual({ r: 255, g: 255, b: 255 });
    // Two px beyond the ring: back to the cell's own content.
    expect(alphaAt(mask, midX, CUSTOM.y - GUTTER - 2)).toBe(0);
  });

  it("keeps the corner nub opaque even where it sits over a cell window", () => {
    // The failure this prevents: the piece is drawn as a plain rect, so its
    // square corner would show through wherever the mask is transparent.
    // MUTATION TEST: drop the ring∪nub rule and this drops to 0.
    const mask = maskRgba(windows, [CUSTOM]);
    expect(alphaAt(mask, CUSTOM.x + 1, CUSTOM.y + 1)).toBe(255);
  });

  it("lets a piece straddle a cell seam without a white stripe through it", () => {
    // The 1-1 layout's two windows are one gutter apart around y = 960, so
    // that row is opaque white with no customs — and must not be, inside a
    // custom's window.
    // MUTATION TEST: let the gutter rule win over customs and this is 255.
    const bare = maskRgba(windows);
    expect(alphaAt(bare, CUSTOM.x + CUSTOM.w / 2, 960)).toBe(255);
    const mask = maskRgba(windows, [CUSTOM]);
    expect(alphaAt(mask, CUSTOM.x + CUSTOM.w / 2, 960)).toBe(0);
  });

  it("leaves the frame margin and the rest of the gutters alone", () => {
    const mask = maskRgba(windows, [CUSTOM]);
    expect(alphaAt(mask, 2, 2)).toBe(255);
    expect(alphaAt(mask, 100, 960)).toBe(255);
    expect(alphaAt(mask, 540, 480)).toBe(0);
  });
});

describe("ringOf", () => {
  it("is the box expanded by exactly one gutter on every side", () => {
    const out: Rect = { x: 300, y: 700, w: 480, h: 480 };
    expect(ringOf(out)).toEqual({
      x: out.x - GUTTER,
      y: out.y - GUTTER,
      w: out.w + 2 * GUTTER,
      h: out.h + 2 * GUTTER,
    });
  });
});
```

Update that file's import line to pull in `ringOf`:

```ts
import { CORNER_RADIUS, GUTTER, maskRgba, ringOf, windowOf, windowsOf } from "./frame.ts";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/frame.test.ts`
Expected: FAIL — `ringOf is not a function` / the nub assertion returns 0.

- [ ] **Step 3: Write the implementation**

In `src/frame.ts`, rename `insideWindow` to `insideRounded` with an explicit radius, add `ringOf`, and rewrite `maskRgba`'s inner loop around the priority order. Replace everything from `function insideWindow` to the end of the file with:

```ts
/** Standard rounded-rect containment: clamp the point into the rect the four
 *  arc centres span, then compare the distance to that clamped point against
 *  the radius. On a straight edge the clamp collapses one axis, so the test
 *  degenerates to the flat edge for free.
 *
 *  Takes the radius rather than reading CORNER_RADIUS directly because the
 *  ring around a floating piece is rounded at CORNER_RADIUS + GUTTER, so its
 *  outer edge stays concentric with the piece's own corners. */
function insideRounded(r: Rect, radius: number, px: number, py: number): boolean {
  if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) return false;
  const cx = Math.min(Math.max(px, r.x + radius), r.x + r.w - radius);
  const cy = Math.min(Math.max(py, r.y + radius), r.y + r.h - radius);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** The white ring around a floating piece: its window expanded by one gutter
 *  on every side, so the piece reads with the same visual weight as a seam
 *  between two cells. Exported because the canvas preview paints the same
 *  region and must derive it the same way rather than recompute it. */
export function ringOf(out: Rect): Rect {
  return {
    x: out.x - GUTTER,
    y: out.y - GUTTER,
    w: out.w + 2 * GUTTER,
    h: out.h + 2 * GUTTER,
  };
}

const SUB = 4;

/** The frame overlay as a raw RGBA buffer, `OUTPUT.w * OUTPUT.h * 4` bytes:
 *  opaque white where the composite must be covered, transparent where it
 *  must show, antialiased on every arc by `SUB * SUB` coverage sampling.
 *
 *  Three rules in priority order, because the overlay is applied AFTER the
 *  floating pieces are composited and therefore has to arbitrate between
 *  them and the gutters:
 *
 *    transparent  inside a custom's window   — the piece shows
 *    opaque       inside a custom's ring∪nub — draws the ring, cuts the
 *                                              piece's square corners
 *    opaque       outside every cell window  — today's gutters and margin
 *    transparent  otherwise
 *
 *  The first rule is what lets a piece straddle a cell seam without the
 *  seam's white stripe crossing it; the second is what stops the piece's
 *  square corner showing wherever it happens to sit over a cell window.
 *  With no customs this reduces exactly to the previous behaviour.
 *
 *  White in all three channels everywhere, including where alpha is 0, so a
 *  partially covered arc pixel can only ever blend towards white. */
export function maskRgba(windows: Rect[], customs: Rect[] = []): Uint8Array {
  const buf = new Uint8Array(OUTPUT.w * OUTPUT.h * 4);
  buf.fill(255);
  const rings = customs.map(ringOf);
  for (let y = 0; y < OUTPUT.h; y++) {
    for (let x = 0; x < OUTPUT.w; x++) {
      let opaque = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const px = x + (sx + 0.5) / SUB;
          const py = y + (sy + 0.5) / SUB;
          if (customs.some((c) => insideRounded(c, CORNER_RADIUS, px, py))) continue;
          if (
            rings.some((r) => insideRounded(r, CORNER_RADIUS + GUTTER, px, py)) ||
            !windows.some((w) => insideRounded(w, CORNER_RADIUS, px, py))
          ) {
            opaque++;
          }
        }
      }
      if (opaque === 0) continue;
      buf[(y * OUTPUT.w + x) * 4 + 3] = Math.round((opaque * 255) / (SUB * SUB));
    }
  }
  return buf;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/frame.test.ts server/mask.test.ts`
Expected: PASS. `server/mask.test.ts` is the regression fence for the no-customs path — the rewritten alpha arithmetic is algebraically identical to the old `255 - covered * 255 / 16`, and this proves it against a real decoded PNG.

- [ ] **Step 5: Commit**

```bash
git -C . add src/frame.ts src/frame.test.ts
git -C . commit -m "feat: mask arbitrates between floating pieces and gutters

maskRgba takes the custom out-rects and resolves each pixel in priority
order: a custom's window wins over a gutter (so a piece can straddle a
seam), and its ring∪nub region wins over everything (so the ring draws
and the piece's square corners are cut). No customs reduces to the
previous behaviour exactly.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The mask cache key

**Files:**
- Modify: `server/mask.ts`
- Modify: `server/mask.test.ts`
- Modify: `server/ffmpeg.test.ts` (two `ensureMask` call sites)

**Interfaces:**
- Consumes: `ringOf`/`maskRgba`/`windowsOf` from `src/frame.ts` (Task 2).
- Produces:
  - `maskPath(layout: Layout, customs?: Rect[], dir?: string): string`
  - `ensureMask(layout: Layout, customs?: Rect[], dir?: string): Promise<string>`
  - The `customs` parameter is **second**, before `dir`. Existing call sites that passed `dir` positionally must be updated in this task.

- [ ] **Step 1: Write the failing test**

Add to `server/mask.test.ts`:

```ts
describe("maskPath — custom boxes", () => {
  const A: Rect = { x: 300, y: 700, w: 480, h: 480 };
  const B: Rect = { x: 302, y: 700, w: 480, h: 480 };

  it("is byte-identical to the no-customs name when there are none", () => {
    // The whole feature is inert until used: today's cached masks must keep
    // hitting, and this is what proves the filename did not move.
    expect(maskPath(DEFAULT_LAYOUT, [], dir)).toBe(maskPath(DEFAULT_LAYOUT, undefined, dir));
    expect(basename(maskPath(DEFAULT_LAYOUT, [], dir))).toBe(
      `${DEFAULT_LAYOUT.id}-g${GUTTER}-r${CORNER_RADIUS}.png`,
    );
  });

  it("gives a different file to a different custom rect", () => {
    // The mask outlives the process. Keyed on the layout alone, nudging a
    // custom box by 2px would keep serving the previous border to exports
    // while the preview showed the new one.
    expect(maskPath(DEFAULT_LAYOUT, [A], dir)).not.toBe(maskPath(DEFAULT_LAYOUT, [], dir));
    expect(maskPath(DEFAULT_LAYOUT, [A], dir)).not.toBe(maskPath(DEFAULT_LAYOUT, [B], dir));
  });

  it("keeps the name hex-only, so nothing client-shaped reaches the path", () => {
    const name = basename(maskPath(DEFAULT_LAYOUT, [A, B], dir));
    expect(name).toMatch(/^[a-z0-9-]+-g\d+-r\d+-c[0-9a-f]{8}\.png$/);
  });
});

describe("ensureMask — custom boxes", () => {
  it("renders the ring and the window for a floating piece", async () => {
    const custom: Rect = { x: 300, y: 700, w: 480, h: 480 };
    const path = await ensureMask(DEFAULT_LAYOUT, [custom], dir);
    expect(path).toBe(maskPath(DEFAULT_LAYOUT, [custom], dir));
    const rgba = await rgbaOf(path);
    expect(alphaAt(rgba, custom.x + custom.w / 2, custom.y + custom.h / 2)).toBe(0);
    expect(alphaAt(rgba, custom.x + custom.w / 2, custom.y - GUTTER / 2)).toBe(255);
    // The seam the piece straddles, inside its window: transparent.
    expect(alphaAt(rgba, custom.x + custom.w / 2, 960)).toBe(0);
  });
});
```

Add `Rect` to that file's type imports:

```ts
import type { Rect } from "../src/geometry.ts";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run server/mask.test.ts`
Expected: FAIL — the custom-rect names come back identical, because `maskPath` ignores its new second argument.

- [ ] **Step 3: Write the implementation**

In `server/mask.ts`:

```ts
import { createHash, randomUUID } from "node:crypto";
```

Replace `maskPath` and `ensureMask`'s signature/body head with:

```ts
/** A short, stable digest of the floating pieces' output rects. Hex only,
 *  so nothing client-shaped can reach the path — though by the time this
 *  runs the rects are validated integers anyway. */
function customKey(customs: Rect[]): string {
  if (customs.length === 0) return "";
  const digest = createHash("sha1")
    .update(customs.map((r) => `${r.x},${r.y},${r.w},${r.h}`).join(";"))
    .digest("hex")
    .slice(0, 8);
  return `-c${digest}`;
}

/** The cache file for a layout's frame overlay.
 *
 *  Both constants are in the name on purpose: the mask outlives the process,
 *  so a filename keyed on the layout alone would keep serving the old border
 *  to exports after `GUTTER` or `CORNER_RADIUS` changed, while the preview —
 *  which computes the overlay every frame — showed the new one. The custom
 *  boxes are in it for exactly the same reason, and only when there are any,
 *  so today's cached files keep hitting. Layout ids come from the `LAYOUTS`
 *  table and the digest is hex, so nothing attacker-controlled reaches this
 *  path. */
export function maskPath(layout: Layout, customs: Rect[] = [], dir: string = MASK_DIR): string {
  return join(dir, `${layout.id}-g${GUTTER}-r${CORNER_RADIUS}${customKey(customs)}.png`);
}
```

and

```ts
export async function ensureMask(
  layout: Layout,
  customs: Rect[] = [],
  dir: string = MASK_DIR,
): Promise<string> {
  const path = maskPath(layout, customs, dir);
```

with the one body line that renders the buffer becoming:

```ts
    await writeFile(raw, maskRgba(windowsOf(layout), customs));
```

Add the `Rect` type import at the top of `server/mask.ts`:

```ts
import type { Rect } from "../src/geometry.ts";
```

Then update the existing positional call sites, which passed `dir` second:

- `server/mask.test.ts`: `ensureMask(DEFAULT_LAYOUT, dir)` → `ensureMask(DEFAULT_LAYOUT, [], dir)`; `maskPath(DEFAULT_LAYOUT, dir)` → `maskPath(DEFAULT_LAYOUT, [], dir)`; same for any `byId(...)` variants in that file.
- `server/ffmpeg.test.ts`: `await ensureMask(DEFAULT_LAYOUT, dir)` → `await ensureMask(DEFAULT_LAYOUT, [], dir)`, and `await ensureMask(byId("2v-1"), dir)` → `await ensureMask(byId("2v-1"), [], dir)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run server/mask.test.ts server/ffmpeg.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C . add server/mask.ts server/mask.test.ts server/ffmpeg.test.ts
git -C . commit -m "feat: key the mask cache on the floating pieces too

maskPath/ensureMask take the custom out-rects and fold an 8-hex sha1 of
them into the filename, but only when there are any — so every mask
already on disk keeps hitting and editing a custom rect cannot serve a
stale border.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The filter graph and the server-side validator

**Files:**
- Modify: `server/ffmpeg.ts`
- Modify: `server/ffmpeg.test.ts`

**Interfaces:**
- Consumes: `CustomBox`, `MAX_CUSTOM`, `MIN_OUT_SIDE`, `isValidCustom` from `src/custom.ts` (Task 1); `ensureMask` from `server/mask.ts` (Task 3) in tests only.
- Produces:
  - `buildFilter(layout: Layout, boxes: Rect[], customs?: CustomBox[]): string`
  - `assertCustoms(customs: CustomBox[], source: Size): void`
  - `ExportOpts.customs?: CustomBox[]`

- [ ] **Step 1: Write the failing test**

Add to `server/ffmpeg.test.ts`. Extend the existing `describe("buildFilter")` block and add two new blocks:

```ts
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
```

```ts
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
    expect(() =>
      assertCustoms([{ out: { ...custom.out, w: 960 }, crop: custom.crop }], SOURCE),
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
```

and, inside the existing `describe("exportClip")` block:

```ts
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

    expect(await probeFile(out)).toEqual({ width: 1080, height: 1920 });

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
```

Update that file's imports:

```ts
import type { CustomBox } from "../src/custom.ts";
import { assertBoxes, assertCustoms, buildFilter, exportClip, firstFrame, isOutName, outName, probeFile } from "./ffmpeg.ts";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run server/ffmpeg.test.ts`
Expected: FAIL — `assertCustoms is not exported` and the filter-string assertions miss.

- [ ] **Step 3: Write the implementation**

In `server/ffmpeg.ts`, add the imports:

```ts
import { MAX_CUSTOM, MIN_OUT_SIDE, isValidCustom } from "../src/custom.ts";
import type { CustomBox } from "../src/custom.ts";
import { OUTPUT } from "../src/geometry.ts";
```

(`OUTPUT` joins the existing `isValidBox` import from `../src/geometry.ts`.)

Add `customs` to `ExportOpts`, right after `boxes`:

```ts
  /** Floating pieces, composited over the finished stack in array order —
   *  last on top. Optional so every existing caller and test is unchanged. */
  customs?: CustomBox[];
```

Replace `buildFilter` with:

```ts
export function buildFilter(layout: Layout, boxes: Rect[], customs: CustomBox[] = []): string {
  const cells = cellsOf(layout);
  const legs = cells.map((cell, i) => {
    const r = boxes[i];
    // Thrown, not defaulted: a missing box means the caller and the layout
    // disagree, and a zero-size fallback would emit a filter graph ffmpeg
    // fails on unreadably. assertBoxes normally catches this first.
    if (r === undefined) {
      throw new Error(
        `buildFilter: layout ${layout.id} needs ${cells.length} boxes, got ${boxes.length}.`,
      );
    }
    return (
      `[c${i}]crop=${r.w}:${r.h}:${r.x}:${r.y},` +
      `scale=${cell.w}:${cell.h}:flags=lanczos[s${i}]`
    );
  });
  const inputs = cells.map((_, i) => `[c${i}]`).join("");
  const customInputs = customs.map((_, j) => `[k${j}]`).join("");
  const scaled = cells.map((_, i) => `[s${i}]`).join("");
  const positions = cells.map((c) => `${c.x}_${c.y}`).join("|");

  // One leg per floating piece, cropped from the same decode and scaled to
  // its own output rect — the crop is source pixels and the scale is output
  // pixels, exactly as for a cell, with no conversion between them.
  const customLegs = customs.map(
    (c, j) =>
      `[k${j}]crop=${c.crop.w}:${c.crop.h}:${c.crop.x}:${c.crop.y},` +
      `scale=${c.out.w}:${c.out.h}:flags=lanczos[t${j}]`,
  );

  // Chained overlays rather than a second xstack: xstack composes a tiling,
  // and a floating piece is an overlap by definition. Array order is z
  // order, last on top.
  let base = "[stack]";
  const overlays = customs.map((c, j) => {
    const step = `${base}[t${j}]overlay=${c.out.x}:${c.out.y}[o${j}]`;
    base = `[o${j}]`;
    return step;
  });

  return [
    `[0:v]split=${cells.length + customs.length}${inputs}${customInputs}`,
    ...legs,
    `${scaled}xstack=inputs=${cells.length}:layout=${positions}[stack]`,
    ...customLegs,
    ...overlays,
    // The frame overlay is still last: it arbitrates between the pieces and
    // the gutters (see maskRgba's priority order), so it must see the
    // finished composite including the floating pieces.
    `${base}[1:v]overlay=0:0:format=auto[v]`,
  ].join(";");
}
```

Add, directly after `assertBoxes`:

```ts
/** The floating pieces' version of assertBoxes, and for the same reason:
 *  numbers are the one thing interpolated into the filter string. Legality
 *  is `isValidCustom` — the same predicate `restore` runs on the client — so
 *  a box cannot preview cleanly and die at export. */
export function assertCustoms(customs: CustomBox[], source: Size): void {
  if (!Array.isArray(customs)) {
    throw new Error(`customs must be an array, got ${typeof customs}.`);
  }
  if (customs.length > MAX_CUSTOM) {
    throw new Error(`At most ${MAX_CUSTOM} custom boxes, got ${customs.length}.`);
  }
  customs.forEach((custom, i) => {
    if (!isValidCustom(custom, source)) {
      throw new Error(
        `Invalid custom box ${i + 1} ${JSON.stringify(custom)} for source ` +
          `${source.w}x${source.h}: out must be even integers, at least ` +
          `${MIN_OUT_SIDE} per side, inside ${OUTPUT.w}x${OUTPUT.h}; crop must ` +
          `be integers matching that box's own ratio and inside the source.`,
      );
    }
  });
}
```

In `exportClip`, add the validation and pass the pieces through:

```ts
export async function exportClip(opts: ExportOpts): Promise<string> {
  assertBoxes(opts.layout, opts.boxes, opts.source);
  assertCustoms(opts.customs ?? [], opts.source);
```

and the filter argument:

```ts
        "-filter_complex", buildFilter(opts.layout, opts.boxes, opts.customs ?? []),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run server/ffmpeg.test.ts`
Expected: PASS, including the real-ffmpeg export.

- [ ] **Step 5: Commit**

```bash
git -C . add server/ffmpeg.ts server/ffmpeg.test.ts
git -C . commit -m "feat: compose floating pieces into the export

Each custom box is one more split leg cropped from the same decode and
overlaid onto the finished stack; the frame mask stays last so it can
arbitrate between the pieces and the gutters. assertCustoms guards the
numbers that reach the filter string, using the same isValidCustom the
client's restore runs.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The export route and the client wrapper

**Files:**
- Modify: `server/index.ts:331-430` (the `/api/export` block)
- Modify: `src/api.ts:86-106` (the `exportClip` body type)

**Interfaces:**
- Consumes: `assertCustoms`, `exportClip` (Task 4); `ensureMask` (Task 3); `CustomBox` (Task 1).
- Produces: `/api/export` accepts an optional `customs: CustomBox[]` in its body; `api.exportClip`'s body type requires `customs` (the client always sends the field, even empty).

- [ ] **Step 1: Wire the route**

In `server/index.ts`, add the type import beside the existing ones:

```ts
import type { CustomBox } from "../src/custom.ts";
```

and add `assertCustoms` to the existing `./ffmpeg.ts` import list.

In the `/api/export` block, immediately after the `boxes` line:

```ts
    // Same posture as boxes: shape here, legality below via assertCustoms.
    // Absent means none, so a body from a client that predates this feature
    // still exports.
    const customs = (raw.customs ?? []) as CustomBox[];
```

Extend the existing validation `try` so a bad piece is a clean 400 rather than the 500 the top-level handler would produce:

```ts
    try {
      assertBoxes(layout, boxes, { w: source.width, h: source.height });
      assertCustoms(customs, { w: source.width, h: source.height });
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
```

Pass them to the export and to the mask:

```ts
      await exportClip({
        input,
        start: start - windowStart,
        duration: end - start,
        layout,
        boxes,
        customs,
        source: { w: source.width, h: source.height },
        // Rendered on first export of each layout+pieces combination and
        // cached from then on, keyed on the layout id, GUTTER, CORNER_RADIUS
        // and a digest of the pieces' output rects.
        mask: await ensureMask(layout, customs.map((c) => c.out)),
        out: body,
      });
```

- [ ] **Step 2: Widen the client wrapper**

In `src/api.ts`, add to the imports:

```ts
import type { CustomBox } from "./custom.ts";
```

and to `exportClip`'s body type, after `boxes`:

```ts
  /** Floating pieces over the layout, in z order — last on top. Always
   *  sent, empty when there are none. */
  customs: CustomBox[];
```

- [ ] **Step 3: Verify the whole suite still passes**

Run: `pnpm test`
Expected: PASS — the same count as before this task plus the tests added in Tasks 1–4. `pnpm build` must also be clean, since `src/api.ts`'s new required field does not yet have a caller (`main.ts` is updated in Task 9) — if `tsc` flags `doExport`, that is expected and is fixed there. To keep this commit green, add `customs: []` to `doExport`'s payload in `src/main.ts` now as a placeholder; Task 9 replaces it with the real getter.

Run: `pnpm build`
Expected: no TypeScript errors.

- [ ] **Step 4: Verify the route rejects a bad piece**

With `pnpm server` running in another terminal, and with any clip already fetched (the route needs a cached window), a request carrying an odd output rect must answer 400 rather than 500:

```bash
curl -s -o /dev/stderr -w '%{http_code}\n' -X POST http://127.0.0.1:8787/api/export \
  -H 'content-type: application/json' \
  -d '{"videoId":"aaaaaaaaaaa","windowStart":0,"windowEnd":10,"start":1,"end":5,
       "starterTitle":"x","titlePng":"","layoutId":"1-1","voice":"","boxes":[],
       "customs":[{"out":{"x":301,"y":700,"w":480,"h":480},"crop":{"x":0,"y":0,"w":480,"h":480}}]}'
```

Expected: a 4xx with a readable message (the exact failing field depends on which validator runs first — `videoId`, the window cache, or `customs`; the point is that no 500 and no ffmpeg invocation results).

- [ ] **Step 5: Commit**

```bash
git -C . add server/index.ts src/api.ts src/main.ts
git -C . commit -m "feat: accept floating pieces on /api/export

Validated with assertCustoms in the same try as assertBoxes, so a bad
piece is a 400 rather than an unreadable ffmpeg failure, and folded into
the mask cache key. An absent field means none, so an older client body
still exports.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Persistence

**Files:**
- Modify: `src/state.ts`
- Modify: `src/state.test.ts`

**Interfaces:**
- Consumes: `CustomBox`, `isValidCustom` from `src/custom.ts`.
- Produces: `AppState.customs: CustomBox[]`; `restore` returns `customs` in its patch; `save` persists them under the same gate as `boxes`.

- [ ] **Step 1: Write the failing test**

Add to `src/state.test.ts`:

```ts
describe("save / restore — custom boxes", () => {
  const source = { w: 1920, h: 1080 };
  const custom = {
    out: { x: 300, y: 700, w: 480, h: 480 },
    crop: { x: 0, y: 100, w: 480, h: 480 },
  };

  it("round-trips the pieces alongside the boxes", () => {
    const videoId = "customs-round-trip";
    setState({
      videoId,
      phase: "framing",
      layoutId: DEFAULT_LAYOUT_ID,
      source,
      boxes: [
        { x: 0, y: 100, w: 900, h: 800 },
        { x: 1020, y: 100, w: 900, h: 800 },
      ],
      customs: [custom],
    });
    save();
    expect(restore(videoId, source).customs).toEqual([custom]);
  });

  it("does not persist pieces outside framing", () => {
    // MUTATION TEST: drop the phase gate and this record gains a customs
    // array written from a phase where the source size is still probe's
    // informational one.
    const videoId = "customs-gated";
    setState({ videoId, phase: "trimming", source, boxes: [], customs: [custom] });
    save();
    expect(readRaw(videoId)).not.toHaveProperty("customs", [custom]);
  });

  it("drops pieces that are illegal against the restored source", () => {
    const videoId = "customs-illegal";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        start: 0,
        end: 10,
        layoutId: DEFAULT_LAYOUT_ID,
        boxes: [
          { x: 0, y: 100, w: 900, h: 800 },
          { x: 1020, y: 100, w: 900, h: 800 },
        ],
        customs: [{ out: { x: 301, y: 700, w: 480, h: 480 }, crop: custom.crop }],
        sourceW: 1920,
        sourceH: 1080,
      }),
    );
    expect(restore(videoId, source).customs).toEqual([]);
  });

  it("returns no pieces for a record that predates the feature", () => {
    const videoId = "customs-legacy";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({ start: 1, end: 2, layoutId: DEFAULT_LAYOUT_ID, sourceW: 0, sourceH: 0 }),
    );
    expect(restore(videoId, source).customs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/state.test.ts`
Expected: FAIL — `customs` is not a property of `AppState` (a TypeScript error under vitest) and `restore` returns no such field.

- [ ] **Step 3: Write the implementation**

In `src/state.ts`:

```ts
import { isValidCustom } from "./custom.ts";
import type { CustomBox } from "./custom.ts";
```

Add to `AppState`, after `boxes`:

```ts
  /** Floating pieces over the layout, in z order — last on top. Empty is the
   *  normal case. Unlike `boxes` these survive a layout change: a custom
   *  box's ratio is its own and its `out` is frame space, so nothing about it
   *  is invalidated by the cells changing. */
  customs: CustomBox[];
```

Add `customs: []` to `initial`, after `boxes: []`.

Add to the `Saved` type, after `boxes`:

```ts
  customs: CustomBox[];
```

In `readSaved`'s return object, after `boxes`:

```ts
    customs: Array.isArray(s.customs) ? s.customs : [],
```

In `save()`'s `saved` object, after `boxes`:

```ts
    // Same gate as boxes, for the same reason: an `out` is frame space and
    // always meaningful, but a `crop` is source pixels and means nothing
    // before /api/window has reported the clip's real size.
    customs: framed ? state.customs : (prev?.customs ?? []),
```

In `restore()`, compute usability separately — a bad piece must not cost the boxes, and vice versa — and return it:

```ts
  const usableCustoms =
    source !== null && sameSource && s.customs.every((c) => isValidCustom(c, source));
```

and in the returned object, after `boxes`:

```ts
    customs: usableCustoms ? s.customs : [],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C . add src/state.ts src/state.test.ts
git -C . commit -m "feat: persist floating pieces per video

Same framing-only gate as boxes, since a crop means nothing before the
clip's real size is known, and the same isValidCustom check on restore
that the server runs before ffmpeg. A record without the field restores
as no pieces.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The canvas preview draws the pieces

**Files:**
- Modify: `src/preview.ts`

**Interfaces:**
- Consumes: `ringOf`, `CORNER_RADIUS`, `GUTTER`, `windowOf` from `src/frame.ts`; `CustomBox` from `src/custom.ts`.
- Produces: `startPreview(canvas, video, cells, boxes, customs)` — the fifth parameter is a getter, read every frame like `boxes`.

DOM-driven modules have no tests here by design (vitest runs `environment: "node"`); this task's verification is the browser plus the export it must agree with.

- [ ] **Step 1: Write the implementation**

Replace `src/preview.ts`'s body with:

```ts
import { CORNER_RADIUS, ringOf, windowOf } from "./frame.ts";
import { OUTPUT } from "./geometry.ts";
import type { Rect } from "./geometry.ts";
import type { CustomBox } from "./custom.ts";

/** The whole composite: one decode, one draw per cell, then one per floating
 *  piece, then the white decoration. Boxes and pieces are read through
 *  getters each frame so a drag needs no re-subscription.
 *
 *  `cells` and `boxes()` are parallel arrays in cellsOf order — the same
 *  order the editor numbers them and xstack composes them. drawImage's
 *  source rect is the box in *source* pixels and its destination rect is
 *  the cell in *output* pixels, with no conversion between them: that is
 *  the invariant that keeps this canvas and ffmpeg's crop= agreeing. A
 *  floating piece works the same way, with its own `out` as the destination.
 *
 *  The decoration is painted in exactly the order ffmpeg applies it: pieces
 *  first, then one white pass that cannot touch a piece's window. That is
 *  why the clip below is set up before either fill — it is the canvas
 *  spelling of maskRgba's priority order, and painting the two fills in the
 *  other order would put a seam's white stripe across a piece.
 *
 *  ponytail: the loop runs unconditionally, which is what makes
 *  redraw-on-seek and redraw-on-drag need no wiring at all. Gate it on
 *  !video.paused if battery ever matters. */
export function startPreview(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  cells: Rect[],
  boxes: () => Rect[],
  customs: () => CustomBox[],
): () => void {
  canvas.width = OUTPUT.w;
  canvas.height = OUTPUT.h;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("2d context unavailable");

  // Derived from the cells rather than passed in, so these are necessarily
  // the same windows the export's mask was rendered from.
  const windows = cells.map(windowOf);

  let raf = 0;
  const frame = () => {
    if (video.readyState >= 2) {
      const bs = boxes();
      cells.forEach((cell, i) => {
        const b = bs[i];
        // A cell with no box yet is skipped, not drawn from a zero rect:
        // drawImage with sw/sh of 0 throws in some browsers, and the
        // previous frame's pixels are a better placeholder than a stripe of
        // whatever the canvas last held.
        if (!b) return;
        ctx.drawImage(video, b.x, b.y, b.w, b.h, cell.x, cell.y, cell.w, cell.h);
      });

      // Floating pieces, drawn as plain rects in array order — last on top,
      // exactly as the overlay chain composes them. Their square corners are
      // cut by the ring fill below.
      const cs = customs();
      for (const c of cs) {
        ctx.drawImage(video, c.crop.x, c.crop.y, c.crop.w, c.crop.h, c.out.x, c.out.y, c.out.w, c.out.h);
      }

      ctx.save();
      // Nothing white may enter a piece's window — the first rule of the
      // mask's priority order, and what lets a piece straddle a cell seam.
      if (cs.length > 0) {
        ctx.beginPath();
        ctx.rect(0, 0, OUTPUT.w, OUTPUT.h);
        for (const c of cs) ctx.roundRect(c.out.x, c.out.y, c.out.w, c.out.h, CORNER_RADIUS);
        ctx.clip("evenodd");
      }
      ctx.fillStyle = "#fff";
      // The gutters and rounded corners, painted over the finished composite
      // exactly as ffmpeg overlays its mask: full-frame white with the
      // windows punched out of it by the even-odd rule. Drawing it every
      // frame costs one fill and needs no invalidation when the layout
      // changes, because `windows` is rebuilt with the preview.
      ctx.beginPath();
      ctx.rect(0, 0, OUTPUT.w, OUTPUT.h);
      for (const w of windows) ctx.roundRect(w.x, w.y, w.w, w.h, CORNER_RADIUS);
      ctx.fill("evenodd");
      // Each piece's ring, which also cuts its square corners. The clip
      // keeps this out of the piece itself.
      for (const c of cs) {
        const r = ringOf(c.out);
        ctx.beginPath();
        ctx.roundRect(r.x, r.y, r.w, r.h, CORNER_RADIUS + GUTTER);
        ctx.fill();
      }
      ctx.restore();
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
```

Add `GUTTER` to that import line — the full line is:

```ts
import { CORNER_RADIUS, GUTTER, ringOf, windowOf } from "./frame.ts";
```

- [ ] **Step 2: Keep the one call site compiling**

`src/main.ts`'s `startPreview(canvasEl, videoEl, cells, currentBoxes)` now needs a fifth argument. Add a temporary getter beside `currentBoxes`:

```ts
/** The current floating pieces. Read fresh on every preview frame and every
 *  drag, like currentBoxes. */
function currentCustoms(): CustomBox[] {
  return getState().customs;
}
```

with `import type { CustomBox } from "./custom.ts";`, and pass it: `startPreview(canvasEl, videoEl, cells, currentBoxes, currentCustoms)`.

- [ ] **Step 3: Verify it builds and the suite is green**

Run: `pnpm build && pnpm test`
Expected: no TypeScript errors, all tests pass.

- [ ] **Step 4: Verify by hand in the browser**

No UI adds a piece until Task 9, so this step verifies the regression only: run `pnpm start`, reach the framing phase, and confirm the canvas renders exactly as it did before — same composite, same gutters, same rounded corners, and a layout switch still rebuilds the preview without restarting the video. The piece itself is verified in Task 9, step 6.

- [ ] **Step 5: Commit**

```bash
git -C . add src/preview.ts src/main.ts
git -C . commit -m "feat: draw floating pieces in the canvas preview

Same order ffmpeg composites in — pieces, then one white pass clipped
out of every piece's window — so the preview and the export agree by
construction rather than by coincidence.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Generalise the editor

**Files:**
- Modify: `src/editor.ts`
- Modify: `src/main.ts` (the single `mountEditor` call site)

**Interfaces:**
- Consumes: `displayScale`, `toDisplay` from `src/geometry.ts`; types `Corner`, `Rect`, `Size`.
- Produces:

```ts
mountEditor(opts: {
  host: HTMLElement;
  media: HTMLElement;                 // was HTMLVideoElement
  bounds: () => Size;                 // was source(); display-scale reference only
  count: number;                      // was cells.length
  labelFrom?: number;                 // index of the first box, for label + colour
  boxes: () => Rect[];
  move: (rect: Rect, dx: number, dy: number, index: number) => Rect;
  resize: (rect: Rect, corner: Corner, dx: number, dy: number, index: number) => Rect;
  onChange(index: number, rect: Rect): void;
  onCommit(): void;
  onRemove?: (index: number) => void;
}): () => void
```

**Deviation from the spec, deliberate:** the spec's §Editing proposed a `ratios()` getter and kept the geometry inside the editor. Injecting `move`/`resize` closures instead is strictly simpler — the editor ends up with no geometry knowledge at all, and the output overlay's free-resize rules live in `custom.ts` where they are tested. Step 6 records this in the spec.

- [ ] **Step 1: Write the implementation**

In `src/editor.ts`, drop the `ratioOf`/`layout.ts` import (the editor no longer knows what a cell is) and replace the options block and the two handlers:

```ts
import { displayScale, toDisplay } from "./geometry.ts";
import type { Corner, Rect, Size } from "./geometry.ts";

const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

type Drag = {
  index: number;
  corner: Corner | null; // null = move the whole box
  originX: number;
  originY: number;
  startRect: Rect;
};

/** Mounts a draggable/resizable box overlay into `opts.host` and returns a
 *  teardown function. Two of these are mounted during framing: one over the
 *  source <video> for crop rects, one over the composite <canvas> for the
 *  floating pieces' output rects.
 *
 *  The editor knows no geometry — `move` and `resize` are injected, so the
 *  aspect-locked source rules and the free-aspect output rules each stay in
 *  the module that tests them. It only ever appends its own `.boxes` layer
 *  and never touches the host's existing children, because removing or
 *  rebuilding a sibling here is exactly the persistent-shell hazard this app
 *  is built to avoid. */
export function mountEditor(opts: {
  host: HTMLElement;
  /** The element the overlay is laid out against — a <video> or a <canvas>.
   *  Only its box and its `loadedmetadata` event are used. */
  media: HTMLElement;
  /** The coordinate space `boxes()` are expressed in, for the display
   *  scale: source pixels for the crop overlay, OUTPUT for the output one. */
  bounds: () => Size;
  /** Node count, fixed for this mount — main.ts remounts when it changes,
   *  the same rule the cell list has always had. */
  count: number;
  /** The index the first node carries, for its label and its colour. The
   *  output overlay passes the cell count so its pieces keep the same
   *  numbers and tints they have on the source overlay. */
  labelFrom?: number;
  boxes: () => Rect[];
  move: (rect: Rect, dx: number, dy: number, index: number) => Rect;
  resize: (rect: Rect, corner: Corner, dx: number, dy: number, index: number) => Rect;
  onChange(index: number, rect: Rect): void;
  onCommit(): void;
  /** When given, each node carries a × that removes it. */
  onRemove?: (index: number) => void;
}): () => void {
  const layer = document.createElement("div");
  layer.className = "boxes";
  opts.host.append(layer);

  const labelFrom = opts.labelFrom ?? 0;
  const nodes = Array.from({ length: opts.count }, (_, i) => makeBox(i));
  layer.append(...nodes);

  function makeBox(index: number): HTMLDivElement {
    const box = document.createElement("div");
    // box-c0..c5 carry the per-index colour: four cells at most, plus two
    // floating pieces.
    box.className = `box box-c${labelFrom + index}`;
    box.dataset.index = String(index);
    const label = document.createElement("span");
    label.className = "box-label";
    label.textContent = String(labelFrom + index + 1);
    box.append(label);
    if (opts.onRemove) {
      const remove = document.createElement("button");
      remove.className = "box-remove";
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "Remove this box";
      remove.ariaLabel = `Remove box ${labelFrom + index + 1}`;
      // pointerdown, not click: the layer's own pointerdown starts a drag,
      // and stopping propagation here is what keeps a removal from also
      // grabbing the box.
      remove.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        opts.onRemove?.(index);
      });
      box.append(remove);
    }
    for (const c of CORNERS) {
      const h = document.createElement("div");
      h.className = `handle handle-${c}`;
      h.dataset.corner = c;
      box.append(h);
    }
    return box;
  }
```

The rest of the file is unchanged except for three references:

- `function scale()` becomes `return displayScale(opts.bounds(), opts.media.clientWidth);`
- the `pointermove` handler drops its `cells[drag.index]` lookup and `ratioOf` call, becoming:

```ts
  layer.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const s = scale();
    // Pointer deltas are display px; the geometry works in the bounds' own
    // units — source px for crops, output px for the floating pieces.
    const dx = (e.clientX - drag.originX) / s;
    const dy = (e.clientY - drag.originY) / s;
    const next =
      drag.corner === null
        ? opts.move(drag.startRect, dx, dy, drag.index)
        : opts.resize(drag.startRect, drag.corner, dx, dy, drag.index);
    opts.onChange(drag.index, next);
    place();
  });
```

- `place()`'s `const bs = opts.boxes();` and its node loop are unchanged; the paint-order sort at the end of `place()` stays exactly as it is.

- [ ] **Step 2: Update the call site so behaviour is unchanged**

In `src/main.ts`'s `ensureFraming`, replace the `mountEditor` call with:

```ts
  stopEditor = mountEditor({
    host: sourceSlot,
    media: videoEl,
    bounds: () => getState().source,
    count: cells.length,
    boxes: currentBoxes,
    move: (rect, dx, dy) => moveBy(rect, dx, dy, getState().source),
    resize: (rect, corner, dx, dy, index) => {
      const cell = cells[index];
      // pointerdown only sets a drag for an index that has both a node and a
      // box, and nodes are built from `cells`, so this is always present.
      if (!cell) return rect;
      return resizeFromCorner(rect, corner, dx, dy, getState().source, ratioOf(cell));
    },
    // Dragging must not trigger a full re-render — that would rebuild the
    // video element mid-drag. The editor moves its own nodes and the rAF
    // loop reads the new rect; state is written without notifying.
    onChange: (index, rect) => {
      const next = [...currentBoxes()];
      next[index] = rect;
      setQuiet({ boxes: next });
    },
    onCommit: () => save(),
  });
```

adding `moveBy` and `resizeFromCorner` to the existing `./geometry.ts` import in `main.ts`, and `ratioOf` to the existing `./layout.ts` import.

- [ ] **Step 3: Verify it builds and the suite is green**

Run: `pnpm build && pnpm test`
Expected: no TypeScript errors, all tests pass.

- [ ] **Step 4: Verify by hand in the browser**

Run `pnpm start`, reach framing, and confirm the crop overlay behaves exactly as before: every box drags, every corner resizes with its aspect held, the labels and tints are unchanged, and a layout switch still rebuilds the overlay without restarting the video.

- [ ] **Step 5: Record the deviation in the spec**

In `docs/specs/2026-08-25-vstack-custom-boxes-design.md`, replace the `ratios: () => (number | null)[]` line and the bullet describing it with the injected-closure form:

```
  move / resize: (rect, …, index) => Rect  // injected; the editor holds no geometry
```

and add one sentence: *"Injected rather than a `ratios()` getter, so the aspect-locked source rules and the free-aspect output rules each stay in the module that tests them."*

- [ ] **Step 6: Commit**

```bash
git -C . add src/editor.ts src/main.ts docs/specs/2026-08-25-vstack-custom-boxes-design.md
git -C . commit -m "refactor: editor takes any host and injected move/resize

Two overlays are needed during framing — crop rects over the <video>,
output rects over the <canvas> — so the editor stops knowing about cells
and ratios and takes the geometry as closures. Behaviour for the crop
overlay is unchanged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The framing UI

**Files:**
- Modify: `src/main.ts`
- Modify: `src/style.css`

**Interfaces:**
- Consumes: everything from Tasks 1, 7 and 8.
- Produces: the `+ Box` control, the output overlay, the `×` removal, and `customs` in the export payload.

- [ ] **Step 1: Add the two new box tints**

In `src/style.css`, add the two scales to the existing `@radix-ui/colors` imports at the top — each solid together with its alpha companion, in the same light-then-dark order the others use:

```css
@import "@radix-ui/colors/cyan.css";
@import "@radix-ui/colors/cyan-alpha.css";
@import "@radix-ui/colors/orange.css";
@import "@radix-ui/colors/orange-alpha.css";
@import "@radix-ui/colors/cyan-dark.css";
@import "@radix-ui/colors/cyan-dark-alpha.css";
@import "@radix-ui/colors/orange-dark.css";
@import "@radix-ui/colors/orange-dark-alpha.css";
```

(Place each next to its peers: the light ones with the other light imports, the dark ones with the other dark imports, so the "dark second" rule that decides the cascade still holds.)

Then, beside the existing `.box-c0..c3` rules:

```css
/* The two floating pieces. Their indices continue the cells', so a piece is
   the same colour and the same number on both overlays. */
.box-c4 { border-color: var(--cyan-9); background: color-mix(in srgb, var(--cyan-9) 12%, transparent); }
.box-c5 { border-color: var(--orange-9); background: color-mix(in srgb, var(--orange-9) 12%, transparent); }

.box-c4 .box-label { color: var(--cyan-11); }
.box-c5 .box-label { color: var(--orange-11); }

/* The removal control, only present on the output overlay. White on a dark
   scrim for the same reason .handle is: it sits over video, not over the
   theme. */
.box-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  padding: 0;
  line-height: 1;
  font-size: 13px;
  color: #fff;
  background: var(--slate-a11);
  border: none;
  border-radius: var(--radius-1);
  cursor: pointer;
  touch-action: none;
}
```

- [ ] **Step 2: Mount the output overlay and wire the controls**

In `src/main.ts`:

Add the imports:

```ts
import { MAX_CUSTOM, defaultCustom, moveOut, resizeOut, resnapCrop } from "./custom.ts";
import type { CustomBox } from "./custom.ts";
```

Track the second overlay beside the first:

```ts
let stopOutEditor: (() => void) | null = null;
```

In `ensureFraming`, the remount key gains the piece count — the node count of both overlays is derived from it, the same rule the cell list has:

```ts
  const sameLayout = editorFor === `${layout.id}:${s.customs.length}`;
  ...
  editorFor = `${layout.id}:${s.customs.length}`;
```

The source overlay's `count` becomes `cells.length + s.customs.length`, and its `move`/`resize`/`onChange` route by index — a crop belongs either to a cell or to a piece:

```ts
  const cellCount = cells.length;
  stopEditor = mountEditor({
    host: sourceSlot,
    media: videoEl,
    bounds: () => getState().source,
    count: cellCount + s.customs.length,
    boxes: () => [...currentBoxes(), ...currentCustoms().map((c) => c.crop)],
    move: (rect, dx, dy) => moveBy(rect, dx, dy, getState().source),
    resize: (rect, corner, dx, dy, index) => {
      const source = getState().source;
      // A piece's crop is locked to the piece's own ratio; a cell's to its
      // cell's. Same isValidBox on both sides, different ratio.
      const custom = currentCustoms()[index - cellCount];
      if (custom) {
        return resizeFromCorner(rect, corner, dx, dy, source, outRatio(custom.out));
      }
      const cell = cells[index];
      if (!cell) return rect;
      return resizeFromCorner(rect, corner, dx, dy, source, ratioOf(cell));
    },
    onChange: (index, rect) => {
      if (index < cellCount) {
        const next = [...currentBoxes()];
        next[index] = rect;
        setQuiet({ boxes: next });
        return;
      }
      const next = [...currentCustoms()];
      const cur = next[index - cellCount];
      if (!cur) return;
      next[index - cellCount] = { ...cur, crop: rect };
      setQuiet({ customs: next });
    },
    onCommit: () => save(),
  });
```

adding `outRatio` to the `./custom.ts` import.

Mount the output overlay over the canvas, right after it:

```ts
  stopOutEditor?.();
  stopOutEditor = null;
  if (s.customs.length > 0) {
    stopOutEditor = mountEditor({
      host: outSlot,
      media: canvasEl,
      // Output space: the canvas is 1080x1920 whatever size it renders at.
      bounds: () => OUTPUT,
      count: s.customs.length,
      labelFrom: cellCount,
      boxes: () => currentCustoms().map((c) => c.out),
      move: (rect, dx, dy) => moveOut(rect, dx, dy),
      resize: (rect, corner, dx, dy) => resizeOut(rect, corner, dx, dy),
      // One patch carrying both halves: the piece's crop is locked to the
      // piece's own ratio, so a resize that changes that ratio has to move
      // the crop in the same frame or the two disagree until the next drag.
      onChange: (index, out) => {
        const next = [...currentCustoms()];
        const cur = next[index];
        if (!cur) return;
        next[index] = { out, crop: resnapCrop(cur.crop, getState().source, out) };
        setQuiet({ customs: next });
      },
      onCommit: () => save(),
      onRemove: (index) => {
        // setState, not setQuiet: the node count changes, so both overlays
        // must be rebuilt — the same reason a layout switch notifies.
        setState({ customs: currentCustoms().filter((_, i) => i !== index) });
        save();
      },
    });
  }
```

`OUTPUT` is already imported in `main.ts` for the layout picker.

`render()` hides the source overlay at `src/main.ts:1229` (`if (boxesLayer) boxesLayer.hidden = s.phase !== "framing";`). Mirror that for the canvas overlay — hidden, never removed, like every other long-lived node in the persistent shell. Capture it next to the existing capture at line 601:

```ts
let outBoxesLayer: HTMLDivElement | null = null;
// …at the end of ensureFraming, after mounting the output overlay:
outBoxesLayer = outSlot.querySelector<HTMLDivElement>(".boxes");
```

and in `render()`, beside the existing line:

```ts
  if (outBoxesLayer) outBoxesLayer.hidden = s.phase !== "framing";
```

When the last piece is removed, `stopOutEditor()` removes that layer, so `outBoxesLayer` is reset to `null` in the same branch that skips mounting.

- [ ] **Step 3: Add the `+ Box` control**

In `renderFraming`, build the button and put it in the first bar row beside the layout picker:

```ts
  const addBox = el("button", {
    textContent: "+ Box",
    title: "Add a box that floats over the layout",
    disabled: Boolean(s.busy) || s.customs.length >= MAX_CUSTOM,
  });
  addBox.onclick = () => {
    // setState: the node count changes, so ensureFraming must rebuild both
    // overlays on the next render.
    setState({ customs: [...s.customs, defaultCustom(s.source, s.customs.length)] });
    save();
  };
```

and in the returned rows, first row:

```ts
      renderLayoutPicker(s.layoutId, Boolean(s.busy)),
      addBox,
```

In `renderLayoutPicker`'s `onclick`, leave `customs` untouched — the existing `setState({ layoutId: layout.id, boxes: [] })` already does exactly that. Add one line to its comment block:

```ts
      // Pieces are NOT cleared: a floating box's ratio is its own and its
      // out rect is frame space, so nothing about it is invalidated by the
      // cells changing.
```

- [ ] **Step 4: Send the pieces on export**

In `doExport`, replace the placeholder `customs: []` from Task 5 with the real value, beside the existing `boxes`:

```ts
      customs: s.customs,
```

- [ ] **Step 5: Verify it builds and the suite is green**

Run: `pnpm build && pnpm test`
Expected: no TypeScript errors, all tests pass.

- [ ] **Step 6: Verify by hand in the browser and through a real export**

Run `pnpm start` and, on a real video in the framing phase:

1. `+ Box` adds a square in the middle of the preview with a cyan outline, numbered one past the last cell, and a matching cyan crop box appears on the source video.
2. Dragging the piece on the preview moves it; dragging a corner changes its aspect, and the source-side crop box changes shape in the same drag.
3. Dragging the source-side crop box moves the crop; the piece's content follows in the preview.
4. The piece has a white ring and rounded corners in the preview, including where it crosses a seam — no white stripe through it.
5. `+ Box` a second time adds an orange one, offset; `+ Box` is then disabled.
6. `×` on a piece removes it; the source-side crop box goes with it.
7. Switching layouts keeps both pieces and re-rolls only the cells' boxes.
8. Reloading the page restores the pieces.
9. Export, then play the file in the preview phase: the exported frame matches the canvas — same ring, same corners, same crop — and the saved `.jpg` beside it shows the starter screen as before.
10. Toggle the theme (CMD+Shift+0) and confirm both new tints read on both themes.

- [ ] **Step 7: Commit**

```bash
git -C . add src/main.ts src/style.css
git -C . commit -m "feat: add, place and remove floating boxes in framing

+ Box adds a piece; it is dragged on the composite preview for its place
in the frame and on the source video for what it shows, with the crop
re-snapped inside the same drag so the two never disagree. Pieces
survive a layout switch, since a piece's ratio is its own.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Documentation and final verification

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/specs/2026-08-25-vstack-custom-boxes-design.md`

**Interfaces:**
- Consumes: the finished feature.
- Produces: nothing code-facing.

- [ ] **Step 1: Update `CLAUDE.md`**

- Spec pointers, at the top: add `docs/specs/2026-08-25-vstack-custom-boxes-design.md`, noting it extends the layouts and frame-borders docs and supersedes the layouts doc's `/api/export` body once more (`customs` on top of `layoutId` + `boxes` + `starterTitle` + `titlePng` + `voice`).
- Architecture map: add `src/custom.ts` ("CustomBox, MAX_CUSTOM/MIN_OUT_SIDE, clampOut/moveOut/resizeOut, resnapCrop, isValidCustom, defaultCustom") beside `src/layout.ts`, and note the layering `geometry ← {layout, custom} ← frame ← everything`.
- Invariants, three new ones:
  - **A custom box's `out` is even on all four fields.** An `overlay` at an odd offset in yuv420p lands on a half-chroma-sample boundary. `clampOut`/`resizeOut` snap down; `isValidOut` rejects odd, on both sides of the wire.
  - **The mask arbitrates, in priority order.** A custom's window beats a gutter (so a piece can straddle a seam); its ring∪nub beats everything (so the ring draws and the piece's square corners are cut). Reorder these and the failure is a white stripe through a piece, or an unrounded corner over a cell — both silent until someone looks closely at an export.
  - **A custom box survives a layout switch; a cell's box does not.** A piece's ratio is its own and its `out` is frame space, so nothing about it is invalidated by the cells changing.
- Gotchas: the mask filename carries the pieces' digest too, and only when there are pieces — so today's cached masks keep hitting.
- Testing posture: `src/custom.test.ts` joins `geometry`/`layout` as exhaustively covered; the two mask-priority assertions in `frame.test.ts` are mutation-tested; `server/ffmpeg.test.ts` gains a real-ffmpeg export with a piece over a seam.
- Commands: update the test count from 166 to whatever `pnpm test` reports.

- [ ] **Step 2: Mark the spec implemented**

In `docs/specs/2026-08-25-vstack-custom-boxes-design.md`, change `Status: designed` to `Status: implemented`.

- [ ] **Step 3: Run the full verification**

```bash
pnpm test
pnpm build
```

Expected: every test passes and `tsc && vite build` is clean. Report the actual test count.

- [ ] **Step 4: Commit**

```bash
git -C . add CLAUDE.md docs/specs/2026-08-25-vstack-custom-boxes-design.md
git -C . commit -m "docs: record the custom-box invariants

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Data model (`CustomBox`, `MAX_CUSTOM`, `MIN_OUT_SIDE`, even rects, crop lock, re-snap, defaults) | 1 |
| Persistence gate and restore validation | 6 |
| Mask priority order, `ringOf`, `insideRounded` | 2 |
| Mask cache key | 3 |
| Filter graph (split, custom legs, overlay chain, mask last) | 4 |
| Canvas preview in the same order | 7 |
| Two overlays, one generalised editor, live ratio following | 8 (editor), 9 (wiring) |
| UI: `+ Box`, `×`, layout switch keeps pieces, export payload | 9 |
| Server validation (`assertCustoms`, absent means none) | 4 (validator), 5 (route) |
| Testing plan | 1, 2, 3, 4, 6 |
| Out of scope (z-order control, per-piece radius, numeric fields, snap guides, shadow) | not implemented, as specified |

**Deviation:** the spec's `ratios()` editor option became injected `move`/`resize` closures (Task 8, Step 5 updates the spec).

**Type consistency:** `CustomBox` is defined once in `src/custom.ts` and imported everywhere. `maskRgba(windows, customs)` and `maskPath`/`ensureMask(layout, customs, dir)` take bare `Rect[]` out-rects, never `CustomBox[]` — the call sites in Tasks 5 and 9 pass `customs.map((c) => c.out)`. `buildFilter`/`assertCustoms`/`ExportOpts.customs` take `CustomBox[]`. `startPreview`'s fifth parameter is `() => CustomBox[]`.
