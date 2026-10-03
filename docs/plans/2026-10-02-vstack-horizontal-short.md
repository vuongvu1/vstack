# Horizontal Output for the Short Journey — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the framing phase export either today's 1080x1920 short or a 1920x1080 horizontal video (no starter screen, outro kept, title-card thumbnail), with three wide layouts and the two floating custom boxes.

**Architecture:** Orientation is a property of the layout (`Layout.frame`), never a separate field. Every function that used the global `OUTPUT` constant takes the frame explicitly. The export route branches on `isWide(layout)`: wide skips `prependStarter`/`speak`, runs a new `appendOutro` (outro letterboxed over its blurred self) and writes a `titleCard` JPEG as the `<name>.thumb.jpg` sidecar that publishing already prefers.

**Tech Stack:** TypeScript (Node type-stripping on the server, Vite on the client), vitest in `environment: "node"`, real ffmpeg in server tests.

**Spec:** `docs/specs/2026-10-02-vstack-horizontal-short-design.md` — read it alongside this plan. `CLAUDE.md` is the authority on invariants; every one it lists for the tall path must still hold.

## Global Constraints

- Tall output must stay byte-identical: the nine existing preset ids, rows and cells; `SCREEN_FILTER` at band 820; mask filenames; every stored record.
- Frames: `TALL = { w: 1080, h: 1920 }`, `WIDE = { w: 1920, h: 1080 }`.
- Wide presets, exactly: `w-1` "Full" `[{h:1080,cols:1}]`; `w-2h` "2 side by side" `[{h:1080,cols:2}]`; `w-2x2` "2 × 2 grid" `[{h:540,cols:2},{h:540,cols:2}]`. Labels must not contain "vertical" or "horizontal".
- Frame-bounded functions take `frame: Size` with **no default**.
- Wide title rules: max 220, min 120 (floor, never below), max 3 lines, block ≤ `round(0.7 * h)` = 756, width ≤ `w - 192`. Tall rules: max 150, min 48, unlimited lines, block ≤ `h / 2`, width ≤ `w - 192`. Step 6, line height 1.2.
- Wide thumbnail band: `WIDE_BAND_H = 860`; tall stays 820. Thumbnail output 1280x720, `-q:v 3`, written to `thumbPath(out)`.
- Wide publish: `shorts: false`; tags `WIDE_TAGS_DEFAULT` = `TAGS_DEFAULT` minus `shorts`.
- Conventions (CLAUDE.md): `import type` for types, explicit `.ts` extensions, no `enum`/`namespace`/`any`/default exports, no `console.log`/`.info`, `noUncheckedIndexedAccess` guarded with `??` not `!`, no non-erasable TS syntax.
- **Commits:** a repo hook blocks `git add`/`git commit` from agents. Each task ends by leaving changes in the working tree and stating the proposed commit message; Hoang commits.
- Test runner: `pnpm exec vitest run <file>` for one file, `pnpm test` for all, `pnpm build` for `tsc && vite build`.

## Review Focus

1. **Tags typed for a tall export carried into a wide one** — `doExport`'s `ytTags || TAGS_DEFAULT` keeps `…, shorts` when the user exports tall then flips to Long and re-exports. Expected: an untouched default swaps to the other orientation's default; hand-edited tags are kept. Pinned by `tagsFor` tests in Task 6.
2. **A title with one unbreakable word (a URL, a long hashtag)** — wider than the frame at every size. Expected: `fitTitle` terminates, returns the floor size and `fits: false`, never loops. Pinned in Task 3.
3. **A wide record restored after the clip was re-fetched at another resolution, or hand-edited with tall-frame pieces** — expected: wide layout kept, illegal boxes/pieces dropped. Pinned in Task 2.
4. **A silent clip exported wide** — the body has no audio stream and `concat` needs matching stream counts. Expected: renders with silence for the body, outro audio intact. Pinned in Task 4.
5. **Same title and marks re-exported in the other orientation** — same `outName`, stale sidecar from the other shape. Expected: tall leaves no `.thumb.jpg`, wide leaves no vertical `.jpg`. Route is untested by design; pinned by the browser checklist in Task 8, step "sidecar swap".

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/geometry.ts` | modify | `TALL`, `WIDE`; temporary `OUTPUT` alias (deleted in Task 9) |
| `src/layout.ts` | modify | `Layout.frame`, three wide presets, `isWide`, `DEFAULT_WIDE_LAYOUT`, `cellsOf` reads the frame |
| `src/custom.ts` | modify | `frame` parameter on every frame-bounded function |
| `src/frame.ts` | modify | `windowOf(cell, frame)`, `maskRgba(frame, windows, customs)` |
| `src/state.ts` | modify | `restore` validates pieces against the layout's frame |
| `server/mask.ts` | modify | mask sized from `layout.frame` |
| `server/ffmpeg.ts` | modify | `assertCustoms(…, frame)`, `pngSize` |
| `src/starter.ts` | modify | `titleRules`, `fitTitle` (pure), `titleFits`, `drawTitle`/`renderTitleArt` take a frame |
| `src/starter.test.ts` | create | `fitTitle` tests |
| `server/longform.ts` | modify | `letterboxLegs` extracted, `appendOutro` |
| `server/starter.ts` | modify | `screenFilter(bandH)`, `WIDE_BAND_H`, `titleCard` |
| `src/defaults.ts` | modify | `WIDE_TAGS_DEFAULT`, `tagsFor` |
| `server/index.ts` | modify | `/api/export` wide branch, sidecar sweep |
| `src/api.ts` | modify | `voice`/`voiceTitle` optional |
| `src/preview.ts` | modify | frame parameter, wide band, no crop guide in wide |
| `src/main.ts` | modify | orientation toggle, filtered picker, hidden voice row, title badge, publish flag/tags, `.is-wide` in framing |
| `src/style.css` | modify | wide layout swatch shape |
| `CLAUDE.md` | modify | spec pointer, architecture lines, invariants |

---

### Task 1: Frames and wide layout presets

**Files:**
- Modify: `src/geometry.ts:5`
- Modify: `src/layout.ts` (type, presets, `cellsOf`)
- Test: `src/layout.test.ts`

**Interfaces:**
- Produces: `TALL: Size`, `WIDE: Size` (geometry.ts); `type Layout = { id: string; label: string; frame: Size; rows: Row[] }`; `DEFAULT_WIDE_LAYOUT: Layout` (id `w-1`); `isWide(layout: Layout): boolean`; `LAYOUTS` now has 12 entries (9 tall, then 3 wide).

- [ ] **Step 1: Update `src/layout.test.ts` to the new expectations (failing)**

Replace the import line and the tests below. Keep every other test as it is.

```ts
import { TALL, WIDE, isValidBox, maxBox } from "./geometry.ts";
import type { Rect, Size } from "./geometry.ts";
import {
  DEFAULT_LAYOUT,
  DEFAULT_LAYOUT_ID,
  DEFAULT_WIDE_LAYOUT,
  LAYOUTS,
  cellsOf,
  defaultBoxes,
  isWide,
  layoutById,
  ratioOf,
} from "./layout.ts";
```

Replace `"has nine presets with unique ids"` with:

```ts
  it("has nine tall and three wide presets, all with unique ids", () => {
    expect(LAYOUTS).toHaveLength(12);
    expect(new Set(LAYOUTS.map((l) => l.id)).size).toBe(12);
    expect(LAYOUTS.filter((l) => !isWide(l))).toHaveLength(9);
    expect(LAYOUTS.filter(isWide).map((l) => l.id)).toEqual(["w-1", "w-2h", "w-2x2"]);
  });

  it("gives every tall preset the TALL frame and every wide one WIDE", () => {
    for (const l of LAYOUTS) expect(l.frame).toEqual(isWide(l) ? WIDE : TALL);
    expect(DEFAULT_LAYOUT.frame).toEqual(TALL);
    expect(DEFAULT_WIDE_LAYOUT).toBe(byId("w-1"));
  });
```

Replace `"has rows that fill the output height at full width"` with:

```ts
  it("has rows that fill their own frame's height at full width", () => {
    for (const l of LAYOUTS) {
      expect(l.rows.reduce((n, r) => n + r.h, 0)).toBe(l.frame.h);
      for (const r of l.rows) {
        expect(Number.isInteger(r.h)).toBe(true);
        expect(r.cols).toBeGreaterThanOrEqual(1);
        expect(l.frame.w % r.cols).toBe(0);
      }
    }
  });
```

In `"tiles the output frame exactly for every preset"`: change `toBeGreaterThanOrEqual(2)` to `toBeGreaterThanOrEqual(1)` (w-1 has one cell), and every `OUTPUT.w` / `OUTPUT.h` to `l.frame.w` / `l.frame.h`.

Replace `"only ever produces the three documented cell shapes"` with:

```ts
  it("only ever produces the documented cell shapes, per frame", () => {
    const shapes = (wide: boolean) =>
      [...new Set(LAYOUTS.filter((l) => isWide(l) === wide).flatMap(cellsOf).map((c) => `${c.w}x${c.h}`))].sort();
    expect(shapes(false)).toEqual(["1080x480", "1080x960", "540x960"]);
    expect(shapes(true)).toEqual(["1920x1080", "960x1080", "960x540"]);
  });

  it("lays out the wide presets row-major", () => {
    expect(cellsOf(byId("w-1"))).toEqual([{ x: 0, y: 0, w: 1920, h: 1080 }]);
    expect(cellsOf(byId("w-2h"))).toEqual([
      { x: 0, y: 0, w: 960, h: 1080 },
      { x: 960, y: 0, w: 960, h: 1080 },
    ]);
    expect(cellsOf(byId("w-2x2"))).toEqual([
      { x: 0, y: 0, w: 960, h: 540 },
      { x: 960, y: 0, w: 960, h: 540 },
      { x: 0, y: 540, w: 960, h: 540 },
      { x: 960, y: 540, w: 960, h: 540 },
    ]);
  });

  it("reports the two wide ratios exactly", () => {
    expect(ratioOf(cellsOf(byId("w-1"))[0] ?? { x: 0, y: 0, w: 1, h: 1 })).toBeCloseTo(16 / 9, 10);
    expect(ratioOf(cellsOf(byId("w-2h"))[0] ?? { x: 0, y: 0, w: 1, h: 1 })).toBeCloseTo(8 / 9, 10);
  });
```

Any other `OUTPUT` reference left in this file becomes `TALL`. The existing `defaultBoxes` tests iterate `LAYOUTS`, so they now cover the wide presets too — check after running that at least one iterates every layout; if none does, add:

```ts
  it("returns per-cell-valid boxes for every wide preset", () => {
    for (const source of [{ w: 1920, h: 1080 }, { w: 1280, h: 720 }, { w: 720, h: 1280 }] as Size[]) {
      for (const l of LAYOUTS.filter(isWide)) {
        const cells = cellsOf(l);
        const boxes = defaultBoxes(source, l);
        expect(boxes).toHaveLength(cells.length);
        cells.forEach((cell, i) => {
          const b = boxes[i];
          if (!b) throw new Error("defaultBoxes returned a hole");
          expect(isValidBox(b, source, ratioOf(cell))).toBe(true);
        });
      }
    }
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/layout.test.ts`
Expected: FAIL — `TALL`/`WIDE`/`isWide`/`DEFAULT_WIDE_LAYOUT` are not exported.

- [ ] **Step 3: Implement**

`src/geometry.ts` — replace line 5:

```ts
/** The two output frames. A layout carries one of these as `frame`, and
 *  everything that bounds by "the frame" takes it from there — see
 *  docs/specs/2026-10-02-vstack-horizontal-short-design.md. */
export const TALL: Size = { w: 1080, h: 1920 };
export const WIDE: Size = { w: 1920, h: 1080 };
/** Transitional alias for the tall frame, removed once every reader takes
 *  its frame from a layout (Task 9 of the horizontal-short plan). */
export const OUTPUT: Size = TALL;
```

`src/layout.ts`:
- Import: `import { TALL, WIDE, clampToBounds, maxBox } from "./geometry.ts";`
- Type: `export type Layout = { id: string; label: string; frame: Size; rows: Row[] };`
- Add `frame: TALL,` to `DEFAULT_LAYOUT` and to each of the eight other tall presets (after `label`).
- After `DEFAULT_LAYOUT_ID`, add:

```ts
/** The wide frame's default, exported as a value for the same reason
 *  `DEFAULT_LAYOUT` is: switching orientation lands here. */
export const DEFAULT_WIDE_LAYOUT: Layout = {
  id: "w-1",
  label: "Full",
  frame: WIDE,
  rows: [{ h: 1080, cols: 1 }],
};

/** Orientation is the layout's frame, never a separate field — two fields
 *  that had to agree would be a new illegal state to validate. */
export function isWide(layout: Layout): boolean {
  return layout.frame.w > layout.frame.h;
}
```

(`isWide` is a function declaration, so it is hoisted and safe to define here.)

- Append to the end of the `LAYOUTS` array, after `2v-2h`:

```ts
  DEFAULT_WIDE_LAYOUT,
  {
    id: "w-2h",
    label: "2 side by side",
    frame: WIDE,
    rows: [{ h: 1080, cols: 2 }],
  },
  {
    id: "w-2x2",
    label: "2 × 2 grid",
    frame: WIDE,
    rows: [
      { h: 540, cols: 2 },
      { h: 540, cols: 2 },
    ],
  },
```

- In `cellsOf`, change `const w = OUTPUT.w / row.cols;` to `const w = layout.frame.w / row.cols;`.
- Update the `ratioOf` doc comment: five values now (1.125, 0.5625, 2.25 tall; 16/9 and 8/9 wide).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run src/layout.test.ts` → PASS.
Run: `pnpm build` → passes (the `OUTPUT` alias keeps every other reader compiling).

- [ ] **Step 5: Hand off**

Propose commit: `feat(layout): add WIDE frame and three wide presets`. Leave changes in the working tree.

---

### Task 2: Thread the frame through custom boxes, the mask and their callers

**Files:**
- Modify: `src/custom.ts`, `src/frame.ts`, `src/state.ts:555-565`, `server/mask.ts:67-72`, `server/ffmpeg.ts:479-497` and `exportClip`, `src/main.ts:1305-1325` and `:2217`, `src/preview.ts:104`
- Test: `src/custom.test.ts`, `src/frame.test.ts`, `src/state.test.ts`, `server/ffmpeg.test.ts`, `server/mask.test.ts`

**Interfaces:**
- Consumes: `TALL`, `WIDE`, `Layout.frame`, `isWide`, `DEFAULT_WIDE_LAYOUT` (Task 1).
- Produces (exact signatures, no frame defaults):
  - `clampOut(rect: Rect, frame: Size, margin = 0): Rect`
  - `moveOut(rect: Rect, dx: number, dy: number, frame: Size, margin = 0): Rect`
  - `resizeOut(rect: Rect, corner: Corner, dx: number, dy: number, frame: Size, margin = 0): Rect`
  - `isValidOut(out: unknown, frame: Size): out is Rect`
  - `isValidCustom(custom: unknown, source: Size, frame: Size): custom is CustomBox`
  - `defaultCustom(source: Size, index: number, frame: Size): CustomBox`
  - `windowOf(cell: Rect, frame: Size): Rect`
  - `maskRgba(frame: Size, windows: Rect[], customs: Rect[] = []): Uint8Array` — buffer is `frame.w * frame.h * 4`
  - `assertCustoms(customs: CustomBox[], source: Size, frame: Size): void`

- [ ] **Step 1: Write the new failing tests**

`src/custom.test.ts` — rename the local `TALL` source constant to `PORTRAIT` (it is a 720x1280 *source*, and `geometry.ts` now exports a `TALL` *frame*); import `TALL, WIDE` from `./geometry.ts` instead of `OUTPUT`. Mechanically pass `TALL` as the frame to every existing call (`clampOut(r)` → `clampOut(r, TALL)`, `clampOut(r, MARGIN)` → `clampOut(r, TALL, MARGIN)`, `moveOut(OUT, dx, dy)` → `moveOut(OUT, dx, dy, TALL)`, `resizeOut(OUT, c, dx, dy, MARGIN)` → `resizeOut(OUT, c, dx, dy, TALL, MARGIN)`, `isValidOut(x)` → `isValidOut(x, TALL)`, `isValidCustom(c, s)` → `isValidCustom(c, s, TALL)`, `defaultCustom(s, i)` → `defaultCustom(s, i, TALL)`), and `assertLegalOut` takes a `frame` argument (default the call sites to `TALL`) replacing `OUTPUT`. Then add:

```ts
describe("custom boxes in the WIDE frame", () => {
  it("clamps inside 1920x1080, not 1080x1920", () => {
    const r = clampOut({ x: 5000, y: 5000, w: 400, h: 400 }, WIDE);
    expect(r.x + r.w).toBe(WIDE.w);
    expect(r.y + r.h).toBe(WIDE.h);
    assertLegalOut(r, WIDE);
  });

  it("moves and resizes against the wide frame with a margin", () => {
    const moved = moveOut({ x: 300, y: 300, w: 480, h: 480 }, 5000, 5000, WIDE, 10);
    expect(moved.x + moved.w).toBe(WIDE.w - 10);
    expect(moved.y + moved.h).toBe(WIDE.h - 10);
    for (const corner of CORNERS) {
      const blown = resizeOut({ x: 600, y: 300, w: 480, h: 480 }, corner, 5000, 5000, WIDE, 10);
      assertLegalOut(blown, WIDE);
      expect(blown.y + blown.h).toBeLessThanOrEqual(WIDE.h - 10);
    }
  });

  it("rejects a tall-frame out rect that sits below the wide frame", () => {
    const tallOnly = { x: 300, y: 1500, w: 300, h: 300 };
    expect(isValidOut(tallOnly, TALL)).toBe(true);
    expect(isValidOut(tallOnly, WIDE)).toBe(false);
  });

  it("places defaultCustom inside the wide frame for every source and index", () => {
    for (const source of SOURCES) {
      for (let i = 0; i < MAX_CUSTOM; i++) {
        const c = defaultCustom(source, i, WIDE);
        assertLegalOut(c.out, WIDE);
        expect(isValidCustom(c, source, WIDE)).toBe(true);
      }
    }
  });
});
```

`src/frame.test.ts` — import `TALL, WIDE` instead of `OUTPUT`. Change `alphaAt`/`rgbAt` to take a `frameW` parameter (`(y * frameW + x) * 4`) and pass `TALL.w` at the existing call sites; `cellsOf(l).map(windowOf)` → `cellsOf(l).map((c) => windowOf(c, l.frame))`; `maskRgba(w, …)` → `maskRgba(TALL, w, …)`; `"leaves exactly one gutter around the frame"` uses `l.frame.w`/`l.frame.h`; the length assertion uses `TALL.w * TALL.h * 4`. `"leaves exactly one gutter between adjacent windows"` asserts `adjacencies >= 1` — `w-1` has one cell and no neighbours, so skip single-cell layouts there with `if (cells.length < 2) continue;` before the loop. Then add:

```ts
describe("the WIDE frame", () => {
  const twoUp = byId("w-2h");

  it("insets w-2h's halves by a full gutter outside and half inside", () => {
    expect(windowsOf(twoUp)).toEqual([
      { x: 10, y: 10, w: 945, h: 1060 },
      { x: 965, y: 10, w: 945, h: 1060 },
    ]);
  });

  it("renders a mask the size of the wide frame, with square corners opaque", () => {
    const mask = maskRgba(WIDE, windowsOf(twoUp));
    expect(mask).toHaveLength(WIDE.w * WIDE.h * 4);
    const [left] = windowsOf(twoUp);
    if (!left) throw new Error("w-2h has no first window");
    // The window's own square corner sits outside the rounded window.
    expect(alphaAt(mask, WIDE.w, left.x, left.y)).toBe(255);
    // Its centre is transparent.
    expect(alphaAt(mask, WIDE.w, left.x + 400, left.y + 500)).toBe(0);
    // The seam between the halves is opaque.
    expect(alphaAt(mask, WIDE.w, 960, 540)).toBe(255);
  });
});
```

`src/state.test.ts` — import `WIDE` is not needed; add in `describe("save / restore — custom boxes")`:

```ts
  it("checks pieces against the restored layout's own frame", () => {
    // A piece legal in the tall frame (y=1500) is off the bottom of a wide
    // one. The wide layout must survive; the piece must not.
    const videoId = "customs-wrong-frame";
    const tallPiece = { out: { x: 300, y: 1500, w: 300, h: 300 }, crop: { x: 0, y: 100, w: 300, h: 300 } };
    const widePiece = { out: { x: 300, y: 300, w: 300, h: 300 }, crop: { x: 0, y: 100, w: 300, h: 300 } };
    const record = (customs: unknown[]) =>
      JSON.stringify({
        segments: [{ start: 0, end: 10 }],
        layoutId: "w-1",
        boxes: [{ x: 0, y: 0, w: 1920, h: 1080 }],
        customs,
        sourceW: 1920,
        sourceH: 1080,
      });
    localStorage.setItem(`vstack:${videoId}`, record([tallPiece]));
    const dropped = restore(videoId, source);
    expect(dropped.layoutId).toBe("w-1");
    expect(dropped.customs).toEqual([]);
    expect(dropped.boxes).toEqual([{ x: 0, y: 0, w: 1920, h: 1080 }]);

    localStorage.setItem(`vstack:${videoId}`, record([widePiece]));
    expect(restore(videoId, source).customs).toEqual([widePiece]);
  });
```

Update the existing `isValidCustom(c, source)` call at line ~651 to `isValidCustom(c, source, TALL)` and import `TALL` from `./geometry.ts`.

`server/ffmpeg.test.ts` — wherever `assertCustoms(customs, source)` is called, add `, TALL` (import `TALL` from `../src/geometry.ts`). Add inside `describe("assertCustoms")`:

```ts
  it("bounds pieces by the frame it is given", () => {
    const piece = { out: { x: 300, y: 1500, w: 300, h: 300 }, crop: { x: 0, y: 100, w: 300, h: 300 } };
    expect(() => assertCustoms([piece], SOURCE, TALL)).not.toThrow();
    expect(() => assertCustoms([piece], SOURCE, WIDE)).toThrow(/inside 1920x1080/);
  });
```

Add inside `describe("exportClip")` (proves the whole wide composite end to end, and fences the `xstack` order for wide):

```ts
  it("writes a 1920x1080 w-2h file whose halves match their boxes, seam white", async () => {
    const twoUp = byId("w-2h");
    const wideMask = await ensureMask(twoUp, [], dir);
    // 8:9 boxes, 960 tall: x 0..852 is all red, x 1020..1872 all blue.
    const half = boxFromHeight(960, SOURCE, 8 / 9);
    const out = join(dir, "out-wide.mp4");
    await exportClip({
      input: src,
      start: 0.5,
      duration: 1,
      layout: twoUp,
      boxes: [
        { x: 0, y: 60, ...half },
        { x: 1020, y: 60, ...half },
      ],
      source: SOURCE,
      mask: wideMask,
      out,
    });
    expect(await probeFile(out)).toMatchObject({ width: 1920, height: 1080 });
    const left = await pixelAt(out, 0.4, 480, 540, 1920);
    expect(left.r).toBeGreaterThan(150);
    expect(left.b).toBeLessThan(80);
    const right = await pixelAt(out, 0.4, 1440, 540, 1920);
    expect(right.b).toBeGreaterThan(150);
    expect(right.r).toBeLessThan(80);
    const seam = await pixelAt(out, 0.4, 960, 540, 1920);
    expect(Math.min(seam.r, seam.g, seam.b)).toBeGreaterThan(200);
  });
```

`server/mask.test.ts` — wherever it computes a pixel offset or buffer size with `OUTPUT`, use `layout.frame` of the layout under test (all existing cases are tall, so `TALL`).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm exec vitest run src/custom.test.ts src/frame.test.ts src/state.test.ts`
Expected: FAIL — wrong arity / still bounded by the tall frame.

- [ ] **Step 3: Implement `src/custom.ts`**

Replace `OUTPUT` in the import with nothing (keep `boxFromHeight, clampToBounds, isValidBox, maxBox`). Change the six functions:

```ts
export function clampOut(rect: Rect, frame: Size, margin = 0): Rect {
  const w = even(clamp(rect.w, MIN_OUT_SIDE, frame.w - 2 * margin));
  const h = even(clamp(rect.h, MIN_OUT_SIDE, frame.h - 2 * margin));
  return {
    w,
    h,
    x: even(clamp(rect.x, margin, frame.w - margin - w)),
    y: even(clamp(rect.y, margin, frame.h - margin - h)),
  };
}

export function moveOut(rect: Rect, dx: number, dy: number, frame: Size, margin = 0): Rect {
  return clampOut({ ...rect, x: rect.x + dx, y: rect.y + dy }, frame, margin);
}

export function resizeOut(
  rect: Rect,
  corner: Corner,
  dx: number,
  dy: number,
  frame: Size,
  margin = 0,
): Rect {
  // …body unchanged except:
  //   OUTPUT.w → frame.w, OUTPUT.h → frame.h,
  //   the final clampOut(…, margin) → clampOut(…, frame, margin)
}

export function isValidOut(out: unknown, frame: Size): out is Rect {
  // …unchanged except the last two lines:
  //   r.x + r.w <= frame.w &&
  //   r.y + r.h <= frame.h
}

export function isValidCustom(custom: unknown, source: Size, frame: Size): custom is CustomBox {
  if (typeof custom !== "object" || custom === null || Array.isArray(custom)) return false;
  const c = custom as CustomBox;
  return isValidOut(c.out, frame) && isValidBox(c.crop, source, outRatio(c.out));
}

export function defaultCustom(source: Size, index: number, frame: Size): CustomBox {
  const side = 540;
  const offset = index * 60;
  const out = clampOut(
    {
      x: (frame.w - side) / 2 + offset,
      y: (frame.h - side) / 2 + offset,
      w: side,
      h: side,
    },
    frame,
  );
  // …rest unchanged
}
```

Update the doc comments that say "1080x1920 frame" to "the layout's frame". In `clampOut`'s doc, add one line: "`frame` has no default on purpose: a default of the tall frame would make every call site that forgot it silently tall."

- [ ] **Step 4: Implement `src/frame.ts`**

Import `Size` as a type from `./geometry.ts` (drop `OUTPUT`).

```ts
export function windowOf(cell: Rect, frame: Size): Rect {
  const half = GUTTER / 2;
  const left = cell.x === 0 ? GUTTER : half;
  const top = cell.y === 0 ? GUTTER : half;
  const right = cell.x + cell.w === frame.w ? GUTTER : half;
  const bottom = cell.y + cell.h === frame.h ? GUTTER : half;
  return { x: cell.x + left, y: cell.y + top, w: cell.w - left - right, h: cell.h - top - bottom };
}

export function windowsOf(layout: Layout): Rect[] {
  return cellsOf(layout).map((cell) => windowOf(cell, layout.frame));
}

export function maskRgba(frame: Size, windows: Rect[], customs: Rect[] = []): Uint8Array {
  const buf = new Uint8Array(frame.w * frame.h * 4);
  buf.fill(255);
  const rings = customs.map(ringOf);
  for (let y = 0; y < frame.h; y++) {
    for (let x = 0; x < frame.w; x++) {
      // …inner sampling loop unchanged…
      buf[(y * frame.w + x) * 4 + 3] = 255 - Math.round((transparent * 255) / (SUB * SUB));
    }
  }
  return buf;
}
```

The alpha expression must stay exactly `255 - Math.round(transparent * 255 / (SUB * SUB))` (CLAUDE.md invariant).

- [ ] **Step 5: Update the callers**

`server/mask.ts`: drop the `OUTPUT` import; `maskRgba(layout.frame, windowsOf(layout), customs)`; `"-video_size", \`${layout.frame.w}x${layout.frame.h}\``.

`server/ffmpeg.ts`: drop `OUTPUT` from the geometry import (keep `isValidBox`).

```ts
export function assertCustoms(customs: CustomBox[], source: Size, frame: Size): void {
  // …unchanged checks, then:
    if (!isValidCustom(custom, source, frame)) {
      throw new Error(
        `Invalid custom box ${i + 1} ${JSON.stringify(custom)} for source ` +
          `${source.w}x${source.h}: out must be even integers, at least ` +
          `${MIN_OUT_SIDE} per side, inside ${frame.w}x${frame.h}; crop must ` +
          `be integers matching that box's own ratio and inside the source.`,
      );
    }
}
```

In `exportClip`: `assertCustoms(opts.customs ?? [], opts.source, opts.layout.frame);`.

`server/index.ts` `/api/export`: `assertCustoms(customs, { w: source.width, h: source.height }, layout.frame);`.

`src/state.ts` `restore`: before `usableCustoms`, add `const frame = (layout ?? resolveLayout(s.layoutId)).frame;` (import `resolveLayout` from `./layout.ts` if not already imported; `resolveLayout` falls back to the tall default, matching what `restore` returns for an unknown id) and change the predicate to `s.customs.every((c) => isValidCustom(c, source, frame))`.

`src/main.ts` `ensureFraming`, the output overlay: compute `const frame = layout.frame;` next to `const cells = cellsOf(layout);`, then

```ts
      bounds: () => frame,
      // …
      move: (rect, dx, dy) => moveOut(rect, dx, dy, frame, GUTTER),
      resize: (rect, corner, dx, dy) => resizeOut(rect, corner, dx, dy, frame, GUTTER),
```

(`ensureFraming` rebuilds the editor whenever the layout id changes, so capturing `frame` is safe.) Update the comment "the canvas is 1080x1920 whatever size it renders at" to "the canvas is the layout's frame whatever size it renders at".

`src/main.ts` `+ Box` handler: `defaultCustom(cur.source, cur.customs.length, resolveLayout(cur.layoutId).frame)`.

`src/preview.ts` line 104: `const windows = cells.map((cell) => windowOf(cell, OUTPUT));` — temporary; Task 8 gives `startPreview` a frame.

- [ ] **Step 6: Run to verify everything passes**

Run: `pnpm exec vitest run src/custom.test.ts src/frame.test.ts src/state.test.ts server/mask.test.ts server/ffmpeg.test.ts`
Expected: PASS.
Run: `pnpm build` → passes.

Mutation check (revert after): in `buildFilter`, swap the two entries of `positions` for a two-cell layout (e.g. `.reverse()` on `cells.map(...)` for `positions` only). The new `w-2h` test must fail on the left/right colours. Restore.

- [ ] **Step 7: Hand off**

Propose commit: `feat(frame): bound custom boxes and the mask by the layout's frame`.

---

### Task 3: A readable title — `fitTitle` and frame-aware title drawing

**Files:**
- Modify: `src/starter.ts`
- Create: `src/starter.test.ts`
- Modify: `src/main.ts` (`renderTitleArt` call in `doExport`), `src/preview.ts` (`drawTitle` call)

**Interfaces:**
- Consumes: `TALL`, `WIDE` (Task 1).
- Produces:
  - `type TitleRules = { maxSize: number; minSize: number; maxLines: number; maxBlockH: number; maxWidth: number }`
  - `titleRules(frame: Size): TitleRules`
  - `type Measure = (text: string, size: number) => number`
  - `type TitleFit = { size: number; lines: string[]; fits: boolean }`
  - `fitTitle(measure: Measure, title: string, rules: TitleRules): TitleFit`
  - `titleFits(title: string, frame: Size): boolean` (DOM; for the framing badge)
  - `drawTitle(ctx: CanvasRenderingContext2D, title: string, frame: Size): void`
  - `renderTitleArt(title: string, frame: Size): Promise<string>`

- [ ] **Step 1: Write the failing tests**

Create `src/starter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TALL, WIDE } from "./geometry.ts";
import { fitTitle, titleRules } from "./starter.ts";
import type { Measure, TitleRules } from "./starter.ts";

/** Half an em per character: crude, deterministic, and enough to make
 *  widths depend on both the text and the size the way a real font does. */
const measure: Measure = (text, size) => text.length * size * 0.5;

/** Today's loop, copied verbatim from before `fitTitle` existed and spelled
 *  against the same fake measurer — the regression fence for tall sizes. */
function legacySize(title: string): number {
  const maxWidth = TALL.w - 2 * 96;
  const wrap = (size: number) => {
    const lines: string[] = [];
    let line = "";
    for (const word of title.trim().split(/\s+/)) {
      const next = line === "" ? word : `${line} ${word}`;
      if (line !== "" && measure(next, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line !== "") lines.push(line);
    return lines;
  };
  let size = 48;
  for (size = 150; size > 48; size -= 6) {
    const lines = wrap(size);
    const fits = lines.every((l) => measure(l, size) <= maxWidth);
    if (fits && lines.length * size * 1.2 <= TALL.h / 2) break;
  }
  return size;
}

const SHORT = "Ăn cơm chưa";
const MEDIUM = "Hôm nay mình sẽ thử thách ăn hết mười tô phở trong một giờ";
const LONG =
  "Hôm nay mình sẽ thử thách ăn hết mười tô phở trong một giờ đồng hồ cùng với " +
  "những người bạn thân nhất và xem ai là người chiến thắng cuối cùng nhé mọi người";

describe("titleRules", () => {
  it("keeps the tall rules exactly as they were", () => {
    expect(titleRules(TALL)).toEqual({
      maxSize: 150,
      minSize: 48,
      maxLines: Number.POSITIVE_INFINITY,
      maxBlockH: 960,
      maxWidth: 888,
    });
  });

  it("gives the wide frame a 120px floor, three lines and a 756px block", () => {
    expect(titleRules(WIDE)).toEqual({
      maxSize: 220,
      minSize: 120,
      maxLines: 3,
      maxBlockH: 756,
      maxWidth: 1728,
    });
  });
});

describe("fitTitle — tall (the regression fence)", () => {
  it("picks the same size today's loop picked, for every title", () => {
    for (const title of [SHORT, MEDIUM, LONG, `${LONG} ${LONG}`]) {
      expect(fitTitle(measure, title, titleRules(TALL)).size).toBe(legacySize(title));
    }
  });
});

describe("fitTitle — wide", () => {
  const rules: TitleRules = titleRules(WIDE);

  it("gives a short title the maximum size", () => {
    expect(fitTitle(measure, SHORT, rules)).toEqual({ size: 220, lines: [SHORT], fits: true });
  });

  it("never goes below the floor or above three lines", () => {
    for (const title of [SHORT, MEDIUM, LONG, `${LONG} ${LONG}`]) {
      const fit = fitTitle(measure, title, rules);
      expect(fit.size).toBeGreaterThanOrEqual(120);
      expect(fit.size).toBeLessThanOrEqual(220);
      expect(fit.lines.length).toBeLessThanOrEqual(3);
    }
  });

  it("fits a medium title on at most three lines, inside the block", () => {
    const fit = fitTitle(measure, MEDIUM, rules);
    expect(fit.fits).toBe(true);
    expect(fit.lines.length * fit.size * 1.2).toBeLessThanOrEqual(756);
    for (const line of fit.lines) expect(measure(line, fit.size)).toBeLessThanOrEqual(1728);
  });

  it("reports a title that needs a fourth line at the floor, instead of shrinking", () => {
    // MUTATION TEST: drop the wide floor (minSize 48) and this comes back
    // fits: true at a size nobody can read on a sidebar tile.
    const fit = fitTitle(measure, `${LONG} ${LONG}`, rules);
    expect(fit).toMatchObject({ size: 120, fits: false });
    expect(fit.lines).toHaveLength(3);
  });

  it("terminates on one unbreakable word wider than the frame", () => {
    const url = "https://www.youtube.com/watch?v=0vGJ0ywUW-8&t=12345s&list=abcdefghijklmnopqrstuvwxyz";
    const fit = fitTitle(measure, url, rules);
    expect(fit).toEqual({ size: 120, lines: [url], fits: false });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/starter.test.ts`
Expected: FAIL — `fitTitle`/`titleRules` not exported.

- [ ] **Step 3: Implement in `src/starter.ts`**

Replace lines 1–92 (imports through `drawTitle`) with:

```ts
import type { Size } from "./geometry.ts";

/** …TITLE_FONT doc comment unchanged… */
export const TITLE_FONT = '"Comic Sans MS", "Chalkboard SE", Chalkboard, cursive';

const MARGIN = 96;
const SIZE_STEP = 6;
const LINE_HEIGHT = 1.2;
/** Relative to the font size, so the outline stays proportional as the text
 *  shrinks to fit. */
const STROKE = 0.16;

/** How big a title may be, and how small it may get, in one frame. */
export type TitleRules = {
  maxSize: number;
  minSize: number;
  maxLines: number;
  maxBlockH: number;
  maxWidth: number;
};

/** Tall is today's rules exactly: a phone-sized screen, where shrinking a
 *  long title to 48px still reads. Wide is a THUMBNAIL — its smallest common
 *  surface is a ~168x94 tile, a 0.087 scale of a 1080-tall frame, so 48px
 *  would land at ~4px there. 120px lands at ~10.5px, the legibility floor,
 *  and it is a floor: a title that does not fit at it is reported (`fits`),
 *  never shrunk past it. */
export function titleRules(frame: Size): TitleRules {
  const maxWidth = frame.w - 2 * MARGIN;
  return frame.w > frame.h
    ? { maxSize: 220, minSize: 120, maxLines: 3, maxBlockH: Math.round(frame.h * 0.7), maxWidth }
    : { maxSize: 150, minSize: 48, maxLines: Number.POSITIVE_INFINITY, maxBlockH: frame.h / 2, maxWidth };
}

/** A text's width at a size. Injected so the fit is testable without a DOM. */
export type Measure = (text: string, size: number) => number;

export type TitleFit = { size: number; lines: string[]; fits: boolean };

/** Greedy word wrap at a given font size. */
function wrapLines(measure: Measure, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  // ponytail: a word wider than the frame gets its own line and overflows
  // rather than being broken mid-word. Hyphenate if a real title ever needs it.
  for (const word of text.trim().split(/\s+/)) {
    const next = line === "" ? word : `${line} ${word}`;
    if (line !== "" && measure(next, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** The largest size, stepping down from `maxSize`, at which the title wraps
 *  inside the width, the line cap and the block height. Below every size
 *  that fits it returns `minSize` — never smaller — with `fits` saying
 *  whether even that worked, and the lines capped at `maxLines`.
 *
 *  The loop's bounds are today's (`size > minSize`), so a tall title gets
 *  the size it always got. The one difference is the floor itself: the
 *  lines are now wrapped AT `minSize` rather than reusing the last size
 *  tried above it. */
export function fitTitle(measure: Measure, title: string, rules: TitleRules): TitleFit {
  const fitsAt = (lines: string[], size: number) =>
    lines.length <= rules.maxLines &&
    lines.every((l) => measure(l, size) <= rules.maxWidth) &&
    lines.length * size * LINE_HEIGHT <= rules.maxBlockH;
  for (let size = rules.maxSize; size > rules.minSize; size -= SIZE_STEP) {
    const lines = wrapLines(measure, title, size, rules.maxWidth);
    if (fitsAt(lines, size)) return { size, lines, fits: true };
  }
  const lines = wrapLines(measure, title, rules.minSize, rules.maxWidth);
  const fits = fitsAt(lines, rules.minSize);
  return { size: rules.minSize, lines: fits ? lines : lines.slice(0, rules.maxLines), fits };
}

/** `ctx.measureText` in `Measure`'s shape. Sets `ctx.font`, so callers that
 *  care about drawing state save and restore around it. */
function canvasMeasure(ctx: CanvasRenderingContext2D): Measure {
  return (text, size) => {
    ctx.font = `bold ${size}px ${TITLE_FONT}`;
    return ctx.measureText(text).width;
  };
}

let measurer: CanvasRenderingContext2D | null = null;

/** Whether the title fits its frame's rules — the framing bar's too-long
 *  badge. One scratch canvas, made on first use. */
export function titleFits(title: string, frame: Size): boolean {
  measurer ??= document.createElement("canvas").getContext("2d");
  if (!measurer) return true;
  return fitTitle(canvasMeasure(measurer), title, titleRules(frame)).fits;
}

/** Lays the title out and paints it into `ctx`, which must be a canvas the
 *  size of `frame`. Leaves no drawing state behind.
 *
 *  …keep the existing paragraph about sharing the draw rather than the bytes… */
export function drawTitle(ctx: CanvasRenderingContext2D, title: string, frame: Size): void {
  ctx.save();
  const { size, lines } = fitTitle(canvasMeasure(ctx), title, titleRules(frame));
  ctx.font = `bold ${size}px ${TITLE_FONT}`;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = size * STROKE;
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#fff";
  // Under the outline, not the fill: a shadow on both passes doubles up and
  // reads as a smear.
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = size * 0.22;
  ctx.shadowOffsetY = size * 0.06;

  const step = size * LINE_HEIGHT;
  const top = frame.h / 2 - ((lines.length - 1) * step) / 2;
  lines.forEach((line, i) => {
    ctx.strokeText(line, frame.w / 2, top + i * step);
  });
  // Fills in a second pass, after every outline: a per-line stroke-then-fill
  // lets the next line's outline overlap the previous line's fill.
  ctx.shadowColor = "transparent";
  lines.forEach((line, i) => {
    ctx.fillText(line, frame.w / 2, top + i * step);
  });
  ctx.restore();
}
```

`renderTitleArt`: signature `renderTitleArt(title: string, frame: Size)`; `canvas.width = frame.w; canvas.height = frame.h;`; `drawTitle(ctx, title, frame);`; doc comment "a transparent PNG the size of `frame`".

- [ ] **Step 4: Update the two callers**

`src/main.ts` `doExport`: `titlePng: await renderTitleArt(starterTitle, layout.frame),`.
`src/preview.ts`: `drawTitle(ctx, art, OUTPUT);` (temporary; Task 8 passes the frame).

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm exec vitest run src/starter.test.ts` → PASS.
Mutation check (revert after): change wide `minSize: 120` to `48` in `titleRules` → the "fourth line at the floor" test must fail. Restore.
Run: `pnpm build` → passes.

- [ ] **Step 6: Hand off**

Propose commit: `feat(starter): pure fitTitle with a readable floor for wide titles`.

---

### Task 4: `appendOutro` — the wide export's second pass

**Files:**
- Modify: `server/longform.ts` (extract `letterboxLegs`, add `appendOutro`)
- Test: `server/longform.test.ts`

**Interfaces:**
- Consumes: `probeFile` (already imported).
- Produces: `appendOutro(opts: { main: string; outro: string; out: string }): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

In `server/longform.test.ts`: import `appendOutro` alongside `stackWide`, and `END_PATH` if the file does not already import it. Add two fixtures to the module-level `let`s and to `beforeAll`:

```ts
/** A finished WIDE body, as `exportClip` writes one for a w-1 layout: green,
 *  2s, with sound — and the same without. */
let wideBody = "";
let wideMute = "";
```

```ts
  wideBody = join(dir, "wide-body.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=green:s=1920x1080:d=2:r=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-y", wideBody,
  ]);
  wideMute = join(dir, "wide-mute.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=green:s=1920x1080:d=2:r=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-y", wideMute,
  ]);
```

Add a describe block (the `red` fixture is a 1080x1920 part with audio — it stands in for the outro so the blur leg has a colour to show):

```ts
describe("appendOutro", () => {
  it("is the body, then the outro letterboxed over its own blurred copy", async () => {
    const out = join(dir, "append.mp4");
    await appendOutro({ main: wideBody, outro: red, out });
    const p = await probeFile(out);
    expect(p).toMatchObject({ width: 1920, height: 1080, hasAudio: true });
    expect(p.seconds).toBeCloseTo(4, 1);

    // The body first — MUTATION TEST: reverse the legs and this reads red.
    const body = await pixelAt(out, 1, 960, 540);
    expect(body.g).toBeGreaterThan(100);
    expect(body.r).toBeLessThan(80);

    // The outro's own picture in the middle…
    const centre = await pixelAt(out, 3, 960, 540);
    expect(centre.r).toBeGreaterThan(150);
    // …and its blurred copy at the edge, NOT black. MUTATION TEST: drop the
    // background leg and this pillarboxes to black.
    const edge = await pixelAt(out, 3, 20, 540);
    expect(edge.r).toBeGreaterThan(60);
  });

  it("renders a silent body through a stand-in, keeping the outro's sound", async () => {
    const out = join(dir, "append-mute.mp4");
    await appendOutro({ main: wideMute, outro: red, out });
    const p = await probeFile(out);
    expect(p.hasAudio).toBe(true);
    expect(p.seconds).toBeCloseTo(4, 1);
    // Silence under the body, the outro's 440 Hz after the cut.
    expect((await loudness(out, 0.5, 1)).max).toBeLessThan(-60);
    expect((await loudness(out, 2.5, 1)).max).toBeGreaterThan(-30);
  });

  it("accepts the real bundled outro", async () => {
    const out = join(dir, "append-real.mp4");
    await appendOutro({ main: wideBody, outro: END_PATH, out });
    expect((await probeFile(out)).seconds).toBeCloseTo(2 + outroSeconds, 1);
  });
});
```

(`loudness(path, t, dur)` already exists in this file and returns `{ mean, max }` in dB — check its return shape and adjust the property names if it differs. `outroSeconds` is already probed in `beforeAll`.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run server/longform.test.ts`
Expected: FAIL — `appendOutro` is not exported.

- [ ] **Step 3: Extract `letterboxLegs` and use it in `stackWide`**

Add above `stackWide`:

```ts
/** The vertical-over-its-own-blur treatment, as filter steps from `input`
 *  to `[lb<tag>]`: a cover-cropped background blurred at 480x270 and
 *  stretched back up, with the source fitted inside it on both axes.
 *  Shared by `stackWide`'s parts and `appendOutro`'s outro so the two
 *  cannot drift into two different looks. */
function letterboxLegs(input: string, tag: string): string[] {
  return [
    `[${input}]split=2[bg${tag}][fg${tag}]`,
    `[bg${tag}]scale=${BG_W}:${BG_H}:force_original_aspect_ratio=increase,` +
      `crop=${BG_W}:${BG_H},gblur=sigma=${BLUR_SIGMA},` +
      `scale=${WIDE.w}:${WIDE.h},setsar=1[bgz${tag}]`,
    `[fg${tag}]scale=${WIDE.w}:${WIDE.h}:force_original_aspect_ratio=decrease:` +
      `force_divisible_by=2,setsar=1[fgz${tag}]`,
    // …move the existing comment about floor((W-w)/4)*2 here…
    `[bgz${tag}][fgz${tag}]overlay=floor((W-w)/4)*2:floor((H-h)/4)*2[lb${tag}]`,
  ];
}
```

In `stackWide`, replace the four-element `legs.push(...)` of split/bg/fg/overlay with:

```ts
    legs.push(
      ...letterboxLegs(`${i}:v`, String(i)),
      `[lb${i}]fps=${FPS},setpts=PTS-STARTPTS,${vFade}format=yuv420p[v${i}]`,
    );
```

Run: `pnpm exec vitest run server/longform.test.ts -t stackWide` → the existing `stackWide` tests still PASS (this is a pure refactor).

- [ ] **Step 4: Implement `appendOutro`**

Add after `stackWide`:

```ts
/** The wide export's second pass: the finished 1920x1080 body, then the
 *  bundled outro — which is a 1080x1920 asset — letterboxed over its own
 *  blurred copy, the treatment `stackWide` gives every vertical part.
 *
 *  A hard cut, no dip and no swell: the short's own outro is a hard cut too.
 *  Both legs run at the BODY's frame rate (the asset is 34 fps), pinned to
 *  square pixels and yuv420p, because `concat` refuses a mismatch rather than
 *  picking a side. A silent body gets a stand-in trimmed to its own length,
 *  appended LAST so it is the one conditional input index.
 *
 *  `outro` is the caller's — `END_PATH` lives in `starter.ts`, this module's
 *  sibling — and must carry sound, as the bundled asset always does. */
export async function appendOutro(opts: { main: string; outro: string; out: string }): Promise<string> {
  const [main, outro] = await Promise.all([probeFile(opts.main), probeFile(opts.outro)]);
  if (!outro.hasAudio) throw new Error(`appendOutro: ${opts.outro} has no audio stream.`);
  const fmt = `aresample=${RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;
  const inputs = ["-i", opts.main, "-i", opts.outro];
  if (!main.hasAudio) inputs.push("-f", "lavfi", "-i", `anullsrc=r=${RATE}:cl=stereo`);
  const graph = [
    `[0:v]fps=${main.fps},setsar=1,format=yuv420p[v0]`,
    ...letterboxLegs("1:v", "o"),
    `[lbo]fps=${main.fps},setpts=PTS-STARTPTS,format=yuv420p[v1]`,
    main.hasAudio
      ? `[0:a]${fmt}[a0]`
      : `[2:a]atrim=0:${main.seconds},asetpts=PTS-STARTPTS,${fmt}[a0]`,
    `[1:a]${fmt}[a1]`,
    "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]",
  ].join(";");
  try {
    await run(
      "ffmpeg",
      [
        "-v", "error",
        ...inputs,
        "-filter_complex", graph,
        "-map", "[v]",
        "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", CRF,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        "-y", opts.out,
      ],
      { maxBuffer: 16 << 20 },
    );
  } catch (err) {
    throw toolError("ffmpeg", err);
  }
  return opts.out;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm exec vitest run server/longform.test.ts` → PASS (new and existing).
Mutation checks (revert after each): (a) swap `[v0][a0][v1][a1]` to `[v1][a1][v0][a0]` → body-colour assertion fails; (b) replace `...letterboxLegs("1:v", "o")` with ``[1:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2[lbo]`` → edge assertion fails.

- [ ] **Step 6: Hand off**

Propose commit: `feat(longform): appendOutro letterboxes the outro after a wide body`.

---

### Task 5: `titleCard` — the wide thumbnail

**Files:**
- Modify: `server/starter.ts:114-144` (band constants and `SCREEN_FILTER`), add `titleCard`
- Test: `server/starter.test.ts`

**Interfaces:**
- Produces: `screenFilter(bandH: number): string`; `WIDE_BAND_H = 860`; `titleCard(opts: { main: string; title: string; out: string }): Promise<string>` writing a 1280x720 JPEG.

- [ ] **Step 1: Write the failing tests**

In `server/starter.test.ts`: import `TALL` instead of `OUTPUT` and replace every `OUTPUT` in the file with `TALL` (mechanical). Import `screenFilter` and `titleCard` from `./starter.ts` and `WIDE` from `../src/geometry.ts`. Add module-level `let wideMain = ""; let wideArt = "";` and in `beforeAll`:

```ts
  // The wide body: green | red, seamed at x=960, 1s.
  wideMain = join(dir, "wide-main.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", `color=c=green:s=960x1080:d=1:r=30`,
    "-f", "lavfi", "-i", `color=c=red:s=960x1080:d=1:r=30`,
    "-filter_complex", "[0:v][1:v]hstack=inputs=2[v]",
    "-map", "[v]", "-pix_fmt", "yuv420p", "-y", wideMain,
  ]);
  // Wide title art: transparent 1920x1080 with an opaque magenta square at
  // the top-left, the same stand-in the tall art uses.
  const wideRgba = new Uint8Array(WIDE.w * WIDE.h * 4);
  for (let y = 0; y < ART; y++) {
    for (let x = 0; x < ART; x++) {
      const i = (y * WIDE.w + x) * 4;
      wideRgba[i] = 255;
      wideRgba[i + 2] = 255;
      wideRgba[i + 3] = 255;
    }
  }
  const wideRaw = join(dir, "wide-art.rgba");
  wideArt = join(dir, "wide-art.png");
  await writeFile(wideRaw, wideRgba);
  await run("ffmpeg", [
    "-v", "error",
    "-f", "rawvideo", "-pixel_format", "rgba",
    "-video_size", `${WIDE.w}x${WIDE.h}`,
    "-i", wideRaw, "-frames:v", "1", "-y", wideArt,
  ]);
```

Add a pixel helper and the tests:

```ts
/** One RGB pixel of a still image, `width` px wide. */
async function stillPixel(path: string, width: number, x: number, y: number) {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 64 << 20 },
  );
  const buf = stdout as unknown as Buffer;
  const i = (y * width + x) * 3;
  return { r: buf[i] ?? 0, g: buf[i + 1] ?? 0, b: buf[i + 2] ?? 0 };
}

describe("screenFilter", () => {
  it("is today's SCREEN_FILTER at the tall band, character for character", () => {
    expect(screenFilter(820)).toBe(
      "[0:v]format=rgb24,split=2[sharp][tosoften];" +
        "[tosoften]gblur=sigma=30,colorchannelmixer=rr=0.65:gg=0.65:bb=0.65,format=rgb24[soft];" +
        "[sharp][soft]blend=all_expr='" +
        "A+(B-A)*clip(min(Y-(H-820)/2,(H+820)/2-Y)/60,0,1)'",
    );
  });
});

describe("titleCard", () => {
  it("is a 1280x720 title card: band blurred, outside sharp, art on top", async () => {
    const out = join(dir, "card.jpg");
    await titleCard({ main: wideMain, title: wideArt, out });
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", out,
    ]);
    expect(stdout.trim()).toBe("1280,720");

    // The seam at the band's centre is mixed by the blur. MUTATION TEST:
    // drop the gblur and this reads pure green or pure red.
    const seam = await stillPixel(out, 1280, 640, 360);
    expect(seam.r).toBeGreaterThan(30);
    expect(seam.g).toBeGreaterThan(30);

    // Above the band (frame y 50 → card y 33) stays sharp, unscrimmed red.
    const top = await stillPixel(out, 1280, 900, 33);
    expect(top.r).toBeGreaterThan(200);
    expect(top.g).toBeLessThan(60);

    // The art's magenta corner.
    const art = await stillPixel(out, 1280, 20, 20);
    expect(art.r).toBeGreaterThan(200);
    expect(art.b).toBeGreaterThan(200);
    expect(art.g).toBeLessThan(80);
  });
});
```

The expected literal is today's `SCREEN_FILTER` (lines 139–144 of `server/starter.ts`) expanded by hand with `BLUR_SIGMA = 30`, `SCRIM = 0.65`, `BAND_H = 820`, `BAND_FEATHER = 60`. The `\,` in that TypeScript template literal is a NonEscapeCharacter and evaluates to a plain `,`, which is why the expected string has bare commas. If the first green run shows a mismatch, fix the expected literal — this test pins *today's* evaluated value, so the code is the reference.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run server/starter.test.ts`
Expected: FAIL — `screenFilter`/`titleCard`/`WIDE_BAND_H` not exported.

- [ ] **Step 3: Implement**

In `server/starter.ts`, after `BAND_FEATHER`:

```ts
/** The wide title card's band: three lines at 220px (`titleRules`' wide
 *  maximum block, 756px) plus feather. More of the frame goes soft than on a
 *  short, which costs nothing — the card is a thumbnail only. */
export const WIDE_BAND_H = 860;
```

Replace the `SCREEN_FILTER` constant with:

```ts
/** …existing SCREEN_FILTER doc comment, plus: "A function of the band height
 *  so the wide title card can use a taller band; the tall screen calls it
 *  with BAND_H and is unchanged."… */
export function screenFilter(bandH: number): string {
  return (
    "[0:v]format=rgb24,split=2[sharp][tosoften];" +
    `[tosoften]gblur=sigma=${BLUR_SIGMA},` +
    `colorchannelmixer=rr=${SCRIM}:gg=${SCRIM}:bb=${SCRIM},format=rgb24[soft];` +
    "[sharp][soft]blend=all_expr='" +
    `A+(B-A)*clip(min(Y-(H-${bandH})/2\,(H+${bandH})/2-Y)/${BAND_FEATHER}\,0\,1)'`
  );
}
const SCREEN_FILTER = screenFilter(BAND_H);
```

Add after `prependStarter`:

```ts
/** The wide export's thumbnail: the starter screen's look — blurred,
 *  scrimmed band, title on top — over the body's first frame, at 1280x720.
 *  It never appears in the video; a wide export has no starter screen.
 *
 *  The body is 1920x1080, already 16:9, so it scales straight to 1280x720
 *  with nothing cropped. `-q:v 3` for `thumbnails.set`'s 2 MB cap, the same
 *  as `firstFrame`. The caller writes this to `thumbPath`, which
 *  `applyThumbnail` already prefers, so publishing needs no change. */
export async function titleCard(opts: { main: string; title: string; out: string }): Promise<string> {
  try {
    await run("ffmpeg", [
      "-v", "error",
      "-i", opts.main,
      "-i", opts.title,
      "-frames:v", "1",
      "-filter_complex",
      `${screenFilter(WIDE_BAND_H)}[bg];[bg][1:v]overlay=0:0:format=auto,scale=1280:720`,
      "-q:v", "3",
      "-y", opts.out,
    ]);
  } catch (err) {
    throw toolError("ffmpeg", err);
  }
  return opts.out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run server/starter.test.ts` → PASS (new and existing).
Mutation check (revert after): remove `gblur=sigma=${BLUR_SIGMA},` from `screenFilter` → the seam assertion fails (and the string test, which is fine).

- [ ] **Step 5: Hand off**

Propose commit: `feat(starter): titleCard renders the wide thumbnail`.

---

### Task 6: Small pure helpers — `pngSize`, wide tags

**Files:**
- Modify: `server/ffmpeg.ts` (add `pngSize`), `src/defaults.ts` (add `WIDE_TAGS_DEFAULT`, `tagsFor`)
- Test: `server/ffmpeg.test.ts`, `src/defaults.test.ts`, `server/youtube.test.ts`

**Interfaces:**
- Produces: `pngSize(buf: Buffer): Size` (`{ w: 0, h: 0 }` for anything without an IHDR); `WIDE_TAGS_DEFAULT: string`; `tagsFor(current: string, wide: boolean): string`.

- [ ] **Step 1: Write the failing tests**

`server/ffmpeg.test.ts`:

```ts
describe("pngSize", () => {
  /** The 8-byte signature, then an IHDR chunk header: length 13, "IHDR",
   *  width and height as big-endian uint32. */
  function header(w: number, h: number): Buffer {
    const b = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  }

  it("reads width and height out of the IHDR chunk", () => {
    expect(pngSize(header(1920, 1080))).toEqual({ w: 1920, h: 1080 });
    expect(pngSize(header(1080, 1920))).toEqual({ w: 1080, h: 1920 });
  });

  it("reads a real PNG ensureMask wrote", async () => {
    expect(pngSize(await readFile(mask))).toEqual({ w: 1080, h: 1920 });
  });

  it("answers 0x0 for a truncated buffer or a first chunk that is not IHDR", () => {
    expect(pngSize(Buffer.alloc(10))).toEqual({ w: 0, h: 0 });
    const notIhdr = header(1920, 1080);
    notIhdr.write("tEXt", 12, "ascii");
    expect(pngSize(notIhdr)).toEqual({ w: 0, h: 0 });
  });
});
```

(Import `readFile` from `node:fs/promises` if the file does not already, and `pngSize` from `./ffmpeg.ts`.)

`src/defaults.test.ts`:

```ts
describe("WIDE_TAGS_DEFAULT / tagsFor", () => {
  it("is the short's tags with shorts removed, nothing else changed", () => {
    expect(WIDE_TAGS_DEFAULT).toBe("vtuber, vtubervn, vtuber vietnam, viral");
    expect(WIDE_TAGS_DEFAULT.split(", ")).toEqual(TAGS_DEFAULT.split(", ").filter((t) => t !== "shorts"));
  });

  it("fills a blank field with the orientation's own default", () => {
    expect(tagsFor("", false)).toBe(TAGS_DEFAULT);
    expect(tagsFor("", true)).toBe(WIDE_TAGS_DEFAULT);
  });

  it("swaps an untouched default for the other orientation's", () => {
    // The carried-over case: exported tall, flipped to Long, re-exported.
    expect(tagsFor(TAGS_DEFAULT, true)).toBe(WIDE_TAGS_DEFAULT);
    expect(tagsFor(WIDE_TAGS_DEFAULT, false)).toBe(TAGS_DEFAULT);
  });

  it("keeps tags the user typed, in either orientation", () => {
    expect(tagsFor("habine, shorts", true)).toBe("habine, shorts");
    expect(tagsFor("habine", false)).toBe("habine");
  });
});
```

`server/youtube.test.ts` (next to the existing `TAGS_DEFAULT` case):

```ts
  it("sends WIDE_TAGS_DEFAULT as tags with no shorts among them", () => {
    const s = buildSnippet({ title: "t", description: "d", tags: WIDE_TAGS_DEFAULT, shorts: false });
    expect(s.snippet.tags).not.toContain("shorts");
    expect(s.snippet.tags).toContain("vtuber");
  });
```

(Check `buildSnippet`'s real parameter and return shape in `server/youtube.ts` and match the existing `TAGS_DEFAULT` test's call exactly.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run server/ffmpeg.test.ts src/defaults.test.ts server/youtube.test.ts`
Expected: FAIL — the three names are not exported.

- [ ] **Step 3: Implement**

`server/ffmpeg.ts`, near `isOutName`:

```ts
/** A PNG's dimensions, from its IHDR chunk — which the format requires to be
 *  the first chunk, straight after the 8-byte signature. The caller has
 *  already checked the signature (`png()` in index.ts); this reads only
 *  what follows. `{ w: 0, h: 0 }` for anything shorter or not IHDR-first, so
 *  a comparison against a real frame simply fails.
 *
 *  `/api/export` uses it to refuse title art sized for the other frame: a
 *  1080x1920 PNG overlaid on a 1920x1080 frame lands off-centre with no
 *  error at all. */
export function pngSize(buf: Buffer): Size {
  if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") return { w: 0, h: 0 };
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
```

`src/defaults.ts`, after `TAGS_DEFAULT`:

```ts
/** A horizontal export's tags: the short's, minus `shorts` — derived rather
 *  than written out, so the two cannot drift. A normal video carrying the
 *  tag is misfiled the way a compilation would be. */
export const WIDE_TAGS_DEFAULT = TAGS_DEFAULT.split(", ")
  .filter((t) => t !== "shorts")
  .join(", ");

/** The tags field's prefill for an export. Blank or the OTHER orientation's
 *  untouched default becomes this one's default; anything the user typed is
 *  theirs and is kept. Without the swap, a tall export followed by a wide
 *  one would carry `shorts` into a normal video. */
export function tagsFor(current: string, wide: boolean): string {
  const own = wide ? WIDE_TAGS_DEFAULT : TAGS_DEFAULT;
  const other = wide ? TAGS_DEFAULT : WIDE_TAGS_DEFAULT;
  return current === "" || current === other ? own : current;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm exec vitest run server/ffmpeg.test.ts src/defaults.test.ts server/youtube.test.ts` → PASS.

- [ ] **Step 5: Hand off**

Propose commit: `feat: pngSize and orientation-aware default tags`.

---

### Task 7: `/api/export` wide branch

**Files:**
- Modify: `server/index.ts` (imports; `/api/export` route; a `saveTitleCard` helper beside `saveStill`; `applyThumbnail`'s doc comment)

**Interfaces:**
- Consumes: `isWide` (Task 1), `assertCustoms(…, frame)` (Task 2), `appendOutro` (Task 4), `titleCard` (Task 5), `pngSize` (Task 6), `END_PATH`, `stillPath`, `thumbPath` (existing).
- Produces: the body contract — on a wide layout `voice` and `voiceTitle` are not read; `titlePng` must be `layout.frame`-sized on either orientation.

This route has no tests by design (CLAUDE.md: network surface). It is verified in Task 8's browser checklist.

- [ ] **Step 1: Imports**

Add `isWide` to the `../src/layout.ts` import; `appendOutro` to the `./longform.ts` import; `titleCard` to the `./starter.ts` import; `pngSize` to the `./ffmpeg.ts` import.

- [ ] **Step 2: Move the voice reads below the layout lookup and add the PNG check**

In `/api/export`, delete these two lines from the top of the route:

```ts
    const voiceTitle = readVoiceTitle(raw.voiceTitle, starterTitle);
    const voiceName = str(raw.voice, "voice");
```

Replace the block from `const layout = layoutById(layoutId);` through the `knownVoices` check with:

```ts
    const layout = layoutById(layoutId);
    if (!layout) return send(res, 400, { error: `Unknown layout ${layoutId}.` });
    // Orientation is the layout's frame — there is no second field to agree
    // with it. A wide export has no starter screen: nothing is spoken.
    const wide = isWide(layout);

    // The title art must be the frame's own size. A PNG for the other frame
    // overlays off-centre with no error at all.
    const artSize = pngSize(titlePng);
    if (artSize.w !== layout.frame.w || artSize.h !== layout.frame.h) {
      return send(res, 400, {
        error:
          `titlePng is ${artSize.w}x${artSize.h}; layout ${layout.id} needs ` +
          `${layout.frame.w}x${layout.frame.h}.`,
      });
    }

    // Read only when something will be spoken. The voice reaches a
    // subprocess as argv, so it is checked against the engine's own preset
    // table rather than pattern-matched — …keep the existing comment…
    const voiceTitle = wide ? "" : readVoiceTitle(raw.voiceTitle, starterTitle);
    const voiceName = wide ? "" : str(raw.voice, "voice");
    if (!wide && !knownVoices().some((v) => v.name === voiceName)) {
      return send(res, 400, { error: `Unknown voice ${voiceName}.` });
    }
```

- [ ] **Step 3: Branch the render**

Replace from `const voicePath = join(dir, "voice.wav");` through `await saveStill(out);` with:

```ts
      if (wide) {
        // No title card in the video, so no voice and no screen: the body,
        // then the outro letterboxed for the wide frame.
        await appendOutro({ main: body, outro: END_PATH, out: partial });
        await rename(partial, out);
        await saveTitleCard(body, art, out);
        // Same title and marks exported tall before would have left its
        // vertical still under this exact name.
        await rm(stillPath(out), { force: true }).catch(() => undefined);
      } else {
        const voicePath = join(dir, "voice.wav");
        await prependStarter({
          main: body,
          title: art,
          voice: voicePath,
          voiceSeconds: await speak(voiceTitle, dir, voicePath, voiceName),
          out: partial,
        });
        await rename(partial, out);
        await saveStill(out);
        // The other direction: a wide export of this same name left a title
        // card that `applyThumbnail` would otherwise prefer over this
        // short's own starter screen.
        await rm(thumbPath(out), { force: true }).catch(() => undefined);
      }
```

`body` is the composite in the temp dir and `art` the title PNG path, both still present here (the route's `finally` sweeps `dir` afterwards).

- [ ] **Step 4: Add `saveTitleCard` beside `saveStill`**

```ts
/** Writes a wide export's thumbnail — the title card over the body's first
 *  frame — as the `.thumb.jpg` sidecar `applyThumbnail` already prefers.
 *
 *  Best-effort, like `saveStill`: the video is the product. Without the card
 *  a publish falls back to `firstFrame(…, "wide")`, the plain composite. */
async function saveTitleCard(body: string, title: string, video: string): Promise<void> {
  const card = thumbPath(video);
  try {
    await titleCard({ main: body, title, out: card });
  } catch (err) {
    console.warn(`vstack: could not save a title card beside ${video}:`, err);
    await rm(card, { force: true }).catch(() => undefined);
  }
}
```

In `applyThumbnail`'s doc comment, change "`thumbPath` is a name only `/api/stack` writes" to "`thumbPath` is written by `/api/stack`, `/api/lofi` and a wide `/api/export` — all three a picture meant as the thumbnail".

- [ ] **Step 5: Verify**

Run: `pnpm build` → passes.
Run: `pnpm test` → all pass (nothing tests the route; this guards the rest).

- [ ] **Step 6: Hand off**

Propose commit: `feat(export): wide branch — no starter, outro, title-card thumbnail`.

---

### Task 8: Framing UI, preview canvas and publish

**Files:**
- Modify: `src/api.ts:266-300`, `src/preview.ts`, `src/main.ts`, `src/style.css:935`

**Interfaces:**
- Consumes: everything above. `startPreview` gains a frame: `startPreview(canvas, video, frame: Size, cells, boxes, customs, still)`.
- Produces: no new exports.

DOM only — verified by hand in a real browser (Step 7). See CLAUDE.md "Environment notes for agents" about the in-app browser pane (`document.hidden`, 0×0 viewport) before reporting an app defect.

- [ ] **Step 1: `src/api.ts`**

In `exportClip`'s body type, make the two speech fields optional and say why:

```ts
  /** …existing doc… Omitted on a wide layout, which speaks nothing. */
  voiceTitle?: string;
  /** …existing doc… Omitted on a wide layout. */
  voice?: string;
```

Update `titlePng`'s doc: "The same title as a transparent PNG the size of the layout's frame".

- [ ] **Step 2: `src/preview.ts`**

- Import `type Size` from `./geometry.ts`; drop `OUTPUT`.
- Constants: keep `BAND_H = 820`; add `const WIDE_BAND_H = 860;` with a comment that it mirrors `server/starter.ts`'s `WIDE_BAND_H` (same `ponytail:` copy-across-the-line note as the other four).
- Delete the module-level `CROP_H`.
- `offscreen(frame: Size)` sizes its canvas from `frame`; `clipOutside(ctx, out, frame)` uses `frame.w/h`.
- `startPreview(canvas, video, frame: Size, cells, boxes, customs, still)`: `canvas.width = frame.w; canvas.height = frame.h;`, `const windows = cells.map((cell) => windowOf(cell, frame));`, every `OUTPUT` → `frame`, `const wide = frame.w > frame.h; const bandH = wide ? WIDE_BAND_H : BAND_H;` and use `bandH` where `BAND_H` was. `drawTitle(ctx, art, frame);`. Wrap the crop-guide block (`const y = …` through its `ctx.restore()`) in `if (!wide) { … }` with `const cropH = Math.round((frame.w * THUMB.h) / THUMB.w);` computed inside it, and a comment: "Wide has no guide: the whole frame IS the thumbnail, scaled to 1280x720 with nothing cropped."

- [ ] **Step 3: `src/main.ts` — framing mount and render**

- Imports: from `./layout.ts` add `DEFAULT_LAYOUT`, `DEFAULT_WIDE_LAYOUT`, `isWide`; from `./starter.ts` add `titleFits`; from `./defaults.ts` add `tagsFor`; from `./geometry.ts` drop `OUTPUT`.
- `ensureFraming`: `startPreview(canvasEl, videoEl, layout.frame, cells, currentBoxes, currentCustoms, currentStill);`.
- `render()` near line 4510, replace the `is-wide` toggle with:

```ts
  // Wide when the thing on the right is 16:9: a long-form or lofi render in
  // preview, or a short-journey cut framed on a wide layout — in framing AND
  // in its preview. The framing canvas is safe here only because
  // `style.css` scopes `object-fit: contain` to `.out.is-wide > video`.
  const wideCut = s.mode === "short" && isWide(resolveLayout(s.layoutId));
  outSlot.classList.toggle(
    "is-wide",
    (s.phase === "preview" && (s.mode !== "short" || wideCut)) || (s.phase === "framing" && wideCut),
  );
```

- [ ] **Step 4: `src/main.ts` — the framing bar**

Add before `renderLayoutPicker`:

```ts
/** Short or Long: which frame the export is. A switch to the other
 *  orientation lands on that side's default layout and clears the boxes AND
 *  the pieces — a tall piece's `out` rect is meaningless in a 1080-tall
 *  frame. Within one orientation the layout picker keeps pieces as before. */
function renderOrientation(currentId: string, busy: boolean): Node {
  const wide = isWide(resolveLayout(currentId));
  const pick = (label: string, toWide: boolean, hint: string) => {
    const b = el("button", { textContent: label, title: hint, disabled: busy });
    b.setAttribute("aria-pressed", String(wide === toWide));
    b.onclick = () => {
      if (wide === toWide) return;
      setState({
        layoutId: (toWide ? DEFAULT_WIDE_LAYOUT : DEFAULT_LAYOUT).id,
        boxes: [],
        customs: [],
        showThumb: false,
      });
      save();
    };
    return b;
  };
  const wrap = el(
    "div",
    { className: "layouts", ariaLabel: "Output shape" },
    pick("Short", false, "1080×1920 vertical short, with the starter screen"),
    pick("Long", true, "1920×1080 video — no starter screen, outro kept"),
  );
  wrap.setAttribute("role", "group");
  return wrap;
}
```

In `renderLayoutPicker`: `const wide = isWide(resolveLayout(currentId));` then `LAYOUTS.filter((layout) => isWide(layout) === wide).map(...)`; `className: wide ? "layout-pick is-wide" : "layout-pick"`; the four swatch percentages divide by `layout.frame.w` / `layout.frame.h` instead of `OUTPUT`.

In `renderFraming`:
- `const layout = resolveLayout(s.layoutId); const wide = isWide(layout);` near the top.
- The title input: `placeholder: wide ? "Title (required)" : "Starter screen title (required)"`, `title: wide ? "Names the file, drawn on the thumbnail, prefills the upload" : <existing>`, `ariaLabel: wide ? "Title" : "Starter screen title"`.
- After the title input:

```ts
  // Wide only: the title is a thumbnail there, and a title past the 120px
  // floor's three lines would be cut from it. Surfaced, never blocking —
  // toggled in place from oninput below, because the field writes quietly.
  const titleWarn = el("span", {
    className: "badge badge-warn",
    textContent: "too long for a readable thumbnail — shorten to ~75 characters",
    hidden: !wide || titleFits(s.starterTitle.trim(), layout.frame),
  });
```

(If `el`'s props object does not reflect `hidden` — check how `el` applies props in `src/main.ts` — set `titleWarn.hidden = …` on the line after construction instead.)

- `const long = !wide && keptLength(s) > SHORTS_MAX_S;` (both declarations of `long` in this function's scope — check there is one).
- The thumb button: `title: wide ? "Show the thumbnail this export will get" : <existing>`.
- In `title.oninput`, add: `titleWarn.hidden = !wide || titleFits(title.value.trim(), layout.frame);`.
- First bar row: `renderOrientation(s.layoutId, Boolean(s.busy)), renderLayoutPicker(s.layoutId, Boolean(s.busy)), addBox, …`.
- Third bar row:

```ts
    el(
      "div",
      { className: "bar-row" },
      title,
      // Wide speaks nothing, so the voice controls have nothing to do.
      ...(wide ? [titleWarn] : [voiceTitle, renderVoicePicker(s), tryVoice]),
      thumb,
      el("div", { className: "bar-end" }, refetch, back, download),
    ),
```

- [ ] **Step 5: `src/main.ts` — export and publish**

`doExport`:

```ts
  const wide = isWide(layout);
  // …
      titlePng: await renderTitleArt(starterTitle, layout.frame),
      // Wide has no starter screen, so nothing is spoken — and the server
      // does not read either field for a wide layout.
      ...(wide ? {} : { voiceTitle: s.voiceTitle.trim(), voice: currentVoice(s) }),
  // …remove the old voiceTitle and voice lines…
  // in setState after the export:
      ytTags: tagsFor(getState().ytTags, wide),
```

Publish (around line 1827):

```ts
        // `#shorts` is what classifies an upload as a Short: never on a
        // long-form or lofi render, and never on a cut framed wide.
        shorts: s.mode === "short" && !isWide(resolveLayout(s.layoutId)),
```

- [ ] **Step 6: `src/style.css`**

After the `.layout-pick` rule:

```css
/* A wide preset's swatch is the wide frame's shape. */
.layout-pick.is-wide {
  width: calc(var(--pick-w) * 16 / 9);
  height: var(--pick-w);
}
```

Confirm (no change expected) that the contain rule is `.out.is-wide > video { object-fit: contain; }` and nothing else under `.out.is-wide` sets `object-fit`.

- [ ] **Step 7: Verify in a real browser**

Run `pnpm build` (must pass), then `pnpm server` and `pnpm dev`, open `http://localhost:5173`, load a cached clip from the idle dropdown, and check each:

1. Framing shows `Short | Long`; Short is pressed; the picker lists the nine tall swatches.
2. Click Long: three wide swatches (wider than tall), `w-1` pressed; the canvas on the right is 16:9 and fills its box; the voice field, voice dropdown and Try are gone; the over-3-min badge is gone.
3. Click `w-2h` and `w-2x2`: one box per cell, crops draggable, composite updates.
4. `+ Box` twice: two pieces inside the 1920x1080 canvas; drag one into each corner — its ring sits on the frame margin; the tinted crop on the source follows a resize.
5. Click Short: back to `1-1`, pieces gone. Click Long again: pieces still gone, `w-1` default boxes.
6. In Long, `🖼 Thumbnail`: blurred band + title over the in-point; no dashed crop guide. Type a long title (~120 characters): the warning badge appears without a re-render; shorten it: the badge goes.
7. Export in Long: lands in preview, the video is 16:9 and ends on the letterboxed outro; `~/Desktop/vstack/` holds `<name>.mp4` and `<name>.thumb.jpg` (1280x720 title card), no vertical `<name>.jpg`. The tags field shows no `shorts`.
8. **Sidecar swap:** `← Back`, switch to Short without touching title or marks, export: same `<name>.mp4`, now a vertical `<name>.jpg`, and `<name>.thumb.jpg` is gone. Switch back to Long, export: `.thumb.jpg` back, `.jpg` gone.
9. Reload the tab in Long framing: it reopens in Long on the same layout with the same boxes.
10. A short in Short still exports exactly as before (starter screen, voice, outro, vertical `.jpg`), and its tags carry `shorts`.

- [ ] **Step 8: Hand off**

Propose commit: `feat(framing): Short/Long toggle, wide layouts, wide preview and publish`.

---

### Task 9: Remove the `OUTPUT` alias and update CLAUDE.md

**Files:**
- Modify: `src/geometry.ts`, every remaining `OUTPUT` reader (tests), `CLAUDE.md`

- [ ] **Step 1: Delete the alias**

Remove `export const OUTPUT` (and its comment) from `src/geometry.ts`.

Run: `grep -rn "OUTPUT" src server scripts` — every hit must be gone or a comment; replace code hits with `TALL` (tests) or the layout's `frame` (app code — there should be none left after Task 8). Update stale prose in doc comments that still says `OUTPUT.h / 2` (e.g. `server/ffmpeg.ts`'s `firstFrame` comment, `server/starter.ts`'s band comment) to "the frame's centre".

- [ ] **Step 2: Update `CLAUDE.md`**

- Spec list (first paragraph): after the script-reader sentence, add: "plus `docs/specs/2026-10-02-vstack-horizontal-short-design.md`, which supersedes nothing and adds a second OUTPUT SHAPE to the short journey: a layout now carries its `frame` (`TALL` 1080x1920 or `WIDE` 1920x1080), and a wide export skips the starter screen and the voice, keeps the outro (letterboxed by `appendOutro`), and writes a title-card `.thumb.jpg` (`titleCard`). No new `mode`, no new phase, no new request field."
- Architecture block: `src/geometry.ts` line add "`TALL`/`WIDE`"; `src/layout.ts` "twelve layout presets (nine tall, three wide), `isWide`, `DEFAULT_WIDE_LAYOUT`"; `server/longform.ts` add "`letterboxLegs`, `appendOutro` (the wide export's pass 2)"; `server/starter.ts` add "`screenFilter`/`WIDE_BAND_H`, `titleCard` (the wide thumbnail)"; `src/starter.ts` add "`titleRules`/`fitTitle` (the pure fit), `titleFits`"; `server/ffmpeg.ts` add "`pngSize`".
- Invariants, add one entry: "**Orientation is the layout's `frame`, and every frame-bounded function takes it with no default.** `OUTPUT` was deleted rather than aliased so the compiler found every reader. A default of `TALL` on `clampOut`/`isValidOut`/`windowOf`/`maskRgba`/… would make any forgotten call site silently tall — pieces clamped to 1920 high in a 1080-high frame. `restore` validates pieces against the restored layout's frame, and switching orientation clears both boxes and pieces."
- Invariants, add: "**A wide title has a 120px floor and the fit is pure.** `fitTitle` takes the measurer as a parameter so `src/starter.test.ts` can pin it in node; tall rules are fenced against a verbatim copy of the old loop. A title past the floor's three lines is surfaced by a badge in the framing bar, never shrunk below 120 and never blocking Export."
- Invariants, add: "**A same-name re-export in the other orientation sweeps the other sidecar.** `outName` ignores orientation. Tall removes `<name>.thumb.jpg` after its rename (or `applyThumbnail` would publish the wide card on a short); wide removes `<name>.jpg`."
- Update the stale sentence in "Gutters and rounded corners…": "`cellsOf` still tiles 1080×1920 exactly" → "`cellsOf` still tiles its layout's frame exactly".
- Update the `.out` gotcha: "The slot holds the framing canvas (always vertical)" → "The slot holds the framing canvas (vertical, or 16:9 on a wide layout)".
- Update the test count in `pnpm test`'s comment to the number the run in Step 3 reports.

- [ ] **Step 3: Full verification**

Run: `pnpm build` → passes.
Run: `pnpm test` → all pass; note the count and put it in CLAUDE.md.

- [ ] **Step 4: Hand off**

Propose commit: `refactor: drop OUTPUT; document the wide frame in CLAUDE.md`.
