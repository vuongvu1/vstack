# vstack — custom floating boxes

Date: 2026-08-25
Status: implemented
Extends: `docs/specs/2026-08-21-vstack-layouts-design.md` (the layout system)
and `docs/specs/2026-08-22-vstack-frame-borders-design.md` (the gutters and
the frame overlay). Neither is superseded: cells, `ratioOf`, `xstack` and the
paint-over-the-composite rule all survive intact, which is the point of the
design below.

## Problem

The nine layouts tile the frame, and a tiling cannot express the shot every
reaction short wants: a small piece floating over a big one. A facecam inset,
a zoomed detail over a wide shot, a logo crop in a corner — all of them need
a piece whose size and position in the *output* frame are the user's choice
rather than a preset's.

Goal: after picking a layout, a `+ Box` button adds a free piece. Its output
rect (size, position, therefore aspect) is dragged on the composite preview;
its crop rect is dragged on the source video exactly like every other box. It
carries the same white border and corner radius as the preset pieces.

## The one decision that matters

A free rect cannot come from `cellsOf`. `Layout` is authored as rows and
cells are derived precisely so that a hand-written cell list cannot express a
seam or an overlap — and a floating box is an overlap by definition. So the
custom boxes are a *second, parallel* concept rather than more cells.

**Rejected — virtual layout.** Synthesise a `Layout` whose cell list is
`cellsOf(preset) ++ customRects`. One array everywhere and `buildFilter`
barely changes. It hands back the exact footgun the rows model removes, and
it leans on `xstack` composing non-tiling, overlapping inputs, which is not a
behaviour to depend on.

**Rejected — uniform `pieces` array.** Collapse cells and customs into one
`{ out, crop }[]` and drop `layoutId` from `/api/export`. Conceptually
cleanest. But `layoutId` is a table-lookup trust boundary (`layoutById`) and
the mask cache key, and this rewrites every existing test for no user-visible
gain.

**Chosen — `customs` alongside `boxes`.** The preset composes exactly as
today; customs are extra decode legs overlaid on the finished stack. Zero
customs is byte-identical to today's filter string and today's mask
filename, so the whole feature is inert until used.

## Data model

```ts
export type CustomBox = { out: Rect; crop: Rect };
export const MAX_CUSTOM = 2;
export const MIN_OUT_SIDE = 160;   // output px
```

`out` is output space (inside 1080×1920); `crop` is source pixels, like every
other rect in this codebase, with zero conversion between the two — the same
invariant that makes `drawImage` and `crop=` agree.

Rules:

- `out` is clamped fully inside `OUTPUT`, each of `x/y/w/h` **even**, each
  side at least `MIN_OUT_SIDE`. Even because an `overlay` at an odd offset in
  `yuv420p` puts the piece on a half-chroma-sample boundary; even costs
  nothing and removes the question.
- `crop` obeys the existing aspect lock against *its own* ratio:
  `isValidBox(crop, source, out.w / out.h)`. `isValidBox` already takes the
  ratio as a parameter — a custom box is exactly the case that parameter was
  written for, one step further than "a box is only legal for its own cell".
- Resizing `out` changes its ratio, so `crop` is **re-snapped live**: keep
  `crop.h` and `crop`'s centre, rebuild the width with
  `boxFromHeight(crop.h, source, newRatio)`, then `clampToBounds`. Aspect
  stays exact at every frame of the drag, so the export can never stretch.
  Height-driven, like every other constructor, so repeated re-snaps do not
  drift. An extreme ratio needs no special case: `boxFromHeight` already
  clamps between `effectiveMinH` and `maxBox(source, ratio).h`, so a very
  wide `out` yields a shorter crop rather than an invalid one.
- Defaults on `+ Box`: 540×540 centred; a second one offset by (60, 60) so
  its handles are not buried under the first's.
- Persisted per video in `Saved.customs`, behind the same
  `phase === "framing" && valid` gate as `boxes`, and dropped by `restore`
  under the same conditions (source-size change, more than `MAX_CUSTOM` of
  them, or any custom failing validation). The count is bounded as well as
  the shapes for the same reason the boxes are checked against the layout's
  cell count: a hand-edited record with three legal pieces would otherwise
  restore, mount and preview, then 400 at `assertCustoms` on export. The
  layout choice survives all of that, as it does today.

## Rendering: one mask, applied last

The custom piece sits *over* the stack, so its ring and rounded corners
cannot come from today's overlay unchanged. Two failure modes make that
concrete:

- A corner nub of the custom's square rect that lands inside a cell window
  would be transparent in today's mask, so the piece would show an unrounded
  corner over that cell.
- A custom straddling a cell seam would get the seam's white stripe painted
  through it.

So the mask keeps its "applied last" position and gains a **z-aware walk**
over the customs — not a flat priority order, because with two pieces there
is a third failure mode: whichever flat order you pick, one of the two pieces
loses its ring and its rounded corners wherever the pieces overlap. The
binding intent is the compositing order the filter graph already uses, so the
mask walks the pieces from topmost (last in the array) down, and the first
piece whose *ring rect* contains the sample decides it and stops the walk:

```
for j from customs.length - 1 down to 0:
    if inside ringOf(customs[j]) rounded at CORNER_RADIUS + GUTTER:
        opaque white   if NOT inside customs[j] rounded at CORNER_RADIUS
                       (that piece's ring, or a nub cutting its corner)
        transparent    otherwise  (that piece's window — it shows)
        decide and stop walking
if no piece's ring rect contained it:
    opaque white   if outside every cell window
    transparent    otherwise
```

where a custom's *window* is its `out` rounded at `CORNER_RADIUS`, and its
*ring rect* is `out` expanded by `GUTTER`, rounded at
`CORNER_RADIUS + GUTTER`. The ring gives the piece the same visual weight as
a seam; the nubs cut its square corners. A piece's window is always inside
its own ring rect, so "inside a window" is always reached by that piece's own
branch and never falls through to the gutter rule.

Check the three failure modes against the walk: a seam pixel inside a custom
window is transparent, so the custom shows; a nub pixel is opaque white
whatever is under it; and where two pieces overlap, the upper one's ring and
nubs are opaque while the lower one's ring is not painted across it. All
three hold.

The walk reduces exactly — byte-for-byte — to the pre-custom behaviour at
zero pieces, and to a `window-beats-ring-beats-gutter` flat order at one.
That identity is what keeps today's cached masks and `server/mask.test.ts`
valid, and it is why the two-piece case is the only one that can regress.

`maskRgba(cellWindows, customOutRects = [])` — same `SUB × SUB` coverage
sampling, with `insideWindow` generalised to `insideRounded(rect, radius,
px, py)`. `customOutRects` are in **array order**, the same z order the
overlay chain composes them in.

Filter graph:

```
[0:v]split=N+M[c0]…[cN-1][k0]…[kM-1];
[ci]crop=…,scale=cell[si];
[s0]…[sN-1]xstack=inputs=N:layout=…[stack];
[kj]crop=…,scale=out.w:out.h[tj];
[stack][t0]overlay=x0:y0[o0];
[o0][t1]overlay=x1:y1[o1];
[o1][1:v]overlay=0:0:format=auto[v]
```

The mask stays input 1 and stays declared before `-ss` — the existing rule
about ffmpeg attaching options to the next `-i` is unchanged.

The canvas preview draws in the identical order: stack pieces, then each
custom as a plain `drawImage` rect, then the white decoration. Same order as
ffmpeg means the preview/export agreement is preserved by construction rather
than by coincidence.

The decoration is where the walk has to be mirrored, because `clip()`
intersects and cannot be undone except by `save`/`restore`:

- the **gutter fill** (full-frame white, even-odd minus the cell windows) is
  clipped by the complement of *every* piece's window;
- then, per piece `j` **in array order**, its **ring fill** (`ringOf(out)`
  rounded at `CORNER_RADIUS + GUTTER`) is clipped by the complement of the
  windows of pieces `k >= j` — itself and everything above it.

One `clip("evenodd")` of "full frame plus this piece's rounded rect" per `k`
in that range gives exactly that, since `clip()` intersects. Clip all pieces
on every ring fill and the upper piece loses its ring over the lower one;
clip only the piece itself and the lower piece's ring stripes across the
upper one.

Mask cache key: `${layout.id}-g${GUTTER}-r${CORNER_RADIUS}` as today, plus
`-c<hash>` **only when customs exist**, where `<hash>` is the first 8 hex
digits of a sha1 over the `out` rects in array order (`x,y,w,h` joined). Hex
only, so nothing client-shaped reaches the path — the rects are validated
integers by then anyway. Today's cache
files, filenames and `server/mask.test.ts` are therefore unchanged, and
editing a custom rect cannot serve a stale border.

## Editing: two overlays, one generalised editor

`mountEditor` is widened rather than cloned:

```ts
mountEditor({
  host,
  media: HTMLElement,              // was HTMLVideoElement; a canvas has the same box API
  bounds: () => Size,              // was source(): source px, or OUTPUT for the canvas
  count: number,                   // fixed at mount, as the cell list is today
  move / resize: (rect, …, index) => Rect  // injected; the editor holds no geometry
  boxes, onChange, onCommit,
}): { place, stop }                // was a bare teardown fn; see the drag bullet
```

Injected rather than a `ratios()` getter, so the aspect-locked source rules
and the free-aspect output rules each stay in the module that tests them.

- **Source overlay** (over `videoEl`, as today): `count = cells.length +
  customs.length`; the injected `resize` closure calls `resizeFromCorner(rect,
  corner, dx, dy, source, ratioOf(cell))` for a cell index and each custom's
  own crop-resize rule for a custom index. A closure, not a live getter, is
  what lets a custom's ratio change *while* the user resizes it on the
  preview, since the crop handles have to follow within that same drag.
- **Output overlay** (new, over `canvasEl`): `count = customs.length`,
  `bounds = () => OUTPUT`, every ratio `null`. Preset cells get no nodes —
  presets stay presets.
- New output-space primitive `resizeOut(rect, corner, dx, dy)` — **in
  `src/custom.ts`, not `src/geometry.ts`**: the anchor-corner math of
  `resizeFromCorner` without the ratio derivation, plus even-snapping. It
  bakes in `OUTPUT` and `MIN_OUT_SIDE` rather than taking them as `bounds`
  and `minSide` parameters, precisely so that those two output-space
  constants stay out of `geometry.ts` — the module that must never learn
  anything about the frame's decoration or its bounds. Same reasoning that
  put `defaultBoxes` in `layout.ts`. `clampToBounds` is unchanged and still
  slides rather than shrinks.
- Both editors remount when `layout.id` **or** `customs.length` changes —
  `editorFor` becomes `${layout.id}:${customs.length}`. Node count is fixed
  at mount, the same rule as today, and neither remount reassigns
  `video.src`.
- A drag on the output overlay emits one `setQuiet` patch carrying the new
  `out` *and* the re-snapped `crop`. The rAF canvas follows for free — it
  re-reads state every frame — but the source overlay is DOM and only moves
  when its own `place()` runs, which nothing in this drag would otherwise
  reach. So `mountEditor` returns `{ place, stop }` rather than a bare
  teardown, `main.ts` keeps the source overlay's handle module-scoped, and
  the output overlay's `onChange` calls `place()` on it. `save()` on commit
  only.
- Colours: customs take the two per-index scales after the last cell's.
  `labelFrom` is the cell count, so on the two-cell default layout a piece is
  `box-c2`/`box-c3` (grass/violet) and `box-c4`/`box-c5` — two new Radix
  scales, `cyan` and `orange`, since `red` stays reserved for errors — are
  only ever seen on a four-cell layout. Six scales cover four cells plus two
  pieces either way, so no collision is possible. Imported with their alpha
  companions like every other scale.

## UI and state flow

- Framing bar, layout row: `+ Box` after the layout swatches, disabled at
  `MAX_CUSTOM`. Removal is an `×` on the box's own node in the output
  overlay — no second bar control, and it removes the thing being pointed at.
- A layout switch clears `boxes` as today but **keeps `customs`**: a custom's
  ratio is its own, its crop is validated against itself, and its `out` is
  frame space. Nothing about it is invalidated by the cells changing. That is
  the payoff of keeping the two concepts parallel.
- `+ Box` and `×` go through `setState` (node count changes → remount);
  drags stay on `setQuiet`, so no re-render lands mid-drag and the `<video>`
  never reloads.
- Export gating is unchanged — still `starterTitle` alone.
- `/api/export`'s body gains `customs`. `/api/probe`, `/api/window`,
  `/api/say`, publish and reveal are untouched, and the `preview` phase is
  unaffected: the file on disk already has the border baked in.

## Server validation

`assertCustoms(customs, source)` sits next to `assertBoxes` in
`server/ffmpeg.ts`, with the same posture — numbers are the only thing
interpolated into the filter string, so a NaN or an out-of-bounds rect must
die before ffmpeg sees it:

```
Array, length ≤ MAX_CUSTOM
out:  all four fields integer and even, w and h ≥ MIN_OUT_SIDE,
      x ≥ 0, y ≥ 0, x + w ≤ OUTPUT.w, y + h ≤ OUTPUT.h
crop: isValidBox(crop, source, out.w / out.h)
```

`raw.customs` absent is `[]`, so a body from an older client still exports.

## Testing

- `src/custom.test.ts` — **not `src/geometry.test.ts`**, since `resizeOut`
  lives in `src/custom.ts`: even snapping, the `MIN_OUT_SIDE` floor,
  clamping, all four anchor corners, and idempotence under repeated
  application. The crop re-snap: exact ratio after an `out` resize, no drift
  over repeated calls.
- `src/frame.test.ts` — the mask with one custom: ring opaque, window
  transparent, a corner nub over a cell window opaque, a seam pixel inside a
  custom window transparent. The last two are mutation-tested: they are the
  two failure modes the walk exists to prevent. Then the mask with **two
  overlapping** customs, at exactly the rects two `+ Box` clicks produce: the
  upper piece's nub and its ring stay opaque where they sit over the lower
  piece's window, and the lower piece's ring stays transparent inside the
  upper piece's window. The first two of those are mutation-tested against
  the walk losing its z order; the third is what fails if the walk is
  "fixed" by simply swapping the window and ring tests.
- `server/mask.test.ts` — path unchanged with no customs, different under a
  changed custom rect, decoded PNG matching the windows.
- `server/ffmpeg.test.ts` — real ffmpeg over a synthetic multi-colour source:
  a 3-cell layout plus one custom, asserting the custom's source colour at
  its centre, white in the ring, and the stack's colour just outside the
  ring. Then a second export with two overlapping customs cropped from
  different colour bands — the only end-to-end proof that the mask is
  z-aware, since the hand-traced samples cannot show what ffmpeg actually
  composited. Plus a regression fence: `buildFilter(layout, boxes, [])` byte-
  identical to today's string.
- `src/state.test.ts` — customs round-trip; a stored record holding more than
  `MAX_CUSTOM` pieces restores as none; mutation: persisting customs outside
  `framing` fails.
- `assertCustoms` — odd coordinates, off-frame rects, a wrong-ratio crop,
  three customs, a non-object.

DOM-driven modules stay untested by design, as today: the two overlays are
verified by hand in a real browser and through a real export.

## Out of scope

No z-order control — customs draw in array order, last on top. No per-custom
radius or gutter. No numeric entry fields for the output rect. No snap guides
or alignment helpers. No drop shadow. A custom box cannot be promoted into a
preset cell, and a preset cell cannot be detached into a custom box.
