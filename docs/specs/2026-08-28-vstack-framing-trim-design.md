# vstack — trimming in the framing phase, over a waveform

2026-08-28

Supersedes nothing. It extends the framing phase described in
`2026-08-20-vstack-design.md` and refined by
`2026-08-28-vstack-segments-design.md`, and it changes **no API at all** —
not `/api/window`, not `/api/export`, not the export body. No new route, no
new server module, no new cached artifact. Everything it needs is already on
disk and already in the export request.

## What the user asked for

Two things, which turned out to be one thing:

1. See the clip's audio while trimming, so a cut doesn't land mid-sentence.
2. Trim in the framing phase, where the video is already local.

Plus an observation, reported as a possible bug: *"the local video range
usually does not match the remote range, though the export video is
correct."*

## The observation is not a bug — it is `PAD`, undrawn

`PAD = 5` (`src/geometry.ts`). `fetchWindow` deliberately fetches
`[start − PAD, end + PAD]` and reports `clipStart`/`clipEnd` as the *marks*,
not the window. The framing scrubber is built with `min = 0` and
`max = v.duration` — the whole padded clip — and draws nothing to say where
the export's own boundaries fall inside it.

So the framing `<video>` plays up to ten seconds of footage the export drops,
with no indication which ten. The export is correct because `doExport` sends
`clipStart`/`clipEnd`, which never moved.

This was verified rather than assumed. Two independently fetched, overlapping
windows of the same video (`760-824.mp4` and `762-829.mp4`) yield
**byte-identical frames** at the same absolute source time, and every cached
clip's probed duration matches its filename bounds to within 20 ms. The clip
timeline is exactly `source − windowStart`; nothing is drifting.

That pad is already downloaded and currently discarded invisibly. This design
turns it into the material the user trims with.

## The decision: trim by editing `clipStart`/`clipEnd`, nothing else

`doExport` already sends `start: s.clipStart, end: s.clipEnd`. Making those
two draggable in the framing bar edits values the export body has always
carried. There is no new field, no new validator, and no new server
behaviour — the server re-validates the pair exactly as it does today.

**This preserves the segments design's central invariant.** *"The framing
phase must never learn that segments exist"* still holds: `clipStart`/
`clipEnd` are one contiguous range in the clip's own timeline, which is the
only thing framing has ever dealt in. For a single segment they are the
marks; for a stitch they are `0` and the stitched duration. Shaving either
end stays a single contiguous range in both cases, and the framing phase
still cannot tell which it is looking at.

### Coordinates

`clipStart`/`clipEnd` share a coordinate system with `windowStart`/
`windowEnd` — source seconds for a single range, the stitch's own timeline
for a stitch. The `<video>` element's timeline is
`[0, windowEnd − windowStart]`, so the kept range sits at
`[clipStart − windowStart, clipEnd − windowStart]` within it, and the server
reconstructs the cut with `-ss (clipStart − windowStart)`.

The drag clamps to `[windowStart, windowEnd]` and enforces
`clipEnd > clipStart`.

## The waveform needs no backend

Cached clips carry **AAC 44.1 kHz stereo** audio (sampled across three clips
in `media/`), and the longest of the fifteen on disk is **98 s**. The browser
can decode that directly:

```
fetch(clipUrl) → arrayBuffer
  → new OfflineAudioContext(1, 1, 8000).decodeAudioData(buf)
  → peak-per-pixel envelope → canvas
```

Decoding *through an 8 kHz mono `OfflineAudioContext`* rather than a live
`AudioContext` is what bounds the memory: `decodeAudioData` resamples to the
context's own rate, so a ten-minute clip costs ~19 MB of `Float32Array`
instead of the ~230 MB a 44.1 kHz stereo decode would.

Peak amplitude is the right statistic **at this zoom and only at this zoom**.
Measured against a 4-hour source, a peak waveform across the full duration is
a flat band — 7.6 s per pixel of continuous speech saturates every bucket,
and `scale=log` renders it a solid slab. At 60 s the phrase structure and the
gaps between sentences are plainly legible. A clip is `marks + 2 × PAD`
seconds long, which sits inside the legible range by construction.

## What changes

- **`src/main.ts`, framing bar.** The existing `type="range"` scrubber gains
  a canvas behind it carrying the waveform, and two draggable handles at
  `clipStart`/`clipEnd`. Region outside the kept range is dimmed.
- **A new `src/waveform.ts`.** Pure: takes a channel `Float32Array` and a
  bucket count, returns a `Float32Array` of per-bucket peaks. It imports
  nothing and knows nothing about Web Audio, which is what keeps it testable.
  The `fetch` + `decodeAudioData` call and the canvas drawing both stay in
  `main.ts` with the rest of the DOM code.
- **`keptLength` gains a framing meaning.** It is `totalDuration(s.segments)`
  today, which happens to equal `clipEnd − clipStart` in *both* the
  single-segment and stitch cases — so nothing is wrong today. The moment
  framing can edit `clipStart`/`clipEnd`, the two diverge, and every consumer
  of `keptLength` in the framing bar (the Export gate, the `SHORTS_MAX_S`
  over-length warning, the kept-duration badge) would report the untrimmed
  length. In framing it must read `clipEnd − clipStart`. The trimming bar's
  two call sites must keep reading the segments, because `clipStart`/
  `clipEnd` are still `0`/`0` before `/api/window` answers.
- **The comment at `src/main.ts:1241` is invalidated and must be rewritten.**
  It currently justifies skipping a window check with *"with marking confined
  to trimming, nothing reachable from here can move them out of it."* This
  design is precisely what makes that false. The clamp described above is
  what replaces the argument.

## What does not change

`/api/window`, `/api/export`, `buildFilter`, `exportClip`, the mask, the
starter screen, publish, and every server module. `PAD` stays at `5`.

## Persistence

`clipStart`/`clipEnd` are not in `save()`'s `Saved` record and this design
does not add them — they belong to a fetched window, like `clipUrl` and
`clipDigest`, and `restore` has no window to attach them to. A framing trim
is therefore lost on reload, which re-enters framing through Continue and a
fresh `/api/window`. That matches how the other window-scoped fields already
behave.

## Rejected alternatives

**A whole-video waveform during trimming, via a new `/api/envelope`.** This
was designed and costed before being dropped. It fetches the full audio
track, streams raw `s16le` through Node computing a 100 Hz peak envelope,
caches ~1.4 MB per 4-hour video and discards the audio. Measured: **39 s** to
fetch (73.8 MiB, itag 249) plus **21 s** to extract. It works — envelope-
derived silence gaps matched `ffmpeg silencedetect` at 726 against 745, with
the first six timestamps identical — but it exists only to answer *"where do
I cut in four hours"*, and the user dropped that question. Once the region is
marked, the remaining question is *"±5 s, where exactly"*, and those bytes
are already local. Parked, not refuted.

**Fetching only ±2 minutes of audio around the mark.** The intuition is that
a small range is cheap. Measured, it is the opposite: six ranged fetches at
four depths in both containers (webm 249 and m4a 140) took **126–161 s** for
1.3 MB, against **39 s** for the entire 73.8 MiB track. YouTube throttles
seek-then-read far harder than a sustained sequential read, and it is not a
container-index problem. Two runs near the very end of the video returned in
12 s and that was never explained; it does not change the ranking.

**Server-rendered waveform PNGs via `showwavespic`.** Besides needing a
route and a cache, the filter buffers its whole input: it was **OOM-killed
(exit 137)** on the 4-hour file. The browser decode has no such ceiling, and
a PNG would fix the zoom level at render time where an envelope does not.

**Raising `PAD` to give more room.** `PAD` is one constant, but it is part of
every cache filename — raising it orphans every clip in `media/` and forces a
re-fetch. Deferred until ±5 s actually proves too tight in use.

## Testing posture

`src/waveform.ts` holds the envelope reduction — an `AudioBuffer`-shaped
input to a `Float32Array` of peaks — and is the testable part. It takes a
channel `Float32Array` plus a bucket count rather than an `AudioBuffer`, so
it is reachable from vitest's `node` environment at all. Tests: peak-per-
bucket against a known signal, bucket-count exactness at lengths that do not
divide evenly, and the zero- and one-sample edges.

The `keptLength` change is the one that can silently mis-report an export's
length, and it lives in `src/main.ts`, which is untested by design. It should
therefore move to a named export somewhere reachable — `src/segments.ts` is
the wrong home (it must not learn about clip bounds), so it belongs beside
the waveform reduction or as a two-line helper in `src/state.ts`. Whichever
it is, the framing branch gets a test; leaving it inline in `main.ts` is the
one option this design rules out.

`decodeAudioData` is Web Audio and absent under vitest's `node` environment,
so the decode step itself stays untested and hand-verified in a real browser,
like `src/starter.ts`, `editor.ts` and `preview.ts` before it. Safari needs
checking specifically: it historically required the prefixed
`webkitOfflineAudioContext` and the callback form of `decodeAudioData`.

## Out of scope

Multiple segments in framing (that is the trimming phase's job, and framing
must not learn they exist), snapping a handle to a detected silence gap,
raising `PAD`, and the parked `/api/envelope`.
