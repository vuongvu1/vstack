# vstack — a long lofi mix from many tracks and repeating speeches

2026-09-21

Extends `docs/specs/2026-09-16-vstack-lofi-design.md` and supersedes nothing.
The lofi journey keeps its phases (`idle` → `lofi` → `preview`), its route
(`/api/lofi`), its uploads door (`/api/upload-audio`), its background fork
(still bytes or an animated `bgId`), its duck, its crackle, its frequency
bars and its spinning mark. Four things change:

- **The music is a LIST.** One track becomes up to `MAX_TRACKS`, played back
  to back, and the render is as long as they sum to.
- **A speech repeats.** Where a speech was placed once, it now recurs
  through the render on a spacing the user sets.
- **Order is partly chosen and partly random.** A file whose name begins
  `1_` plays first; everything else is shuffled once, at add time.
- **The render reports progress.** A three-hour render is tens of minutes of
  ffmpeg, and the panel currently shows nothing at all while it runs.

The picture is unchanged, and needs no work to survive the new length: the
background's still leg already manufactures frames with `-loop 1` and its
GIF leg already replays with `-stream_loop -1`, both bounded by the same
`-t <seconds>` that is now hours rather than minutes. The crackle input is
likewise already `-stream_loop -1`, so the bed does not run out after the
asset's own 3m22s. The bars and the mark both stay on, at their
current cost — see "What this costs" below, which records the number rather
than quietly paying it.

## Why the music is concatenated in a PRE-PASS, not in the main graph

This is the decision the rest of the design rests on, and the alternative is
the obvious one, so it is worth being explicit about why it loses.

The obvious shape is N music inputs on the main graph joined by ffmpeg's
`concat` filter. It works. It also puts one ffmpeg input per track on a
graph that already carries the background, every unique speech, the crackle
and the mark — and a three-hour render at four minutes a track is around
forty-five tracks. Input count is exactly the thing `MAX_PARTS` exists to
bound over in `stackWide`, for the same reason.

More importantly it would break an invariant that is currently free:

> **The lofi render's duration is the music's, by construction — nothing
> sums.**

With N inputs, `seconds` becomes an arithmetic sum of client- or
server-probed lengths, `outName`'s `mmss` is computed from that sum, and the
filename can come to disagree with the file by whatever rounding the concat
introduces. That is precisely the class of failure the invariant was written
against.

So `/api/lofi` concatenates the music into **one file** in its own temp
directory first — the directory it already creates for the still's bytes and
already sweeps in a `finally` — and then probes *that file*. The main graph
takes one music input and is byte-identical to today's. The invariant
survives verbatim: the duration is still the music's, by construction. The
music is now a file this route built.

### The pre-pass

**A single track skips the pre-pass altogether.** One music id means no
concat, no flac, no extra run: the id's own path goes straight to the main
graph and the whole route is byte-identical to today's. This is the same
reduction-to-identity `fill` holds against `troughs` and `trims` holds in
`stackWide` — the existing one-track journey must not pay a new pass, a new
temp file or a new failure mode for a feature it does not use.

With two or more: one audio-only ffmpeg run, N inputs, `concat=n=N:v=0:a=1`, out to flac in
the work directory. Lossless, so the tracks are not re-encoded twice on
their way to the AAC the render ends in; roughly 1 GB transient for three
hours, in `$TMPDIR`, swept with the rest of the work directory.

Each leg is `aresample` + `aformat`ed to a common rate and layout before the
concat, because the tracks are arbitrary user uploads and `concat` requires
agreement. This is the same normalisation the main graph already applies to
`[1:a]`, moved one pass earlier.

### The boundary between two tracks

A dip on each leg — `afade` out on the outgoing track's tail, in on the
incoming track's head — and **never `acrossfade`**.

This is the long journey's decision, reached for the same reason and worth
restating because the reason is not aesthetic. `acrossfade` overlaps the
legs, so the output is `(N-1) * d` **shorter** than the tracks sum to. The
duration is what `outName` commits to in the filename before the render
finishes. A dip keeps the total exact by construction; a crossfade makes it
an arithmetic result that something else has to agree with.

`TRACK_FADE` is 1.5s — longer than the journey's own `FADE` (0.5s), which
measures a voice's breathing room rather than a seam between two pieces of
music, and declared separately for the reason `longform.ts` and
`starter.ts` keep separate blur sigmas: one constant for two jobs means
tuning either moves the other. `d` is clamped to
`min(TRACK_FADE, seconds / 3)` per track, the same clamp
and the same reason `stackWide` carries: on a track shorter than `2 * FADE`
an unclamped fade-in and fade-out overlap and multiply, and once the track
is shorter than the fade itself the fade-out's `st` goes negative and ffmpeg
refuses the graph. Applied only BETWEEN tracks — `i > 0` fades in, `i < N-1`
fades out — because the mix opens and closes deliberately.

## Ordering, and where it is decided

A file whose display name matches `/^1_/` is played first. Everything else
is shuffled. The rule runs separately over the music list and the speech
list; neither knows about the other.

**The shuffle happens once, when files are added, and is stored in state.**
Not at render time. Two reasons: the panel can show the real play order
before anything is rendered, and a re-render to fix a title typo cannot
silently reshuffle three hours of music. A `↻ Shuffle` button re-rolls on
demand. Fisher-Yates, over the non-pinned tail only.

**The prefix is read CLIENT-SIDE, and it has to be.** The original filename
never crosses the wire — `isUploadId` is the whole of what `/api/upload`
hands back, and the client keeps the name purely for display. So the client
resolves the order and sends the resolved list; the server sees an ordered
array of ids and no names at all. This is not a workaround. It is the same
split the journey already has, and it keeps the server's trust boundary
exactly where it is: an id it minted, matched against a UUID pattern.

If two files both begin `1_`, the first in the current list order wins and
the other joins the shuffled tail. Documented rather than errored — it is a
filename convention, not a validated input, and refusing a render over it
would be the wrong severity.

## Placement: `fill`, and its reduction to `troughs`

`src/lofi.ts` gains one exported function:

```ts
fill(env: Float32Array, seconds: number, speeches: Speech[], spacing: number): FillResult
```

`FillResult` is `TroughResult`'s shape — `{ placements } | { error }` —
because the delegation below has to return `troughs`' own answer unchanged.
A `Placement` is still `{ id, at }`, and several placements now share an
`id`.

**When `spacing` is 0 or absent, `fill` delegates to `troughs` unchanged.**
That identity is the point, and it is what should be mutation-tested: it
keeps `src/lofi.test.ts`'s existing exhaustive suite — the longest-first
ordering, the `MIN_GAP` case, the `SKIP_HEAD`/`SKIP_TAIL` boundaries, the
no-fit refusal — describing live behaviour rather than an orphaned branch.
The codebase already holds this shape twice: `bucketAt` reduces to
`floor(x * buckets / w)` when a stitch's two lengths agree, and `trims`
defaults to the identity for every caller that predates trimming.

With a spacing, placement is slot-based:

- Slots at `SKIP_HEAD + k * spacing`, for as many as fit before
  `seconds - SKIP_TAIL`.
- For slot `k`, search `± spacing / 2` around its centre for the quietest
  window that fits, scored by the existing `windowMean(env, …) / base` — the
  same global-median baseline, for the same reason it is global today.
- The speech for slot `k` is `order[k % order.length]`, where `order[0]` is
  the `1_` file **if there is one**. With no `1_` file, `order` is simply the
  shuffle and slot 0 takes whatever landed first — nothing requires a pinned
  file, the prefix is an override rather than a format.

`spacing` is a panel field in minutes, defaulting to 5. `MIN_GAP` survives
as a floor: a spacing below it is clamped, since two speeches closer than
`MIN_GAP` read as one long interruption regardless of what the user typed.

**A speech longer than its own slot refuses BY NAME, with no least-bad
fallback.** The existing posture, unchanged and load-bearing for the same
reason: a silently misplaced speech is indistinguishable from a working
render until someone watches the whole thing.

## Why 36 speech drops are not 36 ffmpeg inputs

A three-hour render at five-minute spacing is about 36 drops. Opening each
as its own input would put 36 inputs on the graph for what might be four
files.

It does not, because the graph already solves this. The crackle leg opens
**one** input and `asplit`s it into one tap per speech, each `atrim`med,
faded and `adelay`ed onto its own moment. The speech legs adopt the same
shape: one input per *unique* speech file, `asplit` into that file's drop
count, each tap delayed onto its own slot.

So inputs are bounded by the file count and only the leg count grows with
drops. That forces a cap split:

- `MAX_SPEECHES` (8) stops meaning "drops" and means **uploaded speech
  files** only. Its comment currently says "eight cut-ins over one track is
  already a lot of interruption", which was true when the two numbers were
  the same and is now describing the wrong quantity.
- `MAX_DROPS` (120) is new and bounds the placements — the filter graph's
  actual size. Three hours at five minutes is 36, so 120 leaves room without
  pretending there is no bound.
- `MAX_TRACKS` (60) bounds the music list. Sixty four-minute tracks is four
  hours, which is past anything this is for.

All three are checked in the panel and again in the route, like
`MAX_SPEECHES` and `MAX_PARTS` already are — the route is reachable without
the panel.

## Render progress

`/api/lofi` currently returns when the render is done and says nothing in
between. That was fine at a few minutes. At forty to ninety it is the
difference between a working feature and one people kill halfway through
because they cannot tell it from a hang.

**`-progress <file>`, polled — not a rewrite to `spawn`.** ffmpeg appends
key/value blocks to the named file as it works; the last `out_time_us` is
the position. The alternative, `spawn` with `-progress pipe:1`, means
rebuilding the error path: `renderLofi` uses `promisify(execFile)` and
throws through `toolError("ffmpeg", err)`, which reads the stderr tail, and
that behaviour is pinned by tests. Writing progress to a file leaves the
invocation, the buffering and the error path untouched.

`server/lofi.ts` keeps a module-scoped slot and exports a getter, exactly
mirroring `publishProgress`:

```ts
export function renderProgress(): { phase: "music" | "render"; done: number; total: number }
```

The getter reads and parses the file **on demand**, when the client polls.
No interval, so there is no timer to leak and no lifecycle to get wrong. The
slot holds the file path and the total, and is cleared in the same `finally`
that sweeps the work directory.

`phase` distinguishes the two runs, because the music pre-pass over three
hours is itself minutes long and a progress bar that sits at zero through it
is the problem restated.

The route is `/api/lofi/progress`, a bare GET returning the getter — one
line, the same as `/api/publish/progress`. Note `server/index.ts` routes on
exact `req.url` equality, so this is a distinct URL rather than a flag.

**ponytail: one global slot.** Two lofi renders cannot overlap in the panel,
the same assumption `publishProgress` already states. Unlike publish, this
route is reachable without the panel, so two concurrent renders would give
the second's numbers to both pollers — a wrong number, not corruption. Key
it by output name the day that matters.

## What this costs

Recorded rather than glossed, because the user chose to keep the overlays
after being shown the number.

- **The bars.** Measured at ~9.7s of encode per minute of render. A
  three-hour video pays roughly 30 minutes of CPU for them alone. One
  constant to disable if that stops being worth it.
- **Temp disk.** ~1 GB of flac for a three-hour music concat, plus the
  partial `.mp4`, both in directories that are already swept.
- **Output size.** The bars are moving content across the full width, so a
  three-hour file plausibly lands between 1 and 3 GB. The resumable upload
  handles it and will be slow. `~/Desktop/vstack/` grows by that per render,
  with nothing pruning it — deliberately the user's to clear, as today.

## What is deliberately not in scope

- **Loudness normalisation across tracks.** Forty-five tracks from forty-five
  sources will not sit at one level, and nothing in the graph corrects for
  it: the music leg carries no gain at all and every `amix` is
  `normalize=0`. This is a real defect of the long render and it is
  **separate** from this feature — it applies equally to today's one-track
  mix. Named here so the next person does not think it was missed. The fix
  is a `loudnorm` per leg in the pre-pass, where the concat already is.
- **Persisting the shuffle order.** Lofi fields are excluded from `save()`,
  pinned by `src/state.test.ts`, and the new ones follow. A reload loses the
  order. Matches today's behaviour exactly.
- **Resuming an interrupted render.** A killed server takes its partial with
  it, as it already does.

## Testing

Following `server/lofi.test.ts`'s posture — real ffmpeg, synthetic fixtures,
assertions on dB and pixels rather than on graph structure.

- **The concat pre-pass**: three tones of known frequency, back to back;
  assert the output's duration is their sum and that a sample inside each
  third carries that track's own tone. The tone is the load-bearing half —
  a mis-ordered leg is still the right length. First and third tones equal,
  middle one different, so an off-by-one lands measurably wrong in either
  direction. This is `server/cut.test.ts`'s fixture design, and for the same
  reason.
- **The boundary dip**: near-silence at the seam, full level well inside
  each track, and NOT at the head or tail of the whole output — the
  assertion that fails if the `i > 0` / `i < N-1` guards are dropped.
  Mutation-test the clamp with the short track in the **middle**, since a
  short track placed first has its fade-in suppressed by the guard and can
  never overlap anything. `server/longform.test.ts` records that a first
  version of this exact test passed with the clamp removed.
- **`fill` reduces to `troughs`**: mutation-tested. Every existing
  `src/lofi.test.ts` case runs through `fill` with no spacing and must be
  unchanged.
- **`fill` with a spacing**: drop count against length and spacing, the
  cycle order (`1_` first, then the shuffled tail, wrapping), `MIN_GAP`
  honoured when a spacing below it is asked for, and the by-name refusal for
  a speech longer than its slot.
- **The `asplit` fan-out**: one speech file, three drops; find its band in a
  narrow bandpass inside each of the three windows and not between them.
  This is the assertion that fails if drops are opened as separate inputs
  and one is mis-indexed.
- **Ordering**: pure, so exhaustive — `1_` pinned, two `1_` files, no `1_`
  file, and a shuffle that is a permutation of its input.
- **Progress parsing**: `out_time_us` out of a real progress file. The route
  and the poll have no tests, like the rest of the network surface.

## Open question for implementation

`MAX_TRACKS = 60` puts 60 inputs on the **pre-pass**, which is the one place
input count still grows with the music list. That is well within ffmpeg's
limits but has not been measured here. If it turns out to bind, the concat
demuxer (one input, a text file listing the tracks) is the upgrade path —
rejected as the default only because it requires stream compatibility across
arbitrary user uploads, which the filter path's per-leg `aresample` does not.
