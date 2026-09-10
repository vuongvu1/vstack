# vstack — cutting parts out of the middle, in the framing phase

2026-09-10

Extends `2026-08-28-vstack-framing-trim-design.md`, which gave the framing
phase two draggable handles over a waveform and made `clipStart`/`clipEnd`
editable there. Supersedes nothing. It adds one optional field to
`/api/export`'s body — `cuts` — and changes no other route, no cached
artifact and no filename.

## What the user asked for

> "In the export UI (trimming with fetched video), I want to cut some parts
> in the middle, the cut parts are marked in red, can be in multiple parts."

Marking middle cuts is possible today only in the *trimming* phase, against
a YouTube iframe with no waveform and no local frames. The framing strip is
where the audio is legible and the video is on disk, and it can only shave
the two ends.

## The model: one kept range with holes in it

`clipStart`/`clipEnd` stay exactly what they are — the outer bounds, in the
same coordinate system as `windowStart`/`windowEnd`. A **cut** is a
`{ start, end }` inside them, in that same coordinate system, drawn red.
What exports is `[clipStart, clipEnd]` minus every cut.

Cuts are a *different thing from `segments`* and deliberately do not reuse
the name. `segments` are source-timeline ranges that `/api/window` fetches
and stitches before framing ever runs; `cuts` are clip-timeline holes
applied at export. They never meet: a stitch arrives at framing as one
continuous file, and cutting a hole in that file is the same operation on
the same axis whether it came from one segment or six.

### The segments invariant, and why this does not break it

`2026-08-28-vstack-segments-design.md` says *"the framing phase must never
learn that segments exist"*, and the reason it gives is preview/export
divergence: the framing `<video>` must never play footage the export drops.

This design keeps that promise by construction rather than by ignorance:

- Every cut is painted red across the strip, so the drop is visible.
- The framing `<video>` **skips** a cut during playback — `ontimeupdate`
  seeks to the cut's end the moment the playhead enters one. What you watch
  is what exports.
- `keptLength` subtracts the cuts, so the kept badge, the `SHORTS_MAX_S`
  over-length warning and Export's own gate all report the real length.

The framing phase still knows nothing about *source* segments, `/api/window`
or the stitch. It edits its own file's timeline, which is all it has ever
done.

## `keepRanges`, the one shared rule

```ts
keepRanges(start: number, end: number, cuts: Segment[]): Segment[]
```

New in `src/segments.ts`, pure, imports nothing — the module the server
already reaches across for. It subtracts normalised cuts from one range and
returns what is left, in order. Both sides compute from it: the client for
the kept-duration badge, the server for the ffmpeg legs. One rule, so a
badge can never disagree with a render.

Cuts are `normalize`d first (existing, tested: sorts, clamps, merges
overlaps, drops empties), so `keepRanges` may assume sorted and disjoint
input.

## Client

- `AppState.cuts: Segment[]`, empty by default. **Not persisted**, for the
  reason `clipStart`/`clipEnd` are not: they belong to a fetched window, and
  `restore` has no window to attach them to.
- The framing bar gains `+ Cut`, capped at `MAX_CUTS = 4`. It drops a
  `CUT_S = 2` second red region at the playhead, clamped inside
  `[clipStart, clipEnd]`.
- Each cut renders as a red band with two drag handles and a `×`. The drags
  use the strip's existing `setQuiet` + `place()` pattern, with one
  notifying `setState` on pointer-up, exactly as the two outer handles do.
- A layout switch, a title edit and a box drag leave cuts alone. Re-entering
  framing through `/api/window` clears them, since they are window-scoped.

## Server

`/api/export`'s body gains an optional `cuts`, validated the way every other
client-supplied field is:

- `isValidSegments(cuts, windowEnd)` — the existing shared validator (array,
  bounded count, finite, sorted, non-overlapping, `end > start`).
- Every cut inside `[start, end]`.
- `keepRanges(start, end, cuts)` non-empty — cutting everything is a 400,
  not an empty render.

With cuts, the route runs **one extra pass before the composite**: the
existing `concatClips`, given the same cached clip once per kept range,
stitches the holes out into `<tmp>/body-cut.mp4`; `exportClip` then runs on
that file with `start: 0`. `concatClips` already normalises SAR, fps and
audio across legs and already handles a silent part, and it is already
tested against real ffmpeg pixels — a cut list is exactly the stitch it was
written for, with one path instead of several.

Without cuts the route is byte-identical to today: no extra pass, no extra
encode generation.

`outName` is unchanged. It names the file after the *marks*, and it always
has — a cut list changes the duration, not the range that was marked.

## Cost

One extra re-encode of the clip (`veryfast`, crf 18) when cuts exist —
seconds on a clip that is `marks + 2 × PAD` long, against two ffmpeg passes
the export already pays for. Not paid at all when the list is empty.

## Out of scope

- Persisting cuts across a reload. They die with the window, like the trim.
- Cuts in the trimming phase. `segments` already cut the source timeline
  there, and two cut models on one strip is the confusion this design's
  naming exists to avoid.
- Fading or crossfading across a cut. The long journey's dip
  (`server/longform.ts`) is the precedent if that is ever wanted.

## Testing

- `src/segments.test.ts` gains `keepRanges`: the identity (no cuts), a hole
  in the middle, cuts flush to either bound, a cut spanning the whole range
  (empty result), several cuts, and cuts wholly outside the range.
- `server/ffmpeg.test.ts` already proves `concatClips` end to end against
  real pixels, including the leg ordering. Nothing new is needed there — the
  route hands it the same shape from one path.
- The strip UI is DOM-driven and untested by design, like the rest of
  `main.ts`.
