# vstack — per-box time offsets (chat sync)

Date: 2026-11-26. Supersedes nothing. Extends the layouts doc, the
custom-boxes doc, the segments doc and the speed-ranges doc without
replacing any of their rules, and adds one optional field to `/api/export`'s
body (`offsets`, on top of everything the speed-ranges doc lists).

## Intent

A livestream's chat panel lags the picture by a few seconds: the moment
happens in the game/cam, and the chat reacts 2–5 s later. When a short puts
the stream and its chat in two boxes, the reactions land after the moment
they are about. The user wants to shift ONE box in time relative to the
others, so the chat box shows footage from a few seconds later, and the reaction
lands on the moment.

Success: in the exported video, a box set to `+3` shows exactly the footage
the source had 3 s later than every `0` box, everywhere in the export —
including across multi-part trims, framing cuts and speed-ups, with no chat
from the neighbouring part bleeding across a join.

## Goals

- A `− N +` control above every adjustable crop box in the framing phase —
  each layout cell and each floating piece. `N` is an integer number of
  seconds, shown as `0`, `+1`, `-1`, …; `−` subtracts 1, `+` adds 1.
- The export honours it for every box, on single-range clips, multi-part
  stitches, framing cuts and speed ranges, in any combination.
- An export with every offset at 0 is byte-identical to today's.

## Non-goals

- **The preview does not shift.** The user said so explicitly: "if it's
  hard to have it in the preview then we can only need it applied in the
  export video". The canvas keeps drawing every box from the one framing
  `<video>`; a shifted box gets a `+3s` badge on the canvas so the
  divergence is visible rather than silent. This is a DELIBERATE, labelled
  preview/export divergence — the one place this codebase accepts it —
  and is marked `ponytail:` in code. Upgrade path: one hidden `<video>` per
  distinct offset, synced to the main one's `currentTime + offset`.
- No sub-second steps.
- No per-box audio. Audio always comes from the main (offset-0) timeline.
- No offsets on the long, lofi, cutter, reader or video-cutter journeys.

## Anti-goals

- Chat from part 2 appearing at the end of part 1 (or vice versa) in a
  multi-part export. That is the failure the chosen approach exists to
  avoid.
- A shifted box whose duration drifts from the others (the composite would
  desync or ffmpeg would cut it short).
- Any change to an export that uses no offsets.

## Constraints (from the codebase)

- Every fetched part carries `PAD` (5 s) of spare footage either side
  (`fetchOne`: `[floor(start − PAD), ceil(end + PAD)]`, clamped to the
  video's own bounds). A multi-part stitch (`fetchWindow` → `concatClips`)
  keeps NO pad between parts, so the framing clip itself has no footage to
  shift into at a join — the per-part files do.
- `/api/export` today: `start`/`end`/`cuts`/`speeds` are in the framing
  clip's timeline (`windowStart..windowEnd`; for a stitch `0..ceil(total)`).
  `planLegs` turns them into legs; with cuts or speeds the route runs
  `concatClips` on the cached clip and `exportClip` on the result from 0.
- `buildFilter` starts `[0:v]split=N`; inputs are 0 = clip, 1 = mask, then
  badges. Input indices are positional and load-bearing.
- `cellsOf` order is load-bearing in four places; offsets for cells follow
  that order.

## Approaches considered

**A. A shifted twin per distinct offset (CHOSEN).** For each distinct
non-zero offset, the export runs the same stitch a second time with every
leg moved by the offset, reading from the PAD'd per-part files, then the
boxes with that offset crop from the twin instead of the main clip. Reuses
`concatClips` wholesale, so cuts, speed legs (`tmix`, `setpts`) and SAR/fps
normalisation come for free and the twin's leg lengths match the main's by
construction. Cost: one extra stitch pass per distinct offset.

**B. Composite each part, then stitch.** Reorder the export so the
composite is built per part and the parts joined afterwards. Rejected:
rewrites the order of the whole export pipeline and puts every existing
export at risk for one feature.

**C. Download a separate shifted copy from YouTube.** Same as A with more
network. Rejected: every extra fetch is another bot-check/403 failure.

The user picked A.

## Design

### Data model (client)

- `AppState.offsets: number[]` — one per layout cell, in `cellsOf` order.
  Missing/short array means 0 for the missing cells.
- `CustomBox` gains an optional `offset?: number` (absent = 0), so a
  piece's offset travels with the piece through reorder, removal and layout
  switches (customs survive a layout switch; cell offsets are cleared with
  the cells' boxes).
- Range: integers in `[-MAX_OFFSET, MAX_OFFSET]`, `MAX_OFFSET = PAD` (5),
  exported from `src/geometry.ts` beside `PAD` so the two cannot drift.
- Persisted per video in the `Saved` record (`offsets` beside `boxes`;
  a piece's `offset` inside `customs`), under the same framing gate as
  `boxes`. `restore` drops anything not an integer in range (falls back to
  0), and bounds `offsets.length` by the restored layout's cell count.

### UI

- Above each crop box in the source overlay (`src/editor.ts`, over the
  framing `<video>` — the "adjustable capture window"), a small
  `− N +` group pinned to the box's top edge, moving with it on drag.
  Label: `0`, `+N`, `-N`. Buttons disable at the bounds.
- Clicks write through `setQuiet` and update the label in place (the drag
  path's rule — no re-render under the pointer), then `save()`.
- Canvas preview (`src/preview.ts`): a shifted box gets a small `+3s` /
  `-2s` badge in its top-left corner, drawn after the composite and before
  the mask. Not drawn in thumbnail view (`showThumb`).
- Multi-part reopen without stored segments: see "Unavailable" below.

### `/api/export` body

New optional fields (a piece's offset rides inside its own custom):

```
offsets?: number[]        // per cell, cellsOf order; absent = all 0
customs[i].offset?: number
segments?: Segment[]      // source-timeline ranges; required iff digest !== "" and any offset ≠ 0
```

Validation: each offset an integer in `[-MAX_OFFSET, MAX_OFFSET]`;
`offsets.length <= cells`; `isValidCustom` ignores `offset` (validated
separately here, so `isValidCustom`'s existing callers are unchanged).
When `digest !== ""` and any offset is non-zero, `segments` is required,
must pass `isValidSegments`, and `segmentDigest(segments)` must equal
`digest` — the hash makes the client's segment list verifiable against the
clip it claims to describe (400 on mismatch: "Trim ranges don't match this
clip — re-open it from Trim to use offsets.").

### Server: the leg mapping (pure, tested)

New pure function in `src/segments.ts` (bottom layer, imports nothing):

```
shiftLegs(legs, sources, offset) → ConcatPart-like { src, start, end, speed }[]
```

- `sources`: the framing clip's timeline expressed as source files:
  - single range (`digest === ""`): one source covering
    `[windowStart, windowEnd]` → the cached clip itself, file offset
    `t - windowStart`, file length = probed duration.
  - stitch: one source per segment, in order. Segment `i` occupies clip
    time `[cum_i, cum_i + len_i]` and lives in part file `i` at file
    offset `seg.start - part.windowStart + (t - cum_i)`; file length =
    that part's probed duration.
- Each leg is first SPLIT at segment seams (a leg crossing a seam becomes
  two pieces, each in its own part — this is what stops cross-part bleed),
  then each piece's file range is moved by `offset`.
- **Slide, never shrink** (the `clampToBounds` rule, for the same reason):
  if the moved range leaves its file (only possible near the video's own
  start/end, where `fetchOne` clamped the pad), slide it back inside. The
  piece keeps its exact length, so the twin's duration equals the main's;
  the cost is that a box near the very start/end of the video is shifted
  by less than asked. A piece longer than its file is impossible (the
  unshifted range already fits).
- `speed` is copied unchanged.
- Reduces to the identity at `offset === 0` (mutation-tested).

### Server: resolving part files

For a stitch, part `i`'s file is the one `fetchOne` wrote:
`windowStart = max(0, floor(seg.start - PAD))`; its `windowEnd` depends on
the video duration (clamped at the end), which the export body does not
carry. Resolve by reading `media/<videoId>/` for un-digested clip names
(`parseClipName`) with that `windowStart` and `windowEnd >= seg.end`
(builder's call on the exact lookup; there is exactly one in practice).
Missing → 404 "Part i of this clip is no longer cached; re-fetch it from
Trim." Paths are always rebuilt by `clipPath`, never taken from the body.

### Server: the export flow

In `/api/export`, when any offset (cell or custom) is non-zero:

1. Force the stitched path even with no cuts/speeds, and build the MAIN
   timeline from the same sources as the twins:
   `main = concatClips(shiftLegs(legs, sources, 0), …)`, NOT from the
   already-stitched cache. The cached stitch carries its own trim/`fps`
   rounding at every seam, while the twins map clip time to part files by
   arithmetic, so building one from the cache and the other from the parts
   can drift by about a frame per seam. Built from the same sources by the
   same function, main and twin are frame-aligned by construction. (For a
   single range the "parts" are the cached clip itself, so nothing changes
   there.) Only offset exports take this path.
2. For each distinct non-zero offset `o`, build
   `twin_o = concatClips(shiftLegs(legs, sources, o), dir/twin-<o>.mp4)`.
   **`concatClips` gains an optional forced output shape** (`{ w, h, fps }`)
   and both calls pass the cached clip's probe. Today it normalises every
   leg to its FIRST part's shape (`probed[0]`), and parts of one stitch can
   differ in resolution (`fetchOne` accepts sub-1080p sources since
   6c491f8). If a cut swallowed part 0's range, a twin would otherwise be
   encoded at part 1's size and every crop rect, which is in the cached
   clip's pixels, would be wrong. Absent = today's behaviour exactly.
   The twin's audio is never mapped (builder may add `-an` to the stitch
   or leave it; not mapped either way).
3. `exportClip` gets `twins: string[]` (distinct offsets in ascending
   order) and the per-box offsets. Twin inputs are appended AFTER the
   badges (positional rule: 0 clip, 1 mask, badges, then twins — nothing
   existing moves), declared before `-ss` like the mask.
4. `buildFilter(layout, boxes, customs, sourceOf)`: instead of one
   `[0:v]split`, one `split` per source input actually used —
   `[0:v]split=a…` for offset-0 boxes and `[k:v]split=b…` for each twin —
   each box's leg reading its own source's branch. Everything after the
   legs (`xstack`, custom overlays, mask) is unchanged. With all offsets
   0 the string is byte-identical to today's (string-pinned test).

With every offset 0 none of this runs and the route is untouched.

### Unavailable

The control is disabled (title tooltip says why) when the clip is a stitch
(`clipDigest !== ""`) and the client has no `segments` whose count matches
— in practice the idle dropdown's reopen of a multi-part clip whose
trim ranges are not in localStorage. The server's digest check is the real
guard; the client gate only avoids a guaranteed 400. It is deliberately
inexact: stored segments edited after an OLDER stitch of the same video was
cached pass the count check and get the server's 400 ("re-open it from
Trim"). `ponytail:` exact gate = a client-side SHA-1 via `crypto.subtle`
mirroring `segmentDigest`'s format; not worth a second hash spelling for a
rare, loud failure.

## Testing

- `src/segments.test.ts` — `shiftLegs`: identity at 0 (mutation-tested);
  a single-range shift; a leg crossing a seam split into two pieces each in
  its own part (the anti-goal — mutation: skip the split, the test fails);
  slide at the video's start and end keeping length; speed preserved;
  total twin duration equals `legsDuration(legs)` for random inputs.
- `server/ffmpeg.test.ts` — `buildFilter` string pin: all-zero offsets
  byte-identical to today; one twin input wired to the right leg.
- Real ffmpeg: a fixture whose colour changes every second (a known
  colour per second). Export a two-cell layout with cell 2 at `+2`; sample
  both cells at several output times — cell 1 shows second `t`'s colour,
  cell 2 shows `t+2`'s. Repeat on a two-part stitch with a sample just
  before the join: cell 2 shows part 1's own later footage, not part 2's
  (the anti-goal). Repeat with one cut and one x2 speed range.
- `src/state.test.ts` — offsets persisted under the framing gate,
  out-of-range values dropped on restore, cleared on layout switch for
  cells and kept for customs.
- UI (editor buttons, canvas badge) — by hand in a browser, as the rest of
  the DOM surface.

## Calls made by Claude (not discussed with the user)

- Floating pieces get offsets too, not only cells.
- Range ±5 s (= `PAD`), 1 s steps.
- Near the video's own start/end the shift slides back inside the
  available footage rather than padding with frozen frames.
- Offsets persist per video (chat delay is a property of the stream).
- Canvas shows a `+Ns` badge on shifted boxes.
- Audio from the offset-0 timeline only.
- With any offset on, the main timeline is rebuilt from the part files
  (not the cached stitch) so it is frame-aligned with the twins.
- `concatClips` takes a forced output shape so a twin always matches the
  crop rects' pixel space.
- The "offset unavailable" gate in the browser is approximate. In the rare
  mismatch case the server's clear 400 is the guard.

## Left to the builder

- Exact part-file lookup; whether the twin stitch drops audio.
- Badge styling; control styling on the existing tokens.
- Where `shiftLegs`' source descriptors are built (route vs helper).
