# vstack — cutting an upload into mp3s

2026-09-21

> **Amended 2026-09-21.** Seven things below are stale against what shipped
> on `feat/audio-cutter`. `CLAUDE.md` carries the correct versions; this
> block is so a session reading the spec first does not "fix" the code back
> to it.
>
> 1. **`server/cut.ts` imports NOTHING from `ffmpeg.ts`.** "`server/cut.ts`"
>    below says it imports `probeAudio`; it does not. `/api/cut` probes
>    before it calls in, so the module needs no prober of its own — its only
>    imports are `toolError` from `errors.ts` and `type Segment` from
>    `src/segments.ts`. That is stricter than what this document asked for
>    and is the version to keep.
> 2. **The `-ss`/`-i` ordering is NOT mutation-pinned.** "Testing" below
>    claims moving `-ss` after `-i` fails both tone assertions; it was tried
>    and it does not — this ffmpeg (Homebrew 8.1.1) accurate-seeks on the
>    input side too, and the short indexed M4A fixture lands on the identical
>    sample either way, measured at identical dB and identical duration
>    including with raw ffmpeg outside the test harness. The four tests pin
>    the range-to-audio **mapping**, which is their real job; the ordering is
>    kept as the convention `exportClip` and `stackWide` hold, and what it
>    defends against — non-indexed containers, and decode-from-zero cost on a
>    long input — is not something this fixture can demonstrate. The numbers
>    are in `.superpowers/sdd/2026-09-21-vstack-audio-cutter/task-2-report.md`.
> 3. **`/api/cut` runs `readTitle` before `isUploadId`**, the reverse of the
>    order "`/api/cut`" below lists. Nothing depends on it beyond which 400 a
>    doubly-bad body gets; recorded so nobody reorders the code to match.
> 4. **The route answers a 404 the "Errors" table does not list** —
>    `"That upload is no longer on disk."`, when `existsSync(uploadPath(id))`
>    fails after the id validates. An addition, not a deviation.
> 5. **Two controls shipped that this document does not mention**, both
>    added in the final implementation round and both silent if dropped: a
>    range-selector chip row, reusing the trimming bar's `.chip-seg` recipe,
>    without which there is no way to re-aim which range `Set Start` /
>    `Set End` write to; and a `waveFor = ""` reset in `pickCutFile`, because
>    this phase writes the module-scoped `wavePeaks`/`waveSeconds` that
>    `loadWave` caches against a clip URL, and without the reset the framing
>    strip paints this upload's envelope over someone else's clip. Both are
>    invariants in `CLAUDE.md`.
> 6. **The sweep has FOUR properties, not the three "The sweep" lists.** It
>    is also scoped to the base being written: a `prev` entry survives
>    unless it is `cutStem(base)` followed by nothing but an index and
>    `.mp3` — exactly the set `cutName` can emit for this base. Without any
>    scoping, cutting one file as `podcast` and then, without leaving the
>    phase, as `ads` unlinks podcast-1.mp3 and podcast-2.mp3 the moment
>    ads-1.mp3 lands. The index test rather than a bare `startsWith` is the
>    second half of the same bug: a slug is hyphen-separated, so `ads-` is a
>    string prefix of `ads-extra-1.mp3` too. `prev` is "everything the last
>    cut wrote", which is not the same set as "what this cut supersedes".
> 7. **The "Errors" table's ffmpeg row was wrong and is corrected in
>    place.** It claimed the next run's `prev` sweeps whatever a part-way
>    failure left behind; on a FIRST cut `cutNames` is still empty, so no
>    `prev` is sent and nothing is swept. The paragraph under the table is
>    the accurate version.

Supersedes nothing and extends nothing. It adds a **fifth journey** beside
the short one, the long one, the lofi one and the chat-moments dead end:
`idle` → `cutting` → `idle`. An uploaded audio or video file is shown with a
waveform strip; the user marks one or more ranges on it; each range comes
back as its own `.mp3` in `OUT_DIR`, revealed in Finder.

It reaches no other phase. It never touches `framing`, `preview`,
`/api/export`, `/api/publish` or `mode`. Like the chat-moments lookup, that
isolation is the design rather than an accident — and it is what keeps every
invariant the other four journeys rest on out of scope here.

## What the user asked for

> "input is an audio or a video, after upload it show the video and play bar
> with frequency (similar to the exporting UI). user can add one or more
> ranges on the play bar, the results will be one or multiples mp3 files
> cutted from the input."

Explicitly **not** asked for: publishing, a thumbnail, a title card, any
video output at all. The output is audio files on the Desktop.

## The four decisions

Taken in the brainstorm, each against a named alternative.

| decision | alternative rejected |
|---|---|
| dead end + reveal | reaching `preview`; downloading an attachment |
| `<base>-<n>.mp3` | `<base>-<mmss>-<mmss>.mp3`; a per-range label |
| `src/segments.ts` for the ranges | drag-out bands on the strip |
| local object URL for playback | playing the uploaded copy back from the server |

The naming choice is the one that carries a cost, and it is recorded in
"Names and the sweep" below: an index renumbers when a range is inserted, so
the feature needs a sweep that `<mmss>-<mmss>` would not have needed.

## The phase

`cutting`, entered by an `Audio cutter →` button in `renderIdle`'s third bar
row beside `Long form →`, `Lofi →` and `Chat moments →`.

**It claims no `mode`.** Every exit from `idle` on the three rendering
journeys sets one because they all meet at `preview` and a stale value
misclassifies an upload there. This journey reaches neither `preview` nor
`/api/publish`, so there is nothing to claim and nothing downstream that
could read it — the identical reasoning the chat-moments button's own
comment gives.

Leaving the phase (Done, or Back) returns to `idle` and revokes the object
URL.

## The shell

Two new persistent nodes, both built once and toggled with `hidden`, because
`sourceSlot` is never emptied:

- `cutVideo`, a `<video controls>` child of `sourceSlot`. A `<video>` rather
  than an `<audio>` for both input kinds: a video upload has a picture to
  show, and an audio-only file plays through the same element with a blank
  frame. One node, no branch.
- The strip, the range controls, the base-name field, the Cut button and the
  results list are all `barSlot` content, rebuilt by `renderCutting()` on
  every render — the same division `renderTrimming` already uses, where the
  strip lives in the bar and the media lives in the slot.

No new `.stage` column, and no `.out` involvement at all: this journey never
produces something to play back in `outSlot`.

### Playback is a local object URL

`cutVideo.src = URL.createObjectURL(file)` the moment the file is picked.
Three things this buys, and the middle one is the reason:

- No new GET route. `/media/uploads/<id>.mp4` happens to be reachable in dev
  because Vite serves the project root, but relying on that would tie
  playback to the dev server, the way `OUT_DIR` moving to `~/Desktop`
  already forced `serveOut` into existence for the other direction.
- Scrubbing is live immediately. The upload runs in parallel; only the Cut
  button waits on the id. A user marking ranges in a 40-minute recording
  should not be watching a progress bar first.
- The picture is the file the user picked, byte for byte, with no question
  of whether the server's copy is the same thing.

The URL is revoked on leaving the phase. It is the one piece of state here
that is not a plain value.

## The strip

Reuses the framing strip's machinery unchanged:

- `decodeTrack(file)` (already in `src/main.ts`, written for the lofi panel)
  decodes the picked `File` through an 8 kHz mono `OfflineAudioContext` and
  returns `{ env, seconds }`. It must not swallow its failures here either:
  a flat strip on the framing bar is cosmetic, but here it is the only thing
  the user aims at.
- `drawWave(canvas, span)` paints it, `bucketAt` maps a column to a bucket.
  `span === seconds` in this phase — there is no stitch and no `PAD` — so
  `bucketAt` reduces exactly to `floor(x * buckets / w)`, which is the
  identity `src/waveform.test.ts` already pins.
- The playhead is `cutVideo.currentTime`, drawn in the same rAF loop shape
  `renderStrip` uses, and **stopped in two places** the way `renderStrip`
  already is: on re-render, and from `render()` whenever `phase !== "cutting"`.
  The departure stop is the load-bearing one — without it the loop keeps
  reading a hidden element for the rest of the session.

`drawWave` reads the module-scoped `wavePeaks` / `waveSeconds` rather than
taking an envelope. This phase writes those two and leaves them, deliberately
rather than growing a parameter: the journeys are mutually exclusive — no
state exists in which both a framing clip and a cut upload are on screen —
and a second envelope field would be a second thing to keep in sync for no
behaviour. Noted `ponytail:` at the assignment.

## The ranges

`state.cutRanges: Segment[]`, spent through `src/segments.ts` with **no new
range arithmetic anywhere in the feature**:

| control | rule |
|---|---|
| `+ Range` | `segmentContaining` + `normalize`, the `+ Part` path |
| `Set Start` / `Set End` | `editMark`, including its asymmetric carry |
| `Remove` | splice + `normalize` |
| cap | `MAX_SEGMENTS` (6) |
| overlap | `normalize` merges, and two merged ranges are one mp3 |

That module is at the very bottom of the client layering, imports nothing,
and is exhaustively tested — including the two refusals, the carry, the
merge and the `duration` clamp. Marking behaviour here is therefore the
trimming phase's behaviour by construction, not by resemblance, and the one
thing that could silently differ between the two phases — what a merge does
to the part the user is aiming at — cannot.

Ranges are **session-only**: `state.ts` must not persist them, mutation-
tested the way the lofi fields' exclusion already is. A cut is over when its
files are on disk; there is nothing to come back to.

## The upload

`/api/upload-audio`, unchanged. It is already the right door for both input
kinds:

- `probeAudio` takes a duration from `format` gated on some stream reporting
  `codec_type: "audio"`, which is true of a bare recording and of a video
  file alike — where `probeFile` would refuse the first outright.
- It is already the gate that refuses a file with **no audio stream**. A
  silent video here can only produce silent mp3s, and refusing at upload is
  the loud version of that failure — the same argument the lofi speech path
  already makes.

`UPLOAD_MAX_BYTES` is checked client-side first, as everywhere else, because
the server's cap destroys the socket rather than answering.

## `server/cut.ts`

A **sibling** of `ffmpeg.ts`, `starter.ts`, `longform.ts` and `lofi.ts`, not
a layer above: every path is the caller's, so it needs neither `MEDIA_DIR`
nor `OUT_DIR`, and it imports nothing from `ffmpeg.ts` but `probeAudio`.

```
cutMp3(src: string, range: Segment, out: string): Promise<void>
```

One ffmpeg pass per range:

```
-ss <start> -i <src> -t <end - start> -vn -c:a libmp3lame -q:a 2 <out>
```

- **`-ss` before `-i`**, the same lesson `exportClip`'s mask input and
  `stackWide`'s trims both carry: ffmpeg attaches an option to the *next*
  `-i`, and `-ss` before the input is also what makes `-t` a duration
  measured from the seek point rather than from zero. Re-encoding, so the
  seek is frame-accurate; a stream copy would snap to the nearest frame and
  silently move the in-point.
- `-vn` because the output is audio. A video input's picture is discarded
  here, the way a lofi speech's is.
- `-q:a 2` — VBR, ~190 kbps. No control over it: the user picked a file and
  wants the audio out of it, and a bitrate knob is a setting to explain
  rather than a decision anyone has to make.
- `libmp3lame` is present in this machine's Homebrew ffmpeg (verified). No
  boot check, unlike the bundled assets: a missing encoder fails the first
  render immediately and loudly with ffmpeg's own message, where a missing
  asset fails halfway through one. `ponytail:` add it to the boot checks the
  day a second machine runs this.

`ponytail:` one decode with N outputs is the upgrade path. N is capped at 6
and these files are short, so N passes over one input is not worth the
mapping.

## `/api/cut`

```
{ id, base, ranges, prev }  →  { names: string[] }
```

Validators, in order, all of them ones this API already has:

1. `isUploadId(id)` — the strictest client-string gate in the API: a UUID
   the *server* minted, so there is nothing legitimate a client can send
   that it does not match. `uploadPath` builds the path from it.
2. `readTitle(base, "base")` → `slugify`. Blank and over-long both refuse.
3. `probeAudio(uploadPath(id))` for the duration, then
   `isValidSegments(ranges, duration)` — the *same* predicate `restore`
   uses on the client, so the two sides cannot come to disagree about what
   a legal range is.

Each range is written to `<OUT_DIR>/<name>.part.mp3` and renamed, with the
partial tracked in `inFlight` so the SIGTERM handler sweeps it — the reason
that `Set` exists is `node --watch` killing the process mid-render, which
applies here exactly as it does to an export.

## Names and the sweep

`<slug>-1.mp3`, `<slug>-2.mp3`, … in range order.

**`OUT_NAME` is not widened.** The long-form spec's invariant says there is
nothing to widen it for, and that holds: this needs a *different* shape, not
a looser one. A second predicate sits beside it in `server/ffmpeg.ts`:

```
CUT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d+\.mp3$/
```

`/api/reveal` accepts `isOutName(name) || isCutName(name)`, both still
followed by `existsSync` in `OUT_DIR`. Two anchored patterns, each matching
exactly what its own producer can emit, is a strictly smaller surface than
one pattern loose enough for both — and since `OUT_DIR` lives under `$HOME`,
what a loose pattern reaches is the user's home directory. `cutName(base, n)`
lives beside `outName` for the same reason `isCutName` lives beside
`isOutName`: it resolves against `OUT_DIR`, which `cut.ts` does not know
about.

`/api/publish` and `/out/` are **not** taught about `.mp3`. Nothing in this
journey produces something to publish or to stream back.

### The sweep

An index-based name renumbers when a range is inserted: cut four ranges,
delete the second, cut again, and `<slug>-4.mp3` is left on the Desktop
describing audio from the previous attempt. That file is indistinguishable
from a current one by name, which is the failure class this codebase treats
as cardinal.

So the client sends the previous run's names as `prev: string[]`, and the
route deletes them **after** the new files are all in place, skipping any
name it just wrote. Three properties, each copied deliberately:

- After, never before — a failed cut must leave the previous run intact.
- Skipping `prev ∩ names` — otherwise it unlinks a file it just wrote, the
  exact defect `/api/export` guards with `prev === name`.
- Resolved through `outPath` before `removeExport` sees it — `removeExport`
  takes a *path*, and passing the bare name compiles (both are strings) and
  silently resolves against `process.cwd()`, where `rm(..., { force: true })`
  swallows the ENOENT and the sweep does nothing. That is the `/api/lofi`
  footgun, written down.

`prev` is in-memory, like `/api/export`'s: a reload between two cuts strands
the older set, which is the accepted cost of not persisting a field whose
only job is naming files to destroy. Every name in `prev` goes through
`isCutName` before it is touched — this is the one client string in the
feature that names a file to delete.

## Errors

| case | answer |
|---|---|
| no audio stream in the upload | 400 at `/api/upload-audio`, before this phase can proceed |
| blank or over-long base | 400, `readTitle` |
| no ranges, or a range outside the file | 400, `isValidSegments` |
| more than `MAX_SEGMENTS` | the client caps the button; `isValidSegments` is the backstop |
| ffmpeg fails on one range | the whole request fails with `toolError`'s stderr tail, and the ranges already renamed STAY on disk — see below |

A **first** cut that fails part-way is the one case nothing cleans up. The
loop renames each range as it finishes, so a failure on range 3 leaves
`<slug>-1.mp3` and `<slug>-2.mp3` behind — and `cutNames` is still empty on
the client, so the next attempt sends no `prev` and sweeps nothing. If that
attempt then succeeds with only two ranges, the two files are simply
overwritten and nothing is stranded; if it succeeds with one, `<slug>-2.mp3`
survives holding the failed run's audio. Only a *later* cut under the same
base is covered by the sweep. `inFlight` covers the partials, never the
renamed files — by design, since the whole point of renaming last is that a
finished file is finished.

## Testing

`server/cut.test.ts`, shelling real ffmpeg like `server/ffmpeg.test.ts` and
`server/lofi.test.ts` do:

- A fixture of three back-to-back tones at distinct frequencies. Cut two
  ranges; assert each output's **duration** and its **dominant frequency**.
  The frequency assertion is the one that matters: a duration alone passes
  when a range maps to the wrong part of the input, and mapping is exactly
  what the `-ss`/`-i` ordering decides. Mutation-pinned by moving `-ss`
  after `-i`, which leaves both durations right and both tones wrong.
- A range that runs to the very end of the input, since `-t` past the end is
  where a duration assertion would otherwise over-report.

`server/ffmpeg.test.ts` gains `isCutName`'s own cases, with the exhaustive
traversal treatment `isOutName` and `videoIdFrom` get — including that a
`.mp4` does not match it and an `.mp3` does not match `isOutName`, which is
what fails if the two are ever merged.

`src/state.test.ts` gains the cut fields' persistence exclusion, mutation-
tested the way the lofi fields' already is.

`src/segments.ts` needs no new tests: this feature adds no rule to it.

The panel, the strip's drag and pointer handling, the route's HTTP surface
and `open -R` have no tests, like the rest of the network and DOM surface in
this codebase.

## What this does not change

`geometry.ts`, `layout.ts`, `custom.ts`, `frame.ts`, `mask.ts`,
`starter.ts`, `longform.ts`, `lofi.ts`, `ytdlp.ts`, `chat.ts`,
`youtube.ts`, `/api/export`, `/api/stack`, `/api/lofi`, `/api/publish`,
`/out/`, `OUT_NAME`, `mode`, and every invariant resting on any of them.
The feature's whole footprint is: one phase, one panel-less bar renderer,
one persistent `<video>`, a handful of session-only `state` fields, one
server module, one route, and two names in `server/ffmpeg.ts`.
