# vstack — white gutters and rounded pieces

Date: 2026-08-22
Status: implemented
Supersedes parts of: `docs/specs/2026-08-21-vstack-layouts-design.md`
(which listed borders as out of scope, and described `xstack` as producing
`[v]` directly)

## Problem

Every layout tiles 1080×1920 edge to edge, so two pieces of a composite meet
at a hard seam. Where both pieces are dark the seam is invisible and the short
reads as one confusing frame; where they differ it reads as an accident rather
than a design. Exported shorts look unfinished next to anything hand-made.

Goal: a small white gutter between the pieces and around the frame, and a
small corner radius on each piece.

## The one decision that matters

A gutter can be built two ways, and only one of them is safe.

**Rejected — shrink the cells.** Inset each cell by the gutter and let
`cellsOf` return the smaller rects. This is the obvious move and it is wrong:
`ratioOf` reads `cell.w / cell.h`, so a 1080×960 cell inset by 10 becomes
1060×945 and its ratio moves from 1.125 to 1.1217. Every stored crop box is
then invalid against its own cell, `restore` and `assertBoxes` reject a whole
saved session, and `layout.test.ts`'s exact-tiling assertions fail. Worse, the
boxes that survive export stretched by the gutter's fraction of the cell.

**Chosen — paint over the composite.** Cells are untouched. The composite is
built edge to edge exactly as before, and a white overlay with rounded holes
punched in it is applied last. The gutter therefore *trims* a few px off each
piece rather than squeezing it, so the aspect of every piece stays exact and
every stored box stays valid.

This is the same reasoning that keeps crop rects in source pixels with zero
conversion: a layout cell contributes only a destination. The frame overlay
contributes only a destination too.

## Model

`src/frame.ts`, pure, sitting at `geometry ← layout ← frame`:

```
GUTTER = 10          // output px; must be even
CORNER_RADIUS = 24   // output px
windowOf(cell): Rect      // the cell's visible window
windowsOf(layout): Rect[] // cellsOf(layout).map(windowOf)
maskRgba(windows): Uint8Array
```

A cell's **window** is the cell inset by `GUTTER` where it meets the frame
edge and `GUTTER / 2` where it meets a neighbour. Because cells tile exactly,
two neighbours each give up half the seam, so every internal seam and every
frame margin is exactly `GUTTER` wide. That is why `GUTTER` must be even — an
odd gutter puts a fractional offset on a window, and a fractional overlay
offset does not survive ffmpeg.

`windowOf` is per-cell rather than per-layout so the preview, which already
holds `cells`, maps over them instead of accepting a second parallel array
that could disagree with the one the export's mask was rendered from.

`maskRgba` returns `OUTPUT.w * OUTPUT.h * 4` bytes: opaque white outside the
windows, transparent inside, with 4×4 coverage sampling on the arcs so they
do not jag at 1080 wide. All three colour channels are white everywhere,
including where alpha is 0, so a partially covered arc pixel can only blend
towards white. Containment is the standard rounded-rect test — clamp the
point into the rect the four arc centres span, then compare the distance to
that clamped point against the radius, which degenerates to the flat edge for
free on the straight runs.

## Preview

`src/preview.ts` derives `windows = cells.map(windowOf)` once and, after the
existing `drawImage` loop, paints:

```
ctx.fillStyle = "#fff"
ctx.beginPath()
ctx.rect(0, 0, OUTPUT.w, OUTPUT.h)
for (const w of windows) ctx.roundRect(w.x, w.y, w.w, w.h, CORNER_RADIUS)
ctx.fill("evenodd")
```

Even-odd punches the windows out of the full-frame rect. One fill per frame,
and no invalidation needed when the layout changes because the preview is
rebuilt anyway (see `ensureFraming`'s `sameLayout` guard).

## Export

ffmpeg has no rounded-rect filter. A per-frame `geq` alpha would cost more
than the encode, so the mask is pre-rendered once and blended as an ordinary
image input.

`server/mask.ts`:

- `MASK_DIR = media/masks`
- `maskPath(layout, dir?)` → `<layoutId>-g<GUTTER>-r<CORNER_RADIUS>.png`.
  Both constants are in the filename because the mask outlives the process:
  keyed on the layout alone, editing `GUTTER` would keep serving the old
  border to exports while the preview — which recomputes every frame —
  showed the new one.
- `ensureMask(layout, dir?)` writes `maskRgba` to a UUID-named `.rgba`, has
  ffmpeg's rawvideo demuxer encode it to a UUID-named `.part.png`, and
  renames into place. No PNG encoder and no new dependency; the UUID and the
  rename are the same discipline `fetchWindow` uses for clips, so two
  concurrent exports cannot leave a half-written mask in the cache.

`server/ffmpeg.ts`:

- `buildFilter` ends `…xstack=…[stack];[stack][1:v]overlay=0:0:format=auto[v]`.
- `ExportOpts` gains `mask: string`, and `exportClip` adds `-loop 1 -i <mask>`
  as input 1. Both inputs are declared before `-ss`, or `-ss` would attach to
  the mask as an input option instead of staying an output option on the clip.

`mask.ts` needs `MEDIA_DIR` from `ffmpeg.ts`, so it sits *above* it and the
mask path is passed into `exportClip` rather than resolved there. That keeps
the server layering acyclic: `errors ← ffmpeg ← {ytdlp, mask} ← index`.
`/api/export`'s request body is unchanged — the mask is derived from the
already-validated `layoutId`, so no new client-supplied value exists.

## Testing

- **`src/frame.test.ts`** — `GUTTER` is even; `windowOf` is the rule
  `windowsOf` maps; windows stay strictly inside their cells; the frame
  margin is exactly one gutter on all four sides; every *edge-sharing pair of
  cells* yields windows exactly one gutter apart (adjacency is decided on the
  cells, because every pair of windows has a positive gap); windows are
  integers with room for two radii. For `maskRgba`: buffer size, white in RGB
  everywhere, transparent at a window centre, opaque in the margin and the
  seam, opaque at a window's *square* corner — which is what fails if the
  radius goes to 0 — transparent along a straight edge, and at least one
  partially covered pixel in each corner square.
- **`server/mask.test.ts`** — the filename carries the layout id and both
  constants; different layouts get different files; `ensureMask` renders a
  1080×1920 PNG whose decoded alpha matches the windows; no `.rgba`
  intermediate is left behind; a second call reuses the cached file.
- **`server/ffmpeg.test.ts`** — the filter string ends in the overlay with
  exactly one `[v]`, and a real export is checked for white pixels in the
  frame margin and the seam, a white pixel halfway along a corner cut's
  diagonal, and the source's colour just inside a piece past the gutter. That
  last pair is the preview/export agreement for the border: the canvas
  punches the same rounded windows out of a white frame that the mask does.

`src/preview.ts` stays untested, like the other DOM-driven modules.

## Out of scope

- UI controls for gutter or radius. Two constants; edit them to change the
  look. Sliders would mean new `AppState` fields, save/restore migration, new
  `/api/export` body fields and server validation.
- Non-white gutters, per-piece borders, drop shadows, or a background image.
- Evicting stale masks when a constant changes. `media/` has no eviction at
  all yet; a mask is ~30 KB against a cache already in the tens of MB.
