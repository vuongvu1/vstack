# vstack Multi-Cell Layouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace vstack's fixed top/bottom crop pair with nine selectable layout presets that compose 2–4 crop regions into the same 1080×1920 output.

**Architecture:** A layout is a list of rows (height in output px, column count); cells are derived by `cellsOf`, so an exact tiling of 1080×1920 is structural rather than hand-maintained. Because cells now come in three shapes (9:8, 9:16, 9:4) and each crop must match its cell's aspect exactly, the hard-coded `BOX_RATIO` becomes a `ratio` parameter throughout `geometry.ts`. Composition moves from `vstack` to a single `xstack` driven by `cellsOf`.

**Tech Stack:** Vite + vanilla TS frontend, zero-dependency `node:http` backend shelling out to `yt-dlp`/`ffmpeg`/`ffprobe`, vitest (`environment: "node"`), `@radix-ui/colors` for all visual values.

**Spec:** `docs/specs/2026-08-21-vstack-layouts-design.md`

## Global Constraints

Copied verbatim from the spec and `CLAUDE.md`. Every task's requirements implicitly include this section.

- **"Stacked" means one above the other; "side by side" means left and right.** UI labels use those words, never "vertical"/"horizontal". Layout ids abbreviate as `v` (stacked) and `h` (side by side).
- **`1-1` must stay pixel-identical to what ships today.** It is the regression fence for the whole change.
- **Crop rects stay in source pixels with zero conversion.** `canvas.drawImage(video, sx,sy,sw,sh, …)` and ffmpeg's `crop=w:h:x:y` consume the *same numbers*. Cells add a *destination* in output space; they never touch the stored value. Never store normalised coordinates.
- **Box size stays height-driven.** Canonical form is integer `h` with `w = round(h * ratio)`. A width-driven round trip is not idempotent.
- **Crop rects stay plain integers, NOT even-rounded.**
- **`clampToBounds` slides, never shrinks.**
- **Geometry uses `/api/window`'s dimensions, never `/api/probe`'s.**
- **Never empty `sourceSlot` or `outSlot`**, and never remove or re-parent the `<iframe>`'s ancestors. Long-lived media is shown/hidden with the `hidden` property.
- **`/api/export` takes window bounds, never a file path.** `layoutId` is resolved by table lookup and never interpolated into a path or a shell argument.
- **No `enum`, `namespace`, `any`, default exports, barrel files, constructor parameter properties.** Node runs `server/*.ts` with type stripping, so non-erasable TS syntax is a boot crash. `tsconfig.json` has `erasableSyntaxOnly: true`.
- **No `console.log`/`.info`** — `.error`/`.warn` only.
- **`strict` and `noUncheckedIndexedAccess` are on:** indexing yields `T | undefined`. Guard with `?? fallback` or an explicit `throw`, never `!`.
- **`import type` for type-only imports; explicit `.ts` extensions on relative imports.**
- **Visual values come from the `@radix-ui/colors` custom properties imported in `src/style.css`.** Import the alpha scale alongside every solid one. Use the hand-rolled token layer (`--radius-*`, `--space-*`, `--shadow-*`, `--control-height`), not fresh literals.
- **`ponytail:` comments** mark deliberate simplifications and name the upgrade path.
- **Environment:** `Bash(git add)`, `Bash(git commit *)` and `Bash(rm *)` are deny-listed. Use `git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add/commit` and Node's `fs.rm` instead of shell `rm`.
- **Verification commands:** `pnpm test` (63 tests before this plan; the count grows) and `pnpm build` (`tsc && vite build`). Both must pass at every commit.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/layout.ts` | **new** — the nine presets, `cellsOf`, `ratioOf`, `defaultBoxes` | 1, 2 |
| `src/layout.test.ts` | **new** — exhaustive tiling tests | 1 |
| `src/geometry.ts` | pure rect math, now ratio-parameterised; loses `BOX_RATIO`, `HALF`, `defaultBoxes` | 2, 5 |
| `src/geometry.test.ts` | parametrised over the three real cell ratios | 2 |
| `server/ffmpeg.ts` | `buildFilter`/`assertBoxes`/`ExportOpts` take `layout` + `boxes`; single `xstack` | 3 |
| `server/ffmpeg.test.ts` | keeps the 2-cell pixel test, adds a 3-cell one | 3 |
| `server/index.ts` | `/api/export` reads `layoutId` + `boxes` | 3 |
| `src/api.ts` | export body type | 3 |
| `src/state.ts` | `layoutId` + `boxes[]`, legacy migration, save gate | 4 |
| `src/state.test.ts` | migration + N-box gate + per-cell-ratio restore | 4 |
| `src/preview.ts` | draws N cells | 5 |
| `src/editor.ts` | index-based boxes, N nodes, generalised z-order | 5 |
| `src/main.ts` | layout picker, `editorFor` remount guard | 3, 4, 5, 6 |
| `src/style.css` | picker recipes, per-index box colours | 6 |
| `CLAUDE.md`, `docs/specs/2026-08-20-vstack-design.md` | invariants and pointers | 7 |

---

### Task 1: The layout table

Pure data plus one derivation. Touches nothing else, so it lands green on its own.

**Files:**
- Create: `src/layout.ts`
- Create: `src/layout.test.ts`

**Interfaces:**
- Consumes: `OUTPUT` and `type Rect` from `src/geometry.ts` (both already exist, unchanged).
- Produces:
  - `type Row = { h: number; cols: number }`
  - `type Layout = { id: string; label: string; rows: Row[] }`
  - `const DEFAULT_LAYOUT: Layout` — the `1-1` layout as a real value, so no consumer needs a `?? fallback` for the default
  - `const DEFAULT_LAYOUT_ID: string`
  - `const LAYOUTS: readonly Layout[]` — 9 entries, `DEFAULT_LAYOUT` first
  - `function layoutById(id: string): Layout | null`
  - `function cellsOf(layout: Layout): Rect[]` — output-space, row-major
  - `function ratioOf(cell: Rect): number`

- [ ] **Step 1: Write the failing test**

Create `src/layout.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { OUTPUT } from "./geometry.ts";
import type { Rect } from "./geometry.ts";
import {
  DEFAULT_LAYOUT,
  DEFAULT_LAYOUT_ID,
  LAYOUTS,
  cellsOf,
  layoutById,
  ratioOf,
} from "./layout.ts";

/** `layoutById` returns `Layout | null` on purpose — an unknown id from
 *  storage or the wire must be representable. Tests know their ids exist, so
 *  they throw rather than reach for `!`, which the project bans. */
function byId(id: string) {
  const layout = layoutById(id);
  if (!layout) throw new Error(`test asked for unknown layout ${id}`);
  return layout;
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

describe("LAYOUTS", () => {
  it("has nine presets with unique ids", () => {
    expect(LAYOUTS).toHaveLength(9);
    expect(new Set(LAYOUTS.map((l) => l.id)).size).toBe(9);
  });

  it("exposes the default as a real value and as a resolvable id", () => {
    expect(DEFAULT_LAYOUT.id).toBe(DEFAULT_LAYOUT_ID);
    expect(byId(DEFAULT_LAYOUT_ID)).toBe(DEFAULT_LAYOUT);
    // 1-1 is the regression fence for the whole feature: it must stay first
    // so a stored record with no layoutId migrates onto today's behaviour.
    expect(DEFAULT_LAYOUT_ID).toBe("1-1");
  });

  it("labels say stacked / side by side, never vertical / horizontal", () => {
    // "vertical" is ambiguous for a split — it can name the divider or the
    // arrangement. The ids abbreviate; the labels must not.
    for (const l of LAYOUTS) {
      expect(l.label.toLowerCase()).not.toMatch(/vertical|horizontal/);
    }
  });

  it("has rows that fill the output height at full width", () => {
    for (const l of LAYOUTS) {
      expect(l.rows.reduce((n, r) => n + r.h, 0)).toBe(OUTPUT.h);
      for (const r of l.rows) {
        expect(Number.isInteger(r.h)).toBe(true);
        expect(r.cols).toBeGreaterThanOrEqual(1);
        expect(OUTPUT.w % r.cols).toBe(0);
      }
    }
  });

  it("returns null for an unknown id instead of throwing", () => {
    expect(layoutById("nope")).toBeNull();
    expect(layoutById("")).toBeNull();
  });
});

describe("cellsOf", () => {
  it("tiles the output frame exactly for every preset", () => {
    for (const l of LAYOUTS) {
      const cells = cellsOf(l);
      expect(cells.length).toBeGreaterThanOrEqual(2);
      expect(cells.length).toBeLessThanOrEqual(4);

      let area = 0;
      for (const c of cells) {
        for (const k of ["x", "y", "w", "h"] as const) {
          expect(Number.isInteger(c[k])).toBe(true);
        }
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.x + c.w).toBeLessThanOrEqual(OUTPUT.w);
        expect(c.y + c.h).toBeLessThanOrEqual(OUTPUT.h);
        area += c.w * c.h;
      }
      // Area sum + zero pairwise overlap + in-bounds together mean an exact
      // tiling: no seam, no double-covered pixel.
      expect(area).toBe(OUTPUT.w * OUTPUT.h);
      for (let i = 0; i < cells.length; i++) {
        for (let j = i + 1; j < cells.length; j++) {
          const a = cells[i];
          const b = cells[j];
          if (!a || !b) throw new Error("cellsOf returned a hole");
          expect(overlapArea(a, b)).toBe(0);
        }
      }
    }
  });

  it("is row-major: row by row, left to right", () => {
    expect(cellsOf(byId("2h-1"))).toEqual([
      { x: 0, y: 0, w: 540, h: 960 },
      { x: 540, y: 0, w: 540, h: 960 },
      { x: 0, y: 960, w: 1080, h: 960 },
    ]);
    expect(cellsOf(byId("2v-1"))).toEqual([
      { x: 0, y: 0, w: 1080, h: 480 },
      { x: 0, y: 480, w: 1080, h: 480 },
      { x: 0, y: 960, w: 1080, h: 960 },
    ]);
    expect(cellsOf(byId("2h-2v"))).toEqual([
      { x: 0, y: 0, w: 540, h: 960 },
      { x: 540, y: 0, w: 540, h: 960 },
      { x: 0, y: 960, w: 1080, h: 480 },
      { x: 0, y: 1440, w: 1080, h: 480 },
    ]);
  });

  it("reproduces today's two 1080x960 halves for 1-1", () => {
    expect(cellsOf(DEFAULT_LAYOUT)).toEqual([
      { x: 0, y: 0, w: 1080, h: 960 },
      { x: 0, y: 960, w: 1080, h: 960 },
    ]);
  });

  it("only ever produces the three documented cell shapes", () => {
    const shapes = new Set(LAYOUTS.flatMap((l) => cellsOf(l)).map((c) => `${c.w}x${c.h}`));
    expect([...shapes].sort()).toEqual(["1080x480", "1080x960", "540x960"]);
  });

  it("produces only even cell dimensions, so yuv420p is satisfiable", () => {
    for (const l of LAYOUTS) {
      for (const c of cellsOf(l)) {
        expect(c.w % 2).toBe(0);
        expect(c.h % 2).toBe(0);
      }
    }
  });
});

describe("ratioOf", () => {
  it("gives the three cell ratios", () => {
    expect(ratioOf({ x: 0, y: 0, w: 1080, h: 960 })).toBeCloseTo(1.125);
    expect(ratioOf({ x: 0, y: 0, w: 540, h: 960 })).toBeCloseTo(0.5625);
    expect(ratioOf({ x: 0, y: 0, w: 1080, h: 480 })).toBeCloseTo(2.25);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/layout.test.ts`
Expected: FAIL — `Failed to resolve import "./layout.ts"`.

- [ ] **Step 3: Write the implementation**

Create `src/layout.ts`:

```ts
import { OUTPUT } from "./geometry.ts";
import type { Rect, Size } from "./geometry.ts";

/** One row of a layout: the full output width, `h` output px tall, split
 *  into `cols` equal cells.
 *
 *  Layouts are authored as rows and cells are *derived* (see `cellsOf`),
 *  never listed. Row heights sum to OUTPUT.h and OUTPUT.w is divisible by
 *  every `cols`, so an exact tiling of the frame is structural: a
 *  hand-written cell list can express a 4px seam or an overlap, a row list
 *  cannot. That matters because a seam is a silent defect — it survives
 *  preview and only shows up as a black line in an exported short. */
export type Row = { h: number; cols: number };

export type Layout = { id: string; label: string; rows: Row[] };

/** Today's layout, and the regression fence for this whole feature: its
 *  output must stay pixel-identical to what shipped before layouts existed.
 *
 *  Exported as a value, not just an id, so consumers needing "the default"
 *  don't have to unwrap `layoutById`'s null. */
export const DEFAULT_LAYOUT: Layout = {
  id: "1-1",
  label: "1 top + 1 bottom",
  rows: [
    { h: 960, cols: 1 },
    { h: 960, cols: 1 },
  ],
};

export const DEFAULT_LAYOUT_ID = DEFAULT_LAYOUT.id;

/** In an id, `v` means stacked (one above the other) and `h` means side by
 *  side. The plain word "vertical" is ambiguous for a split — it can name
 *  the divider or the arrangement — so only the ids abbreviate; the labels
 *  users read spell it out. */
export const LAYOUTS: readonly Layout[] = [
  DEFAULT_LAYOUT,
  {
    id: "2v-1",
    label: "2 top stacked + 1 bottom",
    rows: [
      { h: 480, cols: 1 },
      { h: 480, cols: 1 },
      { h: 960, cols: 1 },
    ],
  },
  {
    id: "2h-1",
    label: "2 top side by side + 1 bottom",
    rows: [
      { h: 960, cols: 2 },
      { h: 960, cols: 1 },
    ],
  },
  {
    id: "1-2v",
    label: "1 top + 2 bottom stacked",
    rows: [
      { h: 960, cols: 1 },
      { h: 480, cols: 1 },
      { h: 480, cols: 1 },
    ],
  },
  {
    id: "1-2h",
    label: "1 top + 2 bottom side by side",
    rows: [
      { h: 960, cols: 1 },
      { h: 960, cols: 2 },
    ],
  },
  {
    id: "2v-2v",
    label: "2 top + 2 bottom, all stacked",
    rows: [
      { h: 480, cols: 1 },
      { h: 480, cols: 1 },
      { h: 480, cols: 1 },
      { h: 480, cols: 1 },
    ],
  },
  {
    id: "2h-2h",
    label: "2 top + 2 bottom side by side",
    rows: [
      { h: 960, cols: 2 },
      { h: 960, cols: 2 },
    ],
  },
  {
    id: "2h-2v",
    label: "2 top side by side + 2 bottom stacked",
    rows: [
      { h: 960, cols: 2 },
      { h: 480, cols: 1 },
      { h: 480, cols: 1 },
    ],
  },
  {
    id: "2v-2h",
    label: "2 top stacked + 2 bottom side by side",
    rows: [
      { h: 480, cols: 1 },
      { h: 480, cols: 1 },
      { h: 960, cols: 2 },
    ],
  },
];

/** A table lookup, deliberately: `layoutId` arrives from localStorage and
 *  from an untrusted request body, and resolving it this way means it is
 *  never interpolated into a filter string, a path, or a subprocess
 *  argument. Returns null for an unknown id so callers must decide what to
 *  do rather than inherit a wrong layout. */
export function layoutById(id: string): Layout | null {
  return LAYOUTS.find((l) => l.id === id) ?? null;
}

/** Output-space cells in reading order: row by row, left to right.
 *
 *  This order is load-bearing in four places, and they must agree: it is the
 *  order boxes are stored in, the order the editor numbers them, the order
 *  the canvas preview draws them, and the order `xstack`'s `layout=` lists
 *  their positions. */
export function cellsOf(layout: Layout): Rect[] {
  const cells: Rect[] = [];
  let y = 0;
  for (const row of layout.rows) {
    const w = OUTPUT.w / row.cols;
    for (let c = 0; c < row.cols; c++) cells.push({ x: c * w, y, w, h: row.h });
    y += row.h;
  }
  return cells;
}

/** A cell's aspect ratio — exactly what its crop box's `w / h` must be.
 *  Only three values occur across all nine layouts: 1.125 (9:8, 1080x960),
 *  0.5625 (9:16, 540x960) and 2.25 (9:4, 1080x480). */
export function ratioOf(cell: Rect): number {
  return cell.w / cell.h;
}
```

Note: the `Size` import is unused until Task 2 adds `defaultBoxes`. Leave it out for now and add it in Task 2 — `tsc` with the project's settings will flag an unused import.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/layout.test.ts`
Expected: PASS, 12 tests.

Run: `pnpm test && pnpm build`
Expected: PASS — the pre-existing 63 tests are untouched, and `tsc` is clean.

- [ ] **Step 5: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/layout.ts src/layout.test.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: add the layout preset table

Nine presets authored as rows (height in output px, column count) with
cells derived by cellsOf, so an exact tiling of 1080x1920 is structural
rather than hand-maintained -- a seam would be a silent defect that
survives preview and only shows as a black line in an export.

Nothing consumes this yet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Ratio-parameterise `geometry.ts`

The load-bearing task. `BOX_RATIO` disappears and every box constructor gains a `ratio`. `defaultBoxes` moves to `layout.ts` — it is the one constructor that needs to know about layouts, and `geometry.ts` importing `Layout` would make the dependency a cycle.

Behaviour must be **unchanged** at the end of this task: every call site passes the `1-1` cell ratios, so the app still frames two 9:8 boxes. Only the plumbing moves.

**Files:**
- Modify: `src/geometry.ts` (`MIN_BOX_H`, `BOX_RATIO`, `effectiveMinH`, `maxBox`, `boxFromHeight`, `resizeFromCorner`, `isValidBox`, `defaultBoxes`)
- Modify: `src/layout.ts` (append `defaultBoxes`)
- Modify: `src/geometry.test.ts` (parametrise over the three ratios)
- Modify: `src/layout.test.ts` (add `defaultBoxes` tests)
- Modify: `src/editor.ts` (pass a ratio into `resizeFromCorner`)
- Modify: `src/state.ts` (pass a ratio into `isValidBox`)
- Modify: `src/main.ts` (supply ratios; use the moved `defaultBoxes`)
- Modify: `server/ffmpeg.ts` (pass a ratio into `isValidBox`)

**Interfaces:**
- Consumes: `DEFAULT_LAYOUT`, `cellsOf`, `ratioOf` from Task 1.
- Produces:
  - `const MIN_BOX_SIDE = 142` (replaces `MIN_BOX_H`)
  - `maxBox(source: Size, ratio: number): Size`
  - `boxFromHeight(h: number, source: Size, ratio: number): Size`
  - `resizeFromCorner(rect: Rect, corner: Corner, dx: number, dy: number, source: Size, ratio: number): Rect`
  - `isValidBox(rect: Rect, source: Size, ratio: number): boolean`
  - `defaultBoxes(source: Size, layout: Layout): Rect[]` — **in `src/layout.ts`**
  - `BOX_RATIO` is **deleted**. `HALF` survives this task (Task 5 removes its last consumer).
  - `mountEditor` opts gain `ratios: () => number[]`.

- [ ] **Step 1: Write the failing tests — the fractional-floor trap first**

This is the subtle one, so it goes in before anything else. Add to `src/geometry.test.ts` (the full parametrised rewrite of the file follows in Step 3; add just this block now so the trap is caught before the implementation exists):

```ts
describe("effectiveMinH via boxFromHeight — the fractional floor", () => {
  it("produces a box isValidBox accepts at the smallest size, every ratio", () => {
    // The trap: the min-side floor is MIN_BOX_SIDE / ratio, which is
    // FRACTIONAL for a tall cell -- 142 / 0.5625 = 252.444. boxFromHeight
    // rounds its clamped height, so a floor left fractional yields h = 252
    // while isValidBox compares against 252.444 and rejects it: the
    // validator refuses its own constructor's output. The floor has to be
    // an integer, and it has to be the same integer on both sides.
    // Verified: with a fractional floor this assertion fails at r = 0.5625
    // and passes at 1.125 and 2.25, which is exactly the kind of
    // one-ratio-only breakage that would slip through a 9:8-shaped test.
    for (const ratio of RATIOS) {
      for (const s of SOURCES) {
        const smallest = { x: 0, y: 0, ...boxFromHeight(1, s, ratio) };
        expect(isValidBox(smallest, s, ratio)).toBe(true);
      }
    }
  });

  it("leaves the 9:8 floor at exactly MIN_BOX_SIDE", () => {
    // max(142, 142 / 1.125) = max(142, 126.2) = 142. Today's behaviour must
    // not move by a pixel.
    expect(boxFromHeight(1, HD, 1.125).h).toBe(MIN_BOX_SIDE);
  });

  it("raises the floor for a tall cell so the box stays grabbable", () => {
    // Height-only, a 9:16 box would floor at 142x80 -- too narrow to hit
    // its own corner handles.
    const b = boxFromHeight(1, HD, 0.5625);
    expect(b.h).toBe(253);
    expect(b.w).toBe(142);
  });

  it("keeps the floor at MIN_BOX_SIDE for a wide cell", () => {
    // max(142, 142 / 2.25) = max(142, 63.1) = 142.
    const b = boxFromHeight(1, HD, 2.25);
    expect(b.h).toBe(MIN_BOX_SIDE);
    expect(b.w).toBe(320);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/geometry.test.ts`
Expected: FAIL — `MIN_BOX_SIDE` and `RATIOS` are not defined, and `boxFromHeight` takes two arguments.

- [ ] **Step 3: Rewrite `src/geometry.test.ts` parametrised over the three real ratios**

Replace the file's header and the `maxBox`/`boxFromHeight`/`resizeFromCorner`/`defaultBoxes`/`isValidBox`/tiny-source blocks. The exact 9:8 numbers stay verbatim — they are the regression fence.

```ts
import { describe, expect, it } from "vitest";
import {
  MIN_BOX_SIDE,
  boxFromHeight,
  clampToBounds,
  displayScale,
  fromDisplay,
  isValidBox,
  maxBox,
  moveBy,
  resizeFromCorner,
  toDisplay,
} from "./geometry.ts";
import type { Corner, Rect, Size } from "./geometry.ts";

const HD: Size = { w: 1920, h: 1080 };
const SD: Size = { w: 1280, h: 720 };
const SQUARE: Size = { w: 1000, h: 1000 };
const TALL: Size = { w: 720, h: 1280 };
const SOURCES = [HD, SD, SQUARE, TALL];
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

/** The only three cell shapes any layout produces: 1080x960 (9:8),
 *  540x960 (9:16) and 1080x480 (9:4). Asserted exhaustive by
 *  layout.test.ts, so parametrising on them here covers every real case. */
const RATIOS = [1.125, 0.5625, 2.25];

describe("maxBox", () => {
  it("locks the ratio exactly and fits inside every source, every ratio", () => {
    for (const ratio of RATIOS) {
      for (const s of SOURCES) {
        const b = maxBox(s, ratio);
        expect(b.w).toBe(Math.round(b.h * ratio));
        expect(b.w).toBeLessThanOrEqual(s.w);
        expect(b.h).toBeLessThanOrEqual(s.h);
      }
    }
  });

  it("fills the limiting dimension of a 16:9 source at 9:8", () => {
    // 1080 * 9/8 = 1215, which fits in 1920 — so height is the limit.
    expect(maxBox(HD, 1.125)).toEqual({ w: 1215, h: 1080 });
    expect(maxBox(SD, 1.125)).toEqual({ w: 810, h: 720 });
  });

  it("is limited by width on a square or tall source at 9:8", () => {
    // 1000 / 1.125 = 888.89 -> 888
    expect(maxBox(SQUARE, 1.125)).toEqual({ w: 999, h: 888 });
    // 720 / 1.125 = 640 exactly
    expect(maxBox(TALL, 1.125)).toEqual({ w: 720, h: 640 });
  });

  it("is height-limited for a tall cell and width-limited for a wide one", () => {
    // 9:16 in 16:9: the source's full height fits, width is what's spare.
    expect(maxBox(HD, 0.5625)).toEqual({ w: 608, h: 1080 });
    // 9:4 in 16:9: 1920 / 2.25 = 853.33 -> 853, so width is the limit.
    expect(maxBox(HD, 2.25)).toEqual({ w: 1919, h: 853 });
  });
});

describe("boxFromHeight", () => {
  it("locks aspect exactly, every ratio", () => {
    for (const ratio of RATIOS) {
      for (const s of SOURCES) {
        for (const h of [MIN_BOX_SIDE, 200, 501, 888, 10_000]) {
          const b = boxFromHeight(h, s, ratio);
          expect(b.w).toBe(Math.round(b.h * ratio));
        }
      }
    }
  });

  it("clamps to maxBox above", () => {
    for (const ratio of RATIOS) {
      expect(boxFromHeight(99_999, HD, ratio)).toEqual(maxBox(HD, ratio));
    }
  });

  it("is idempotent — re-snapping never shrinks the box, every ratio", () => {
    // The whole reason size is height-driven: a width-driven round trip
    // loses a pixel per call, so a box re-snapped on every drag frame
    // would visibly shrink.
    for (const ratio of RATIOS) {
      for (const s of SOURCES) {
        let b = boxFromHeight(500, s, ratio);
        for (let i = 0; i < 20; i++) {
          const next = boxFromHeight(b.h, s, ratio);
          expect(next).toEqual(b);
          b = next;
        }
      }
    }
  });

  it("returns integers", () => {
    for (const ratio of RATIOS) {
      const b = boxFromHeight(501, HD, ratio);
      expect(Number.isInteger(b.w)).toBe(true);
      expect(Number.isInteger(b.h)).toBe(true);
    }
  });
});

describe("clampToBounds", () => {
  it("slides an out-of-bounds rect back in without resizing it", () => {
    for (const ratio of RATIOS) {
      const size = boxFromHeight(400, HD, ratio);
      const cases: [number, number][] = [[-500, -500], [9999, 9999], [-1, 500], [1900, -3]];
      for (const [x, y] of cases) {
        const r = clampToBounds({ x, y, ...size }, HD);
        expect(r.w).toBe(size.w); // never shrinks — shrinking breaks the lock
        expect(r.h).toBe(size.h);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(HD.w);
        expect(r.y + r.h).toBeLessThanOrEqual(HD.h);
      }
    }
  });

  it("pins a max-size box at every edge without violating bounds", () => {
    for (const ratio of RATIOS) {
      const size = maxBox(HD, ratio);
      const r = clampToBounds({ x: -9999, y: -9999, ...size }, HD);
      expect(r).toEqual({ x: 0, y: 0, ...size });
    }
  });
});

describe("moveBy", () => {
  it("keeps the box valid for arbitrary drags, every ratio", () => {
    for (const ratio of RATIOS) {
      let r = { x: 100, y: 100, ...boxFromHeight(400, HD, ratio) };
      const drags: [number, number][] = [[50, 50], [-9999, 0], [0, 9999], [777, -333]];
      for (const [dx, dy] of drags) {
        r = moveBy(r, dx, dy, HD);
        expect(isValidBox(r, HD, ratio)).toBe(true);
      }
    }
  });
});

describe("resizeFromCorner", () => {
  it("keeps the opposite corner fixed while growing", () => {
    const start = { x: 400, y: 300, ...boxFromHeight(400, HD, 1.125) };
    // Dragging "se" outward must leave the nw corner where it was.
    const grown = resizeFromCorner(start, "se", 200, 200, HD, 1.125);
    expect(grown.x).toBe(start.x);
    expect(grown.y).toBe(start.y);
    expect(grown.h).toBeGreaterThan(start.h);
  });

  it("keeps the se corner fixed when dragging nw", () => {
    const start = { x: 400, y: 300, ...boxFromHeight(400, HD, 1.125) };
    const grown = resizeFromCorner(start, "nw", -100, -100, HD, 1.125);
    expect(grown.x + grown.w).toBe(start.x + start.w);
    expect(grown.y + grown.h).toBe(start.y + start.h);
  });

  it("produces a valid box from every corner, source, ratio, huge drags", () => {
    for (const ratio of RATIOS) {
      for (const s of SOURCES) {
        for (const c of CORNERS) {
          const start = { x: 10, y: 10, ...boxFromHeight(300, s, ratio) };
          for (const d of [-9999, -50, 0, 50, 9999]) {
            expect(isValidBox(resizeFromCorner(start, c, d, d, s, ratio), s, ratio)).toBe(true);
            expect(isValidBox(resizeFromCorner(start, c, d, -d, s, ratio), s, ratio)).toBe(true);
          }
        }
      }
    }
  });

  it("never shrinks below the effective floor", () => {
    const start = { x: 500, y: 400, ...boxFromHeight(300, HD, 1.125) };
    expect(resizeFromCorner(start, "se", -9999, -9999, HD, 1.125).h).toBe(MIN_BOX_SIDE);
  });
});

describe("display conversion", () => {
  it("round-trips within a pixel", () => {
    const scale = displayScale(HD, 960);
    expect(scale).toBeCloseTo(0.5);
    const r = { x: 400, y: 300, ...boxFromHeight(600, HD, 1.125) };
    const back = fromDisplay(toDisplay(r, scale), scale);
    for (const k of ["x", "y", "w", "h"] as const) {
      expect(Math.abs(back[k] - r[k])).toBeLessThanOrEqual(1);
    }
  });
});

describe("isValidBox", () => {
  it("rejects a non-integer rect", () => {
    expect(isValidBox({ x: 0.5, y: 0, w: 1215, h: 1080 }, HD, 1.125)).toBe(false);
  });

  it("rejects a rect off the aspect lock", () => {
    expect(isValidBox({ x: 0, y: 0, w: 1200, h: 1080 }, HD, 1.125)).toBe(false);
  });

  it("rejects a 9:8 rect measured against a 9:16 cell, and vice versa", () => {
    // The new silent-failure mode this feature introduces: a legal box for
    // the wrong cell. A 1215x1080 box is perfect 9:8 and perfectly in
    // bounds, and would preview and export as a stretched cell if the
    // validator ignored which cell it belongs to.
    const nineEight = { x: 0, y: 0, w: 1215, h: 1080 };
    expect(isValidBox(nineEight, HD, 1.125)).toBe(true);
    expect(isValidBox(nineEight, HD, 0.5625)).toBe(false);
    expect(isValidBox(nineEight, HD, 2.25)).toBe(false);
  });

  it("rejects a rect hanging over an edge", () => {
    expect(isValidBox({ x: 800, y: 0, w: 1215, h: 1080 }, HD, 1.125)).toBe(false);
  });

  it("rejects a rect below the effective floor", () => {
    const h = MIN_BOX_SIDE - 1;
    expect(isValidBox({ x: 0, y: 0, w: Math.round(h * 1.125), h }, HD, 1.125)).toBe(false);
  });

  it("rejects a missing rect instead of throwing", () => {
    const missing = undefined as unknown as Rect;
    expect(() => isValidBox(missing, HD, 1.125)).not.toThrow();
    expect(isValidBox(missing, HD, 1.125)).toBe(false);
    const nulled = null as unknown as Rect;
    expect(isValidBox(nulled, HD, 1.125)).toBe(false);
  });
});

describe("sources too small for MIN_BOX_SIDE", () => {
  it("still produces boxes isValidBox accepts, every ratio", () => {
    const tiny: Size[] = [
      { w: 100, h: 100 },
      { w: 64, h: 64 },
      { w: 320, h: 40 },
      { w: 40, h: 320 },
    ];
    for (const ratio of RATIOS) {
      for (const s of tiny) {
        // Asking for an impossibly small box must still yield a legal one.
        expect(isValidBox({ x: 0, y: 0, ...boxFromHeight(1, s, ratio) }, s, ratio)).toBe(true);
        expect(isValidBox({ x: 0, y: 0, ...maxBox(s, ratio) }, s, ratio)).toBe(true);
      }
    }
  });
});
```

Also paste in the `describe("effectiveMinH via boxFromHeight — the fractional floor")` block from Step 1 (it depends on `RATIOS`, `SOURCES`, `HD` and `MIN_BOX_SIDE`, all defined above).

The old `describe("defaultBoxes")` and the `defaultBoxes` assertions inside `describe("isValidBox")` and the tiny-source block are **removed from this file** — `defaultBoxes` now lives in `layout.ts` and is tested there in Step 6.

- [ ] **Step 4: Rewrite the affected parts of `src/geometry.ts`**

Delete `BOX_RATIO`. Keep `OUTPUT` and `HALF` (Task 5 removes `HALF`'s last consumer). Replace `MIN_BOX_H`, `effectiveMinH`, `maxBox`, `boxFromHeight`, `resizeFromCorner`, `isValidBox`, and delete `defaultBoxes`:

```ts
/** Source px, applied to the box's *shorter* axis. 142 * 9/8 = 160 wide at
 *  9:8 — small enough to be useful, large enough that a box can still be
 *  grabbed and dragged.
 *
 *  Renamed from MIN_BOX_H because a height-only floor stopped being enough
 *  once cells came in three shapes: a 9:16 cell floored at h = 142 is only
 *  80px wide, too narrow to hit its own corner handles. */
export const MIN_BOX_SIDE = 142;

/** MIN_BOX_SIDE is the preferred floor on both axes, so for a cell narrower
 *  than it is tall the height floor has to rise to keep the width legal. A
 *  source too small to contain it cannot honour it — the effective floor is
 *  whichever is smaller. Both boxFromHeight and isValidBox read this, so the
 *  validator can never reject what the constructors produce.
 *
 *  Math.ceil is load-bearing, not cosmetic — what matters is that the floor
 *  is an INTEGER. MIN_BOX_SIDE / ratio is fractional for a tall cell
 *  (142 / 0.5625 = 252.444) and boxFromHeight *rounds* its clamped height,
 *  so leaving the floor fractional makes the smallest constructible box
 *  h = 252 while isValidBox compares it against 252.444 and rejects it: the
 *  validator refuses its own constructor's output, at 9:16 only. An integer
 *  floor is also what makes boxFromHeight's round-after-clamp unable to
 *  escape the range at all. Ceil over round because a floor should never
 *  round *below* the minimum it names. */
function effectiveMinH(source: Size, ratio: number): number {
  const floor = Math.ceil(Math.max(MIN_BOX_SIDE, MIN_BOX_SIDE / ratio));
  return Math.min(floor, maxBox(source, ratio).h);
}

/** Largest box of the given aspect that fits. Height is derived first,
 *  because deriving width first can round up past the source edge. */
export function maxBox(source: Size, ratio: number): Size {
  const h = Math.floor(Math.min(source.h, source.w / ratio));
  return { w: Math.round(h * ratio), h };
}

/** Canonical box construction: integer height, width derived exactly.
 *  `ratio` is the target cell's w/h — 1.125, 0.5625 or 2.25 (see
 *  layout.ts's ratioOf). */
export function boxFromHeight(h: number, source: Size, ratio: number): Size {
  const height = Math.round(clamp(h, effectiveMinH(source, ratio), maxBox(source, ratio).h));
  return { w: Math.round(height * ratio), h: height };
}
```

`resizeFromCorner` gains a trailing `ratio: number` parameter and threads it through — the two internal uses become:

```ts
  const wantH = Math.max(0, north ? anchorY - draggedY : draggedY - anchorY);

  const size = boxFromHeight(Math.max(wantH, wantW / ratio), source, ratio);
```

`isValidBox` gains a trailing `ratio: number` and its aspect check becomes `rect.w === Math.round(rect.h * ratio)`, with `effectiveMinH(source, ratio)`:

```ts
/** One definition of a legal rect, shared by the client editor and the
 *  server's pre-ffmpeg validation. `ratio` is the ratio of the *cell this
 *  box feeds*, which is why it is a parameter and not a constant: a box can
 *  be a flawless 9:8 rect and still be illegal for a 540x960 cell. */
export function isValidBox(rect: Rect, source: Size, ratio: number): boolean {
  // Guarded because this validates values arriving from untrusted JSON at
  // runtime, whatever the parameter type claims at compile time.
  if (typeof rect !== "object" || rect === null) return false;
  const ints = [rect.x, rect.y, rect.w, rect.h].every(Number.isInteger);
  return (
    ints &&
    rect.w === Math.round(rect.h * ratio) &&
    rect.h >= effectiveMinH(source, ratio) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.w <= source.w &&
    rect.y + rect.h <= source.h
  );
}
```

- [ ] **Step 5: Run the geometry tests to verify they pass**

Run: `pnpm vitest run src/geometry.test.ts`
Expected: PASS. The rest of the suite and `tsc` are still broken — call sites come next.

- [ ] **Step 6: Write the failing `defaultBoxes` test in `src/layout.test.ts`**

Append to `src/layout.test.ts` (extend the existing import to add `defaultBoxes`, and import `isValidBox`/`maxBox` from `./geometry.ts`):

```ts
describe("defaultBoxes", () => {
  const SOURCES: Size[] = [
    { w: 1920, h: 1080 },
    { w: 1280, h: 720 },
    { w: 1000, h: 1000 },
    { w: 720, h: 1280 },
    { w: 100, h: 100 },
  ];

  it("reproduces today's exact left/right pin for 1-1", () => {
    // The regression fence. Before layouts existed, defaultBoxes put both
    // halves at max size, top pinned left and bottom pinned right, both
    // vertically centred — one drag from the facecam case.
    for (const s of SOURCES) {
      const boxes = defaultBoxes(s, DEFAULT_LAYOUT);
      const size = maxBox(s, 1.125);
      const y = Math.round((s.h - size.h) / 2);
      expect(boxes).toEqual([
        { x: 0, y, ...size },
        { x: s.w - size.w, y, ...size },
      ]);
    }
  });

  it("returns one box per cell, each valid against its own cell ratio", () => {
    for (const l of LAYOUTS) {
      const cells = cellsOf(l);
      for (const s of SOURCES) {
        const boxes = defaultBoxes(s, l);
        expect(boxes).toHaveLength(cells.length);
        cells.forEach((cell, i) => {
          const box = boxes[i];
          if (!box) throw new Error("defaultBoxes returned a hole");
          expect(isValidBox(box, s, ratioOf(cell))).toBe(true);
        });
      }
    }
  });

  it("gives every box the maximum size for its cell", () => {
    for (const l of LAYOUTS) {
      const cells = cellsOf(l);
      const s: Size = { w: 1920, h: 1080 };
      const boxes = defaultBoxes(s, l);
      cells.forEach((cell, i) => {
        expect(boxes[i]).toMatchObject(maxBox(s, ratioOf(cell)));
      });
    }
  });

  it("does not stack boxes of the same shape on top of each other", () => {
    // Boxes are grouped by cell ratio and each group spreads along whichever
    // source axis has slack for that group's box size. A single global
    // spread axis would be wrong for one group or the other in the mixed
    // layouts, and spreading 9:4 boxes on x — where they are already as wide
    // as the source — would leave them all at x = 0, perfectly coincident.
    const s: Size = { w: 1920, h: 1080 };
    for (const l of LAYOUTS) {
      const cells = cellsOf(l);
      const boxes = defaultBoxes(s, l);
      for (let i = 0; i < cells.length; i++) {
        for (let j = i + 1; j < cells.length; j++) {
          const ci = cells[i];
          const cj = cells[j];
          const bi = boxes[i];
          const bj = boxes[j];
          if (!ci || !cj || !bi || !bj) throw new Error("hole");
          if (ratioOf(ci) !== ratioOf(cj)) continue; // different groups may overlap
          expect(`${bi.x},${bi.y}`).not.toBe(`${bj.x},${bj.y}`);
        }
      }
    }
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm vitest run src/layout.test.ts`
Expected: FAIL — `defaultBoxes` is not exported from `./layout.ts`.

- [ ] **Step 8: Append `defaultBoxes` to `src/layout.ts`**

Add `Size` to the type import (`import type { Rect, Size } from "./geometry.ts";`) and `clampToBounds, maxBox` to the value import from `./geometry.ts`:

```ts
/** One box per cell, each at the maximum size its cell's ratio allows.
 *
 *  Boxes are grouped by cell ratio and each group is spread independently,
 *  along whichever source axis has more slack for that group's box size, and
 *  centred on the other. Grouping is what makes this well-defined for the
 *  mixed layouts: 2h-2v holds two 540x960 cells (tall, x slack) and two
 *  1080x480 cells (wide, y slack), and one global spread axis would be wrong
 *  for one pair or the other. Boxes from *different* groups may overlap,
 *  which is harmless — different shapes, so their handles never coincide.
 *
 *  For 1-1 on a 16:9 source this is a single group of two, computing x = 0
 *  and x = source.w - w with y centred: bit-identical to the left/right pin
 *  that shipped before layouts existed, which frames a two-speaker wide shot
 *  correctly with zero clicks and is one drag from the facecam case. */
export function defaultBoxes(source: Size, layout: Layout): Rect[] {
  const cells = cellsOf(layout);
  const boxes: Rect[] = [];

  // Index positions within each ratio group before placing anything, so a
  // group's spread depends only on its own membership and not on where its
  // cells happen to fall in reading order.
  const groups = new Map<number, number[]>();
  cells.forEach((cell, i) => {
    const ratio = ratioOf(cell);
    const members = groups.get(ratio) ?? [];
    members.push(i);
    groups.set(ratio, members);
  });

  for (const [ratio, members] of groups) {
    const size = maxBox(source, ratio);
    const slackX = source.w - size.w;
    const slackY = source.h - size.h;
    // x wins an exact tie, which is what keeps 1-1 on a 16:9 source (where
    // slackY is 0) spreading horizontally as it always has.
    const spreadOnX = slackX >= slackY;
    const slack = spreadOnX ? slackX : slackY;
    const centred = Math.round((spreadOnX ? slackY : slackX) / 2);

    members.forEach((cellIndex, i) => {
      const along = members.length === 1
        ? Math.round(slack / 2)
        : Math.round((i * slack) / (members.length - 1));
      const rect = spreadOnX
        ? { x: along, y: centred, ...size }
        : { x: centred, y: along, ...size };
      boxes[cellIndex] = clampToBounds(rect, source);
    });
  }

  return boxes;
}
```

- [ ] **Step 9: Run the layout tests to verify they pass**

Run: `pnpm vitest run src/layout.test.ts`
Expected: PASS.

- [ ] **Step 10: Update the four call sites so the app still builds and behaves identically**

**`src/editor.ts`** — `mountEditor` opts gain `ratios: () => number[]`, and the drag path reads the dragged box's ratio:

```ts
export function mountEditor(opts: {
  host: HTMLElement;
  media: HTMLVideoElement;
  source: () => Size;
  boxes: () => { top: Rect; bottom: Rect };
  /** Parallel to the layout's cells: index 0 is the first cell. Task 5
   *  turns `Which` into that same index; for now 0 is top, 1 is bottom. */
  ratios: () => number[];
  onChange(which: Which, rect: Rect): void;
  onCommit(): void;
}): () => void {
```

and inside the `pointermove` handler:

```ts
    const source = opts.source();
    // A layout always has at least two cells, so this index is always
    // present; `?? 1.125` is only here because noUncheckedIndexedAccess
    // requires a value, and 9:8 is the shape that existed before layouts.
    const ratio = opts.ratios()[drag.which === "top" ? 0 : 1] ?? 1.125;
    const next =
      drag.corner === null
        ? moveBy(drag.startRect, dx, dy, source)
        : resizeFromCorner(drag.startRect, drag.corner, dx, dy, source, ratio);
```

**`src/state.ts`** — `restore`'s `validBox` needs a ratio. Add the import and thread the `1-1` cell ratios (Task 4 generalises this):

```ts
import { isValidBox } from "./geometry.ts";
import { DEFAULT_LAYOUT, cellsOf, ratioOf } from "./layout.ts";
```

```ts
  const cells = cellsOf(DEFAULT_LAYOUT);
  const validBox = (box: Rect | null, cellIndex: number): Rect | null => {
    const cell = cells[cellIndex];
    if (source === null || !sameSource || box === null || cell === undefined) return null;
    return isValidBox(box, source, ratioOf(cell)) ? box : null;
  };
  return {
    start: Number.isFinite(s.start) ? s.start : initial.start,
    end: Number.isFinite(s.end) ? s.end : initial.end,
    boxTop: validBox(s.boxTop, 0),
    boxBottom: validBox(s.boxBottom, 1),
  };
```

**`server/ffmpeg.ts`** — `assertBoxes` threads the `1-1` cell ratios (Task 3 generalises it):

```ts
import { DEFAULT_LAYOUT, cellsOf, ratioOf } from "../src/layout.ts";
```

```ts
export function assertBoxes(top: Rect, bottom: Rect, source: Size): void {
  const cells = cellsOf(DEFAULT_LAYOUT);
  const pairs = [["top", top, cells[0]], ["bottom", bottom, cells[1]]] as const;
  for (const [name, rect, cell] of pairs) {
    if (cell === undefined || !isValidBox(rect, source, ratioOf(cell))) {
      throw new Error(
        `Invalid ${name} box ${JSON.stringify(rect)} for source ` +
          `${source.w}x${source.h}: must be integers, 9:8 (w = round(h * 9/8)), ` +
          `and fully inside the frame.`,
      );
    }
  }
}
```

**`src/main.ts`** — import `defaultBoxes` from `./layout.ts` instead of `./geometry.ts`, and adapt the three uses plus the new `ratios` prop. `defaultBoxes` now returns an array, so:

```ts
import { SHORTS_MAX_S, SKIP_TRIM_UNDER } from "./geometry.ts";
import { DEFAULT_LAYOUT, cellsOf, defaultBoxes, ratioOf } from "./layout.ts";
```

In `ensureFraming`, the defaulting block and both `boxes` getters:

```ts
  if (!s.boxTop || !s.boxBottom) {
    const [top, bottom] = defaultBoxes(s.source, DEFAULT_LAYOUT);
    // setQuiet, not setState: this runs during render, and notifying from
    // inside a render is re-entrant. The rAF preview loop below reads state
    // fresh every frame, so a quiet update still reaches the canvas.
    setQuiet({ boxTop: top ?? null, boxBottom: bottom ?? null });
    save();
  }

  stopPreview = startPreview(canvasEl, videoEl, () => {
    const cur = getState();
    const [top, bottom] = defaultBoxes(cur.source, DEFAULT_LAYOUT);
    return {
      top: cur.boxTop ?? top ?? { x: 0, y: 0, w: 0, h: 0 },
      bottom: cur.boxBottom ?? bottom ?? { x: 0, y: 0, w: 0, h: 0 },
    };
  });

  stopEditor?.();
  stopEditor = mountEditor({
    host: sourceSlot,
    media: videoEl,
    source: () => getState().source,
    ratios: () => cellsOf(DEFAULT_LAYOUT).map(ratioOf),
    boxes: () => {
      const cur = getState();
      const [top, bottom] = defaultBoxes(cur.source, DEFAULT_LAYOUT);
      return {
        top: cur.boxTop ?? top ?? { x: 0, y: 0, w: 0, h: 0 },
        bottom: cur.boxBottom ?? bottom ?? { x: 0, y: 0, w: 0, h: 0 },
      };
    },
    onChange: (which, rect) => {
      setQuiet(which === "top" ? { boxTop: rect } : { boxBottom: rect });
    },
    onCommit: () => save(),
  });
```

- [ ] **Step 11: Run the whole suite and the build**

Run: `pnpm test`
Expected: PASS — all of it, including the untouched `server/ffmpeg.test.ts` and `src/state.test.ts`.

Run: `pnpm build`
Expected: PASS, no `tsc` errors.

- [ ] **Step 12: Verify by hand that nothing moved**

Run `pnpm server` in one terminal and `pnpm dev` in another. Load a video, reach the framing phase, and confirm: the two default boxes are still pinned left and right at max size, dragging and corner-resizing still feel identical, and an export still produces a correct 1080×1920 file. This task is a pure refactor — anything visibly different is a bug in it.

- [ ] **Step 13: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/geometry.ts src/geometry.test.ts src/layout.ts src/layout.test.ts src/editor.ts src/state.ts src/main.ts server/ffmpeg.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "refactor: make the crop aspect ratio a parameter

Cells come in three shapes once layouts exist (9:8, 9:16, 9:4) and every
crop must match its own cell exactly, so BOX_RATIO stops being a
constant: maxBox, boxFromHeight, resizeFromCorner and isValidBox all take
a ratio. Call sites pass the 1-1 cell ratios, so behaviour is unchanged.

MIN_BOX_H becomes MIN_BOX_SIDE and floors both axes -- a 9:16 box floored
at h=142 is 80px wide, too narrow to grab its own handles. The floor is
ceiled, not rounded: 142 / 0.5625 = 252.44, and rounding that down would
put the smallest constructible box below the floor isValidBox checks, so
the validator would reject its own constructor's output.

defaultBoxes moves to layout.ts, since it is the one box constructor that
needs to know about layouts and geometry.ts importing Layout would make
the dependency a cycle.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `xstack` composition and the `/api/export` wire format

**Files:**
- Modify: `server/ffmpeg.ts` (`buildFilter`, `assertBoxes`, `ExportOpts`, `exportClip`)
- Modify: `server/ffmpeg.test.ts`
- Modify: `server/index.ts` (`/api/export` body)
- Modify: `src/api.ts` (`exportClip` body type)
- Modify: `src/main.ts` (`doExport` sends `layoutId` + `boxes`)

**Interfaces:**
- Consumes: `Layout`, `DEFAULT_LAYOUT`, `DEFAULT_LAYOUT_ID`, `cellsOf`, `ratioOf`, `layoutById` (Tasks 1–2); `isValidBox(rect, source, ratio)` (Task 2).
- Produces:
  - `buildFilter(layout: Layout, boxes: Rect[]): string`
  - `assertBoxes(layout: Layout, boxes: Rect[], source: Size): void`
  - `ExportOpts` with `layout: Layout; boxes: Rect[]` replacing `top: Rect; bottom: Rect`
  - `/api/export` body: `{ videoId, windowStart, windowEnd, start, end, title, layoutId: string, boxes: Rect[] }`

- [ ] **Step 1: Write the failing tests**

Replace the `describe("buildFilter")` and `describe("assertBoxes")` blocks in `server/ffmpeg.test.ts` and add the 3-cell pixel test. Extend the imports:

```ts
import { boxFromHeight } from "../src/geometry.ts";
import { DEFAULT_LAYOUT, cellsOf, layoutById } from "../src/layout.ts";
import type { Layout } from "../src/layout.ts";
```

```ts
/** `layoutById` returns `Layout | null` by design. Tests know their ids
 *  exist, so they throw rather than reach for `!`. */
function byId(id: string): Layout {
  const layout = layoutById(id);
  if (!layout) throw new Error(`test asked for unknown layout ${id}`);
  return layout;
}

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
```

Add the 3-cell pixel test. Build a second fixture source in `beforeAll` — three horizontal colour bands, so a 9:4 crop fits inside one band:

```ts
let bands = "";
```

inside `beforeAll`, after `src` is written:

```ts
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
```

and the test itself, inside `describe("exportClip")`:

```ts
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
```

The existing `exportClip` tests (`writes a 1080x1920 file whose halves match`, `rejects a negative start`, `rejects a zero or negative duration`) keep their assertions but swap `top: TOP, bottom: BOTTOM` for `layout: DEFAULT_LAYOUT, boxes: [TOP, BOTTOM]`. The 2-cell pixel assertions themselves must not change — they are the `1-1` regression fence.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run server/ffmpeg.test.ts`
Expected: FAIL — `buildFilter` expects two `Rect`s, and `xstack=` appears nowhere in its output.

- [ ] **Step 3: Rewrite `buildFilter`, `assertBoxes` and `ExportOpts`**

In `server/ffmpeg.ts`, replace the `HALF` import with `layout.ts`'s helpers (this removes one of `HALF`'s two consumers; Task 5 removes the other and deletes it):

```ts
import { isValidBox } from "../src/geometry.ts";
import type { Rect, Size } from "../src/geometry.ts";
import { cellsOf, ratioOf } from "../src/layout.ts";
import type { Layout } from "../src/layout.ts";
```

```ts
export type ExportOpts = {
  input: string;
  start: number;
  duration: number;
  layout: Layout;
  boxes: Rect[];
  source: Size;
  out: string;
};

/** One decode, split N ways, each leg cropped and scaled to its cell, then
 *  composed. Two -i of the same file would decode it twice.
 *
 *  A single xstack rather than hstack-per-row-then-vstack: it needs no
 *  special case for single-column rows, and its `layout=` string comes
 *  straight out of cellsOf, so the composition can't drift from the cells
 *  the preview and the editor use. For the 1-1 layout it emits
 *  `layout=0_0|0_960`, which is pixel-identical to the vstack this
 *  replaced. */
export function buildFilter(layout: Layout, boxes: Rect[]): string {
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
  const scaled = cells.map((_, i) => `[s${i}]`).join("");
  const positions = cells.map((c) => `${c.x}_${c.y}`).join("|");
  return [
    `[0:v]split=${cells.length}${inputs}`,
    ...legs,
    `${scaled}xstack=inputs=${cells.length}:layout=${positions}[v]`,
  ].join(";");
}

/** Numbers are the one thing interpolated into the filter string, and a NaN
 *  or out-of-bounds rect makes ffmpeg fail unreadably. Same isValidBox the
 *  client editor uses, so there is one definition of a legal rect — checked
 *  per box against *its own cell's* ratio, because a flawless 9:8 rect is
 *  still illegal for a 540x960 cell and would export stretched. */
export function assertBoxes(layout: Layout, boxes: Rect[], source: Size): void {
  const cells = cellsOf(layout);
  if (!Array.isArray(boxes) || boxes.length !== cells.length) {
    throw new Error(
      `Layout ${layout.id} needs ${cells.length} boxes, got ` +
        `${Array.isArray(boxes) ? String(boxes.length) : typeof boxes}.`,
    );
  }
  cells.forEach((cell, i) => {
    const rect = boxes[i];
    const ratio = ratioOf(cell);
    if (rect === undefined || !isValidBox(rect, source, ratio)) {
      throw new Error(
        `Invalid box ${i + 1} ${JSON.stringify(rect)} for source ` +
          `${source.w}x${source.h}: must be integers, ${cell.w}:${cell.h} ` +
          `(w = round(h * ${ratio})), and fully inside the frame.`,
      );
    }
  });
}
```

And in `exportClip`, the two touched lines:

```ts
  assertBoxes(opts.layout, opts.boxes, opts.source);
```

```ts
        "-filter_complex", buildFilter(opts.layout, opts.boxes),
```

- [ ] **Step 4: Run the ffmpeg tests to verify they pass**

Run: `pnpm vitest run server/ffmpeg.test.ts`
Expected: PASS. These shell out to real ffmpeg, so allow ~30s.

- [ ] **Step 5: Move the wire format to `layoutId` + `boxes`**

**`server/index.ts`** — import the layout helpers and replace the two-box block in `/api/export`:

```ts
import { layoutById } from "../src/layout.ts";
```

```ts
    const title = str(raw.title, "title");
    const layoutId = str(raw.layoutId, "layoutId");
    // Shape is checked here; legality (integers, per-cell ratio, in-bounds)
    // is checked below via assertBoxes/isValidBox, which safely reject null,
    // non-arrays, non-objects and non-integers instead of throwing a
    // TypeError.
    const boxes = raw.boxes as Rect[];
```

then, after the existing `videoId`/`end > start`/window checks:

```ts
    // A table lookup, so nothing from the request body is ever interpolated
    // into the filter graph — the same posture as taking window bounds
    // instead of a file path.
    const layout = layoutById(layoutId);
    if (!layout) return send(res, 400, { error: `Unknown layout ${layoutId}.` });
```

and the `assertBoxes` call plus the `exportClip` call:

```ts
    try {
      assertBoxes(layout, boxes, { w: source.width, h: source.height });
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
```

```ts
      await exportClip({
        input,
        start: start - windowStart,
        duration: end - start,
        layout,
        boxes,
        source: { w: source.width, h: source.height },
        out,
      });
```

**`src/api.ts`** — the export body:

```ts
export async function exportClip(body: {
  videoId: string;
  windowStart: number;
  windowEnd: number;
  start: number;
  end: number;
  title: string;
  layoutId: string;
  boxes: Rect[];
}): Promise<Blob> {
  return (await post("/api/export", body)).blob();
}
```

**`src/main.ts`** — `doExport` sends the new shape. State still holds `boxTop`/`boxBottom` until Task 4, so it assembles the array here:

```ts
async function doExport(): Promise<void> {
  const s = getState();
  if (!s.boxTop || !s.boxBottom) return;
  const boxTop = s.boxTop;
  const boxBottom = s.boxBottom;
  await guard("Rendering… (a 30s clip takes ~5–10s)", async () => {
    const blob = await api.exportClip({
      videoId: s.videoId,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      start: s.start,
      end: s.end,
      title: s.title,
      layoutId: DEFAULT_LAYOUT_ID,
      boxes: [boxTop, boxBottom],
    });
```

(the local `boxTop`/`boxBottom` consts replace the `as NonNullable<…>` casts — the early return already narrowed them, and hoisting them out of the closure keeps that narrowing). Add `DEFAULT_LAYOUT_ID` to the `./layout.ts` import.

- [ ] **Step 6: Run everything**

Run: `pnpm test && pnpm build`
Expected: PASS.

- [ ] **Step 7: Verify an export by hand**

With `pnpm server` and `pnpm dev` running, export a clip and open the result. It must be a correct 1080×1920 file with the two halves matching the boxes — `xstack` has replaced `vstack` and this is the check that the replacement is pixel-equivalent in the real pipeline, not just in the fixture test.

- [ ] **Step 8: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add server/ffmpeg.ts server/ffmpeg.test.ts server/index.ts src/api.ts src/main.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: compose N cells with a single xstack

buildFilter and assertBoxes take a layout and a box list instead of a
top/bottom pair, and composition moves from vstack to one xstack whose
layout= string comes straight from cellsOf -- no special case for
single-column rows, and the composition cannot drift from the cells the
preview and editor use. 1-1 emits layout=0_0|0_960, pixel-identical to
the vstack it replaces.

assertBoxes now validates each box against its own cell's ratio: a
flawless 9:8 rect is still illegal for a 540x960 cell and would export
stretched.

/api/export takes layoutId + boxes. layoutId is resolved by table lookup,
so nothing from the body reaches the filter graph.

Adds a 3-cell pixel test on a colour-banded source -- what proves xstack's
layout ordering, the way the vstack leg-swap assertion did for two cells.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `layoutId` + `boxes[]` in state, with legacy migration

**Files:**
- Modify: `src/state.ts`
- Modify: `src/state.test.ts`
- Modify: `src/main.ts` (read/write the new fields)
- Modify: `src/editor.ts` — no change needed yet; Task 5 changes it

**Interfaces:**
- Consumes: `DEFAULT_LAYOUT`, `DEFAULT_LAYOUT_ID`, `cellsOf`, `ratioOf`, `layoutById`, `defaultBoxes` (Tasks 1–2).
- Produces:
  - `AppState` gains `layoutId: string` and `boxes: Rect[]`; loses `boxTop` and `boxBottom`.
  - `restore(videoId, source)` returns `Partial<AppState>` with `layoutId` and `boxes`.
  - Stored record shape: `{ start, end, layoutId, boxes, sourceW, sourceH }`.

- [ ] **Step 1: Write the failing tests**

In `src/state.test.ts`, rewrite the stored-shape expectations and add the migration and per-cell-ratio cases. Boxes in these fixtures must be legal 9:8 rects for a 1920×1080 source — `{ x, y, w: 180, h: 160 }` already is (`round(160 * 1.125) = 180`, and `160 >= 142`).

```ts
import { DEFAULT_LAYOUT_ID } from "./layout.ts";
```

```ts
describe("save", () => {
  it("does not clobber a framed box list when a mark is saved back in trimming", () => {
    // The regression case: boxes were framed and saved in an earlier
    // session against the clip's real fetched dimensions (1920x1080).
    const videoId = "regression-trimming";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        start: 5,
        end: 50,
        layoutId: "1-1",
        boxes: [
          { x: 0, y: 0, w: 180, h: 160 },
          { x: 10, y: 10, w: 180, h: 160 },
        ],
        sourceW: 1920,
        sourceH: 1080,
      }),
    );

    // A revisit to trimming starts with boxes back at [] in memory and
    // `source` back at probe's informational (mismatched) dimensions —
    // exactly the state a fresh AppState has before framing runs again.
    setState({
      videoId,
      phase: "trimming",
      start: 12,
      end: 60,
      layoutId: "1-1",
      boxes: [],
      source: { w: 3840, h: 2160 },
    });
    save();

    expect(readRaw(videoId)).toEqual({
      start: 12,
      end: 60,
      layoutId: "1-1",
      boxes: [
        { x: 0, y: 0, w: 180, h: 160 },
        { x: 10, y: 10, w: 180, h: 160 },
      ],
      sourceW: 1920,
      sourceH: 1080,
    });
  });

  it("writes through real boxes and dimensions once framing has them all", () => {
    const videoId = "framed";
    setState({
      videoId,
      phase: "framing",
      start: 1,
      end: 9,
      layoutId: "1-1",
      boxes: [
        { x: 1, y: 1, w: 180, h: 160 },
        { x: 2, y: 2, w: 180, h: 160 },
      ],
      source: { w: 1920, h: 1080 },
    });
    save();

    expect(readRaw(videoId)).toEqual({
      start: 1,
      end: 9,
      layoutId: "1-1",
      boxes: [
        { x: 1, y: 1, w: 180, h: 160 },
        { x: 2, y: 2, w: 180, h: 160 },
      ],
      sourceW: 1920,
      sourceH: 1080,
    });
  });

  it("keeps the previous boxes when framing has fewer than the layout's cells", () => {
    // The subtlest branch of `framed`: phase is "framing" but the list is
    // half-built, which is the state ensureFraming passes through. Writing
    // it would erase a complete list saved earlier.
    const videoId = "half-framed";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        start: 3,
        end: 30,
        layoutId: "2v-1",
        boxes: [
          { x: 5, y: 5, w: 1080, h: 480 },
          { x: 6, y: 6, w: 1080, h: 480 },
          { x: 7, y: 7, w: 180, h: 160 },
        ],
        sourceW: 1920,
        sourceH: 1080,
      }),
    );
    setState({
      videoId,
      phase: "framing",
      start: 4,
      end: 40,
      layoutId: "2v-1",
      boxes: [{ x: 99, y: 99, w: 1080, h: 480 }], // only the first, so far
      source: { w: 1920, h: 1080 },
    });
    save();

    expect(readRaw(videoId)).toMatchObject({
      start: 4,
      end: 40,
      layoutId: "2v-1",
      boxes: [
        { x: 5, y: 5, w: 1080, h: 480 },
        { x: 6, y: 6, w: 1080, h: 480 },
        { x: 7, y: 7, w: 180, h: 160 },
      ],
    });
  });
});

describe("restore", () => {
  it("migrates a legacy boxTop/boxBottom record onto the 1-1 layout", () => {
    // Records written before layouts existed have no layoutId and no boxes
    // array. Dropping them would silently un-frame every video already in
    // storage.
    const videoId = "legacy";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        start: 7,
        end: 70,
        boxTop: { x: 0, y: 0, w: 180, h: 160 },
        boxBottom: { x: 1, y: 1, w: 180, h: 160 },
        sourceW: 1920,
        sourceH: 1080,
      }),
    );

    expect(restore(videoId, { w: 1920, h: 1080 })).toEqual({
      start: 7,
      end: 70,
      layoutId: DEFAULT_LAYOUT_ID,
      boxes: [
        { x: 0, y: 0, w: 180, h: 160 },
        { x: 1, y: 1, w: 180, h: 160 },
      ],
    });
  });

  it("drops boxes when the source dimensions don't match, keeps marks and layout", () => {
    const videoId = "mismatch";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        start: 7,
        end: 70,
        layoutId: "2h-1",
        boxes: [
          { x: 0, y: 0, w: 540, h: 960 },
          { x: 1, y: 1, w: 540, h: 960 },
          { x: 2, y: 2, w: 180, h: 160 },
        ],
        sourceW: 1920,
        sourceH: 1080,
      }),
    );

    // A re-fetch at a different resolution costs the boxes — rects are
    // stored in source pixels — but must not cost the layout choice.
    expect(restore(videoId, { w: 1280, h: 720 })).toEqual({
      start: 7,
      end: 70,
      layoutId: "2h-1",
      boxes: [],
    });
  });

  it("drops boxes whose count does not match the stored layout's cells", () => {
    const videoId = "count-mismatch";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        start: 0,
        end: 5,
        layoutId: "2v-1", // 3 cells
        boxes: [{ x: 0, y: 0, w: 180, h: 160 }], // 1 box
        sourceW: 1920,
        sourceH: 1080,
      }),
    );
    expect(restore(videoId, { w: 1920, h: 1080 })).toMatchObject({
      layoutId: "2v-1",
      boxes: [],
    });
  });

  it("drops boxes that are legal for the wrong cell", () => {
    // 2h-1's first two cells are 540x960 (9:16). A perfect 9:8 rect there
    // would restore and preview cleanly and only die at export.
    const videoId = "wrong-cell";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        start: 0,
        end: 5,
        layoutId: "2h-1",
        boxes: [
          { x: 0, y: 0, w: 180, h: 160 }, // 9:8 — wrong for a 9:16 cell
          { x: 0, y: 0, w: 540, h: 960 },
          { x: 0, y: 0, w: 180, h: 160 },
        ],
        sourceW: 1920,
        sourceH: 1080,
      }),
    );
    expect(restore(videoId, { w: 1920, h: 1080 })).toMatchObject({
      layoutId: "2h-1",
      boxes: [],
    });
  });

  it("falls back to the default layout for an unknown stored id", () => {
    const videoId = "unknown-layout";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        start: 0,
        end: 5,
        layoutId: "not-a-layout",
        boxes: [{ x: 0, y: 0, w: 180, h: 160 }],
        sourceW: 1920,
        sourceH: 1080,
      }),
    );
    expect(restore(videoId, { w: 1920, h: 1080 })).toMatchObject({
      layoutId: DEFAULT_LAYOUT_ID,
      boxes: [],
    });
  });

  it("drops boxes that are not an array at all", () => {
    const videoId = "boxes-not-array";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({ start: 0, end: 5, layoutId: "1-1", boxes: "nope", sourceW: 1920, sourceH: 1080 }),
    );
    expect(restore(videoId, { w: 1920, h: 1080 })).toMatchObject({ boxes: [] });
  });
});
```

The remaining existing tests in the file (`saves cleanly on a first-ever save`, `recovers from a malformed prior entry`, `is a no-op without a videoId`, `returns {} when nothing is stored`, `tolerates malformed or unexpected storage contents`) keep their structure with `boxTop: null, boxBottom: null` swapped for `boxes: []` and `layoutId: DEFAULT_LAYOUT_ID` added to the expected records.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/state.test.ts`
Expected: FAIL — `setState` rejects `boxes`/`layoutId`, and stored records still carry `boxTop`/`boxBottom`.

- [ ] **Step 3: Rewrite `src/state.ts`**

```ts
import { isValidBox } from "./geometry.ts";
import type { Rect, Size } from "./geometry.ts";
import { DEFAULT_LAYOUT_ID, cellsOf, layoutById, ratioOf } from "./layout.ts";

export type Phase = "idle" | "trimming" | "framing";

export type AppState = {
  phase: Phase;
  error: string;
  busy: string;
  url: string;
  videoId: string;
  title: string;
  duration: number;
  start: number;
  end: number;
  clipUrl: string;
  windowStart: number;
  windowEnd: number;
  source: Size;
  layoutId: string;
  /** One crop rect per cell of `layoutId`, in `cellsOf` order. Empty means
   *  "not framed yet" — the only other legal length is the layout's cell
   *  count, which is what `save`'s gate and `restore` both check. */
  boxes: Rect[];
};

const initial: AppState = {
  phase: "idle",
  error: "",
  busy: "",
  url: "",
  videoId: "",
  title: "",
  duration: 0,
  start: 0,
  end: 0,
  clipUrl: "",
  windowStart: 0,
  windowEnd: 0,
  source: { w: 0, h: 0 },
  layoutId: DEFAULT_LAYOUT_ID,
  boxes: [],
};
```

`getState`, `setState`, `setQuiet` and `subscribe` are unchanged. The stored shape and its reader:

```ts
type Saved = {
  start: number;
  end: number;
  layoutId: string;
  boxes: Rect[];
  sourceW: number;
  sourceH: number;
};

/** The pre-layouts stored shape. Records in a real user's localStorage
 *  predate this feature, and dropping them would silently un-frame every
 *  video already framed. */
type Legacy = { boxTop?: Rect | null; boxBottom?: Rect | null };

const key = (videoId: string) => `vstack:${videoId}`;

function readSaved(videoId: string): Saved | null {
  const raw = localStorage.getItem(key(videoId));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // JSON.parse accepts bare primitives too — the literal string "null"
  // parses successfully to `null` without throwing, as does "42" or a
  // quoted string, so the shape must be checked before reading fields off
  // it, not just the parse call itself.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const s = parsed as Partial<Saved> & Legacy;

  // Migration: a record with no `boxes` but with the old pair is a
  // pre-layouts save, and the pair it holds is by definition a 1-1 framing.
  const migrated: Rect[] | null =
    s.boxes === undefined && s.boxTop && s.boxBottom ? [s.boxTop, s.boxBottom] : null;

  return {
    start: s.start ?? 0,
    end: s.end ?? 0,
    layoutId: s.layoutId ?? DEFAULT_LAYOUT_ID,
    boxes: migrated ?? (Array.isArray(s.boxes) ? s.boxes : []),
    sourceW: s.sourceW ?? 0,
    sourceH: s.sourceH ?? 0,
  };
}
```

`save`, with the gate generalised from "both boxes present" to "one box per cell":

```ts
export function save(): void {
  if (!state.videoId) return;
  const prev = readSaved(state.videoId);
  // Boxes and dimensions only mean anything once /api/window has reported
  // the clip's real size. Before that, `state.source` still holds probe's
  // informational dimensions and `boxes` is empty, so writing them here
  // unconditionally would erase a set framed in an earlier session the
  // moment a mark is touched again during a later trimming visit. Marks,
  // by contrast, always reflect the current session and always persist.
  //
  // The count check is what covers the half-built case: ensureFraming
  // passes through states where some cells have boxes and some don't, and
  // writing one of those would truncate a complete stored set.
  const cells = cellsOf(layoutById(state.layoutId) ?? { id: "", label: "", rows: [] });
  const framed =
    state.phase === "framing" && cells.length > 0 && state.boxes.length === cells.length;
  const saved: Saved = {
    start: state.start,
    end: state.end,
    layoutId: framed ? state.layoutId : (prev?.layoutId ?? DEFAULT_LAYOUT_ID),
    boxes: framed ? state.boxes : (prev?.boxes ?? []),
    sourceW: framed ? state.source.w : (prev?.sourceW ?? 0),
    sourceH: framed ? state.source.h : (prev?.sourceH ?? 0),
  };
  localStorage.setItem(key(state.videoId), JSON.stringify(saved));
}
```

`ponytail:` note — `cellsOf` on a synthesised empty layout is how an unknown `state.layoutId` yields `cells.length === 0` and therefore `framed === false`, rather than needing a second branch. If that reads too clever later, split it.

`restore`:

```ts
/** Restores marks, layout and boxes for a video. Boxes are dropped if the
 *  source resolution changed — rects are stored in source pixels, so they
 *  are meaningless against different dimensions — if their count doesn't
 *  match the layout's cells, or if any fails `isValidBox` against *its own
 *  cell's* ratio, the same check the server runs before ffmpeg. A rect that
 *  matches dimensions but is a legal 9:8 box aimed at a 540x960 cell would
 *  otherwise restore and preview cleanly and die only at export time.
 *
 *  A known layoutId survives all of that: losing the boxes to a re-fetch at
 *  a different resolution should not also cost the layout choice.
 *
 *  localStorage is untrusted input like any other: `Saved`'s field types are
 *  a compile-time claim, not a runtime guarantee, so marks are coerced
 *  through `Number.isFinite` too — a stray string in storage must not
 *  silently make it into a numeric comparison (`"50" > 5` is `true`) and
 *  enable Continue. */
export function restore(videoId: string, source: Size | null): Partial<AppState> {
  const s = readSaved(videoId);
  if (!s) return {};
  const layout = layoutById(s.layoutId);
  const cells = layout ? cellsOf(layout) : [];
  const sameSource = source !== null && s.sourceW === source.w && s.sourceH === source.h;
  const usable =
    source !== null &&
    sameSource &&
    cells.length > 0 &&
    s.boxes.length === cells.length &&
    cells.every((cell, i) => {
      const box = s.boxes[i];
      return box !== undefined && isValidBox(box, source, ratioOf(cell));
    });
  return {
    start: Number.isFinite(s.start) ? s.start : initial.start,
    end: Number.isFinite(s.end) ? s.end : initial.end,
    layoutId: layout ? layout.id : DEFAULT_LAYOUT_ID,
    boxes: usable ? s.boxes : [],
  };
}
```

- [ ] **Step 4: Run the state tests to verify they pass**

Run: `pnpm vitest run src/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `src/main.ts` to the new state fields**

Three `setState` calls carry boxes (`load`'s short-video branch, `openWindow`, and `ensureFraming`'s defaulting), plus `doExport`'s guard. Replace `boxTop: saved.boxTop ?? null, boxBottom: saved.boxBottom ?? null` with `layoutId: saved.layoutId ?? DEFAULT_LAYOUT_ID, boxes: saved.boxes ?? []` in both `load` and `openWindow`.

In `ensureFraming`:

```ts
  const layout = layoutById(s.layoutId) ?? DEFAULT_LAYOUT;
  const cells = cellsOf(layout);

  if (s.boxes.length !== cells.length) {
    // setQuiet, not setState: this runs during render, and notifying from
    // inside a render is re-entrant. The rAF preview loop below reads state
    // fresh every frame, so a quiet update still reaches the canvas.
    setQuiet({ boxes: defaultBoxes(s.source, layout) });
    save();
  }
```

and both getters become one helper, defined next to `ensureFraming`:

```ts
/** The current boxes, or this layout's defaults if the list isn't built yet.
 *  Read fresh on every preview frame and every drag, so it must not
 *  allocate a fallback unless it actually needs one. */
function currentBoxes(): Rect[] {
  const cur = getState();
  const layout = layoutById(cur.layoutId) ?? DEFAULT_LAYOUT;
  const cells = cellsOf(layout);
  return cur.boxes.length === cells.length ? cur.boxes : defaultBoxes(cur.source, layout);
}
```

`doExport`'s guard and body:

```ts
async function doExport(): Promise<void> {
  const s = getState();
  const layout = layoutById(s.layoutId) ?? DEFAULT_LAYOUT;
  const boxes = s.boxes;
  if (boxes.length !== cellsOf(layout).length) return;
  await guard("Rendering… (a 30s clip takes ~5–10s)", async () => {
    const blob = await api.exportClip({
      videoId: s.videoId,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      start: s.start,
      end: s.end,
      title: s.title,
      layoutId: layout.id,
      boxes,
    });
```

`startPreview` and `mountEditor` still take `{ top, bottom }` until Task 5, so for this task pass them the first two entries of `currentBoxes()`:

```ts
  stopPreview = startPreview(canvasEl, videoEl, () => {
    const [top, bottom] = currentBoxes();
    const empty = { x: 0, y: 0, w: 0, h: 0 };
    return { top: top ?? empty, bottom: bottom ?? empty };
  });
```

with the same pattern in `mountEditor`'s `boxes` getter, and `onChange` writing into a copy:

```ts
    onChange: (which, rect) => {
      const next = [...getState().boxes];
      next[which === "top" ? 0 : 1] = rect;
      setQuiet({ boxes: next });
    },
```

- [ ] **Step 6: Run everything**

Run: `pnpm test && pnpm build`
Expected: PASS.

- [ ] **Step 7: Verify the migration by hand**

This is the one step with a real user-data risk, so check it against real storage rather than only the stub. Before starting: in the browser console on `localhost:5173`, run `Object.entries(localStorage).filter(([k]) => k.startsWith("vstack:"))` and copy the output somewhere. After the change, load one of those videos, reach framing, and confirm the boxes come back where you left them — then re-run the same console snippet and confirm the record now carries `layoutId` and `boxes`.

- [ ] **Step 8: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/state.ts src/state.test.ts src/main.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: store a layout id and a box list instead of a pair

boxTop/boxBottom become layoutId + boxes[], with boxes[] in cellsOf
order and empty meaning not-framed-yet. The save gate generalises from
both-boxes-present to one-box-per-cell, which still covers the half-built
state ensureFraming passes through.

readSaved migrates pre-layouts records: a stored pair with no boxes array
is by definition a 1-1 framing, and dropping it would silently un-frame
every video already in localStorage.

restore drops boxes on a count mismatch or a per-cell ratio failure -- a
legal 9:8 rect aimed at a 540x960 cell would otherwise restore and
preview cleanly and die only at export -- but keeps a known layoutId, so
a re-fetch at a new resolution costs the boxes and not the choice.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: N cells in the preview and the editor

**Files:**
- Modify: `src/preview.ts`
- Modify: `src/editor.ts`
- Modify: `src/geometry.ts` (delete `HALF`)
- Modify: `src/main.ts` (pass arrays through)

**Interfaces:**
- Consumes: `cellsOf`, `ratioOf` (Task 1); `state.boxes` (Task 4).
- Produces:
  - `startPreview(canvas, video, cells: Rect[], boxes: () => Rect[]): () => void`
  - `mountEditor` opts: `cells: () => Rect[]`, `boxes: () => Rect[]`, `onChange(index: number, rect: Rect)`. `Which` is deleted.
  - `HALF` no longer exists in `geometry.ts`.

These are DOM-driven modules, untested by design (vitest runs `environment: "node"` here), so this task's verification is `tsc` plus the by-hand checks in Step 4.

- [ ] **Step 1: Rewrite `src/preview.ts`**

```ts
import { OUTPUT } from "./geometry.ts";
import type { Rect } from "./geometry.ts";

/** The whole composite: one decode, one draw per cell. Boxes are read
 *  through a getter each frame so a drag needs no re-subscription.
 *
 *  `cells` and `boxes()` are parallel arrays in cellsOf order — the same
 *  order the editor numbers them and xstack composes them. drawImage's
 *  source rect is the box in *source* pixels and its destination rect is
 *  the cell in *output* pixels, with no conversion between them: that is
 *  the invariant that keeps this canvas and ffmpeg's crop= agreeing.
 *
 *  ponytail: the loop runs unconditionally, which is what makes
 *  redraw-on-seek and redraw-on-drag need no wiring at all. Gate it on
 *  !video.paused if battery ever matters. */
export function startPreview(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  cells: Rect[],
  boxes: () => Rect[],
): () => void {
  canvas.width = OUTPUT.w;
  canvas.height = OUTPUT.h;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("2d context unavailable");

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
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
```

- [ ] **Step 2: Rewrite `src/editor.ts` around a cell index**

Replace the `Which` type, `Drag`, the node map, `makeBox`, `place`'s loop and z-order, and the `pointerdown`/`pointermove` handlers:

```ts
import { displayScale, moveBy, resizeFromCorner, toDisplay } from "./geometry.ts";
import { ratioOf } from "./layout.ts";
import type { Corner, Rect, Size } from "./geometry.ts";

const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

type Drag = {
  index: number;
  corner: Corner | null; // null = move the whole box
  originX: number;
  originY: number;
  startRect: Rect;
};

export function mountEditor(opts: {
  host: HTMLElement;
  media: HTMLVideoElement;
  source: () => Size;
  /** Output-space cells in cellsOf order. Fixed for this mount — main.ts
   *  remounts the editor when the layout changes, because the node count
   *  is derived from it. */
  cells: () => Rect[];
  boxes: () => Rect[];
  onChange(index: number, rect: Rect): void;
  onCommit(): void;
}): () => void {
  const layer = document.createElement("div");
  layer.className = "boxes";
  opts.host.append(layer);

  const cells = opts.cells();
  const nodes = cells.map((_, i) => makeBox(i));
  layer.append(...nodes);

  function makeBox(index: number): HTMLDivElement {
    const box = document.createElement("div");
    // box-c0..c3 carry the per-index colour; four is the maximum cell count
    // any layout declares.
    box.className = `box box-c${index}`;
    box.dataset.index = String(index);
    const label = document.createElement("span");
    label.className = "box-label";
    label.textContent = String(index + 1);
    box.append(label);
    for (const c of CORNERS) {
      const h = document.createElement("div");
      h.className = `handle handle-${c}`;
      h.dataset.corner = c;
      box.append(h);
    }
    return box;
  }

  let drag: Drag | null = null;

  function scale(): number {
    return displayScale(opts.source(), opts.media.clientWidth);
  }

  function place(): void {
    const s = scale();
    const bs = opts.boxes();
    const rect = opts.media.getBoundingClientRect();
    const hostRect = opts.host.getBoundingClientRect();
    layer.style.left = `${rect.left - hostRect.left}px`;
    layer.style.top = `${rect.top - hostRect.top}px`;
    layer.style.width = `${rect.width}px`;
    layer.style.height = `${rect.height}px`;
    nodes.forEach((node, i) => {
      const box = bs[i];
      if (!box) {
        node.hidden = true;
        return;
      }
      node.hidden = false;
      const d = toDisplay(box, s);
      node.style.left = `${d.x}px`;
      node.style.top = `${d.y}px`;
      node.style.width = `${d.w}px`;
      node.style.height = `${d.h}px`;
    });
    // Native hit-testing follows paint order, so the later sibling wins where
    // the boxes overlap. defaultBoxes overlaps by construction, which would
    // leave the covered box's handles — the ones used to shrink it for the
    // facecam case — unreachable. Append largest first so the smallest ends
    // up on top, and break an exact tie toward the lower index: a 2x2 grid
    // starts as four equal-area boxes, and without the tie-break cell 1's
    // handles sit under cell 4's.
    const area = (i: number) => {
      const b = bs[i];
      return b ? b.w * b.h : 0;
    };
    const order = nodes.map((_, i) => i).sort((a, b) => area(b) - area(a) || b - a);
    layer.append(...order.map((i) => nodes[i] ?? layer));
  }

  layer.addEventListener("pointerdown", (e) => {
    const target = e.target as HTMLElement;
    const boxNode = target.closest<HTMLElement>(".box");
    if (!boxNode) return;
    const index = Number(boxNode.dataset.index);
    const startRect = opts.boxes()[index];
    if (!Number.isInteger(index) || !startRect) return;
    const corner = (target.dataset.corner as Corner | undefined) ?? null;
    drag = { index, corner, originX: e.clientX, originY: e.clientY, startRect };
    layer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  layer.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const s = scale();
    // Pointer deltas are display px; geometry works in source px.
    const dx = (e.clientX - drag.originX) / s;
    const dy = (e.clientY - drag.originY) / s;
    const source = opts.source();
    const cell = cells[drag.index];
    // pointerdown only sets `drag` for an index that has both a node and a
    // box, and nodes are built from `cells`, so this is always present.
    if (!cell) return;
    const next =
      drag.corner === null
        ? moveBy(drag.startRect, dx, dy, source)
        : resizeFromCorner(drag.startRect, drag.corner, dx, dy, source, ratioOf(cell));
    opts.onChange(drag.index, next);
    place();
  });
```

`endDrag`, the resize listeners, the `ResizeObserver` and the teardown are unchanged.

Note on `layer.append(...order.map((i) => nodes[i] ?? layer))`: the `?? layer` satisfies `noUncheckedIndexedAccess` and is unreachable, since `order` is built from `nodes`' own indices. If that reads badly, hoist a local `const node = nodes[i]; if (!node) continue;` loop instead of `append(...)`.

- [ ] **Step 3: Delete `HALF` and update `src/main.ts`**

`HALF` has no consumers left — `server/ffmpeg.ts` dropped it in Task 3 and `preview.ts` in Step 1. Remove it from `src/geometry.ts`:

```ts
export const OUTPUT: Size = { w: 1080, h: 1920 };
```

(the `HALF` line and its `Size` annotation go; `OUTPUT` stays).

In `src/main.ts`, `ensureFraming` now passes arrays:

```ts
  stopPreview = startPreview(canvasEl, videoEl, cells, currentBoxes);

  stopEditor?.();
  stopEditor = mountEditor({
    host: sourceSlot,
    media: videoEl,
    source: () => getState().source,
    cells: () => cells,
    boxes: currentBoxes,
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

- [ ] **Step 4: Verify**

Run: `pnpm test && pnpm build`
Expected: PASS. No new tests here — these modules are DOM-driven and untested by design.

By hand, with `pnpm server` and `pnpm dev`: reach framing and confirm the two boxes still drag and resize, the labels now read `1` and `2`, the canvas preview still matches, and an export still comes out right. Behaviour is still `1-1`-only until Task 6 adds the picker.

- [ ] **Step 5: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/preview.ts src/editor.ts src/geometry.ts src/main.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: draw and edit N cells instead of a top/bottom pair

startPreview takes parallel cells/boxes arrays and draws one per cell;
mountEditor builds one node per cell and keys drags on the cell index,
reading that cell's ratio for a corner resize.

The z-order rule gains a tie-break toward the lower index. A 2x2 grid
starts as four equal-area boxes, and largest-first alone would leave
cell 1's handles unreachable under cell 4's.

HALF has no consumers left, so it goes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The layout picker

**Files:**
- Modify: `src/main.ts` (picker in the framing bar, `editorFor` remount guard)
- Modify: `src/style.css` (two extra Radix scales, picker recipes, per-index box colours)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: no new exported API. `renderFraming` gains a picker; `ensureFraming` gains an `editorFor` guard.

- [ ] **Step 1: Add the two extra colour scales and the picker recipes to `src/style.css`**

The boxes need four distinguishable colours and only `blue`/`amber` are imported (`red` is the error colour, so reusing it for a crop box would misread). Add `grass` and `violet` — with their alpha companions, per the project's rule that soft fills composite over both the page background and a white card:

```css
@import "@radix-ui/colors/grass.css";
@import "@radix-ui/colors/grass-alpha.css";
@import "@radix-ui/colors/violet.css";
@import "@radix-ui/colors/violet-alpha.css";
```

Replace the `.box-top` / `.box-bottom` rules with the four per-index ones:

```css
.box-c0 { border-color: var(--blue-9); background: color-mix(in srgb, var(--blue-9) 12%, transparent); }
.box-c1 { border-color: var(--amber-9); background: color-mix(in srgb, var(--amber-9) 12%, transparent); }
.box-c2 { border-color: var(--grass-9); background: color-mix(in srgb, var(--grass-9) 12%, transparent); }
.box-c3 { border-color: var(--violet-9); background: color-mix(in srgb, var(--violet-9) 12%, transparent); }

.box-c0 .box-label { color: var(--blue-11); }
.box-c1 .box-label { color: var(--amber-11); }
.box-c2 .box-label { color: var(--grass-11); }
.box-c3 .box-label { color: var(--violet-11); }
```

And the picker. The swatch is a 9:16 box with each cell absolutely positioned as a percentage of the output, so the diagram is generated from `cellsOf` and can never disagree with what the layout actually does:

```css
/* The layout picker. Nine text labels would swamp the bar, and for a tool
   whose whole job is visual composition the diagram IS the label. */
.layouts { display: flex; gap: var(--space-1); align-items: center; }

.layout-pick {
  --pick-w: 20px;
  width: var(--pick-w);
  height: calc(var(--pick-w) * 16 / 9);
  position: relative;
  padding: 0;
  border: 1px solid var(--slate-a7);
  border-radius: var(--radius-1);
  background: var(--slate-a3);
  cursor: pointer;
}

.layout-pick:hover { border-color: var(--slate-a8); }
.layout-pick:focus-visible { outline: 2px solid var(--blue-8); outline-offset: 2px; }
.layout-pick[aria-pressed="true"] { border-color: var(--blue-9); background: var(--blue-a4); }

.layout-cell {
  position: absolute;
  background: var(--slate-a8);
  border-radius: 1px;
}

.layout-pick[aria-pressed="true"] .layout-cell { background: var(--blue-9); }
```

The cells are inset by a hairline so adjacent ones read as separate blocks rather than one solid fill; that inset is applied in JS along with the percentages.

- [ ] **Step 2: Add the picker to `src/main.ts`**

A builder next to `renderFraming`:

```ts
/** One button per layout, each drawing its own cells. The diagram is
 *  generated from `cellsOf`, so a picker swatch cannot drift from what the
 *  layout actually composes — which a hand-drawn icon set would. */
function renderLayoutPicker(currentId: string): Node {
  const picks = LAYOUTS.map((layout) => {
    const selected = layout.id === currentId;
    const pick = el("button", {
      className: "layout-pick",
      title: layout.label,
      ariaLabel: layout.label,
      disabled: Boolean(getState().busy),
    });
    pick.setAttribute("aria-pressed", String(selected));
    for (const cell of cellsOf(layout)) {
      // Percentages, plus a 1px inset so neighbouring cells read as
      // separate blocks instead of one filled rectangle.
      pick.append(
        el("span", {
          className: "layout-cell",
          style:
            `left: calc(${(cell.x / OUTPUT.w) * 100}% + 1px);` +
            `top: calc(${(cell.y / OUTPUT.h) * 100}% + 1px);` +
            `width: calc(${(cell.w / OUTPUT.w) * 100}% - 2px);` +
            `height: calc(${(cell.h / OUTPUT.h) * 100}% - 2px);`,
        }),
      );
    }
    pick.onclick = () => {
      if (layout.id === currentId) return;
      // Boxes are cleared, not carried over: cell ratios differ between
      // layouts, so a box from the old one is illegal in the new one.
      // ensureFraming rolls this layout's defaults on the next render.
      //
      // ponytail: a boxesByLayout map would preserve a framing per layout
      // and make flipping between them to compare non-destructive. Add it
      // if that gets annoying.
      setState({ layoutId: layout.id, boxes: [] });
      save();
    };
    return pick;
  });
  return el("div", { className: "layouts" }, ...picks);
}
```

Add `LAYOUTS` and `OUTPUT` to the imports, and put the picker in `renderFraming`'s returned children — before the marks badge, so the phase-advancing Export stays last:

```ts
  return [
    setStart,
    setEnd,
    renderLayoutPicker(s.layoutId),
    el("span", { className: "badge", textContent: `${clock(s.start)} → ${clock(s.end)}` }),
```

- [ ] **Step 3: Add the `editorFor` remount guard to `ensureFraming`**

`ensureFraming`'s existing `framingFor === s.clipUrl` guard is what keeps `videoEl` alive across re-renders, and it must keep doing exactly that — a layout change must not rebuild the video. But the editor's node count and the preview's cell list are both derived from the layout, so those two need rebuilding when it changes and nothing else does.

Add the tracker beside `framingFor`:

```ts
// The layout the mounted editor and preview loop were built for. Their
// node count and cell list are layout-derived, so a layout change has to
// rebuild them — while leaving videoEl, canvasEl and every other child of
// sourceSlot/outSlot exactly where they are. Emptying either slot is the
// hazard this whole shell exists to avoid.
let editorFor = "";
```

and restructure `ensureFraming`'s head so the clip check and the layout check are separate:

```ts
function ensureFraming(): { video: HTMLVideoElement; canvas: HTMLCanvasElement } {
  const s = getState();
  const layout = layoutById(s.layoutId) ?? DEFAULT_LAYOUT;
  const cells = cellsOf(layout);
  const sameClip = videoEl !== null && canvasEl !== null && framingFor === s.clipUrl;
  const sameLayout = editorFor === layout.id;
  if (sameClip && sameLayout && videoEl && canvasEl) {
    return { video: videoEl, canvas: canvasEl };
  }
  framingFor = s.clipUrl;
  editorFor = layout.id;
  stopPreview?.();

  if (!videoEl) {
    videoEl = el("video", { controls: true, preload: "auto" });
    sourceSlot.append(videoEl);
  }
  // Only on a genuine clip change: assigning the same src reloads the
  // element and restarts playback, which a layout switch must not do.
  if (!sameClip) videoEl.src = s.clipUrl;

  if (!canvasEl) {
    canvasEl = el("canvas");
    outSlot.append(canvasEl);
  }

  if (s.boxes.length !== cells.length) {
    setQuiet({ boxes: defaultBoxes(s.source, layout) });
    save();
  }
```

the rest of the function (the `startPreview` call, `stopEditor?.()`, `mountEditor`, `boxesLayer` re-query, `return`) is unchanged from Task 5 — it already rebuilds both on every pass through.

- [ ] **Step 4: Verify**

Run: `pnpm test && pnpm build`
Expected: PASS.

By hand, with `pnpm server` and `pnpm dev`, this is the first task with visible new behaviour, so check all of it:

1. Reach framing. Nine swatches appear, the first (`1-1`) pressed, and the two boxes are where they always were.
2. Click `2h-2h`. Four boxes appear in four colours, each a tall 9:16 slice, labelled 1–4. **The video must not restart or reload.**
3. Drag box 1 to the middle of the frame and confirm its handles stay reachable where it overlaps box 4 — that's the z-order tie-break.
4. Export. The result is a 2×2 grid, each quadrant showing the region you framed, in reading order.
5. Click `2v-1`. Three boxes: two wide 9:4 strips and one 9:8. Export and confirm the two strips land on top and the 9:8 fills the bottom half.
6. Reload the page and load the same video again. The layout you last used and its boxes come back.
7. Switch to `trimming` with "Back to trim" and return. The picker, the boxes and the overlay all survive, and the YouTube player's audio does not play under the framing view.

- [ ] **Step 5: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/main.ts src/style.css
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: add the layout picker

Nine buttons in the framing bar, each drawing its own cells from cellsOf
as percentage-positioned divs, so a swatch cannot drift from what its
layout actually composes. Selecting one clears the boxes -- cell ratios
differ between layouts, so an old box is illegal in a new one -- and
ensureFraming rolls that layout's defaults.

ensureFraming's clip guard splits from a new layout guard: a layout
change rebuilds the editor's nodes and the preview's cell list while
leaving videoEl, canvasEl and every other child of the persistent slots
untouched, and no longer reassigns video.src (which would restart
playback).

Boxes get four per-index colours, adding the grass and violet scales with
their alpha companions.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Update the docs that now lie

`CLAUDE.md` states invariants in terms of `BOX_RATIO`, `HALF` and a top/bottom pair, and it is the file every future session reads first. `docs/specs/2026-08-20-vstack-design.md` is described there as "accurate to what shipped", which stops being true.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/specs/2026-08-20-vstack-design.md`

- [ ] **Step 1: Update `CLAUDE.md`**

- Opening description: "turn two 9:8 regions of a YouTube video into a 1080×1920 vertical short" → "turn 2–4 regions of a YouTube video into a 1080×1920 vertical short".
- Add the new spec to the "Read this first" paragraph: `docs/specs/2026-08-21-vstack-layouts-design.md` covers layouts and supersedes the two-box model in the 2026-08-20 design doc.
- Architecture block: add `src/layout.ts   nine layout presets, cellsOf, ratioOf, defaultBoxes`, and note the layering is `errors ← ffmpeg ← ytdlp ← index` on the server and `geometry ← layout ← everything` on the client.
- Rewrite the "Crop rects are stored in source pixels" invariant to mention that cells add an output-space *destination* and never touch the stored value.
- Rewrite "Box size is height-driven" as `w = round(h * ratio)` where `ratio` is the target cell's.
- Add a new invariant: **A box is only legal for its own cell.** A flawless 9:8 rect is illegal in a 540×960 cell and would export stretched — `isValidBox` takes the ratio for exactly this reason, and both `restore` and `assertBoxes` pass the per-cell value.
- Add a new invariant: **The min-box floor is ceiled, not rounded.** `MIN_BOX_SIDE / ratio` is 252.44 for a 9:16 cell, and rounding it down puts the smallest constructible box below the floor `isValidBox` checks.
- Add to the mutation-tested list: swapping two entries in `buildFilter`'s `xstack` `layout=` string fails the 3-cell pixel assertions.
- Add a gotcha: **`cellsOf` order is load-bearing in four places** — stored boxes, editor numbering, canvas draw order, and `xstack`'s `layout=`. They must agree.
- Add a gotcha: **a layout change must not reassign `video.src`.** `ensureFraming` splits its clip guard from its layout guard for this; assigning the same src reloads the element and restarts playback.
- Update the test count in the Commands block to whatever `pnpm test` reports.

- [ ] **Step 2: Add a pointer at the top of `docs/specs/2026-08-20-vstack-design.md`**

```markdown
> **Superseded in part.** The two-box top/bottom model described below was
> replaced by nine layout presets composing 2–4 regions. See
> `docs/specs/2026-08-21-vstack-layouts-design.md`. Everything else here —
> the three phases, the fetch/window/export routes, the caching scheme — is
> still accurate.
```

- [ ] **Step 3: Verify**

Run: `pnpm test`
Expected: PASS. Copy the reported test count into `CLAUDE.md`.

Re-read `CLAUDE.md` end to end and check that no sentence still describes a two-box world.

- [ ] **Step 4: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add CLAUDE.md docs/specs/2026-08-20-vstack-design.md
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "docs: bring CLAUDE.md up to the layout model

Restates the invariants in terms of per-cell ratios, adds the two new
silent-failure modes layouts introduce (a box legal for the wrong cell,
and a min-box floor rounded instead of ceiled), and records that cellsOf
order is load-bearing in four places that must agree.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: terminology → Task 1 (asserted by a test); layout model and the nine presets → Task 1; `BOX_RATIO` becoming a parameter and the surviving invariants → Task 2; the min-side floor → Task 2; `layout.ts` → Tasks 1–2; `geometry.ts` → Tasks 2, 5; `ffmpeg.ts` `xstack` → Task 3; `state.ts` shape, migration, save gate, restore → Task 4; `editor.ts` z-order → Task 5; `preview.ts` → Task 5; `main.ts` picker and remount guard → Task 6; `api.ts`/`index.ts` wire → Task 3; the full testing section → Tasks 1–4. Out-of-scope items stay out. The spec's own layering rule is what moved `defaultBoxes` into `layout.ts`, and the spec was corrected before this plan was written.

**Placeholder scan.** No TBDs, no "add appropriate error handling", no "similar to Task N" — the repeated `?? fallback` and box-getter patterns are written out at each site.

**Type consistency.** `layoutById` returns `Layout | null` everywhere; `DEFAULT_LAYOUT` is the value used wherever a non-null default is needed. `cellsOf(layout): Rect[]` and `ratioOf(cell): number` keep their signatures from Task 1 through Task 6. `isValidBox(rect, source, ratio)`, `maxBox(source, ratio)`, `boxFromHeight(h, source, ratio)` and `resizeFromCorner(rect, corner, dx, dy, source, ratio)` are introduced in Task 2 and called with that exact arity in Tasks 2–5. `mountEditor`'s `ratios: () => number[]` (Task 2) is deliberately replaced by `cells: () => Rect[]` in Task 5, and both call sites are shown. `startPreview` gains its `cells` parameter in Task 5 and Task 5 is the only place it is called. `assertBoxes(layout, boxes, source)` and `buildFilter(layout, boxes)` are consistent between `ffmpeg.ts`, its test, and `index.ts`.

**Interim states.** Tasks 2, 3 and 4 each leave a deliberate interim (call sites passing `1-1` ratios, `main.ts` assembling a two-element array, the editor still keyed on `"top"`/`"bottom"`) so that every commit has `pnpm test` and `pnpm build` green. Each is superseded by name in a later task.
