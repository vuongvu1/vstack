# vstack — long-form output from finished shorts

2026-09-03

Supersedes nothing. It adds a **second way through the app**, parallel to
the one every prior spec describes, and reuses the last phase of it.

Every existing spec describes one journey: a YouTube URL becomes a
1080×1920 vertical short. This adds a second: a set of vertical `.mp4`
files, uploaded from disk, become one 1920×1080 horizontal video —
each part letterboxed onto a blurred copy of itself, concatenated in an
order the user chooses, then published through the machinery
`2026-08-23-vstack-publish-design.md` already built.

Nothing about the short journey changes. `/api/probe`, `/api/window`,
`/api/export`, `buildFilter`, `exportClip`, `prependStarter`, the frame
mask, `concatClips`, the layout system and the custom-box system are all
**untouched**. The only edits to existing code are additive: one new state
field, one new `defaults.ts` group, and one widened `buildSnippet`
signature — the last of which is a bug fix as much as a feature (see
"The `#Shorts` problem").

## What the user asked for

> The app currently generates short-form content. Now I want it to generate
> long-form content as well, from the short content output we have (I still
> keep them). On the home page, another option to generate long form content
> for YouTube (horizontal, best fit resolution). In the next page, the user
> can upload a list of videos (mp4) and reorder as wished. The output video
> will be simple: since the input videos are vertical, the output will
> contain the input plus a suitable blurred background of the input again.

Four decisions were settled in brainstorming and are recorded here as
constraints, not as open questions:

1. **Input arrives by upload**, not by picking from `OUT_DIR`. The user
   wants to stack videos vstack never made, not only its own exports.
2. **Parts are concatenated as-is.** Each finished short already carries a
   title card at the front and the bundled outro at the back; those stay.
   The long video reads as a compilation with chapter-like intros between
   segments. Nothing is stripped, nothing is detected.
3. **The flow ends in a real publish**, not just a file on disk — the
   existing preview phase, with its metadata panel and Publish button.
4. **Output is 1920×1080.** Every input is 1080×1920 and that is YouTube's
   long-form shape. "Best fit resolution" resolves to a constant here.

## The shape of the problem

The short journey is a pipeline of transformations over *one* source: probe
it, fetch a window of it, crop regions out of it, compose them into a
vertical frame, prepend a title card. Every layer knows the video id.

The long journey shares none of that. It has N sources, no video id, no
crop, no layout, no title card and no speech. What it *does* share is the
last stretch: a finished `.mp4` sitting in `OUT_DIR`, served over `/out/`,
played back, and uploaded with a title, a description and tags.

So the design is a **branch at `idle` that rejoins at `preview`**, and the
work is almost entirely in the middle: getting bytes from the user's disk
onto the server, and one ffmpeg graph.

```
idle ─┬─ trimming ─ framing ─┐
      └─ stacking ───────────┴─ preview
```

## Mode

`AppState` gains one field:

```ts
/** Which journey this session is on. Set once on the way out of `idle` and
 *  never again — the two paths do not meet until `preview`, which is the
 *  only phase that reads it. Not persisted: a mode belongs to a session's
 *  work, the same way `outName` and `outUrl` do. */
mode: "short" | "long";
```

Default `"short"`, so every stored record written before this feature
existed restores onto the journey it was made for. `save()` and `restore()`
do not touch it, and `src/state.test.ts` pins that exclusion the same way it
already pins `voice`'s.

Three things read it, all in `preview`:

- `defaultTitle` / the description / the tags the publish panel prefills.
- `/api/publish`'s `shorts` flag.
- The `← Back` button's target — `framing` on the short path, `stacking` on
  the long one.

Nothing else in the codebase branches on it. In particular `serveOut`,
`isOutName`, `/api/reveal` and `firstFrame` are mode-blind, because a
finished file is a finished file.

## Upload

### The route

`POST /api/upload`, `content-type: video/mp4`, **the request body is the raw
file** — one request per file.

There is no multipart parsing. Hand-rolling `multipart/form-data` is on the
order of 150 lines of boundary scanning and header folding, all of it a
place for bugs; taking a dependency for it violates the zero-dependency
posture the server has held since the first spec. Neither cost buys
anything: the browser is on loopback, and a raw body is the encoding a
single file already wants. The client does

```ts
await fetch("/api/upload", { method: "POST", body: file });
```

with the `File` straight from the `<input>`, which the platform streams for
free.

### What the server does

1. Stream `req` into `media/uploads/<uuid>.part.mp4`, counting bytes.
2. Past `UPLOAD_MAX` (512 MB), destroy the socket and unlink the partial —
   the same abort `PNG_MAX` already performs on an oversized title image,
   for the same reason: a body cap that answers politely has already
   buffered the thing it was capping.
3. `probeFile` the finished file. **This is the trust boundary.** A file
   that will not probe is deleted and the request answers 400. Nothing else
   inspects the bytes, and nothing needs to: ffmpeg is the only consumer.
4. `rename` to `<uuid>.mp4`.
5. Answer `{ id, duration, width, height }`.

The `.part` suffix and the UUID carry the same two lessons the download
partial and the export partial already carry — a half-written file must
never be reachable under a name a later request can ask for, and two
concurrent writes must not share a target.

### There is no client-supplied path component

The original filename never reaches the server. The client keeps it for
display; the server's handle is the UUID it minted itself. This is
*stricter* than `isOutName`, which validates a name the client chose, and
stricter than `/api/export`'s `digest`, which validates eight hex
characters the client computed. Here there is nothing to validate on the
way in at all, and on the way out `ids` are checked against
`/^[0-9a-f-]{36}$/` plus an `existsSync` in `media/uploads/` — a pattern
that cannot traverse and a directory that cannot be escaped.

### Storage

`media/uploads/` grows without eviction, exactly as `media/` and
`~/Desktop/vstack/` already do. Deliberate: re-rendering after a title fix
must not require re-uploading a gigabyte. `reportCache` already walks
`media/` recursively, so the uploads show up in the boot size log for free.

`listClips` never sees them — it reads `media/<id>/` per video directory,
and a UUID at the top level matches neither that traversal nor `CLIP_RE`.

### Deliberate omission: no progress UI

`ponytail:` loopback writes at roughly a gigabyte a second, so even a large
file lands inside the time a button takes to look pressed. The Add button
goes busy and comes back. Add a progress bar if a file ever makes it feel
dead.

## Render

### `server/longform.ts`

A new module beside `ffmpeg.ts` and `starter.ts` — it imports `errors.ts`
and `probeFile`, takes an output path from the caller, and re-derives
nothing. One exported function:

```ts
export async function stackWide(paths: string[], out: string): Promise<string>
```

It builds **one** ffmpeg graph that widens and concatenates in a single
encode. Per part `i`:

```
[i:v]split=2[bg{i}][fg{i}];
[bg{i}]scale=480:270:force_original_aspect_ratio=increase,crop=480:270,
       gblur=sigma=BLUR_SIGMA,scale=1920:1080,setsar=1[bgz{i}];
[fg{i}]scale=-2:1080,setsar=1[fgz{i}];
[bgz{i}][fgz{i}]overlay=(W-w)/2:0,fps=30,format=yuv420p[v{i}];
[i:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}]
```

then `[v0][a0][v1][a1]…concat=n=N:v=1:a=1[v][a]`, encoded `libx264 -preset
veryfast -crf 20`, `-c:a aac -b:a 128k`, `-movflags +faststart`.

Three properties of that graph are load-bearing and each has a reason:

**The blur downscales to 480×270 first.** A 1080×1920 source scaled to
*cover* 1920×1080 is 1920×3413. Running `gblur` at that size costs roughly
fifty times what it costs at 480×270, for a picture whose entire purpose is
to be out of focus. The downscale *is* most of the blur; the upscale back
to 1920×1080 costs nothing. Do not "improve" this by blurring at full
resolution — it is not more correct, only slower.

**The foreground is `scale=-2:1080`, not a computed width.** On a 1080×1920
source that yields 608×1080: 0.08% of aspect drift, invisible, and even on
both axes, which yuv420p requires. Computing 607.5 exactly and then having
to round it anyway buys nothing.

**`gblur` is available; `drawtext` is not.** This ffmpeg (Homebrew 8.1.1
here) is built without libfreetype, libass and librsvg — which is why
`renderTitleArt` runs in the browser — but `gblur` is core and
`server/starter.ts` already uses it. Nothing in this graph needs text.

`longform.ts` declares its **own** `BLUR_SIGMA = 12`, deliberately not
importing `starter.ts`'s `30`. The two blur different things at different
scales: the starter screen softens a full-resolution 1080×1920 frame behind
a title, this softens a 480×270 thumbnail before stretching it sixteenfold,
and the stretch supplies most of the softening on its own. Sharing one
constant would couple two knobs that want different values and would make
tuning either one move the other.

**A part with no audio** gets a leg cut from a shared `anullsrc` input,
appended **last** so the real parts' input indices never move. This is the
same positional rule `concatClips` and `prependStarter` both already
follow, and it is why the stand-in is conditional and trailing rather than
always present at index 0.

### Why `concatClips` is not reused

`concatClips` already normalises SAR, fps, sample rate and channel layout
across legs, and already handles the silent-part case. Extending it with a
target shape and a per-leg video filter would avoid duplicating about six
lines of audio chain.

It is not worth it. `concatClips` is mutation-tested for the segments path
— reversing its leg order fails a real pixel assertion — and its video leg
is genuinely a *different* chain from this one: it trims to a range and
normalises to part one's own probed shape, where this one takes whole files
and normalises to a fixed 1920×1080 with a composite in between. A
parameter that switches between two unrelated chains makes both harder to
read, and puts the segments path one careless edit away from a silent
regression. The duplicated audio lines are the cheaper cost.

### The route

`POST /api/stack`, body `{ ids: string[], title: string }`.

- `ids`: 1–20 entries, each matching `/^[0-9a-f-]{36}$/` and existing in
  `media/uploads/`. Order is the render order.
- `title`: through the same `readTitle` validator `/api/export` uses.

The output name is `outName(title, 0, total)` — which emits
`<slug>-0000-<mmss>.mp4` and **passes today's `OUT_NAME` regex unchanged**.
That is the whole reason `/out/`, `/api/reveal` and `/api/publish` need no
edits: the long-form render is, as far as they can tell, an ordinary
export. The duration passed to `outName` is the ceiled sum of the parts'
probed durations, computed inline — *not* `src/segments.ts`'s
`totalDuration`, which sums source-timeline segments and has nothing to do
with this path despite the matching shape.

The route writes `<OUT_DIR>/<name>.<uuid>.part.mp4`, registers that path in
the existing `inFlight` set so the SIGINT/SIGTERM sweep takes it if
`node --watch` kills the process mid-render, and renames on success. It
answers `{ name, url, size, duration }` — the same JSON shape
`/api/export` answers with, so the client's preview transition is the same
code path.

**No `.jpg` still is written.** That file exists for Studio's *Shorts*
thumbnail slot, and a 16:9 video has no such slot. `removeExport` unlinks
the still with `force: true`, so its absence is already a no-op.

### Deliberate omission: no `prev` sweep

The short path sends the previous output name as `prev` so a title or mark
edit does not strand the render it supersedes. `/api/stack` does not. A
long-form name varies only in the title and the total duration, and a
re-render after a reorder produces the *same* name — which overwrites
itself. Only a title edit strands a file, which is the one case the short
path's `prev` also cannot cover across a reload. If stranded renders become
annoying, `prev` is four lines to add here and takes `isOutName` unchanged.

## The `#Shorts` problem

`buildSnippet` currently appends `#Shorts` to the description whenever the
description does not already carry a `#shorts` token, case-insensitively.
That is correct for every video this app has ever produced and **wrong for
every video this feature produces**: it is the tag that tells YouTube to
classify an upload as a Short, and a twenty-minute compilation carrying it
is misfiled at the platform level.

So:

- `buildSnippet` takes `shorts: boolean`. `true` keeps today's behaviour
  exactly, including the case-insensitive single append; `false` leaves the
  description untouched.
- `/api/publish` reads the flag from its body, defaulting to `true` — so a
  request written before this field existed still behaves as it did.
- `server/youtube.test.ts` covers both. This file is where every decision
  that is awkward to change later already lives, and this is one of them.

`selfDeclaredMadeForKids: false` and `privacyStatus: "private"` are
unchanged and remain non-optional: the private status is Google's audit
rule for unaudited API projects, not a setting.

## Publish defaults

`src/defaults.ts` gains a long-form group beside the existing one:

- `LONG_TITLE_HASHTAGS` — the visible tags, no `#shorts`.
- `LONG_DESCRIPTION_TEMPLATE` — same channel links, **no shorts tag**.
- `LONG_TAGS_DEFAULT` — same comma-separated form, no `shorts` entry.

`defaultTitle(starterTitle, mode)` reserves room for whichever tag string
applies *before* slicing the title, preserving the existing invariant: the
naive concatenate-then-slice order cuts the tail, and the tail is the tags.

`src/defaults.test.ts` gains the long-form cases — tags survive a
200-character title, output never exceeds `YT_TITLE_MAX`.

## Thumbnail

`firstFrame(out, "wide")` on a 1920×1080 source is a plain downscale to
1280×720. The `force_original_aspect_ratio=increase` + `crop` pair is a
no-op at a matching aspect, so **nothing is lost** — unlike the shorts
path, where the same call takes a 607px band out of a 1080×1920 frame and
can clip the outer lines of a four-line title.

The frame itself is the first part's title card, letterboxed on its own
blur. That is a reasonable long-form thumbnail and needs no new pipeline.

`thumbnails.set` still needs a phone-verified channel and still answers 403
without one, and the publish bar still shows `thumbnail skipped` rather
than failing an upload whose video is already up.

## The stacking phase

### The panel

A new persistent-shell child of `sourceSlot`, built once at startup and
toggled with `hidden` — beside `publishForm`, under the same two rules that
already govern that slot: **never empty `sourceSlot`** (removing the
YouTube iframe's ancestor discards its browsing context and reloads the
player), and `hidden` alone is not enough, so the panel is covered by
`style.css`'s existing `.source > [hidden] { display: none; }`.

It renders a numbered list, one row per uploaded file: a grip, index, display
name, duration, then `↑`, `↓`, `✕`.

Rows reorder two ways, and both are load-bearing. A row is `draggable` and
drops onto any other row through the HTML5 drag API; the `↑`/`↓` buttons stay
beside it because native drag-and-drop has no keyboard path at all. Both ends
call the same `reorder(from, to)` — two array splices against live state.

The drop target is marked with a 2px line — `is-drop-before` on the target's
top edge, `is-drop-after` on its bottom. Which side is not cosmetic: `reorder`
splices the moved row OUT before inserting it at `to`, so every index past the
source shifts down by one and a downward move lands *after* the target while
an upward one lands *before* it. A fixed side would point at the wrong gap on
every second drag. It is an inset `box-shadow` rather than a border, which
would add 2px to the row's box and nudge the whole list on every `dragover`.

`clearDropMarks` runs at the top of each `dragover` rather than out of a
`dragleave` handler: `dragleave` also fires when the pointer crosses into one
of the row's own children, so a per-row clear flickers the line as the cursor
travels along a row it is still over.

`ponytail:` the HTML5 drag API rather than pointer events, so there is no
autoscroll when the list runs past the panel and the line marks a whole row
rather than tracking the cursor's position within it. Reach for pointer
capture the day either one bites. The source index lives in a module-scoped `dragFrom` rather than being
read back out of `dataTransfer`, because the spec only exposes the payload on
`drop` and a `dragover` handler has to know the source to decide whether to
accept at all; the transfer still carries it as `text/plain`, since Firefox
refuses to start a drag whose `dataTransfer` is empty.

### The bar

Two rows, following the existing `.bar-row` + `.bar-end` grammar:

1. `<input type="file" multiple accept="video/mp4">` and an `Add` button.
2. A title field (`.field-grow`), then `← Back` (`.btn-gray`) and
   `Render →` (`.btn-solid`) in a trailing `.bar-end`.

The title field writes through `setQuiet` — a notifying update on every
keystroke would rebuild the input and drop the cursor — so `Render`'s
`disabled` is flipped **inside the input handler**, not by a render. This
is the same in-place toggle the Export button and the Try button already
use, and for the same reason: without it the button stays disabled until
some unrelated `setState` happens along, which reads as a broken button
rather than as "type a title first". `doStack` re-checks the title itself
rather than trusting the button.

### State

The uploaded parts live in `AppState` as

```ts
/** Uploaded long-form parts, in render order. Empty on the short path.
 *  `id` is the server's UUID; `name` is the local filename, kept only for
 *  display, and never sent anywhere. */
parts: { id: string; name: string; duration: number }[];
```

Not persisted. A reload loses the list, which is the accepted cost of not
adding a stored record whose entries point at files the user may have swept
by hand. The uploaded `.mp4`s themselves survive on disk; only the ordering
is lost.

Reorder and remove handlers read `getState().parts`, never `render()`'s
snapshot — the same rule `+ Box` already follows, for the same reason: a
handler that appends to an array written by `setQuiet` and reads a stale
copy silently reverts whatever happened since the last notifying update.

## Data flow, end to end

```
idle  ──[Long form →]──▶  stacking
                            │  <input type=file> → N × POST /api/upload
                            │      → media/uploads/<uuid>.mp4, probed
                            │  ↑ ↓ ✕ reorder state.parts
                            │  title typed
                            └──[Render →]── POST /api/stack {ids, title}
                                              → stackWide(paths, part)
                                              → rename into OUT_DIR
                                              → { name, url, size, duration }
                                                     │
preview  ◀───────────────────────────────────────────┘
   │  <video src="/out/<name>?t=<mtime>">
   │  panel prefilled from LONG_* defaults
   └──[Publish]── POST /api/publish {name, title, description, tags,
                                     shorts: false}
                    → uploadVideo → setThumbnail(firstFrame(out,"wide"))
```

## Error handling

Nothing new in kind. `HttpError` and `toolError` cover both new routes, the
way they cover every existing one:

- An unprobeable upload: 400, partial deleted.
- An oversized upload: socket destroyed, partial deleted — no response
  body, because a body implies the server read what it was refusing to
  read.
- An id that does not resolve to a file: 400 before ffmpeg is spawned.
- A failed `stackWide`: `toolError("ffmpeg", err)` with the stderr tail,
  the partial removed in a `finally` and dropped from `inFlight`.
- A killed server mid-render: the SIGINT/SIGTERM handler unlinks the
  partial synchronously.

## Testing

`server/longform.test.ts` — real ffmpeg, mirroring `server/ffmpeg.test.ts`'s
posture of asserting output *pixels* rather than command strings. Two
synthetic 1080×1920 clips in different colours, stacked:

- Output is exactly 1920×1080.
- A centre pixel sampled in each half carries that part's own colour —
  which is the letterboxed foreground, at full saturation.
- A left-edge pixel is **not black**. This is the assertion that fails if
  the blur leg is dropped and the graph pillarboxes instead, and it is the
  reason the two source clips are different colours: the edge sample also
  proves the background tracks the part it belongs to.
- Duration is the sum of the parts.
- Leg order is mutation-tested — reversing the concat's input order must
  fail the second half's colour sample, exactly as `concatClips`' own test
  does.

`server/youtube.test.ts` — `shorts: false` leaves a description with no
shorts tag alone; `shorts: true` still appends `#Shorts` once, and still
does not double-append against `DESCRIPTION_TEMPLATE`.

`src/defaults.test.ts` — the long-form title cases.

`src/state.test.ts` — `mode` and `parts` are absent from `save()`'s record,
mutation-tested on `not.toHaveProperty`, the way `voice`'s exclusion
already is; a record with no `mode` restores as `"short"`.

The upload route, the stacking panel and the reorder buttons have **no
tests**, consistent with the existing posture: `main.ts`, `editor.ts`,
`preview.ts` and `player.ts` are DOM-driven and verified by hand, and the
HTTP surface around `/api/publish` and `/api/reveal` is untested for the
same reason.

## Out of scope

Named so they are not mistaken for oversights:

- **Stripping the per-part title cards and outros.** Settled: the
  compilation keeps them. Doing it would need per-file in/out points, which
  is a trimming UI this feature deliberately does not have.
- **A long-form title card of its own.** The output starts on the first
  part's card.
- **Per-part trimming, transitions, crossfades, chapter markers.**
- **Upload progress.** See the `ponytail:` note above.
- **Eviction of `media/uploads/`.** Consistent with `media/` and
  `OUT_DIR`, both of which the user sweeps by hand.
- **Making the output resolution configurable.** Every input is 1080×1920.
  A knob with one legal value is not a knob.
