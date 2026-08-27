# vstack — multiple trim segments, and a visible playhead

2026-08-28

Supersedes nothing outright. It extends the trimming phase described in
`2026-08-20-vstack-design.md` (one `start`/`end` pair, one fetched window)
and changes `/api/window`'s request body and response. Everything downstream
of `/api/window` — `buildFilter`, `exportClip`, the frame mask,
`prependStarter`, the framing preview, `/api/export`, publish — is
**unchanged**, and that is the point of the design rather than a happy
accident.

## What the user asked for

Three things, in the trimming phase:

1. The strip should show where the playhead is.
2. The marked range's ends should read as rounded.
3. More than one kept part, the way a cut tool works.

(1) and (2) are cosmetic and land in `src/player.ts` + `src/style.css`.
(3) is the whole rest of this document.

## The shape of the problem

Today the trimming phase produces exactly one contiguous range, and every
layer below it assumes that:

- `/api/window` downloads `[start − PAD, end + PAD]` into
  `media/<id>/<windowStart>-<windowEnd>.mp4`.
- The framing phase points a `<video>` at that file and crops frames out of
  it — one continuous timeline, scrubbed and previewed on a canvas.
- `/api/export` reconstructs the same path from window bounds and does
  `-ss (start − windowStart) -t (end − start)`.

A discontinuous selection breaks the middle layer. There is no way to hand
the framing `<video>` a set of ranges and have the canvas preview honour the
gaps without reimplementing playback — and a preview that plays footage the
export drops is exactly the preview/export divergence this codebase treats
as the cardinal failure.

## The decision: cut at fetch, not at export

**The kept parts are concatenated into the cached clip file itself.** By the
time the framing phase sees anything, it is looking at one continuous video
whose every frame is in the export. Nothing below `/api/window` learns that
segments exist.

The alternative — carrying segments through to `/api/export` and turning them
into a `trim`/`concat` chain ahead of the split in `buildFilter` — was
rejected. It stores less, but the framing `<video>` would still be the padded
span, so the preview would play the cut-out footage. It would also put a
variable-length filter chain in front of the one graph in this codebase whose
`xstack layout=` ordering is mutation-tested.

### Consequence: two timelines, named apart

For a single segment the clip *is* a contiguous slice of the source, so clip
time and source time differ by a constant (`windowStart`) and `/api/export`
subtracts it. For a stitch that is no longer true — clip time is its own
thing.

So `/api/window` reports `clipStart` and `clipEnd` alongside the window
bounds, and `doExport` sends *those* as the body's `start`/`end`:

| | one segment | N segments |
|---|---|---|
| `windowStart` | `floor(start − PAD)` | `0` |
| `windowEnd` | `ceil(end + PAD)` | probed clip duration |
| `clipStart` | `start` | `0` |
| `clipEnd` | `end` | probed clip duration |

For one segment `clipStart`/`clipEnd` are the user's marks, so the export
request is byte-identical to today's. `AppState.segments` keeps holding the
*source*-timeline marks throughout, because that is what the trimming strip
draws and what "Back to trim" restores.

`clipEnd` is **probed off the finished file, not summed client-side**.
Summing the segments' durations is right to within a frame, and a `-t` a
frame past the end costs nothing today — but it is a number that can drift
from the file it describes, and this codebase already has one bug of exactly
that shape on record (`probeMain` reading the wrong `ffprobe` line).

`outName(starterTitle, start, end)` receives clip time, so a multi-part
export lands as `<slug>-0000-0035.mp4`. Deliberate: source timestamps do not
describe a stitch, and threading the source marks through purely for the
filename would mean a second pair of numbers on the wire that nothing else
reads.

## `src/segments.ts`

New module at the bottom of the client layering, beside `geometry.ts`,
importing nothing. Server-importable for the same reason `ytdlp.ts` already
imports `PAD` from `src/geometry.ts`.

```ts
export type Segment = { start: number; end: number };
export const MAX_SEGMENTS = 6;

/** Clamp to [0, duration], drop `end <= start`, sort by start, merge
 *  overlaps. Idempotent. */
export function normalize(segs: Segment[], duration: number): Segment[];

/** The validator both sides run. Non-empty, at most MAX_SEGMENTS, every
 *  bound finite and within [0, duration], every `end > start`, sorted and
 *  non-overlapping. */
export function isValidSegments(segs: unknown, duration: number): segs is Segment[];

export function totalDuration(segs: Segment[]): number;
```

`isValidSegments` takes `unknown` for the same reason `isOutName` does: it is
called on a raw request-body field and on a `JSON.parse` result, and a
`Segment[]` annotation at either site would be a compile-time claim about a
value that arrives from outside the program.

**Split validator, same posture as `isValidBox`/`assertBoxes`.** The client's
`restore` and the server's `/api/window` call the same function. Either alone
would let a bad selection through one side and die on the other.

`MAX_SEGMENTS = 6` bounds the ffmpeg graph and the untrusted-input surface,
mirroring `MAX_CUSTOM`. `restore` checks the count as well as each element,
for the reason spelled out in CLAUDE.md for `customs`: a hand-edited
localStorage record holding twenty individually legal segments would
otherwise reach `fetchWindow` and fire twenty downloads.

`normalize` merging overlaps rather than rejecting them is a UI decision:
dragging one part's end past the next part's start is an ordinary editing
gesture, and merging is what every cut tool does with it.

## State

`AppState.start` / `AppState.end` become `segments: Segment[]`, **always
length ≥ 1**. One segment is today's behaviour exactly, so the single-part
path is not a special case anywhere — it is the general path at N = 1.

Read sites become `segments[0].start` and `segments.at(-1).end` — under
`noUncheckedIndexedAccess` both need a `?? 0` fallback rather than a `!`.

Two new fields, `clipStart` and `clipEnd`, set by `openWindow` from
`/api/window`'s response. Not persisted: like `clipUrl` and `windowStart`
they belong to a fetched window, not to the video.

`readSaved` migrates the old record shape:

```ts
// A record with no `segments` but with the old pair is a pre-segments save,
// and that pair is by definition one segment. Same shape as the
// boxTop/boxBottom migration above it.
//
// Tested on `!== undefined`, NOT on truthiness: a record marked from the
// very start of the video stores `start: 0`, and `s.start ?? s.end` would
// read that as "nothing here" and drop a real mark. The one case a
// truthiness check gets wrong is the one a user hits by pressing Set Start
// without moving the playhead.
const migrated =
  s.segments === undefined && (s.start !== undefined || s.end !== undefined)
    ? [{ start: s.start ?? 0, end: s.end ?? 0 }]
    : null;
```

`save()` persists `segments` unconditionally, the way it persists the marks
today — they always reflect the current session. The framing-only gate stays
for boxes/customs/dimensions.

## `/api/window`

Request body `{ videoId, segments, duration }` instead of
`{ videoId, start, end, duration }`. Response gains `clipStart` and
`clipEnd`.

No backwards compatibility for the old body. This is a local single-user
tool with one client, shipped from the same repo; a compatibility shim would
be a second code path with no second caller.

The route validates with `isValidSegments` and answers 400 on failure —
before any subprocess spawns, which is where this API draws every trust
boundary.

## `fetchWindow`

```ts
fetchWindow(videoId, segments: Segment[], duration): Promise<WindowResult>
```

**N = 1 → today's code path, untouched.** Same `PAD`, same download ladder,
same `<windowStart>-<windowEnd>.mp4` filename. Every clip already sitting in
`media/` still hits, and the single-part case cannot regress into the new
code at all.

**N > 1 →**

1. Fetch each segment through that *same* single-segment path. Each part is
   an ordinary cached clip: it carries `PAD`, it goes through the three-rung
   download ladder, it is written under a UUID partial and renamed, and it is
   shared with a plain single-segment fetch of the same range. Re-cutting a
   video re-downloads nothing.
2. Concatenate the parts into `media/<id>/0-<total>-<digest>.mp4`, trimming
   each leg back to its own segment bounds (the parts carry `PAD`; the stitch
   must not).
3. Probe the result for dimensions and duration.

`probeFile` grows from `{ width, height }` to
`{ width, height, fps, seconds, hasAudio }` — one `ffprobe -of json` call
either way, and every existing caller destructures only the two fields it
already used. `starter.ts`'s private `probeMain` is deliberately **not**
folded into it: `starter.ts` sits *beside* `ffmpeg.ts` in the layering, not
above it, and importing from it would be the first edge that breaks that.

The per-part fetch is what keeps this from becoming a "download the whole
span between the first and last mark" design — two 10-second parts an hour
apart would otherwise pull an hour of video.

### The concat pass

New `concatClips` in `server/ffmpeg.ts` (so `ytdlp.ts`, which already imports
from it, can call it and the layering stays acyclic). One ffmpeg invocation,
N inputs, per leg:

```
[i:v] trim=<start−ws>:<end−ws>, setpts=PTS-STARTPTS,
      scale=<W>:<H>, setsar=1, fps=<fps> [vi]
[i:a] atrim=<start−ws>:<end−ws>, asetpts=PTS-STARTPTS  [ai]
```

then `concat=n=N:v=1:a=1`.

- **`setsar=1` on every leg.** `concat` refuses a SAR mismatch — it does not
  pick a side, it fails with `Nothing was written into output file`. This is
  the lesson `prependStarter` already carries for its three legs.
- **`scale` + `fps` normalisation off part 1's probe.** Parts of the same
  video normally match, but the download ladder can land different rungs on
  different calls, and a resolution mismatch would otherwise fail the same
  opaque way. Normalising is a few characters; detecting and reporting the
  mismatch is a branch and a message.
- **A part with no audio gets `anullsrc`**, the same stand-in
  `prependStarter` uses, so the audio leg count always matches the video leg
  count. `hasAudio` is read from `-of json`, never from
  `-of default=nk=1` — that reads one line per *stream* and is what made
  every clip look silent once already.

### The cache filename, and the guard on it

`0-<total>-<digest>.mp4`, where `<total>` is `Math.round` of the segments'
summed duration (`CLIP_RE` matches `\d+`, and segment bounds are playhead
floats) and `<digest>` is 8 hex characters of a sha1 over those bounds. The
rounded total names the file; the *probed* duration is what `clipEnd`
reports, and the two are allowed to differ by under a second — the name is
an identifier, not a measurement. Same construction as `maskPath`'s `-c<digest>` suffix for
custom boxes, and for the same reason: two different segment sets can total
the same number of seconds, and without the digest the second would serve the
first's stitch forever.

`CLIP_RE` in `server/ytdlp.ts` widens from

```
/^(\d+)-(\d+)\.mp4$/     →     /^(\d+)-(\d+)(?:-[0-9a-f]{8})?\.mp4$/
```

**This is the one edit here that fails silently.** `parseClipName` is the
whole guard that keeps a truncated `<name>.<uuid>.part.mp4` out of
`listClips` — a partial listed as a row hands the framing phase a broken
video that previews as a black canvas. The widened pattern is still anchored
and still admits no dots, so a partial still cannot match; the existing
`server/ytdlp.test.ts` cases stay, and new ones cover the digest form and the
partial form against it.

`clipName`/`clipPath` gain an optional `digest` parameter so the name is
still built in one place, and `parseClipName` returns it alongside the
bounds (`""` for the plain two-number form).

### How the digest reaches `/api/export`, and why that is a new field

`/api/export` reconstructs its input path from `videoId` + window bounds.
A stitch's filename carries a third component those bounds do not contain,
so the reconstruction would miss it and every multi-part export would 404
with "not cached".

Three ways out, and the choice matters because this is the API's trust
boundary:

1. **Send `segments` and recompute the digest server-side.** Preserves the
   "no client-supplied path component" rule exactly — but it breaks on the
   `listClips` path, where the client reopens a stitch it never cut and has
   no segments to send. That is a real flow (it is the idle screen's second
   way in), so this is not a complete answer.
2. **Send the digest as its own field**, validated against `/^[0-9a-f]{8}$/`.
3. Send the filename. Rejected outright — that is a path.

**(2).** The body gains an optional `digest`, absent meaning `""` meaning
today's plain name. Eight hex characters cannot traverse, cannot escape
`MEDIA_DIR`, and `clipPath` still builds the path; this is the same posture
`isOutName` already takes where reconstruction is impossible, with a much
narrower alphabet. `listClips` returns each row's digest, so the reopen
path has it for free.

CLAUDE.md's `/api/export` invariant needs updating to say so: the body is
window bounds *plus an optional 8-hex digest*, still never a path.

### `listClips` must stop rebuilding the path

```ts
const path = clipPath(videoId, bounds.windowStart, bounds.windowEnd);
```

silently drops the digest and probes a file that does not exist, so every
stitch would be skipped by the `probeFile` catch and never listed. It reads
`join(MEDIA_DIR, videoId, name)` instead — the name `readdir` already
handed it, which `parseClipName` has already validated character by
character.

## The trimming UI

The strip draws one `.strip-range` per segment. The **active** segment — a
module-scoped index in `main.ts`, alongside `stampText`, because nothing
about it is persisted and it must survive `barSlot` being rebuilt without
causing a rebuild — is the one Set Start / Set End write to, and is drawn
brighter.

New controls in the marking row:

- **`+ Part`** appends `{ t, min(t + 5, duration) }` at the playhead and
  makes it active. A five-second default rather than an empty range: every
  intermediate state stays valid, so Continue never has to explain itself.
- **`− Part`** removes the active segment; disabled at one.
- Segment chips in the marks badge switch the active segment.

Both write through `setState` + `save()` and read live state via
`getState()`, **not** `render()`'s snapshot `s` — the same hazard `+ Box`
hit: a handler appending to an array that drag handlers write through
`setQuiet` will otherwise persist a stale copy and revert the previous edit.

Continue is gated on `isValidSegments`.

## The playhead and the strip's ends

`renderStrip` returns `{ el, stop }` rather than a bare element — the same
`{ place, stop }` shape `mountEditor` returns, and for the same reason: it
now owns a rAF loop that has to be cancelled. `renderTrimming` holds the
handle in a module-scoped `strip` and calls `stop()` before each re-render.

The playhead is a 2px `.strip-head` positioned from a `head(): number`
callback so `player.ts` keeps knowing nothing about `main.ts`'s player
handle.

`.strip-range` gets `border-radius: 999px` and `.strip` goes 12px → 14px.
At 12px with `--radius-3` (6px) the range is *already* geometrically a pill;
999px makes that unconditional at any height, and the extra 2px is what makes
the rounding read.

## Testing

`src/segments.test.ts` gets the exhaustive treatment `geometry.ts`,
`layout.ts` and `custom.ts` have, for the same reason — its bugs are silent:

- `normalize` is idempotent, sorts, clamps, drops empties, merges overlaps.
- `isValidSegments` accepts everything `normalize` emits and rejects
  everything else: empty, over `MAX_SEGMENTS`, unsorted, overlapping,
  `end <= start`, out of bounds, non-finite, non-array, `null`.
- `totalDuration` against a known set.

`server/ytdlp.test.ts` gains cases for the widened `CLIP_RE`: the digest form
parses, a `.part.mp4` still does not, a digest of the wrong length or case
does not.

`server/ffmpeg.test.ts` gains one real end-to-end concat — two parts cut from
different colour bands of a synthetic source, asserting the output's duration
is the sum and that a frame sampled from each half carries that part's own
colour. That is the only proof the legs are in order and neither is dropped.
A non-square-SAR part is included, since `concat` failing on SAR is the
failure this design most expects to hit.

`src/state.test.ts` gains the migration: a stored `{start, end}` record
restores as one segment, and a stored `segments` array survives a round trip.

The trimming bar, the strip and the playhead are DOM-driven and untested by
design, like `main.ts`, `editor.ts`, `preview.ts` and `player.ts` already are.

## Known ceilings

- `media/` grows faster: a multi-part cut stores each part *and* the stitch.
  Nothing prunes it today either. `ponytail:` an LRU when it gets annoying.
- Merging overlaps means two parts dragged together silently become one. The
  chip count changes, which is the only feedback.
- `MAX_SEGMENTS = 6` is a bound, not a measured limit.
