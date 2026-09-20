# vstack — a lofi mix from a track, a picture and some speeches

2026-09-16

> **Amended 2026-09-16**, while the implementation plan was being written and
> before any code existed. Two decisions below were reversed against what the
> codebase actually does:
>
> - The music upload is **`/api/upload-audio`**, not `/api/upload?audio=1`.
> `server/index.ts` routes on exact `req.url` equality (the comment on
> `/api/publish/progress` says so), and a query string does not match
> `/api/upload`. The two routes share one extracted handler and differ only
> in which prober they call.
> - The duck's knobs are **`DUCK_THRESHOLD` and `DUCK_RATIO`**, not a
> `DUCK_DB`. `sidechaincompress` takes a threshold and a ratio, not a target
> depth, so a dB knob would have been a number that named nothing in the
> graph.
>
> **Amended 2026-09-17**, after `c629fba` (a browser-verified defect: a
> non-16:9 picture stretched to 1920x1080 warped visibly for the whole
> render, behind every second of it, in a way a 1280x720 thumbnail glanced
> at once does not). The background is now **cover-cropped** by `renderWide`,
> not stretched — `src/thumb.ts` splits `decodeBitmap`/`encodeJpeg` out as
> the shared steps and gives the background its own `increase`+crop drawing
> distinct from `renderThumb`'s stretch. The "Unlike the background, the
> thumbnail is stretched rather than cropped" line below was written when
> *both* were stretched and reads as though the background was always
> cropped; it is accidentally still correct, but for a different reason than
> the one it states.

> **Amended 2026-09-17**, on the user's call after watching a real render:
> the lofi journey plays **no transition swell**. `long-form-transition-sound.mp3`
> stays bundled and stays the LONG journey's asset — `longform.ts` still
> mixes it over every cut between two compilation parts — but a cut-in here
> is a voice arriving inside a track that never stops playing, not a chapter
> break between two unrelated videos, and a swell over it is one sound too
> many. Everything below about `TRANSITION_PATH`, `TRANSITION_PEAK`,
> `TRANSITION_GAIN`, the `asplit`/`adelay` fan-out and the swell's own
> `amix` describes a graph that no longer exists: `[ducked][sm]amix=…
> duration=first` now produces `[a]` directly. `checkLofi` went with it —
> it existed only to check that one asset at boot, and this journey now
> bundles nothing. The dip to black at each cut-in's edges is unchanged;
> only the sound over it is gone.

> **Amended 2026-09-18**, adding the "vinyl record" treatment on a cut-in's
> voice, after the reference tool at `audiokit.in/tools/lofi-converter` —
> which describes its own preset as rolling off the high end, injecting
> "faux-vinyl crackle and tape hiss", wobbling the pitch, and crushing the
> bit rate. Three of those four shipped. The band-limit was already here;
> `acrusher` adds the bit reduction, BEFORE the lowpass so its aliasing is
> rolled off rather than sprayed past a filter that already ran; and
> `vinyl-crackle.mp3` — a sixth bundled asset, built from the lead-in
> grooves of two public-domain Edison cylinders on Wikimedia Commons — plays
> as a bed under the whole render with a second, louder leg faded in under
> each cut-in. `checkLofi` returns with it.
>
> The pitch wobble did NOT ship. `vibrato` emits NaN inside this graph
> (clean in isolation, which is what hid it) and kills the AAC encoder; it
> is also the effect least suited to speech. The treatment is skipped
> entirely on a cut-in with no audio of its own, both because there is
> nothing in silence to treat and because filtering silence is what
> triggered the NaN.

> **Amended 2026-09-18 (second)**, after listening. Three corrections to the
> amendment above, all found by measuring a render rather than by reasoning:
> the crackle asset is the USER'S own file, not the Edison-cylinder loop
> that first shipped; the crackle plays at FULL SPECTRUM rather than
> band-limited with the voice (rolled off it is provably inaudible — the
> same render with its gain at zero measured identical to 0.1 dB); and it is
> levelled with `compand` before either gain, because a 41 dB crest factor
> means the gain that makes the bed audible is also the gain that clips its
> pops. The band-limit test now measures the speech's own contribution
> rather than the whole mix, which is all it was ever about.

> **Amended 2026-09-18 (third)**, on the user's call: a speech is now
> **audio only**, and the whole cut-in is gone. A speech may be uploaded as
> an audio file or as a video one indifferently — if it carries pictures,
> they are discarded. The background picture holds the frame from t=0 to the
> end of the track, and the only thing a speech does is arrive in the mix.
>
> Everything below about the cut-in's picture describes a graph that no
> longer exists: the letterbox over a blurred copy of itself, the `tpad`
> padding to each speech's own start, the `enable=`-gated `overlay` chain,
> the dip to black at each speech's edges and the half-gap clamp on those
> dips are all removed. So is the `anullsrc` stand-in: a speech is probed
> with **`probeAudio`** on both sides of the wire now (the client uploads it
> through `/api/upload-audio`, the route re-probes it there), so a file with
> no audio stream is refused at upload rather than rendered as a silent
> stretch. The video track is one still frame, so there is nothing left to
> synchronise and nothing to stand in for.
>
> `FADE` survives, doing less: it is the crackle boost's own ramp and the
> room `troughs` reserves at each edge of a placement. The audio chain —
> the band-limit, `acrusher`, the duck, the crackle's two layers — is
> untouched. `server/lofi.test.ts` lost its two picture-of-the-speech
> assertions, its dip assertion and its half-gap-clamp test, and gained
> three: the background is still the background at seven sampled instants
> including both edges of a speech (mutation-pinned by re-adding the
> overlay), two audio-only .m4a speeches land in their own windows, and a
> speech with no audio stream is refused.

> **Amended 2026-09-20 (fourth)**, on the user's call: the background may be
> an **animated GIF**, looped for as long as the track runs, and not only a
> still. Everything below describing the background as one picture still
> holds with "picture" read as "loop" — the same cover-crop, the same `-t`
> bound at the music's length, the same "the picture is the whole video".
>
> Two things are genuinely new. `renderLofi`'s `image` option is now
> `background`, and it picks between `-loop 1 -framerate N` (a still) and
> `-stream_loop -1` (an animation) by COUNTING FRAMES with ffprobe. The two
> forms are not interchangeable and one wrong pairing hangs rather than
> erroring — see the invariant in CLAUDE.md before touching it. And
> `/api/lofi` grew a second door for the background: `bgId`, an upload id,
> as the alternative to the inline `image` bytes. A GIF cannot go inline
> because the client cannot cover-crop it (`createImageBitmap` sees only its
> first frame) and because `json()` reads a whole body into memory uncapped.
> `image` and `bgId` are mutually exclusive; `thumb` is required either way
> and is a still JPEG either way.

> **Amended 2026-09-20 (fifth)**: every lofi render now carries a **spinning
> mark** in the top-right corner — `server/assets/lofi-video-logo.png`, a
> seventh bundled asset, turning once every 10 seconds for the whole track.
> It is unconditional: no upload behind it and no way to switch it off, the
> same posture the crackle takes, and `checkLofi` now guards both files.
>
> The geometry has two traps, both recorded as an invariant in CLAUDE.md
> because both look right in the one frame anybody checks: `rotate` shears
> off whatever leaves its input-sized box, so the mark is padded to its own
> diagonal first; and the margin insets that padded box rather than the mark,
> or the clearance collapses to 10px at 45 degrees while 0 and 90 look fine.
> Its ffmpeg input is appended LAST, after the crackle, so no existing index
> moves.

Supersedes nothing. It adds a **fourth journey** beside the short one, the
long one and the chat-moments dead end: `idle → lofi → preview`. A user
picks one music track, one background image and a handful of speech clips;
the app finds the quiet stretches in the music, drops the speeches into
them, and renders one 1920x1080 video the length of the track. It shares
`preview`, `/out/`, the publish panel and `/api/upload` with the long
journey and nothing else.

Everything the other specs describe is unchanged by this one.

## What the user asked for

A lofi music video in the shape of
`youtube.com/watch?v=OYX64gV0ZQg`: a track plays end to end over a still
picture, and where the music thins out, a spoken clip cuts in — treated so
it sounds like it belongs to the mix rather than pasted over it.

Three inputs, all the user's own files:

- one **music** track (the bed, and the output's full length),
- some **speeches** (`.mp4`, used whole — the user trims them elsewhere),
- one **background image**.

Explicitly **not** asked for: trimming a speech in-app, more than one
picture, captions, or animating the background.

## Decisions taken before the design

Recorded because each one closed off a branch of the design rather than
being a detail inside it.

| question | answer |
|---|---|
| what is on screen during a speech | the speech's own video, cut in |
| output shape | 1920x1080, always |
| how the speech video sits in the frame | letterboxed over a blurred copy of itself — `stackWide`'s recipe |
| how much of a speech is used | all of it |
| how positions are chosen | detected, then correctable by dragging |
| what "lofi effect" means | a 300–3000 Hz band on the voice, and the music ducks under it |
| what happens at the edge of a cut-in | a dip to black, like the long journey's |

## Mode

A fourth `mode`: `"lofi"`. The mode-claim invariant already in CLAUDE.md
holds — every exit from `idle` claims one — so this adds one call site (the
`Lofi →` button) and touches two existing reads:

- `preview`'s `← Back` target, which currently branches `long` →
  `stacking`, otherwise `framing`; it becomes a three-way.
- the wide-slot test, `s.phase === "preview" && s.mode === "long"`, which
  becomes `s.mode !== "short"`. A lofi render is 16:9 for the same reason a
  stack is, so the slot's shape follows "not the short journey" rather than
  an enumeration that grows with every journey.

`shorts: false` on publish, for the reason the long journey documents: a
track-length video carrying `#Shorts` is misfiled at the platform level and
cannot be undone from Studio.

## Inputs

### Speeches — `/api/upload`, unchanged

Exactly what the long journey's parts already do: raw bytes over loopback, a
server-minted UUID, `probeFile` as the trust boundary, `isUploadId` on the
way back in, `UPLOAD_MAX_BYTES` checked client-side with the socket-destroy
backstop behind it. Nothing in that route changes for a speech.

### Music — `/api/upload-audio`

A second URL rather than a flag on the first, because this server routes on
exact `req.url` equality and a query string would miss `/api/upload`
entirely. Both URLs run the same extracted handler; the only difference is
which prober validates the bytes.

The audio prober exists because `probeFile` **requires a video stream**
(`ffprobe found no video stream in …`) and an mp3 has none. The audio case
calls a small `probeAudio` instead: duration from `format`, plus an
assertion that some stream has `codec_type === "audio"`. Everything else is
the same code path.

The file still lands as `<uuid>.mp4`. ffmpeg dispatches on content, not on
extension, so `uploadPath`, `isUploadId`, `reportCache` and the partial's
`.part.mp4` naming all need no edits at all.

`ponytail:` the misleading extension. Give `uploadPath` a second argument
the day someone opens `media/uploads/` by hand and is confused by it.

### Background image — not uploaded at all

The client rasterises the picked file into a 1920x1080 JPEG on a canvas and
sends the bytes in the render body, where the existing `jpeg()` validator
checks the signature. This is the third image this client rasterises for a
server that cannot (after `titlePng` and `renderThumb`), and it is here for
`renderThumb`'s reasons: `createImageBitmap` decodes every format the
browser can display, which is wider than a scale filter would have to be
told about, and the output's dimensions are fixed so nothing server-side has
to check one.

The same picture, re-rasterised at 1280x720 by `renderThumb`, is the publish
thumbnail. So the long journey's "a wide video's thumbnail must be picked,
not derived" decision is satisfied without a second picker.

Unlike the background, the thumbnail is **stretched** rather than cropped —
that is `renderThumb`'s existing rule and it is not changed here.

## Detection — `src/lofi.ts`

A pure module at the bottom of the client layering beside `geometry.ts` and
`segments.ts`, importing nothing. That is what lets vitest's `node`
environment test it, and what would let the server import it later if
detection ever has to move.

```ts
export type Speech = { id: string; name: string; seconds: number };
export type Placement = { id: string; at: number };

export const BUCKETS_PER_SEC = 4;
export const MIN_GAP = 20;       // seconds between two speeches
export const SKIP_HEAD = 15;     // no speech in the opening
export const SKIP_TAIL = 10;     // nor over the ending

export function troughs(
  env: Float32Array,
  seconds: number,
  speeches: Speech[],
): Placement[] | { error: string };
```

The envelope is produced by the client, not by this module: `main.ts`
already decodes audio through an 8 kHz mono `OfflineAudioContext` and
reduces it with `peaks()` from `src/waveform.ts`. The lofi panel reuses both,
at four buckets a second.

The algorithm:

1. `baseline = median(env)`, floored away from zero. Global, not rolling —
   a music track is stationary in a way an eleven-hour chat log is not, which
   is the one place this deliberately does **not** copy `server/chat.ts`'s
   scorer. `ponytail:` a rolling median if a track with a loud half comes to
   misplace everything.
2. Each speech needs `L = seconds + 2 * FADE` of room — the dip out of the
   picture and back into it are part of its slot, not extra.
3. Slide an `L`-wide window over the bins; a window's score is its mean
   divided by `baseline`. Lower is quieter.
4. Place the **longest speech first**. A long speech has strictly fewer
   legal windows than a short one, so placing the short ones first can take
   the only slot the long one had. Take the lowest-scoring window that
   starts after `SKIP_HEAD`, ends before `seconds - SKIP_TAIL`, and clears
   `MIN_GAP` from every slot already taken.
5. Sort the result by time and return it. `at` is the window's start plus
   `FADE` — the instant the speech's own picture is fully up.

If a speech has no legal window, the whole call fails with a message that
names it: *"Speech 3 (47s) has no quiet stretch that long."* It does **not**
fall back to the least-bad position. A silently misplaced speech is
indistinguishable from a working render until someone watches the output,
which is the failure class this codebase treats as cardinal.

The returned positions are drawn as markers on the waveform strip and can be
dragged. A drag rewrites that one `at`, clamped to the track and to its
neighbours' `MIN_GAP`; detection does not re-run on a drag, only when the
speech set changes.

## The `lofi` phase

### The panel

`lofiPanel`, a third child of `sourceSlot` beside `publishForm` and
`stackPanel`, toggled with `hidden` under the same rule: `sourceSlot` itself
is never hidden, because that would put the YouTube iframe's ancestor into
`display: none`.

Three pickers:

- **Music** — one file. Once uploaded, the panel shows its name and
  duration, and the bar's strip gains its waveform.
- **Background** — one image, shown as a chip at the size it will be
  cropped to.
- **Speeches** — many `.mp4`s, a list with a remove button each. **No
  reorder controls**, unlike the stacking panel: time places these, not list
  order, so a row's position in the list means nothing.

### The bar

The waveform strip with a draggable marker per speech, a title field, and
`Render` as the one `.btn-solid`. `Render` is disabled until there is a
title, music, an image, at least one speech, and a placement for every
speech — flipped in place from the title field's `oninput`, the same way
Export's and Publish's already are, because the field writes through
`setQuiet` and reaches no render.

### State

`music`, `image`, `speeches[]` and `placements[]` join `AppState` beside
`parts`, and like `parts` and `thumb` they are **not persisted**. A reload
re-picks. The image in particular is a megabyte-scale data URL that has no
business in localStorage, and the ids alone would restore a panel whose
pickers disagree with it.

## Render — `server/lofi.ts`

A sibling of `ffmpeg.ts`, `longform.ts` and `starter.ts`, not a layer above
any of them: it takes input paths and an output path from the caller, needs
neither `MEDIA_DIR` nor `OUT_DIR`, and imports `probeFile` and nothing else.

It re-derives the transition asset's path with its own `asset()` helper and
declares its own `FADE` and `TRANSITION_PEAK` rather than importing them
from `longform.ts`. Siblings do not import siblings here — the same call
`longform.ts` made when it re-derived `TRANSITION_PATH` instead of reaching
into `starter.ts` for it, and the same call `starter.ts` and `youtube.ts`
each made re-deriving `~/.vstack/`.

One ffmpeg pass. Inputs: `0` the image (`-loop 1`), `1` the music, `2 …
N+1` the speeches in placement order.

### Video

Base: the image scaled to **cover** 1920x1080 (`force_original_aspect_ratio=
increase` + `crop`), at 30 fps, `setsar=1`.

Then one `fade=t=out` / `fade=t=in` pair chained onto that base per speech,
at `at - FADE` and at `at + duration`. Chaining works because `fade=out`
**holds** black after it completes rather than restoring, so N pairs read as
N dips rather than as one fade the stream never comes back from.

Each speech gets `stackWide`'s exact foreground recipe — `scale=1920:1080:
force_original_aspect_ratio=decrease:force_divisible_by=2` over a blurred,
upscaled copy of itself — then `setpts=PTS-STARTPTS+at/TB`, its own
`fade=in` at 0 and `fade=out` at `duration - FADE`, then
`overlay=enable='between(t,at,at+duration)':eof_action=pass:repeatlast=0`
onto the base. `format=yuv420p` closes the chain and `-t <music seconds>`
closes the output.

`decrease` rather than a fixed height for `stackWide`'s reason: an upload is
whatever file the user picked, and a part wider than 16:9 scaled to a fixed
height overflows the frame.

### Why overlay rather than concat

The output's duration is the music's **by construction**. Nothing sums, so
`outName`'s `mmss` cannot come to disagree with the file it names, and no
leg's length feeds any later leg's offset. A concat of image legs and speech
legs would put that arithmetic back — the trap the long journey's
dip-rather-than-`xfade` decision already exists to avoid, and it would have
one extra twist here: the final image leg would have to absorb the rounding
so the picture still ends when the music does.

### Audio

Each speech: `highpass=f=300,lowpass=f=3000` — the AM-radio band, which is
the whole lofi treatment — then `adelay` to its `at`. Those mix into
`[speech]` with `normalize=0`.

`[speech]` is `asplit`, and one copy is the sidechain of a
`sidechaincompress` over the music. The duck is what makes a merely
*adequate* trough sound deliberate: the detector only has to find a thin
stretch, not a silent one. It is also why the duck is a compressor rather
than a `volume` step gated on `between(t,a,b)` — a step has no attack or
release and clicks at both edges.

The ducked music and `[speech]` mix, and the swell goes on top of that: one
`adelay` of `at - TRANSITION_PEAK`, clamped at zero, per speech, **on the
way in only**. Entering a cut-in is a chapter break and wants marking;
leaving one has the voice ending and the music resuming already, and a
second swell there is noise.

Both mixes are `normalize=0` and `duration=first`, for the two reasons
`stackWide` documents: `amix` divides by its input count by default, so a
render would come out quiet purely for carrying a swell; and `longest` would
let a swell delayed onto a late speech outrun the programme and push the
render past the duration `outName` has already committed to.

Three knobs: `DUCK_THRESHOLD` and `DUCK_RATIO` (the compressor's own two
parameters — `sidechaincompress` has no target-depth input, so there is no
dB number to set), and `TRANSITION_GAIN` (1.0, `longform.ts`'s value).
Setting the last to zero removes the swell without touching the graph.

`FADE` is 0.5s, the same number `longform.ts` uses and for the same reason —
a beat the eye reads as a break — but declared here rather than imported, so
tuning one does not move the other.

## The route — `/api/lofi`

```
{ title, music: <uploadId>, image: <jpeg bytes>,
  speeches: [{ id: <uploadId>, at: <seconds> }], prev? }
```

Validators, in order — the first four already exist:

- `readTitle(raw.title, "title")`
- `isUploadId` on `music` and on every `speeches[].id`
- `jpeg(raw.image, "image")` — three bytes, `FF D8 FF`
- `isOutName` on `prev`
- this route's own: at most `MAX_SPEECHES` (8) entries; every `at` finite and
  ≥ 0; **and, against durations the server probes itself rather than any
  the client sent**, `at + duration <= music duration` for each speech and
  no two speeches overlapping.

There is no client-supplied path component: a UUID `isUploadId` has reduced
to 36 characters of hex and dashes, and `uploadPath` builds the path. The
image is bytes, not a name.

The response is the same three fields `/api/stack` answers with, and the
same post-render work: `outName(title, 0, total)`, where `total` is the music's probed duration —
which passes today's
`OUT_NAME` unchanged, exactly as a long-form name does, so `/out/`,
`/api/reveal` and `/api/publish` need no edits — the image saved beside it
as the `<name>.thumb.jpg` sidecar `applyThumbnail` already prefers over a
render's own first frame, the partial-and-rename dance with the in-flight
`Set`, and the `prev` sweep after the rename rather than before it.

## Error handling

- No quiet stretch long enough for some speech → detection fails
  client-side, naming the speech; no request is sent.
- A file ffmpeg cannot read → the existing `/api/upload` 400, unchanged.
- An upload over `UPLOAD_MAX_BYTES` → the client's own size check, with the
  socket-destroy backstop behind it.
- A speech that no longer fits after a drag → the drag is clamped, so this
  cannot reach the route; the server check exists because the route is
  reachable without the client.

## Testing

`src/lofi.test.ts` — pure, and exhaustive on the model the other bottom
modules are: `troughs` over a synthetic envelope with two known holes,
longest-speech-first placement (a case where placing the short one first
would strand the long one), `MIN_GAP`, `SKIP_HEAD` and `SKIP_TAIL` at either
side of their boundaries, the no-fit refusal, and stability across repeated
calls.

`server/lofi.test.ts` — real ffmpeg, real pixels, real audio levels, with an
explicit `beforeAll` timeout for `longform.test.ts`'s reason (several real
encodes competing for CPU in the full suite):

- the output is 1920x1080 and **exactly the music's duration**,
- a frame at 0.5s carries the image's colour,
- a frame mid-speech carries the speech's,
- a frame on a dip is near black,
- the music's level during a speech is measurably below its level before
  it,
- the speech's energy above 4 kHz is near zero,
- the transition swell survives a SILENT cut-in, measured on its own peak
  above a highpass that removes the bed — the one case that catches the
  swell's conditional input index losing its silence-stand-in offset, which
  a non-silent cut-in cannot (the correct and the broken formula agree
  there).

Mutation-pinned: dropping the duck, dropping the fades, and dropping the
speech's band-limiting filter each fail exactly one of those. Dropping the
output `-t` was also run and caught nothing — it is provably redundant for
this graph (the image input's own `-t` already bounds the video, and two
chained `amix ... duration=first` stages bound the audio independently of
it) and is kept for defence in depth against a future graph change, not as
a guarded invariant. "Reversing the overlay order" was never run.

`src/lofi.test.ts` also covers `clampPlacement`: an ordinary move, each of
the track's own two bounds, each neighbour's bound, and the drag-past-a-
neighbour case that leaves no legal position at all, which is refused
rather than resolved to an illegal `at`.

The route, the panel and the pickers have no tests, like the rest of the
network and DOM surface.

## Out of scope

- Trimming a speech inside the app.
- More than one background, or any motion on the one background — no Ken
  Burns drift, no video background.
- Captions or any text on screen. This ffmpeg has no `drawtext`, and a
  per-speech rasterised PNG is a feature of its own.
- Eviction for `media/uploads/`, which this journey grows the same way the
  long one does.
- A crossfade between the picture and a cut-in. Named in the long journey's
  `ponytail:` comment for the same arithmetic reason, and the reason is
  stronger here: a crossfade would make the video shorter than the track.
