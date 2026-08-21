import { OUTPUT, clampToBounds, maxBox } from "./geometry.ts";
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

/** `layoutById(id) ?? DEFAULT_LAYOUT`, named and shared so every caller that
 *  wants *a* layout rather than *this exact id or nothing* falls back the
 *  same way. Before this existed, `main.ts` repeated the idiom at three call
 *  sites while `state.ts`'s `save()` fell back to a synthesised zero-cell
 *  layout instead — two different answers to "what does an unknown id mean"
 *  in the same codebase. Unreachable today (`restore` only ever returns a
 *  known id or `DEFAULT_LAYOUT_ID`, and the picker only ever sets a known
 *  id), but "unreachable" is exactly the kind of guard that silently stops
 *  being true after a refactor, so it is worth resolving one way on
 *  purpose. */
export function resolveLayout(id: string): Layout {
  return layoutById(id) ?? DEFAULT_LAYOUT;
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
