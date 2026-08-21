# vstack — multi-cell layouts

Date: 2026-08-21
Status: design approved, not yet implemented
Supersedes parts of: `docs/specs/2026-08-20-vstack-design.md` (the two-box model)

## Problem

vstack composites exactly two crop regions into a 1080×1920 vertical short: a
top half and a bottom half, each 1080×960. Two regions is one shape of story.
A three-way reaction, a 2×2 grid of speakers, a wide letterbox strip over a
9:8 main shot — none are reachable.

Goal: nine fixed layout presets, selectable during the framing phase, each
composing 2–4 crop regions into the same 1080×1920 output.

## Terminology

The word "vertical" is ambiguous for a split — it can name the divider or the
arrangement. **In this document and in the UI, "stacked" means one above the
other and "side by side" means left and right.** The user's "vertical" maps to
*stacked*; "horizontal" maps to *side by side*. Layout ids encode this as `v`
and `h` respectively.

## The layout model

A layout is a list of rows. Each row has a height in output pixels and a
column count; the row's width is always the full 1080. Row heights sum to
1920, and 1080 is divisible by every column count. Cells are derived, never
authored:

```ts
export type Row = { h: number; cols: number };   // h in output px
export type Layout = { id: string; label: string; rows: Row[] };
export function cellsOf(layout: Layout): Rect[];  // output-space, row-major
```

Deriving cells from rows rather than listing them makes an exact tiling of
1080×1920 structural. A hand-written cell list can express a 4px seam or an
overlap; a row list cannot.

### The nine presets

| id | label (UI) | rows (h × cols) | cells | cell sizes |
|---|---|---|---|---|
| `1-1` | 1 top + 1 bottom | 960×1, 960×1 | 2 | 1080×960 ×2 |
| `2v-1` | 2 top stacked + 1 bottom | 480×1, 480×1, 960×1 | 3 | 1080×480 ×2, 1080×960 |
| `2h-1` | 2 top side-by-side + 1 bottom | 960×2, 960×1 | 3 | 540×960 ×2, 1080×960 |
| `1-2v` | 1 top + 2 bottom stacked | 960×1, 480×1, 480×1 | 3 | 1080×960, 1080×480 ×2 |
| `1-2h` | 1 top + 2 bottom side-by-side | 960×1, 960×2 | 3 | 1080×960, 540×960 ×2 |
| `2v-2v` | 4 stacked | 480×1, 480×1, 480×1, 480×1 | 4 | 1080×480 ×4 |
| `2h-2h` | 2×2 grid | 960×2, 960×2 | 4 | 540×960 ×4 |
| `2h-2v` | 2 top side-by-side + 2 bottom stacked | 960×2, 480×1, 480×1 | 4 | 540×960 ×2, 1080×480 ×2 |
| `2v-2h` | 2 top stacked + 2 bottom side-by-side | 480×1, 480×1, 960×2 | 4 | 1080×480 ×2, 540×960 ×2 |

`1-1` is today's behaviour and must stay pixel-identical.

Three distinct cell shapes exist across all nine:

| cell | ratio | as a fraction |
|---|---|---|
| 1080×960 | 1.125 | 9:8 |
| 540×960 | 0.5625 | 9:16 |
| 1080×480 | 2.25 | 9:4 |

## Consequence: `BOX_RATIO` stops being a constant

Today every crop is 9:8 because every output cell is 9:8, and `geometry.ts`
hard-codes `BOX_RATIO = 9 / 8`. A 540×960 cell requires a 9:16 crop (a tall
slice of source); a 1080×480 cell requires a 9:4 crop (a wide letterbox
slice). Crops keep matching their cell's aspect **exactly** — no letterboxing,
no distortion, same rule as today, applied per cell.

So the ratio becomes a parameter. This is the entire change to the tested
core; everything else follows from it.

### Invariants that survive unchanged

- **Crop rects stay in source pixels with zero conversion.** `drawImage` and
  ffmpeg's `crop=` still consume the same numbers. Cells add a *destination*
  in output space; they do not touch the stored value.
- **Box size stays height-driven.** Canonical form becomes integer `h` with
  `w = round(h * ratio)`. Still idempotent, so a box re-snapped every drag
  frame does not shrink.
- **Crop rects stay plain integers, not even-rounded.** Every cell size is
  even (1080, 540, 960, 480), so chroma subsampling is satisfied by the
  encoded frame as before.
- **Geometry still uses `/api/window`'s dimensions, never `/api/probe`'s.**
- **`clampToBounds` still slides, never shrinks.** It needed only "every
  constructor caps size at `maxBox` first", which holds per-ratio.

### `MIN_BOX_H` becomes a min-*side* floor

`MIN_BOX_H = 142` exists so a box stays grabbable. Height-only, a 9:16 cell
would floor at 142×80 — too narrow to hit its handles.

Rename to `MIN_BOX_SIDE = 142` and floor both axes:

```ts
effectiveMinH(source, ratio) =
  min(ceil(max(142, 142 / ratio)), maxBox(source, ratio).h)
```

For 9:8 this evaluates to exactly 142, so current behaviour and tests are
untouched. For 9:16 it yields a box of 142×253; for 9:4, 320×142.

The `ceil` is load-bearing: what matters is that the floor is an **integer**.
`142 / 0.5625 = 252.444`, and `boxFromHeight` rounds its clamped height — so a
floor left fractional makes the smallest constructible 9:16 box `h = 252`
while `isValidBox`, reading the same fractional floor, rejects it. The
validator would refuse its own constructor's output, at one ratio only.
Verified empirically before this spec was finalised.

## Module changes

Layering stays strict and acyclic. `layout.ts` depends on `geometry.ts` for
types and `OUTPUT`; nothing in `geometry.ts` learns about layouts.

```
geometry ← layout ← { state, editor, preview, main } and { ffmpeg, index }
```

### `src/layout.ts` (new)

Holds `Row`, `Layout`, `LAYOUTS`, `DEFAULT_LAYOUT_ID`, `layoutById`,
`cellsOf`, `ratioOf` and `defaultBoxes`. `layoutById` is a table lookup
returning `null` for an unknown id, so a `layoutId` arriving from the wire is
never interpolated into anything — the same posture as `/api/export` taking
window bounds instead of a file path.

`defaultBoxes` lives here rather than in `geometry.ts` because it is the one
box constructor that needs to know about layouts, and `geometry.ts` importing
`Layout` would make the dependency a cycle. The layering above is what decides
this: `geometry.ts` never learns what a layout is.

### `src/geometry.ts`

- Delete `BOX_RATIO` and `HALF`. Both encoded "there is one cell shape".
- `MIN_BOX_H` → `MIN_BOX_SIDE`, with the two-axis floor above.
- Add a `ratio` parameter to `maxBox`, `boxFromHeight`, `resizeFromCorner`,
  `isValidBox`.
- Unchanged, being ratio-free by nature: `clampToBounds`, `moveBy`,
  `displayScale`, `toDisplay`, `fromDisplay`.
- `defaultBoxes` **moves out** of this module into `layout.ts` (see the
  layering note there) and becomes:

  `defaultBoxes(source, layout) → Rect[]`: every cell gets `maxBox` at its own
  ratio. Boxes are then **grouped by cell ratio** and each group is spread
  independently, along whichever source axis has more slack for that group's
  box size (`source.w - w` vs `source.h - h`, x winning an exact tie), centred
  on the other axis. Within a group of size `k`, box `i` sits at
  `round(i * slack / (k - 1))`, or centred when `k === 1`.

  Grouping by ratio is what makes this well-defined for the mixed layouts:
  `2h-2v` holds two 540×960 cells (tall, x slack) and two 1080×480 cells
  (wide, y slack), and a single global spread axis would be wrong for one pair
  or the other. Two boxes from *different* groups may overlap, which is
  harmless — they are different shapes, so their handles do not coincide.

  For `1-1` on a 16:9 source this is one group of two, computing `x = 0` and
  `x = source.w - w` with `y` centred — bit-identical to today's left/right
  pin. For a group of 9:4 cells, which are as wide as the source and therefore
  have no x slack, it spreads down the frame instead; spreading on x would
  stack identical boxes on top of one another.

### `server/ffmpeg.ts`

`buildFilter(layout, boxes)` replaces `buildFilter(top, bottom)`. One decode,
split N ways, each leg cropped and scaled to its cell, composed by a single
`xstack`:

```
[0:v]split=N[c0][c1]…;
[c0]crop=w:h:x:y,scale=cw:ch:flags=lanczos[s0];
…
[s0][s1]…xstack=inputs=N:layout=0_0|540_0|…[v]
```

The `layout=` string is built from `cellsOf`. One `xstack` rather than
`hstack`-per-row-then-`vstack` avoids special-casing single-column rows, and
for `1-1` produces output pixel-identical to today's `vstack`.

`assertBoxes(layout, boxes, source)` checks the box count against the cell
count, then runs `isValidBox` per box against **that cell's** ratio. The error
message names the cell index and its expected ratio.

`ExportOpts` carries `layout` and `boxes` in place of `top` and `bottom`.

### `src/state.ts`

`boxTop: Rect | null` and `boxBottom: Rect | null` become:

```ts
layoutId: string;   // default "1-1"
boxes: Rect[];      // [] = not framed yet, else length === cellsOf(layout).length
```

`readSaved` migrates legacy records: a stored object with `boxTop`/`boxBottom`
and no `boxes` becomes `{ layoutId: "1-1", boxes: [boxTop, boxBottom] }`.
Already-framed videos keep their framing.

The save gate generalises to
`phase === "framing" && boxes.length === cellsOf(layout).length`, with
`layoutId` and `boxes` persisted as a unit and carried forward from the
previous record otherwise.

`restore` drops `boxes` to `[]` on any of: unknown `layoutId`, count mismatch
against the layout's cells, changed source resolution, or a per-cell
`isValidBox` failure. It **keeps a known `layoutId`** — a re-fetch at a
different resolution should cost the boxes, not the layout choice.

Switching layout resets boxes to that layout's defaults.
`ponytail:` a `boxesByLayout` map would preserve a framing per layout; add it
if flipping between layouts to compare gets annoying.

### `src/editor.ts`

`Which = "top" | "bottom"` becomes a cell index; `nodes` becomes an array;
labels become `1…N`.

The overlap z-order rule needs generalising with care. Native hit-testing
follows paint order, so the last-appended sibling wins where boxes overlap,
and the current code puts the smaller box on top, favouring TOP on a tie.
Generalised:

```ts
indices.sort((a, b) => area(b) - area(a) || b - a)
```

Largest appended first; ties broken so the earlier index still lands on top.
Without the tie-break, a 2×2 grid of equal-size boxes leaves cell 1's handles
unreachable underneath cell 4.

### `src/preview.ts`

Loops the cells: `drawImage(video, box.x, box.y, box.w, box.h, cell.x, cell.y,
cell.w, cell.h)`.

### `src/main.ts`

Nine mini-diagram buttons in the framing bar. Each is a 1080×1920-proportioned
box (~20×36 px) with its `cellsOf` rects drawn as absolutely-positioned divs;
the selected one takes `.btn-solid` and `aria-pressed`. Nine text labels would
swamp the bar, and for a visual tool the diagram *is* the label. New
`.layouts` / `.layout-pick` / `.layout-cell` recipes go on the existing
hand-rolled token layer, not fresh literals.

Selecting a layout does `setState({ layoutId, boxes: [] })` then `save()`;
`ensureFraming` re-defaults the boxes.

Critical wiring: `ensureFraming`'s `framingFor === s.clipUrl` guard already
keeps `videoEl` alive across a layout change, but the editor's node count is
now layout-dependent. It gains an `editorFor === layoutId` guard that remounts
the `.boxes` overlay and restarts the preview loop on a layout switch —
without touching `videoEl` or any other child of `sourceSlot`. The
persistent-shell rule is unchanged: never empty `sourceSlot` or `outSlot`.

### `src/api.ts` and `server/index.ts`

The `/api/export` body carries `layoutId: string` and `boxes: Rect[]` in place
of `boxTop` and `boxBottom`. The route resolves `layoutId` through
`layoutById` and answers 400 for an unknown id before looking at the boxes,
then validates the boxes through `assertBoxes` as it does today (a plain
`Error` mapped to a clean 400 rather than a 500).

## Testing

`geometry.ts` keeps its exhaustive coverage, now parametrised. `layout.ts` is
new pure data-plus-derivation and gets its own exhaustive tests, for the same
reason: its bugs are silent, showing up as a seam or a mis-tiled export.

- **`src/layout.test.ts`** (new): for all nine presets — cells tile 1080×1920
  exactly (area sum, zero pairwise overlap, every cell in-bounds), row heights
  sum to 1920, `1080 % cols === 0`, `cellsOf` is row-major, ids unique.
- **`src/geometry.test.ts`**: parametrised over the three real ratios (1.125,
  0.5625, 2.25). The existing exact 9:8 numbers stay as a regression fence.
  Adds per-ratio height-driven idempotence and the min-side floor. Both
  mutation-tested invariants stay mutation-tested. Adds `defaultBoxes` cases:
  `1-1` reproduces today's exact left/right pin, every layout returns
  `isValidBox` rects against their own cell ratios, and boxes within a
  ratio group do not coincide.
- **`server/ffmpeg.test.ts`**: the existing 2-cell pixel test stays untouched.
  Adds a 3-cell `2v-1` pixel test against a red/green/blue-banded source,
  asserting each output cell's centre colour — this is what proves the
  `xstack` layout string's ordering, the way the `vstack` leg-swap mutation
  test proves it today. Plus a filter-string test for a 4-cell layout.
- **`src/state.test.ts`**: legacy `boxTop`/`boxBottom` migration, the N-box
  save gate, per-cell-ratio restore rejection, and `layoutId` surviving a box
  rejection.

DOM-driven modules (`main`, `editor`, `preview`, `player`) stay untested by
design — vitest runs `environment: "node"` here.

## Out of scope

- Per-layout box memory (`boxesByLayout`) — noted as a `ponytail:` above.
- Arbitrary/custom layouts, a layout editor, or a split-tree layout language.
  Nine presets, expressible as row lists.
- Non-exact-aspect crops (letterboxing or stretching a crop into a cell).
- Per-cell audio selection. Audio still comes from the source stream via
  `-map 0:a?`.
- Gaps, borders, or backgrounds between cells. Cells tile exactly.
