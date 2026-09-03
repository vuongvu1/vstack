# CLAUDE.md

`vstack` — turn 2–4 regions of a YouTube video into a 1080×1920 vertical short.

Local single-user tool. Not deployed. Vite + vanilla TS frontend, zero-dependency
`node:http` backend that shells out to `yt-dlp` and `ffmpeg`.

Read `docs/specs/2026-08-20-vstack-design.md` before changing behaviour — the
three phases, `/api/probe`, `/api/window` and the caching scheme it describes
are still accurate — plus `docs/specs/2026-08-21-vstack-layouts-design.md`,
which covers the layout system, supersedes the two-box model the 2026-08-20
doc describes, and is the authority on `/api/export`'s current body
(`layoutId` + `boxes`, not that doc's `boxTop`/`boxBottom`), plus
`docs/specs/2026-08-22-vstack-frame-borders-design.md`, which covers the white
gutters and rounded pieces and supersedes the layouts doc's claim that borders
are out of scope and that `xstack` produces `[v]` directly, plus
`docs/specs/2026-08-22-vstack-starter-screen-design.md`, which covers the
title card prepended to every export and supersedes the layouts doc's
`/api/export` body again (`starterTitle` + `titlePng` on top of `layoutId` +
`boxes`, and no `title` — the starter title names the file now), plus
`docs/specs/2026-08-23-vstack-publish-design.md`, which covers `out/`, the
`preview` phase and publishing, and supersedes the starter-screen doc's
`/api/export` *response* — that route answers with JSON now and leaves the
file on disk rather than streaming an attachment back, plus
`docs/specs/2026-08-25-vstack-custom-boxes-design.md`, which covers the up to
two floating pieces a user can drop over a layout's cells, extends the
layouts doc and the frame-borders doc without superseding either (cells,
`ratioOf`, `xstack` and the paint-over-the-composite rule all survive
intact), and supersedes the layouts doc's `/api/export` body once more —
`customs` on top of `layoutId` + `boxes` + `starterTitle` + `titlePng` +
`voice`, plus `docs/specs/2026-08-28-vstack-segments-design.md`, which covers
multiple trim segments and a visible playhead and supersedes the 2026-08-20
doc's one-`start`/`end`-pair trimming phase and `/api/window`'s body
(`segments` + `duration`, not `start` + `end`), and supersedes the
custom-boxes doc's `/api/export` body once more — an optional `digest` on top
of everything else, plus `docs/specs/2026-09-03-vstack-longform-design.md`,
which supersedes nothing and instead adds a SECOND journey through the app:
uploaded vertical mp4s letterboxed onto blurred copies of themselves,
concatenated into one 1920x1080 video, and published through the same
preview phase. Everything every other spec describes is the *short* journey
and is unchanged by it. No spec covers the speech engine: every one of them
describes macOS `say` and its `Linh` voice, which this codebase no longer
uses at all (see "the voice" below).
`docs/plans/2026-08-20-vstack.md` is the historical build plan and carries
inline "as built" corrections; treat it as a record, not as instructions.

## Commands

```
pnpm server   # backend on 127.0.0.1:8787 under `node --watch` (runs .ts directly,
              # no build). Restarts on any server file it imports — which is why
              # `src/main.ts` edits do not bounce it, but `src/geometry.ts` does.
pnpm dev      # Vite on :5173, proxies /api -> :8787
pnpm test     # vitest, 272 tests (shells real ffmpeg *and* real VieNeu-TTS)
pnpm build    # tsc && vite build
pnpm voices   # audition the starter screen's 20 TTS presets (see below)
pnpm tts-setup     # one-off: build ~/.vstack/vieneu (see server/tts.py)
pnpm youtube-auth  # one-off OAuth setup for publishing (see server/youtube.ts)
```

Needs `ffmpeg`, `ffprobe` and `yt-dlp` on PATH, the speech venv from
`pnpm tts-setup`, and all four bundled assets in `server/assets/`. The server checks
all of it at boot and exits with an install hint if any is missing. Nothing
here needs macOS `say` any more — the starter screen's voice is VieNeu-TTS,
and the only remaining macOS dependency is `afplay` in `pnpm voices` and
`open -R` in `/api/reveal`.

## Architecture

```
server/errors.ts   HttpError (status + message), toolError (stderr tail)
server/ffmpeg.ts   MEDIA_DIR/OUT_DIR, clipName/clipPath, segmentDigest,
                   outName/outPath, isOutName, stillPath/removeExport,
                   probeFile, ConcatPart/
                   concatClips, buildFilter, assertBoxes, exportClip,
                   firstFrame,
                   reportCache
server/mask.ts     MASK_DIR, maskPath, ensureMask (frame-overlay PNG cache)
server/longform.ts WIDE, stackWide (the long journey's one ffmpeg pass)
server/starter.ts  MUSIC_PATH/CUE_PATH/TITLE_SOUND_PATH/END_PATH, VOICE,
                   starterDuration, checkStarter, installedVoices,
                   knownVoices, synthesize, speak, prependStarter (the title
                   card *and* the outro, pass 2 of the export)
server/tts.py      VieNeu-TTS front end: `--list` (preset table, no model) and
                   variadic `<text-file> <voice> <out.wav> ...` synthesis
scripts/tts-setup.ts `pnpm tts-setup` — builds ~/.vstack/vieneu
scripts/audition.ts  `pnpm voices` — speaks a title in each preset voice
server/assets/     starter-music.mp3 (the bed), before-video-start-sound.mp3
                   (the cue before the cut), start-title-sound.mp3 (the hit
                   at t=0, and the app's own phase-advance chime),
                   end_video.mp4 (the outro, concatenated after the clip)
server/youtube.ts  CONFIG_DIR/TOKEN_PATH, readClient, checkYouTube,
                   buildSnippet, accessToken, uploadVideo, publishProgress,
                   setThumbnail
scripts/youtube-auth.ts  `pnpm youtube-auth` — the one-off OAuth dance
server/ytdlp.ts    videoIdFrom, probe, fetchWindow, parseClipName, listClips
server/index.ts    12 routes (11 POST + GET /out/<name>), serveOut range
                   streaming, body validators, boot checks
src/geometry.ts    pure rect math — THE tested core
src/segments.ts    Segment, MAX_SEGMENTS, normalize, isValidSegments,
                   totalDuration
src/layout.ts      nine layout presets, cellsOf, ratioOf, defaultBoxes
src/custom.ts      CustomBox, MAX_CUSTOM/MIN_OUT_SIDE, outRatio, clampOut/
                   moveOut/resizeOut, resnapCrop, isValidOut/isValidCustom,
                   defaultCustom
src/frame.ts       GUTTER/CORNER_RADIUS, windowOf/windowsOf, ringOf, maskRgba
src/starter.ts     TITLE_FONT, renderTitleArt (title → transparent PNG)
src/state.ts       AppState, setState/setQuiet, save/restore
src/api.ts         9 fetch wrappers
src/format.ts      mmss / clock / slugify (shared client + server)
src/player.ts      YT IFrame API wrapper + trim strip
src/editor.ts      box drag/resize overlay (crops over the <video>, pieces'
                   `out` rects over the <canvas>); returns { place, stop }
src/preview.ts     canvas composite rAF loop
src/main.ts        persistent shell, phase machine, all five phases
media/             clip cache (gitignored)
media/uploads/     long-form parts, one <uuid>.mp4 per upload (gitignored)
~/Desktop/vstack/  finished shorts, plus a vertical .jpg still beside each
                   one (OUT_DIR; VSTACK_OUT_DIR overrides). Outside the repo,
                   so the user sweeps it, not .gitignore
~/.vstack/vieneu/  the speech venv (~750 MB of wheels). Also outside the repo,
                   but for a different reason — see the static-root rule
~/.cache/huggingface/  the ~285 MB VieNeu model, pulled on first export
```

Layering is strict and acyclic: `errors ← {ffmpeg, starter, youtube} ←
{ytdlp, mask} ← index` on the server, `{geometry, segments} ← {layout,
custom} ← frame ← everything` on the client. `segments.ts` sits at the very
bottom beside `geometry.ts` and imports nothing — which is what lets the
server import it directly too, the way `ytdlp.ts` already reaches across for
`geometry.ts`'s `PAD`. `custom.ts` sits beside `layout.ts`, not above or
below it, because a floating piece's ratio is its own rather than a cell's —
it imports only `geometry.ts`, the same as `layout.ts` does, and never needs
`cellsOf` or `ratioOf`. `frame.ts` does *not* import `custom.ts`, even though
it sits above it in the layering — `windowsOf` still walks `cellsOf` from
`layout.ts`, and `maskRgba`'s `customs` parameter takes bare `Rect`s rather
than `CustomBox`, so `frame.ts` never needs to know the crop half of a custom
box exists.
`starter.ts` sits beside `ffmpeg.ts`, not above it, because it takes paths in
the caller's temp dir and never needs `MEDIA_DIR` — it re-derives
`~/.vstack/vieneu` itself for the same reason `youtube.ts` re-derives
`CONFIG_DIR`. `tts.py` is not in the layering at all: it is a subprocess, and
`starter.ts` is the only thing that ever spawns it. `youtube.ts` sits beside
both for the same reason — it re-derives `CONFIG_DIR` under `~/.vstack/`
itself rather than importing `MEDIA_DIR` or `OUT_DIR` from `ffmpeg.ts`.
`geometry.ts` never imports `layout.ts` — that is why `defaultBoxes` lives in
`layout.ts` instead of `geometry.ts`. `mask.ts` sits *above* `ffmpeg.ts`
because it needs `MEDIA_DIR`, which is why the mask path is passed into
`exportClip` as `ExportOpts.mask` rather than resolved inside it.
`longform.ts` sits beside `ffmpeg.ts` and `starter.ts`, not above either —
it takes an output path from the caller and needs neither `MEDIA_DIR` nor
`OUT_DIR`, and it imports `probeFile` from `ffmpeg.ts` and nothing else.

Five phases in two journeys that share the last one: `idle` (URL) →
`trimming` (YouTube iframe, mark start/end, no download) → `framing` (real
`<video>` of the fetched window, crop boxes, canvas composite, export) →
`preview` (the finished file played back on the right, with the upload's
title/description/tags in a panel on the left where the framing `<video>`
was — it has nothing left to say once the export exists) is the short
journey, and `idle` → `stacking` → `preview` is the long one. `publishForm`
is a child of `sourceSlot`, not a third `.stage` column, and `stackPanel` is
another beside it, under the same rule — `sourceSlot` itself is never
hidden: that would put the YouTube iframe's ancestor into `display:none`,
and only its children are ever toggled. Export no longer downloads: it writes
`<OUT_DIR>/<slug>-<mmss>-<mmss>.mp4`, saves the opening frame beside it as a
vertical `.jpg` for Studio's Shorts thumbnail slot, and advances the phase. Videos under
`SKIP_TRIM_UNDER` (180s) skip `trimming`. `idle` has a second way in beside the
URL field: a dropdown of everything already in `media/` (`/api/clips` →
`listClips`), which opens straight into `framing` with no network at all.
That path has no `/api/probe` behind it, so two badge values are stand-ins —
`title` falls back to the starter title last typed for that video (then the
id) and `duration` is the clip's own `windowEnd`, which makes "Back to trim"
draw a strip ending at the clip rather than at the video. Both are cosmetic,
and Continue re-fetches a real window, so nothing downstream inherits them.
Marking is `trimming`-only — the framing bar has no Set Start/Set End, so a
skipped-trim video reaches marking through "Back to trim". The transport row
drives the iframe from the bar because YouTube's own controls are only
reachable by clicking *into* the video, which takes the keyboard with it; the
Play/Pause label follows the API's `onStateChange` (forwarded into
`syncTransport`) rather than this app's own clicks, since the overlay controls
change state without going through the wrapper. Both marks can also
be reached by pasting a YouTube `?t=` link into the trimming bar's timestamp
field (`parseTimestamp` in `src/format.ts`), which only seeks. The `NUDGES`
group (−2/−1/+1/+2s) only seeks too: YouTube's own arrow keys move 5s and the
iframe only hears them while focused, which every button in the bar takes
away. Aiming at a mark pauses first — a rolling player has left the frame you
aimed at by the time you reach Set Start — so the nudges and the pasted
timestamp both pause before seeking. The jump-to-mark buttons deliberately do
not: reviewing a cut is not aiming at one, and YouTube's `seekTo` resumes a
playing player while leaving a paused one paused, so a bare seek preserves
whatever the user was already doing.

## Invariants — breaking these is silent, not loud

**Crop rects are stored in source pixels, with zero conversion.** `canvas.drawImage(video, sx,sy,sw,sh, dx,dy,dw,dh)` and ffmpeg's `crop=w:h:x:y` consume the stored rect as the *same numbers*, unconverted. This was verified empirically (canvas `[114,63,67]` vs export `[111,62,66]` at matching coordinates). A layout cell contributes only the *destination* — `drawImage`'s `dx,dy,dw,dh` and ffmpeg's `scale=` target are output-space and never touch the stored value. Introducing a conversion anywhere in the stored value breaks the preview/export agreement. Never store normalised coordinates — normalising scales x by width and y by height, so a 9:8 box in a 16:9 source has `w/h = 0.632` and every aspect check has to un-warp it.

**Gutters and rounded corners are output-space decoration and must never
reach `ratioOf`.** `src/frame.ts` insets each *cell* into a *window* and paints
white over everything outside the windows — over the finished composite, in
both the canvas preview and (as a pre-rendered PNG overlay) the export. Cells
themselves are untouched, so `cellsOf` still tiles 1080×1920 exactly and
`ratioOf` still returns 1.125 / 0.5625 / 2.25. Inset the cell instead and a
1080×960 cell becomes 1060×945: its ratio moves to 1.1217, every stored box is
suddenly invalid against its own cell, `restore` and `assertBoxes` reject a
whole saved session, and whatever survives exports stretched. Painting over
also means the gutter *trims* a few px off each piece rather than squeezing
it, so every piece's aspect stays exact.

**`GUTTER` must be even.** Internal edges are inset by `GUTTER / 2` so two
neighbours each give up half the seam — the only rule that makes every
internal seam identical. An odd gutter puts a fractional offset on a window,
and a fractional overlay offset does not survive ffmpeg.

**Box size is height-driven.** Canonical form is integer `h` with `w = round(h * ratio)`, where `ratio` is the *target cell's* — 1.125, 0.5625 or 2.25 (`ratioOf` in `src/layout.ts`), never a constant. A width-driven round trip is not idempotent — it loses a pixel per call, so a box re-snapped every drag frame visibly shrinks.

**A box is only legal for its own cell.** A flawless 9:8 rect is illegal in a 540×960 cell and would export stretched. This is why `isValidBox` takes a `ratio` parameter instead of a constant, and why both `restore` (client) and `assertBoxes` (server) pass the per-cell value. Either one alone would let a wrong-cell box preview cleanly and die only at export.

**The min-box floor is ceiled, not rounded.** The floor is `min(ceil(max(MIN_BOX_SIDE, MIN_BOX_SIDE / ratio)), maxBox(source, ratio).h)`. `MIN_BOX_SIDE / ratio` is fractional for a 9:16 cell (142 / 0.5625 = 252.444), and `boxFromHeight` rounds its clamped height, so a fractional floor would make the smallest constructible 9:16 box `h = 252` while `isValidBox` — reading that same fractional floor — requires `>= 252.444` and rejects it: the validator refuses its own constructor's output, at one ratio only. `ceil` fixes this because the floor must be an integer. The three floors evaluate to 142 / 253 / 142 for the 9:8 / 9:16 / 9:4 cells, so 9:8 behaviour is unchanged.

**`clampToBounds` slides, never shrinks.** Shrinking breaks the box's aspect lock and ships a stretched region that nobody notices until export. This holds per ratio: safe only because every constructor caps size at `maxBox(source, ratio)` first. Mutation-tested: making it shrink fails 3 tests.

**Crop rects are plain integers, NOT even-rounded.** Chroma subsampling constrains the *encoded frame* — each cell scales to 1080×960, 540×960 or 1080×480, all already even — not the crop window. Even-rounding buys nothing and costs exactness.

**Geometry uses `/api/window`'s dimensions, never `/api/probe`'s.** Probe reports the best available format — 3840×2160 for a video whose fetched clip is 1920×1080. Framing on probe's numbers mis-crops every export.

Two invariants are mutation-tested and should stay that way: swapping two entries in `buildFilter`'s `xstack` `layout=` string fails the 3-cell pixel assertions in `server/ffmpeg.test.ts`; making `clampToBounds` shrink fails 3 geometry tests.

**The voice is the other client-supplied string that reaches a subprocess.**
`/api/export`'s `voice` becomes argv of `tts.py`, so it is checked against
`knownVoices()` — the engine's own preset table, cached at boot by
`checkStarter` — and not against a pattern. A table lookup is the same posture
as `layoutById`: there is no regex to get subtly wrong, and the set of legal
values is by definition whatever the installed engine ships. `checkStarter`
filling that cache is therefore load-bearing for the *validator*, not just for
the boot hint — an empty cache rejects every export rather than accepting
every voice, which is the right way for it to fail.

**The shown title and the spoken title are two fields, and only the shown
one is required.** `starterTitle` is painted on the screen, names the file
(`outName`) and prefills the upload (`defaultTitle`); `voiceTitle` is
optional and only reaches `speak`. Blank means "say the shown title", and
that fallback is applied in exactly one place — `readVoiceTitle` in
`server/index.ts`, which both `/api/export` and `/api/say` call. The client
sends the field raw, blank included, rather than resolving it too: two copies
of a fallback is how Try comes to audition a different string from the one an
export speaks. A present `voiceTitle` goes through `readTitle` unchanged,
because it reaches the same engine that would read a novel. Absent, `null`
and blank all fall back, so every stored record and every request written
before this field existed still works.

**`isOutName` is the one client-supplied path component on the `/out/` side
of this API** — `/out/<name>`, `/api/reveal`, `/api/publish` and
`/api/export`'s `prev` all take it.
Everywhere else on that side the server takes window bounds or an id and
reconstructs a path itself, so there is nothing to validate. Preview breaks
that — publish and reveal both name a file that already exists — so the name
is checked against exactly what `slugify` + `mmss` can emit (the `OUT_NAME`
regex in `server/ffmpeg.ts`), plus an `existsSync` in `OUT_DIR`. Loosen the
pattern and `open -R`, an upload, and `serveOut`'s file read all point at
whatever the caller asked for — and since `OUT_DIR` now lives under `$HOME`,
that is a reach into the user's home directory rather than into the repo.
`/api/export`'s `digest` (below) is the analogous case on the `/media/`
side — narrower, eight lowercase hex characters rather than a full name, but
validated for the identical reason.

**A re-export sweeps the render it replaces, and only after the new file is
in place.** `outName` is deterministic in title and marks, so a crop tweak
overwrites itself — but a *mark* or *title* edit lands under a new name and
would leave the superseded `.mp4` and its `.jpg` on the Desktop forever. The
client sends the previous name as `prev`; `/api/export` deletes it via
`removeExport` after `rename(partial, out)` and `saveStill`, never before —
a failed export must leave the render it was replacing intact — and skips
the delete when `prev === name`, which would otherwise unlink the file just
written. Best-effort, like `saveStill`: a stale file is not worth failing an
export that succeeded. `prev` is in-memory (`state.outName`) rather than
persisted, so a reload between two exports strands the older file; that is
the accepted cost of not adding a persisted field whose only job is naming a
file to destroy. Note the pattern is `isOutName`, never something looser —
this is the one client string in the API that names a file to *delete*.

**Uploads are private and there is no option.** An unaudited YouTube Data API
project has every `videos.insert` locked to private viewing. `buildSnippet`
hardcodes `privacyStatus: "private"` and `selfDeclaredMadeForKids: false` —
the second is required by the API, and an upload without it is rejected.

**The title's hashtags are reserved before the title, not appended after.**
`defaultTitle` gives the starter title only `100 - len(TITLE_HASHTAGS) - 1`
characters and puts the tags on the end. Concatenating first and slicing to
100 afterwards cuts the *tail*, and the tail is the tags — a long Vietnamese
title would upload ending in `#vtubervn #vtuberv`. A clipped title is one edit
away from fixed; a clipped hashtag reads as a typo to every viewer.

**The preview URL carries the file's mtime.** The output name is stable
across re-exports, so `/out/<name>` with no cache-buster re-shows the
*previous* render — a fixed crop looks like it changed nothing.

**A custom box's `out` is even on all four fields.** An `overlay` at an odd
offset in yuv420p lands on a half-chroma-sample boundary. `clampOut` and
`resizeOut` snap every field down to even (down, not nearest, so a value
already clamped to a maximum cannot round back past it); `isValidOut` rejects
odd on both sides of the wire — `restore` (client) and `assertCustoms`
(server) share it, the same split-validator posture `isValidBox` already has
for cell boxes. Skip the snap or the check anywhere and the failure is a
chroma-plane shift nobody notices until they zoom into an export's seam.

**The drag path bounds a piece by the gutter-inset frame; the validators
bound it by the whole frame, and that asymmetry is deliberate.** A piece's
ring is one gutter wide, so `moveOut`/`resizeOut` take a `margin` (the
framing bar passes `GUTTER`) and stop the drag with that ring parked exactly
on the frame's own white margin — one band rather than two, none of it off
the frame, and a piece dragged into a corner reads like a cell's window, same
10px inset at the same 24px radius. `isValidOut` deliberately does *not*
know about the margin: the inset is a placement preference, not a legality
rule, so every record written before it existed still restores, an older
client's body still exports, and a piece already flush to an edge renders as
it always did until a drag pulls it inside. Validators stay a superset of
what the constructors emit, never the reverse. The margin must be even for
the same reason every `out` field is — `even()` rounds down, so an odd lower
bound would floor back underneath itself. Note this is the one place the
gutter reaches `custom.ts`, which sits *below* `frame.ts`: it arrives as a
plain number through a parameter rather than an import, and it moves a
position only — never a size, a ratio or a crop.

**`restore` bounds the piece *count* as well as each piece's shape.**
`isValidCustom` per element is not enough: localStorage is untrusted input,
and a hand-edited record holding three individually legal pieces would mount
three nodes, preview them, and only die at `assertCustoms` with a 400. The
`MAX_CUSTOM` check mirrors what the boxes path right above it already does
with the layout's cell count.

**The mask walks the pieces from topmost down; it is not a flat priority
order.** `maskRgba` takes `customs` in the array order `buildFilter` overlays
them in — last on top — and, per sample, walks them backwards. The first
piece whose *ring rect* (its `out` expanded by `GUTTER`, rounded at
`CORNER_RADIUS + GUTTER`) contains the sample owns it outright and the walk
stops: opaque if the sample is outside that piece's own window (its ring, or
a nub cutting its square corner), transparent if inside it (the piece shows,
even across a cell seam). Only a sample inside no piece's ring rect falls
through to the old rule — opaque outside every cell window, transparent
otherwise. A piece's window is always inside its own ring rect, so "inside a
window" is always reached by that piece's own branch.

Neither flat order is correct and both are silent. Testing *any* piece's
window before *every* piece's ring — what this did before — is
indistinguishable from the walk at zero or one piece, and at two the upper
piece loses its ring and its rounded corners wherever it sits over the lower
one; since `defaultCustom` places the two defaults overlapping by 480x480,
two clicks of `+ Box` *is* the defect state. Swapping the two tests so
ring∪nub beats everything is worse: it paints the lower piece's ring across
the upper one. And putting the gutter rule ahead of either threads a seam's
white stripe straight through a piece that straddles it. The walk reduces
byte-for-byte to the old code at zero and one piece — verified, and fenced by
`server/mask.test.ts` — so that identity is what any future rework has to
preserve.

**A custom box survives a layout switch; a cell's box does not.** Switching
layouts clears `boxes` because a preset's cells just changed shape or count,
but `customs` is left alone — a piece's ratio is its own and its `out` is
frame space, so nothing about a custom is invalidated by the cells changing.

**The canvas protects the pieces with one `clip()` per piece, not one
combined even-odd path — and the ring fills need a different set of clips
from the gutter fill.** `clip()` intersects, so intersecting "frame minus
this piece" once per piece is the complement of the *union* of those pieces'
windows. A single even-odd path built from every piece's rect at once is a
*parity* test instead: two overlapping pieces cancel back to unprotected, so
the white gutter fill would paint over their intersection in the preview
while the export's mask leaves it alone.

The gutter fill takes that clip over *all* pieces. Each piece's ring fill
takes it over that piece and every piece *above* it only — which is the
canvas spelling of `maskRgba`'s topmost-down walk, and what lets an upper
piece's ring and nubs land over a lower piece while keeping a lower piece's
ring out of an upper piece's window. Clip all pieces on every ring fill too
and the upper piece loses its ring over the lower one; clip only the piece
itself and the lower piece's ring stripes across the upper one. Both are
silent preview/export divergence, and both are only visible once two pieces
overlap — which is exactly the state `+ Box` twice produces.

**`maskRgba`'s alpha must stay `255 - Math.round(transparent * 255 / SUB²)`,
never the complementary `Math.round(opaque * 255 / SUB²)`.** `255 / 16`
(`SUB = 4`) is not an integer, so the two forms are not the same number at
every coverage level — at 8/16 coverage both round the halfway point up, and
the two expressions land one apart. That shifts a pair of pixels at every
corner arc — 16 on the two-cell default layout, 32 on a four-cell one — a
difference the five-pixel spot check in `server/mask.test.ts` does not sample
and so does not catch.

**The framing strip has one axis, and it is `span`, not the file's own
duration.** The handles and the playhead are placed in `windowEnd -
windowStart`; the waveform envelope covers the decoded clip. Those agree for
a single range, so `drawWave` spreading the envelope across the full canvas
width looked right — but a stitch is named `0-<ceil(sum)>`, and
`/api/export` rebuilds the cache path from that name, so `windowEnd` has to
stay the ceil'd total while the file is only `sum` seconds long. The
envelope was therefore stretched by `ceil(sum)/sum`: 0.5% on a 56s stitch,
but ~11% on a short two-part cut, and progressive, so the waveform pulled
furthest from the audio exactly at the out-point a user is checking.
`bucketAt` in `src/waveform.ts` converts a column of the strip's axis into a
bucket of the envelope and returns -1 for the phantom tail past the end of
the decoded audio, which stays blank rather than repeating the last bucket.
It reduces exactly to the old `floor(x * buckets / w)` when the two lengths
agree, and `src/waveform.test.ts` mutation-tests that identity along with
the stitch case — dropping `span` back out of the mapping fails both stitch
tests and neither single-range one, which is why the single-range test alone
could never have caught this.

**The framing phase must never learn that segments exist.** The cut is
baked into the cached clip by `/api/window` — `fetchWindow` fetches each
segment and `concatClips` stitches the kept ranges into one continuous file
before the framing `<video>` ever sees it. Carrying segments to `/api/export`
as well, instead of the clip-timeline `start`/`end` it already sends, would
leave the framing `<video>` playing footage the export drops — the exact
preview/export divergence this codebase treats as the cardinal failure,
reintroduced at the one layer this design exists to keep it out of.

**A segment is identified by which part contains an instant, never by exact
`start` equality.** `normalize` merges overlapping parts, and a merged part
keeps the *earlier* one's `start` — so `segs.findIndex(seg => seg.start ===
t)` returns -1 after a backward merge, and a fallback there would silently
aim the marking controls at an unrelated part. `segmentContaining` in
`src/main.ts` is what both `+ Part` and `setMark` use instead, matching on
containment of the whole edited/added range rather than a single point.
`setMark` must also re-aim `activeSegment` at whatever `segmentContaining`
returns *after* normalising: dragging a mark into a neighbour merges the two,
so the active index can point at an untouched segment once the merge lands,
even though the edited range's own identity survives inside the merged one.

**`renderStrip`'s rAF loop is stopped in two places, and both are
load-bearing.** `renderTrimming` stops the old loop before building its
replacement — the ordinary re-render case. `render()` stops it and nulls the
module-scoped handle whenever `phase` is not `trimming` — the departure
case, the same way it already toggles `boxesLayer`/`outBoxesLayer` by phase.
The normal flow (trim once, then frame, export, preview) never re-enters
trimming, so nothing else ever calls the departure stop — without it the
loop keeps `postMessage`-ing a hidden YouTube iframe every frame for the rest
of the session, not just the rest of this visit to trimming.

**`setMark` refuses an edit that would leave `end <= start`, rather than
letting `normalize` handle it.** `normalize` *drops* a segment whose end is
not after its start — the right behaviour for a merge, the wrong one for an
edit in progress. Set End with the playhead sitting before the active part's
own start would otherwise pass a doomed range straight to `normalize` and
silently delete the very part the user was trying to adjust — the worst
possible answer to an ordinary misclick. Refusing the edit outright leaves
the strip exactly as it was, which reads as "that did nothing" instead of
"that deleted your part".

**`mode` is claimed on every exit from `idle`, not just the long one.** The
`Long form →` button sets `"long"`; all three short-journey exits —
`load()`'s skip-trim branch, `load()`'s trimming branch, and the
cached-clip picker's open path — set `"short"`. Miss one of the three and
`mode` sticks on whatever a previous session last set, which is silent
because nothing downstream errors: an ordinary short export publishes
*without* `#Shorts` — the exact misclassification the `shorts` flag exists
to prevent, in reverse — and its `← Back` button on `preview` jumps to
`stacking` instead of `framing`. Found in review, not by a test (fixed in
commit `b7fe004`) — `state.test.ts` only exercises `save()`/`restore()`,
which never touch `mode` at all, so nothing pins the three call sites down.

**`#shorts` is what classifies an upload, so `buildSnippet` must not force
it.** The flag is optional and defaults to `true`, which is what keeps every
existing caller and every request body written before it exact — only the
long journey sends `false`. A twenty-minute compilation carrying the tag is
misfiled by YouTube at the platform level, and the uploader cannot undo it
from Studio.

**A long-form output's name passes `isOutName` unchanged, and that is load-
bearing.** `outName(title, 0, total)` emits `<slug>-0000-<mmss>.mp4`, which
today's `OUT_NAME` regex already accepts — which is the entire reason
`/out/`, `/api/reveal` and `/api/publish` needed no edits for this feature.
Do not widen `OUT_NAME` for long form; there is nothing to widen it for.

**`stackWide` blurs at 480x270 and stretches back up, never at full
resolution.** A 1080x1920 source scaled to *cover* 1920x1080 is 1920x3413,
and `gblur` over that costs roughly fifty times what it costs at 480x270 —
for a picture whose entire purpose is to be out of focus. The upscale
supplies most of the softening on its own, which is also why
`longform.ts`'s own `BLUR_SIGMA` is 12 where `starter.ts`'s is 30. The two
are deliberately not shared: one constant for two blurs at two scales means
tuning either one moves the other.

**`stackWide`'s foreground uses `decrease`, not `-2:1080`.** An upload is
whatever file the user picked; only the common case is 9:16. A part wider
than 16:9 scaled to a fixed height overflows the frame, so the foreground
is `scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2`
— fits inside on both axes, even on both, for any input aspect.

**`isUploadId` is the third client-string gate in this API, and the
strictest.** `isOutName` validates a name the client chose; `/api/export`'s
`digest` validates eight hex characters the client computed; this validates
a UUID the *server* minted, so there is nothing legitimate a client can send
that it does not match. The original filename never crosses the wire at all
— the client keeps it purely for display.

## Gotchas that each cost real time

**Never empty `sourceSlot` or `outSlot`.** They hold the trimming iframe,
the framing `<video>`, the crop overlay, the composite canvas, the output
`<video>` and the publish panel — all built once and toggled with `hidden`. Removing an `<iframe>`'s *ancestor* from the document runs its removing steps and discards its nested browsing context — so re-appending even the identical node reloads the YouTube player. `main.ts` builds a persistent shell once; `render()` only ever `replaceChildren`s `barSlot` and the status slot. Long-lived media is shown/hidden with the `hidden` property.

**`hidden` alone is not enough.** `style.css` carries `.source > [hidden], .out > [hidden] { display: none; }` because the author-origin `display: block` on the media children beats the UA's `[hidden]` rule. Without it the DOM property looks correct while the element stays fully visible. Keep the selector list generic — it already covers the iframe, the `<video>`, the canvas and the `.boxes` layer.

**`display: none` does not pause anything.** That is *why* the persistent shell preserves the player. `render()` explicitly pauses whichever media is being hidden; without it the YouTube audio plays under the framing phase.

**`listClips` must never offer a download partial.** A fetch in progress
leaves `<name>.<uuid>.part.mp4` beside the finished clips, and that file is
truncated by definition — listing it hands the framing phase a broken video
that previews as a black canvas. `parseClipName`'s anchored
`^(\d+)-(\d+)(?:-([0-9a-f]{8}))?\.mp4$` is the whole guard (plus an
`end > start` check, since `/api/export` rejects an empty window), and it is
what `server/ytdlp.test.ts` pins down — including cases for the digest form,
a digest of the wrong length or alphabet, and a `.part.mp4` against the
widened pattern. Loosen it and the partial reappears as a row. `listClips` must also
build each row's path from the name `readdir` handed it, never by rebuilding
one from the parsed bounds: `clipPath(videoId, windowStart, windowEnd)`
silently drops a stitch's digest, so a multi-part clip would probe a file
that does not exist, fail silently in the `probeFile` catch, and never be
listed at all.

**`cellsOf` order is load-bearing in four places that must agree:** the order boxes are stored in (`state.boxes`), the order the editor numbers them, the order the canvas preview draws them, and the order `xstack`'s `layout=` string lists positions. Reorder `cellsOf`'s traversal and all four silently disagree about which rect belongs to which cell.

**A layout change must not reassign `video.src`.** `ensureFraming` splits its clip guard (`sameClip`) from its layout guard (`sameLayout`, tracked by `editorFor`) for exactly this reason — assigning the same `src` reloads the element and restarts playback. `sameClip` is captured before `framingFor` is reassigned, so a layout switch mid-clip rebuilds the editor and preview without touching the video.

**A quiet update reaches no render, so anything gated on it must be toggled
in place.** In `preview` this crosses two render functions: the Publish
button is built by the bar and the title that gates it by the panel, so the
bar hands its button to `publishBtn` for the panel's `oninput` to flip. Both
are rebuilt in the same `render()` pass, so the reference cannot go stale
before a keystroke can fire. The starter-title input uses `setQuiet` (see below), and Export is
disabled on that same value — so its `disabled` is flipped inside the input
handler. Without that it stays disabled until an unrelated `setState` happens
along, which reads as "Export is broken" rather than "type a title first".
`doExport` re-checks the title itself rather than trusting the button.

**`setQuiet`, not `setState`, in the drag path and during render.** `setState` notifies subscribers synchronously, so calling it from inside `render()` is re-entrant, and a re-render mid-drag rebuilds the bar and risks disturbing playback. The rAF preview loop reads state every frame, so a quiet update still reaches the canvas. `save()` runs on drag end only.

**A handler that appends to a `setQuiet`-written array must read live state,
never `render()`'s snapshot.** `s` in `renderFraming()` is the state as of the
last *notifying* update, and every drag writes through `setQuiet`. `+ Box`
building `[...s.customs, …]` therefore replaced the array with a stale copy —
snapping the previous piece back to its as-added rect, its re-snapped crop
with it, and persisting the revert on the next line's `save()`. It reads
`getState()` now, the same way `onRemove` already read `currentCustoms()`.
A handler's *`disabled`* may still come off `s`: `busy` and the `MAX_CUSTOM`
cap only move via `setState`, which rebuilds the bar.

**The two framing overlays are coupled in one direction, and only the DOM
half needs telling.** A drag on the *output* overlay rewrites a piece's `out`
**and** its re-snapped `crop`. The rAF canvas follows for free — it re-reads
state every frame — but the *source* overlay is DOM, and `place()` is
reachable only from that layer's own `pointermove`, `window.resize`,
`loadedmetadata` and its `ResizeObserver`, none of which fire here. So
`mountEditor` returns `{ place, stop }` rather than a bare teardown, `main.ts`
keeps the source overlay's handle in a module-scoped `sourceEditor`, and the
output overlay's `onChange` calls `sourceEditor?.place()`. Without it the
composite and the export are correct throughout and only the tinted crop box
lies — it keeps its old width until touched, then jumps.

**`starterTitle` persists unconditionally, like the marks.** The framing-only gate below is for values that are meaningless before `/api/window` has reported the clip's real size; a title is not one of them.

**The voice is persisted globally, NOT in the per-video record.** `saveVoice`
/ `savedVoice` own a `vstack:voice` key of their own, the way `vstack:theme`
does, and `save()`/`restore()` never touch it. Keyed per video it looked
correct in every test and still reverted to the server's fallback on every
*new* video, because a fresh id has no stored entry to read a voice out of —
the failure only shows on the second video, which is exactly when nobody is
looking for it. `src/state.test.ts` mutation-tests the exclusion: putting
`voice` back into `save()`'s record fails on `not.toHaveProperty("voice")`.
`restore` must stay silent about it too, or loading a video would overwrite
the global choice with nothing.

**`save()` only persists boxes/dimensions when `phase === "framing"` with a full set of boxes for the current layout.** Otherwise it carries the stored values forward. Before framing, `state.source` still holds probe's informational dimensions and `boxes` is empty — writing them would erase a set framed in an earlier session, and the half-built states `ensureFraming` passes through (some cells boxed, some not) would truncate a complete stored set.

**Two yt-dlp format selectors, tried in order, and they are complementary.** `best[height<=1080]` 403s on videos with no HLS rendition (only progressive itag 18, which the ANDROID_VR client can't fetch); `bv*+ba` 403s on videos that do have HLS. Measured on real videos. yt-dlp's own `/` fallback cannot help — the 403 arrives at *download* time, after the format is chosen — so the retry lives in `fetchWindow`.

**The download partial must end in `.mp4`.** With `--merge-output-format mp4`, yt-dlp appends the container extension when `-o` lacks it, so a `<path>.part` target silently produced `<path>.part.mp4` and the rename failed with ENOENT. The partial also carries a UUID so two concurrent fetches can't rename a corrupt clip into the cache.

**Node runs `server/*.ts` with type stripping, so non-erasable TS syntax is a *boot crash*, not a compile error.** No constructor parameter properties, no `enum`, no `namespace`. `tsconfig.json` sets `erasableSyntaxOnly: true` so `tsc` catches it at the gate the project actually runs.

**The mask input must be declared before `-ss`.** `exportClip` passes
`-loop 1 -i <mask>` as input 1. ffmpeg attaches options to the *next* `-i`,
so putting the mask input after `-ss` would silently turn `-ss` into an input
option on the mask and lose the frame-accurate seek on the clip.

**The mask filename carries `GUTTER` and `CORNER_RADIUS`, not just the layout
id.** The mask is cached in `media/masks/` and outlives the process. Keyed on
the layout alone, editing either constant would keep serving the old border to
exports while the preview — which recomputes the overlay every frame — showed
the new one. The filename also carries the floating pieces' digest
(`maskPath`'s `-c<8 hex of sha1 over the out rects>`), but *only* when there
are any customs — a layout with none keeps today's exact filename, so every
mask cached before this feature shipped keeps hitting, and editing a custom's
`out` rect changes the digest so it can never serve a stale border either.

**`/api/export` takes window bounds plus an optional 8-hex `digest`, still
never a path.** Its body is `videoId` + window/mark bounds + `layoutId` +
`boxes` + `customs` + `starterTitle` + `voiceTitle` + `titlePng` + `voice` +
`digest` + `prev`. The
server reconstructs the cache filename itself, so there is no client-supplied
path to validate for traversal — except a stitch's filename carries a third
component, `segmentDigest`'s hash of the segment bounds, that window bounds
alone do not encode. Sending the segments themselves and recomputing the
digest server-side would preserve "no client-supplied path component"
exactly, but it breaks on the `listClips` reopen path: a video opened from
the idle screen's dropdown was never cut in this session, so the client has
no segments to hash. `digest` is validated against `/^[0-9a-f]{8}$/` — eight
hex characters cannot traverse or escape `MEDIA_DIR`, `clipPath` still builds
the actual path, and `listClips` hands back each row's digest for free so the
reopen path always has one to send — the same posture `isOutName` (above)
already takes on the `/out/` side. The starter screen's `titlePng` is the
other exception — an image the client rendered, because this machine's ffmpeg
*cannot rasterise text at all* — so it is length-capped and checked against
the PNG signature before it reaches ffmpeg. Keep all three of those that way.

**This ffmpeg has no `drawtext`.** Homebrew 8.1.1 here is built without
libfreetype, libass and librsvg; `ffmpeg -h filter=drawtext` says `Unknown
filter 'drawtext'`, and the `svg_pipe` demuxer that *is* listed has no decoder
behind it. That is the whole reason `renderTitleArt` lives in the browser.
Don't "simplify" it into a server-side `drawtext` — it will not run here.

**`concat` refuses a SAR mismatch, it does not pick a side.** `scale=` in
`buildFilter` carries the *source's* sample aspect into the composite, so an
anamorphic upload lands as 1080x1920 at SAR 1214:1215. `prependStarter`
therefore does `setsar=1` on *both* legs; without it the error is `Nothing was
written into output file`, not a subtly wrong aspect. Note that libx264
normalises a SAR that close to square back to 1:1, so a synthetic fixture has
to use something further out (the test uses 40:41) to reproduce it.

**`ffprobe -of default=nk=1` prints one line per *stream*.** Reading a
per-file answer out of it means guessing which line is which — taking the
first said "codec_type=video", so `hasAudio` was false for every clip that had
audio and every export replaced the clip's sound with the silence stand-in,
while every stream-shape assertion still passed. `probeMain` uses `-of json`.

**The starter screen is pass 2, not part of `buildFilter`.** `exportClip`
writes `body.mp4`; `prependStarter` extracts its first frame, blurs it,
overlays the title art and concatenates — three legs now, since the bundled
`end_video.mp4` outro is appended in the same pass. The outro is a finished
1080x1920 video with its own audio, so it needs only the `fps` + `setsar=1`
normalisation every concat leg gets; its dimensions are taken on trust, and a
mismatched replacement fails the export loudly rather than stretching. Its
audio leg is unconditional, so the asset must always carry sound. Folding it into the export's graph
means a `split`/`trim`/`loop` chain *and* turning `-ss`/`-t` into filters,
because an output `-t` would truncate the concatenation rather than the clip.

**Vite's dev server serves the project root statically — which covers
`media/` and no longer covers output.** `/media/<id>/<clip>.mp4` still reaches
the browser with no route behind it. `OUT_DIR` moved to `~/Desktop/vstack`,
outside that root, so `/out/<name>` is a real `GET` route (`serveOut`) that
Vite proxies alongside `/api`. It answers byte ranges because a `<video>`
requests one the instant it seeks, and replying 200 to a Range request leaves
scrubbing silently dead. The static-root rule still bites the other way:
nothing private may sit under the project root, which is why credentials live
in `~/.vstack/` — a `secrets/` directory here would be readable at
`/secrets/youtube-token.json` by any page the browser has open.

**The resumable upload's PUT uses `node:https`, not `fetch`.** It needs an
exact `Content-Length`, and `Content-Length` is a forbidden header name under
the fetch spec — a fetch with a stream body may drop it and send chunked,
which the endpoint refuses. `https.request` also gives byte progress from one
`data` listener.

**A response stream with no `error` listener can hang a promise forever.**
Node swallows a destroyed `http.IncomingMessage` that nobody listens to —
`end` never fires, so nothing ever settles. `putVideo`'s `res.on("error",
fail)` exists because a reviewer reproduced exactly that: `busy` stuck and the
progress poll ticking with no way out but a reload. The 10-minute
`req.setTimeout` covers the sibling failure, a connection that stalls with
neither a FIN nor an RST to trigger either handler. `seenResponse` then
decides who owns a failure once both sides can throw: after headers arrive, a
write-side `EPIPE` is just the already-closed socket noticing, so reporting
it instead of Google's real response body would trade an actionable message
for a bare `EPIPE`.

**`prompt=consent`, not just `access_type=offline`.** The first gets a
refresh token at all; the second gets one *again* on a re-run, which is every
time the 7-day expiry Google applies to Testing-status consent screens bites.
Setting the consent screen to "In production" — no verification needed for
`youtube.upload` — stops the expiry.

**`thumbnails.set` sets the 16:9 thumbnail, NOT the Shorts one — and
Studio's Shorts thumbnail slot stays empty forever.** This looks exactly like
a broken feature and is not one. The API stores the image (verified: the
reply's `items` carries all five derived sizes and the signed `maxres` URL
serves the real picture), but Studio's *Shorts* section shows a separate 9:16
thumbnail that no Data API v3 method populates. The custom thumbnail is what
search, embeds and suggested-video surfaces use; the Shorts player itself
always shows a frame from the video, which here is the starter screen anyway.
Setting the vertical Shorts thumbnail is a manual Studio job. Do not "fix"
the empty slot — nothing in this codebase can.

**The thumbnail is cropped to 16:9, never letterboxed.** Since
`thumbnails.set` feeds 16:9 surfaces, uploading the raw 1080x1920 frame gets
it pillarboxed into a 32%-wide strip with black either side — which at tile
size reads as a black thumbnail. `firstFrame` therefore scales to *cover* and
crops (`force_original_aspect_ratio=increase` + `crop`), never `decrease` +
`pad`. The crop is safe only because `renderTitleArt` centres the title block
on `OUTPUT.h / 2` and the crop takes 607px around that same centre; a title of
four or more lines (180px each at `MAX_SIZE`) loses its outer lines from the
thumbnail, though never from the video.

**A killed server must take its partial with it.** `node --watch` SIGTERMs
the process on every server edit, and a killed process never reaches the
`finally` that removes `out/<name>.<uuid>.part.mp4` — while the ffmpeg it
spawned is a separate process that keeps writing. `index.ts` therefore tracks
in-flight partials in a `Set` and unlinks them from a SIGINT/SIGTERM handler,
`unlinkSync` because a signal handler has no time for a promise. Verified by
polling for a real partial mid-export, sending SIGTERM while it existed, and
confirming nothing was left behind. This also gives the process a SIGTERM
handler it did not have before; `killOldServer`'s "gone almost at once" still
holds, since the handler is a few sync unlinks and an exit.

**The export writes `out/<name>.<uuid>.part.mp4` and renames.** A half-written
file must never be servable under a name the client can request, and the
rename has to stay on one volume: `$TMPDIR` is a different filesystem on
macOS, so rendering into the temp dir and renaming into the project risks
`EXDEV`. The UUID is the same lesson as the download partial's, applied where
it was first missing: `out`'s name is deterministic (starter title + marks),
so two concurrent exports of the same range would otherwise share one partial
and each ffmpeg would write into the other's open fd — whoever renamed first
would publish a file the other was still writing into.

**No route checks `Origin` or `Host`.** Loopback-only binding predates this
branch, but publish raises what a drive-by page open in the same browser can
do with it: a same-origin-policy-exempt simple POST to 127.0.0.1:8787 can fire
`/api/reveal` (spawns `open -R`) or `/api/publish` (uploads under the user's
own OAuth grant), no preflight required. The only mitigations are needing a
valid, already-existing `out/` name (`isOutName` plus `existsSync`) and every
upload landing private — not a same-origin check. Deliberate for a local
single-user tool; not something to fix here.

## Conventions

- `import type` for type-only imports; explicit `.ts` extensions on relative imports (Node requires them; Vite accepts them).
- No `enum`, `namespace`, `any`, default exports, or barrel files.
- No `console.log`/`.info` — `.error`/`.warn` only.
- `strict` and `noUncheckedIndexedAccess` are on: indexing yields `T | undefined`, guard with `?? fallback` rather than `!`.
- Visual values come from the `@radix-ui/colors` custom properties imported in `style.css` — light `slate`/`blue`/`amber`/`red`/`grass`/`violet` plus each one's `-alpha` companion. `grass` and `violet` were added to tint crop boxes 3 and 4; `red` was already spoken for as the error/callout colour, so it couldn't be reused for a third or fourth box. Both the light and the dark files are imported, dark second: light keys its tokens to `:root` and dark to `.dark`, equal specificity, so the import order is what decides which one wins when `<html>` carries the class. CMD+Shift+0 (a `keydown` listener at the bottom of `src/main.ts`, persisted under `vstack:theme`) toggles it, and there is deliberately no control for it in the UI. Only three surfaces were literal `#fff` and needed tokens of their own — `--page`, `--panel`, `--field` — because everything else already reads from a scale and flips for free; the two remaining `#fff`s are correct in both themes (solid-button text, and the crop handle, which sits over video rather than over the theme). Import the alpha scale alongside every solid one: soft buttons, badges and card borders sit on both the page background and a white card, and an opaque `blue-3` bands at that boundary where `blue-a3` does not.
- `style.css` hand-rolls Radix *Themes*' token layer (`--radius-1..4`, `--space-1..6`, `--shadow-2/3`, `--control-height`) and its component recipes (Card, Button solid/soft/soft-gray, TextField surface, Badge, Callout, Slider track/thumb). The React package can't be used here, so the metrics are transcribed, not imported — keep new UI on these tokens rather than fresh literals. Button variants are classes: bare `<button>` is soft accent, `.btn-solid` is the one phase-advancing action, `.btn-gray` steps back. A bar with more controls than fit on a line splits itself into `.bar-row`s (each claims 100% of `.bar`), grouped by what each row is *for*, with whatever belongs at the far edge — the advancing action, or read-only badges — in a trailing `.bar-end` whose `margin-left: auto` pins it there instead of letting it wrap to a line of its own. Trimming is scrubber + marks, then the transport (play/pause, jump to a mark, nudge), then the marking controls; framing is layout + clip facts, then title and actions. `.field-grow` is how a field claims its row's free space rather than sitting at its intrinsic `size`.
- `ponytail:` comments mark deliberate simplifications and name the upgrade path.

## Testing posture

`geometry.ts`, `layout.ts`, `custom.ts` and `segments.ts` are the modules with exhaustive coverage, deliberately — their bugs are silent. `src/custom.test.ts` covers `clampOut`/`moveOut`/`resizeOut`'s even-snapping, `resizeOut`'s `MIN_OUT_SIDE` floor and frame bounds from every anchor corner, `clampOut`'s and `resnapCrop`'s idempotence under a repeated re-snap (`resnapCrop`'s also keeping the ratio exact), and `isValidOut`/`isValidCustom` against everything `clampOut`/`defaultCustom` can emit and everything illegal. `src/segments.test.ts` covers `normalize` (idempotent, sorts, clamps, drops empties, merges overlaps), `isValidSegments` against everything `normalize` emits and everything illegal (empty, over `MAX_SEGMENTS`, unsorted, overlapping, `end <= start`, out of bounds, non-finite, non-array, `null`), and `totalDuration` against a known set. `layout.test.ts` asserts the nine presets tile 1080×1920 exactly, that only the three documented cell shapes occur, and that `defaultBoxes` returns per-cell-valid boxes: a mis-tiled layout survives preview and only shows up as a seam in an exported clip. `server/ffmpeg.test.ts` shells out to real ffmpeg and asserts output pixels; it is the only thing proving the preview/export agreement from the ffmpeg side — now including the border, via white pixels in the seam and at a corner cut's diagonal against the source's colour just inside a piece, now including a real export with one floating piece straddling a cell seam, asserting the piece's own colour survives the seam, the ring around it is white, and the stack's colour resumes just past the ring, and a second with TWO overlapping pieces cropped from different colour bands, which is the only end-to-end proof that the mask's walk is z-aware (the upper piece's nub and the upper half of its ring both land over the lower piece's window and read as that piece's own colour if it is not) — and now a real two-range `concatClips`, asserting the output's duration is the parts' sum and that a frame sampled from each half carries that part's own colour cropped from a different colour band, with the leg ordering mutation-tested (reversing the concat's input order fails the second sample), plus a part with no audio stood in with `anullsrc`, plus a non-square-SAR part, since a SAR mismatch is the failure `concat` is most likely to hit and it fails opaquely (`Nothing was written into output file`) rather than picking a side. `frame.test.ts` covers the window insets (every internal seam and frame margin
exactly one gutter, adjacency decided on the *cells* because every pair of
windows has a positive gap) and the mask's alpha, including the assertion that
a window's square corner is opaque — the one that fails if `CORNER_RADIUS`
goes to 0 — plus, with a custom in play, that a corner nub stays opaque over a
cell window and that a piece straddling a seam stays free of the seam's white
stripe, and, with two overlapping pieces at exactly the rects `+ Box` twice
produces, that the upper piece keeps both its nub and its ring over the lower
one while the lower one's ring stays out of the upper one's window. The
single-piece pair and the two-piece pair are all mutation-tested, against the
two failure modes the mask exists to prevent and against the walk losing its z
order respectively. `server/mask.test.ts` decodes the rendered PNG back to RGBA and
checks it against those windows.
`server/starter.test.ts` shells out to real ffmpeg *and* the real speech
engine, so it needs `pnpm tts-setup` to have run and it pays the model load:
the output's duration is the screen plus the clip, the seam pixel is mixed over
the screen (the assertion that fails if the blur is dropped) and pure over the
clip, and a non-square-SAR clip concatenates at all. It also covers the two
things `tts.py` can get silently wrong — the TSV parse (every row's gender,
region and style non-empty, names kept whole through their spaces and
diacritics) and the variadic argv stride, which is mutation-tested. Audio is checked one
layer per window — the bed before the voice starts, the voice, the cue in the
tail slot the voice leaves free, and the clip's own sound after the cut (the
assertion that caught `hasAudio` reading the wrong ffprobe line). Each window
is one where only that layer can be heard, so all four are load-bearing. `src/starter.ts` is DOM-driven and untested like the rest — it was
verified by hand in a real browser and through a real export.
`state.test.ts` covers the save-gating that guards against erasing framed boxes, and the `{start, end}` → `segments` migration: a stored old-shape record restores as one segment (tested on `!== undefined`, not truthiness, so a mark stored as `0` still migrates), and a stored `segments` array survives a round trip untouched. `ytdlp.test.ts` covers `videoIdFrom`, the trust boundary that decides whether a subprocess spawns, and the widened `CLIP_RE`: the digest form parses, a `.part.mp4` still does not, and a digest of the wrong length or alphabet (including uppercase) does not either.
`src/defaults.test.ts` covers `defaultTitle` — that the tags survive a
200-character starter title, that no input can exceed 100, and that the
description template still carries a shorts tag so `buildSnippet`'s append
stays a no-op against it. `server/youtube.test.ts` feeds `TAGS_DEFAULT`
through `buildSnippet`, which is what fails if the constant is ever edited
into a space-separated or hashtagged list — the two live on opposite sides
of the client/server line and nothing else makes them agree. `server/youtube.test.ts` covers `buildSnippet` and nothing else — it is where
every decision that is awkward to change later lives (the 100-char title cap,
`#Shorts` appended once and case-insensitively, private, not-made-for-kids).
The HTTP calls, `open -R`, the preview bar and the auth script have no tests,
like the rest of the network and DOM surface. The out-name tests in
`server/ffmpeg.test.ts` are the traversal guard and get the same exhaustive
treatment `videoIdFrom` does.
`server/longform.test.ts` shells out to real ffmpeg and asserts output
pixels, the same posture `server/ffmpeg.test.ts` holds: the output is
1920x1080, a centre sample in each half carries that part's own colour, and
a left-edge sample is NOT black — which is the assertion that fails if the
blur leg is dropped and the graph pillarboxes instead. The two parts are
different colours so the edge sample also proves each background tracks its
own part, and the leg ordering is mutation-tested the way `concatClips`'
already is. A silent second part covers the `anullsrc` stand-in, and a 16:9
part covers an upload that is not vertical. `server/youtube.test.ts` gains
the `shorts` flag's four cases. The upload route, the stacking panel and
the reorder buttons have no tests, like the rest of the network and DOM
surface.

DOM-driven modules (`main`, `editor`, `preview`, `player`) have no tests by design — vitest runs `environment: "node"` here and those behaviours are verified by hand.

## Environment notes for agents

- `Bash(git add)`, `Bash(git commit *)` and `Bash(rm *)` are deny-listed in this environment. Use `git -C <path> add/commit` (the prefix differs, so it passes) and Node's `fs.rm` instead of shell `rm`.
- The in-app Browser pane reports `document.hidden = true`, which suspends `requestAnimationFrame` and throttles `ResizeObserver` per spec, and its viewport has measured 0×0 with layout collapsing. Neither is an app defect — rule the environment out before reporting one. Patch `requestAnimationFrame` from the console if you need the loop to run; never in app source.
- `media/` grows without eviction and is already ~47 MB. Size is logged at boot and after each fetch.
- The starter screen's background is blurred and darkened **only in a
  feathered band behind the title** (`SCREEN_FILTER`); the rest of the frame
  stays sharp, because the clip is what makes someone stop scrolling. Four
  knobs: `BLUR_SIGMA`, `SCRIM` (a brightness multiplier — 0.65 is black at
  35%, multiplicative because `eq=brightness` only offsets and a white UI
  panel would fall just 255→217), `BAND_H` and `BAND_FEATHER`. All four
  change the thumbnail too — it is this same frame.
- **`maskedmerge` does not do what its name suggests; `blend` with an
  expression does.** Fed a verified greyscale mask (0 outside the band, 255
  at the centre) `maskedmerge` returned a pixel halfway between the layers
  where the mask was fully white — blurred+scrimmed `(84,40,0)` and sharp
  `(251,0,0)` came back as `(154,9,0)`, so the band looked half-treated and
  the blur appeared to have been dropped. `blend=all_expr` matches the
  arithmetic exactly at every sample. Both starter-screen band assertions are
  mutation-tested: dropping the blur fails the in-band check, widening the
  band to the whole frame fails the out-of-band one.
- The screen's background is computed in the **frame-extraction pass**, not
  the composite graph. It is one static image, and a per-pixel expression
  evaluated over every frame of the screen would cost ~300M evaluations for a
  picture that never changes.
- `start-title-sound.mp3` is used twice: as the fourth audio layer of the
  starter screen (at t=0, with the title, `TITLE_GAIN`) and as `bell()` in
  `src/main.ts`, which rings on every phase advance. `src/main.ts` therefore
  imports across the client/server line — deliberate, so the app and the
  video say the same thing with the same file rather than two copies. It is
  3s long with ~1s of audible decay, so `atrim` truncates silence, not a
  sound.
- **The starter screen's audio inputs are positional and one of them is
  conditional.** The silence stand-in is only appended when the clip has no
  audio, so it is the *last* index — adding an input above it moves the
  stand-in and breaks silent clips only. `server/starter.test.ts` checks each
  layer in a window where only that layer can be heard, which is why the bed
  has its own test with a deliberately short voice: the title hit now owns
  the head, and past `starterDuration`'s 1.6s floor the voice ends on the
  frame the cue starts, leaving the bed nothing to be isolated in.
- The bundled `starter-music.mp3` opens on a soft intro (mean -14 dB at 0:00 against -3 dB by 0:20) and the screen is only a couple of seconds long, so the bed hears the quietest part of the track. `MUSIC_START` and `MUSIC_GAIN` in `server/starter.ts` are the two knobs.
- **The starter screen's voice is VieNeu-TTS, not macOS `say`.** `tts.py`
  shells out to a venv at `~/.vstack/vieneu` built by `pnpm tts-setup`; the
  ~285 MB model lands in `~/.cache/huggingface` on the first export. Twenty
  Vietnamese presets across three accents (Bắc / Trung / Nam), picked
  per-export from a dropdown in the framing bar and persisted per video.
  Apache 2.0, torch-free ONNX int8 — the README's own recommendation on Apple
  Silicon, where the CPU path beats the MPS build.
- **`say` was abandoned because it has no ceiling left, not because it broke.**
  Its only Vietnamese voice is `Linh`, and `Linh (Enhanced)` is a separate
  *name* rather than a silent upgrade of it — both appear in `say -v '?'` once
  the 133 MB download lands. Enhanced is `quality=2` and vi_VN has no
  `quality=3` premium tier at all, so that was the whole public ceiling. Don't
  revisit `say` expecting to find more there.
- **The Siri voices under Accessibility → Read & Speak are unreachable from
  any app, and picking one changes nothing here.** Selecting "Siri Voice 3"
  writes a `com.apple.ttsbundle.gryphon-neural_…_premium` id into
  `com.apple.Accessibility`, and those bundles appear in *neither* `say -v '?'`
  *nor* `AVSpeechSynthesisVoice.speechVoices()` — verified on macOS 26.6.2,
  where the only vi entries are `com.apple.voice.{compact,enhanced}.vi-VN.Linh`.
  They drive macOS' own reader and Siri, nothing else. (macOS 26 renamed that
  pane from "Spoken Content" to "Read & Speak"; the anchor is still
  `AX_FEATURE_SPOKENCONTENT`.)
- **`tts.py --list` must never construct a `Vieneu`.** The preset table is a
  static JSON shipped inside the wheel
  (`vieneu/assets/voices_v3_turbo.json` — speaker embeddings plus pre-encoded
  reference codes), so reading it directly costs 0.06s where an ONNX session
  costs 4.2s. Boot calls `--list` on every start and `node --watch` restarts on
  every server edit, so routing this through the model would put four seconds
  on every save. It is located with `importlib.util.find_spec`, which does not
  execute the package.
- **`synthesize` is variadic because the model load dominates.** ~4.2s of ONNX
  session setup, then ~0.4s per voice: `pnpm voices` over all twenty presets is
  ~12s in one process against ~84s as twenty spawns. `speak` is the one-job
  case and the export path. `tts.py` walks argv in twos after the text file,
  and `server/starter.test.ts` mutation-tests that stride — changing it to 1
  fails with `ValueError: Voice '/…/a.wav' not found`.
- **An export pays ~4.6s for the voice and that is deliberate.** A resident
  process would reclaim it, at the cost of something to start, health-check and
  shut down; the export already spends far longer in two ffmpeg passes.
  VieNeu has a `mode="remote"` if that ever stops being true.
- The engine's `region` and `gender` columns collide in Vietnamese: a Southern
  voice is `region: "Nam"`, and a male voice's label is also "Nam" (`gender` is
  the English `male`/`female`). Different columns, both the engine's words —
  `pnpm voices` prints `Nam · Nữ` for a Southern woman and that is correct.
- Audition with `pnpm voices [title] [voice...]` — one file per voice in
  `$TMPDIR/vstack-voices`, each played through `afplay` unless `--quiet`.
  `VSTACK_VOICE="<name>" pnpm server` sets the *fallback* the dropdown starts
  from; `checkStarter` rejects a name the engine doesn't know at boot.
- **`/api/say` answers the WAV itself and keeps nothing.** The framing bar's
  Try button hears the real title in the selected voice without an export. It
  runs `/api/export`'s two validators (`readTitle`, then the voice against
  `knownVoices`) and synthesises into a `mkdtemp` dir it removes in a
  `finally` — verified as three requests leaving zero directories. A server
  killed mid-sample does strand one, deliberately un-tracked: unlike an export
  partial it is in `$TMPDIR`, is not servable, and has no name a client could
  request, which were the three reasons `inFlight` exists.
- The voice dropdown writes through `saveVoice` rather than `save()`, and
  `main.ts` reads it back with `setQuiet({ voice: savedVoice() })` immediately
  before the first `render()` — so the control opens on the last-picked voice
  instead of flashing the server's fallback. `savedVoice` is a function rather
  than a value folded into `initial` because `initial` is evaluated at module
  load, which under vitest is before the localStorage stub exists.
- **The Try button carries its own busy state, not `guard`'s.** A global
  `busy` re-renders the bar — rebuilding the title input mid-iteration — and
  disables Export and the transport for the ~4.6s the model takes. Same
  reasoning as the Export button's in-place `disabled` flip: the title field
  updates via `setQuiet`, so both buttons are toggled from inside its
  `oninput` rather than by a render.
- `~/Desktop/vstack/` grows without eviction, two files per export (the
  `.mp4` and its vertical `.jpg`). Nothing prunes it — deliberately the
  user's to clear, which is why it sits on the Desktop rather than in the
  repo.
- Publishing needs `~/.vstack/youtube-client.json` (a **Desktop app** OAuth
  client from Google Cloud Console, with YouTube Data API v3 enabled) and a
  token from `pnpm youtube-auth`. Missing either is a boot *warning*, not a
  boot failure — everything except Publish works without them.
- The thumbnail is the export's own first frame — the starter screen —
  lifted by `firstFrame`, cropped to 1280x720, and posted with
  `thumbnails.set`, which accepts the `youtube.upload` scope the auth script
  already requests, so no re-consent.
  It needs a **phone-verified channel**; an unverified one answers 403 and
  the bar shows a `thumbnail skipped` badge rather than failing a publish
  whose video is already up. That JPEG is cropped 16:9 and goes to a temp
  dir; the vertical one saved next to the export is a different shape for a
  different slot — see `firstFrame`'s `shape` argument.
- Uploads land private and cannot be made public from here; that is Google's
  audit rule for unaudited API projects, not a missing feature. The endpoint
  also has its own ~100 uploads/day quota.
- `.strip-range` is square-cornered on purpose, having dropped the
  `--radius-3` it carried before multiple segments existed. A cut boundary is
  a position, and a rounded end reads as a fade — several rounded ranges side
  by side read as lozenges rather than cuts. That is exactly why `.strip`
  itself gained `overflow: hidden`: without it, a part marked at 0 or ending
  at the video's duration paints its square corner past the track's own
  rounded one — a notch sticking out at exactly the two positions a user is
  most likely to mark.

**`.out` is `aspect-ratio: 9 / 16` and a long-form video is not.** The slot
holds the framing canvas (always vertical) as well as the preview `<video>`,
so the shape is toggled by `render()` on the phase AND the mode
(`.out.is-wide`), never set once. Without it a 16:9 output is squeezed into
a thin strip with most of the card empty, which reads as a broken render.

**`media/uploads/` grows without eviction and nothing lists it.**
Deliberate: re-rendering a stack after a title fix must not mean
re-uploading a gigabyte. `listClips` cannot reach it — it walks per-video
directories and matches `CLIP_RE`, and a UUID at the top level is neither.
`reportCache` counts it, so the boot log shows it growing.

**`/api/upload` destroys the socket past `UPLOAD_MAX_BYTES` rather than
answering.** Replying politely means having read the whole body first, which
is the cost the cap exists to avoid — but a destroyed socket surfaces
client-side as `BACKEND_DOWN` ("start the backend"), which is the wrong
sentence for a file that is simply too big. That is why the client checks
`file.size` first and the server's check is the backstop. Both read the same
constant from `src/defaults.ts`.
