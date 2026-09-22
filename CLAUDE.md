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
and is unchanged by it. Two of that doc's own decisions have since been
reversed and it carries an amendment saying so: outro stripping is no longer
out of scope (every part but the last gives up the bundled `end_video.mp4`),
and `/api/stack`'s body takes a required `thumb` on top of `ids` + `title`, plus
`docs/specs/2026-09-12-vstack-chat-moments-design.md`, which supersedes
nothing and adds a dead-end lookup beside the two journeys: a finished
livestream's chat replay, scored into the fifteen moments it reacted hardest
to. It writes no `segments`, fetches no video and reaches no other phase —
the result is a list of `youtu.be/<id>?t=` links the user copies out, plus
`docs/specs/2026-09-16-vstack-lofi-design.md`, which supersedes nothing and
adds a FOURTH journey beside the short one, the long one and the
chat-moments dead end: `idle` → `lofi` → `preview`, where a music track, a
background picture and up to `MAX_SPEECHES` (8) speech clips become one
1920x1080 video, each speech mixed into a quiet stretch of the music,
band-limited and ducking it. A speech is AUDIO ONLY — it may be uploaded
as an audio file or a video one, and a video one's picture is discarded.
The background may be a still OR an animated GIF, looped for as long as
the track runs; a bundled mark spins in the top-right corner of every one
of them, and a band of frequency bars runs along the bottom.
It shares `preview`, `/out/`, the publish panel and `media/uploads/` with
the long journey and nothing else — the long journey's parts arrive on
`/api/upload`, every one of the lofi journey's on `/api/upload-audio`, plus
`docs/specs/2026-09-21-vstack-lofi-longform-design.md`, which supersedes
nothing and extends the 2026-09-16 doc rather than any other: the music
becomes a LIST of up to `MAX_TRACKS` (70) tracks, joined into one file
before the render ever probes it; a speech now RECURS on a spacing the
user sets, up to `MAX_DROPS` (300) placements, with `MAX_SPEECHES`
re-scoped to mean distinct uploaded FILES rather than placements; a
`1_`-prefixed upload plays first and the rest are shuffled once,
client-side, at add time; and the render reports progress, polled from an
ffmpeg `-progress` file, plus
`docs/specs/2026-09-21-vstack-audio-cutter-design.md`, which supersedes
nothing and extends nothing and adds a FIFTH journey that is also a second
dead end: `idle` → `cutting` → `idle`, where an uploaded audio or video
file is marked into ranges on a waveform strip and each range comes back as
its own `.mp3` in `OUT_DIR`, revealed in Finder. It reaches no other phase,
claims no `mode`, and never touches `framing`, `preview`, `/api/export`,
`/api/publish` or `/out/` — that isolation is the design rather than an
accident, and it is what keeps every invariant the other four journeys rest
on out of scope there. It borrows `media/uploads/` and `/api/upload-audio`
from the lofi journey and `src/segments.ts` from the trimming phase, and
that is the whole of what it shares. No
spec covers the speech engine: every one of them
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
pnpm test     # vitest, 448 tests (shells real ffmpeg *and* real VieNeu-TTS)
pnpm build    # tsc && vite build
pnpm voices   # audition the starter screen's 20 TTS presets (see below)
pnpm tts-setup     # one-off: build ~/.vstack/vieneu (see server/tts.py)
pnpm youtube-auth  # one-off OAuth setup for publishing (see server/youtube.ts)
```

Needs `ffmpeg`, `ffprobe` and `yt-dlp` on PATH, the speech venv from
`pnpm tts-setup`, and all seven bundled assets in `server/assets/`. The server checks
all of it at boot and exits with an install hint if any is missing —
`checkStarter` owns the short journey's four, `checkLongform` the long
journey's one, and `checkLofi` the lofi journey's two. The cutter adds
nothing to that list: it bundles no asset, and its one external requirement
is `libmp3lame`, which is present in this machine's Homebrew ffmpeg
(verified). A missing *encoder* fails the first render immediately with
ffmpeg's own message, where a missing *asset* fails halfway through one —
which is the difference the boot checks exist for. `ponytail:` add it the
day a second machine runs this. Nothing
here needs macOS `say` any more — the starter screen's voice is VieNeu-TTS,
and the only remaining macOS dependency is `afplay` in `pnpm voices` and
`open -R` in `/api/reveal`.

## Architecture

```
server/errors.ts   HttpError (status + message), toolError (stderr tail)
server/ffmpeg.ts   MEDIA_DIR/OUT_DIR, clipName/clipPath, segmentDigest,
                   outName/outPath, isOutName, cutName/isCutName,
                   stillPath/thumbPath/
                   removeExport,
                   UPLOADS_DIR/uploadPath, isUploadId,
                   probeFile, probeAudio, ConcatPart/
                   concatClips, buildFilter, assertBoxes, exportClip,
                   firstFrame,
                   reportCache
server/mask.ts     MASK_DIR, maskPath, ensureMask (frame-overlay PNG cache)
server/longform.ts WIDE, FADE, TRANSITION_PATH/TRANSITION_PEAK,
                   checkLongform, Trim/MIN_KEPT/detectTrim/keptRange,
                   stackWide (the long journey's one ffmpeg pass)
server/lofi.ts     WIDE, FADE, TRACK_FADE, CRACKLE_PATH, LOGO_PATH/LOGO_RECT/
                   SPIN_SECONDS, VIZ_RECT/VIZ_BAR, checkLofi,
                   concatMusic (the music pre-pass — several tracks dipped
                   at each seam into one file, or one track untouched),
                   Cut/renderLofi (the
                   lofi journey's one ffmpeg pass — one background, still
                   or a looped GIF, for the whole track, with every speech
                   mixed in as AUDIO ONLY, one input per unique speech
                   FILE), parseProgress/renderProgress/clearProgress (the
                   `-progress` file, polled)
server/cut.ts      MP3_QUALITY, cutMp3 (the cutter's one ffmpeg pass, run
                   once per range)
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
                   end_video.mp4 (the outro, concatenated after the clip),
                   long-form-transition-sound.mp3 (the swell over each cut —
                   the LONG journey's asset, owned by longform.ts),
                   vinyl-crackle.mp3 (the lofi journey's surface noise,
                   owned by lofi.ts — supplied by the user; 3m22s, and AAC
                   inside a .mp3 name, which ffmpeg sniffs past),
                   lofi-video-logo.png (the mark that spins in the lofi
                   journey's top-right corner — also lofi.ts's, 360x360
                   RGBA, supplied by the user)
server/youtube.ts  CONFIG_DIR/TOKEN_PATH, readClient, checkYouTube,
                   buildSnippet, accessToken, uploadVideo, publishProgress,
                   setThumbnail
scripts/youtube-auth.ts  `pnpm youtube-auth` — the one-off OAuth dance
server/ytdlp.ts    videoIdFrom, probe, fetchWindow, parseClipName, listClips
server/chat.ts     ChatMsg/Moment, BIN/WIN/LAG/TOP/MIN_GAP/SKIP_HEAD,
                   fetchChat (chat replay -> media/<id>/chat.json),
                   parseChat, peaks (the scorer)
server/index.ts    17 routes (16 POST + GET /out/<name>), serveOut range
                   streaming, body validators, boot checks
src/geometry.ts    pure rect math — THE tested core
src/segments.ts    Segment, MAX_SEGMENTS, normalize, isValidSegments,
                   totalDuration, keepRanges, editMark
src/lofi.ts        Speech/Placement, BUCKETS_PER_SEC/MIN_GAP/SKIP_HEAD/
                   SKIP_TAIL, troughs (the detector — longest speech first),
                   orderByPrefix (a `1_` file first, the rest shuffled once),
                   fill (troughs' own answer at spacing 0, slots above it)
src/layout.ts      nine layout presets, cellsOf, ratioOf, defaultBoxes
src/custom.ts      CustomBox, MAX_CUSTOM/MIN_OUT_SIDE, outRatio, clampOut/
                   moveOut/resizeOut, resnapCrop, isValidOut/isValidCustom,
                   defaultCustom
src/frame.ts       GUTTER/CORNER_RADIUS, windowOf/windowsOf, ringOf, maskRgba
src/starter.ts     TITLE_FONT, drawTitle (title → a canvas), renderTitleArt
                   (that same draw, encoded as a transparent PNG)
src/thumb.ts       THUMB, renderThumb (any picture → 1280x720 JPEG, stretched),
                   WIDE_IMAGE, renderWide (any picture → 1920x1080 JPEG,
                   cover-cropped — the lofi journey's background)
src/state.ts       AppState, setState/setQuiet, save/restore
src/api.ts         15 fetch wrappers
src/format.ts      mmss / clock / slugify (shared client + server)
src/player.ts      YT IFrame API wrapper + trim strip
src/editor.ts      box drag/resize overlay (crops over the <video>, pieces'
                   `out` rects over the <canvas>); returns { place, stop }
src/preview.ts     canvas composite rAF loop, plus the thumbnail overpaint
src/main.ts        persistent shell, phase machine, all seven phases
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
`lofi.ts` sits beside `ffmpeg.ts`, `longform.ts` and `starter.ts` for the
same reason — every path is the caller's, neither directory is needed — and
imports `probeFile` and `probeAudio` from `ffmpeg.ts` and nothing else. It
declares its own `FADE` and re-derives its own asset path rather than
importing either from `longform.ts`, which is its SIBLING rather than a
layer below it — the same call `longform.ts` already made against
`starter.ts` for `~/.vstack/`. `cut.ts` sits beside all four of them and is
the thinnest of the set: every path is the caller's, and it imports nothing
from `ffmpeg.ts` at all — not even `probeAudio`, because the route probes
before it calls in. The spec says it imports `probeAudio`; the shipped
module does not, and that direction is the one to keep. Its only imports are
`toolError` from `errors.ts` and `type Segment` from `src/segments.ts`, the
same reach across the client/server line `ytdlp.ts` already makes for
`geometry.ts`'s `PAD` — which is also what makes the cutter's ranges the
trimming phase's ranges by construction rather than by resemblance.
`src/lofi.ts` sits at the very bottom beside
`geometry.ts` and `segments.ts` and imports only `defaults.ts`, itself a
leaf — `MAX_DROPS` bounds `fill`'s own slot loop, so the cap that has to
hold lives one import away from the function that spends it rather than
being threaded in by every caller. A music track's own loudness envelope
and a speech's own length are otherwise enough to place it, with no need to
reach into `layout.ts`, `custom.ts` or `frame.ts`.
`chat.ts` sits above `ffmpeg.ts` beside `mask.ts` — it needs `MEDIA_DIR` for
its cache and imports nothing else, deliberately not `ytdlp.ts`, so
`videoIdFrom` stays the one trust boundary that decides whether a subprocess
spawns.

Eight phases: six of them across three journeys that share the last one, plus
two dead ends: `idle` (URL) →
`trimming` (YouTube iframe, mark start/end, no download) → `framing` (real
`<video>` of the fetched window, crop boxes, canvas composite, export) →
`preview` (the finished file played back on the right, with the upload's
title/description/tags in a panel on the left where the framing `<video>`
was — it has nothing left to say once the export exists) is the short
journey, `idle` → `stacking` → `preview` is the long one, and `idle` →
`lofi` → `preview` is the third — a list of music tracks, a background
picture and up to `MAX_DROPS` speech drops from up to `MAX_SPEECHES` files
become one 1920x1080 render. `publishForm`
is a child of `sourceSlot`, not a third `.stage` column, `stackPanel` is
another beside it, and `lofiPanel` is a third, all under the same rule —
`sourceSlot` itself is never
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
away. A pasted timestamp pauses before seeking — a rolling player has left the
frame you aimed at by the time you reach Set Start. The nudges and the
jump-to-mark buttons deliberately do not: YouTube's `seekTo` resumes a playing
player while leaving a paused one paused, so a bare seek preserves whatever the
user was already doing, and a nudge is reached from a pause the user already
took.

`idle` → `moments` → `idle` is a fourth way out of `idle` and a dead end,
sharing no phase with any journey.

`idle` → `cutting` → `idle` is the fifth way out and the second dead end: an
uploaded audio or video file, a waveform strip, up to `MAX_SEGMENTS` marked
ranges, and one `.mp3` per range in `OUT_DIR`. Like `moments` it **claims no
`mode`** — the three rendering journeys all set one because they meet at
`preview` and a stale value misclassifies an upload there, and this journey
reaches neither `preview` nor `/api/publish`, so there is nothing to claim
and nothing downstream that could read it. That absence is why the status
row's three probed badges exclude `cutting` explicitly rather than
inheriting the `mode === "short"` test: on a fresh session `mode` is still
`"short"`, and those badges would describe some other video entirely.
`cutVideo` is a persistent `<video controls>` child of `sourceSlot` under
the same never-empty rule as every other long-lived node; there is no
`.out` involvement at all, because this journey produces nothing to play
back. Its `src` is a local `URL.createObjectURL(file)`, not the uploaded
copy: scrubbing is live before the upload finishes (only the Cut button
waits on the id), and there is no second GET route to write — `/media/` is
only reachable in dev because Vite serves the project root, and relying on
that is what forced `serveOut` into existence in the other direction. The
URL is revoked in `releaseCutUrl`, and `render()` calls it on every render
where `phase !== "cutting"` rather than leaving it to the `← Back` button,
so a route out of this phase added later cannot leak the blob for the life
of the tab. It is idempotent, which is what makes running it on every
render of every other phase free.

## Invariants — breaking these is silent, not loud

**The chat scorer's baseline is a rolling median and its denominator is
`sqrt(base + 4)`, and both were measured as silent failures.** A global
mean over an eleven-hour stream is 3.3 messages a bin against a local 9-16
inside its busy stretches, so it ranks the loudest *hour* rather than the
loudest *moments*. A plain `count / base` ratio is division by a small
number: it promoted nine messages over a baseline of one — dead air at the
end of the stream — above forty messages and seventeen laugh tokens over a
baseline of nine. Both are mutation-tested in `server/chat.test.ts`, along
with the lag offset, because all three produce a plausible-looking list
rather than an error. YouTube's own "Live chat replay is on." banner is
dropped at parse for the same reason: left in, it won the ranking outright.

**`/api/moments` must reject a live stream before it spawns yt-dlp.**
`--sub-langs live_chat` on an ongoing stream *follows the chat in real
time* and never returns, so the request hangs until the stream ends rather
than failing. `probe()` already reports `liveStatus`, which is why the
guard needs no new detection — but it is a separate table from
`NOT_FETCHABLE`, whose `is_live` message is about a section of video being
ill-defined and says nothing about why this route cannot run.

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
of this API** — `/out/<name>`, `/api/reveal`, `/api/publish` and both
`/api/export`'s and `/api/lofi`'s `prev` all take it.
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
`/api/lofi` has the identical `prev` and the identical sweep, after its own
`rename` and sidecar write — `removeExport` takes a *path*, not the bare
name `prev` arrives as, so the caller must resolve it through `outPath`
first the way `/api/export` already does; passing the name through directly
compiles (both are strings) but resolves against `process.cwd()` instead of
`OUT_DIR`, and `rm(..., { force: true })` swallows the resulting ENOENT
silently — the sweep does nothing and no error surfaces.

**The `.progress` sidecar sweeps itself, because nothing else in this
codebase could find it to sweep.** `concatMusic` and `renderLofi` each write
`${out}.progress` for `-progress` to append to, and each removes its OWN in
a `finally` the instant its ffmpeg process exits — never the route. `out` is
a temp-dir path for `concatMusic`'s pre-pass, which the route's own
`finally` already sweeps wholesale either way, but for `renderLofi` it is
the partial inside `OUT_DIR`, which on this machine is `~/Desktop/vstack` —
the user's own directory, not scratch space. Neither `isOutName` nor
`isCutName` matches a `.progress` suffix, so no existing check could ever
name this file to clean it up, the way `removeExport`, `/api/export`'s
`prev` and `/api/cut`'s `prev` all do for the shapes they own. A
route-level sweep would need a THIRD filename convention threaded through
`server/index.ts` for a file only `lofi.ts` ever writes; letting each
function clean up its own litter needs none. Found in review, not by a
test — the failure is a `.progress` file left on the Desktop beside every
finished render, not a wrong answer anything asserts on.

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

**A framing cut is a hole in the clip, and `keepRanges` is the one rule
both sides spend it with.** The framing strip drops red regions inside
`[clipStart, clipEnd]` (`state.cuts`, `+ Cut`, capped at `MAX_CUTS`), and
`/api/export` carries them as an optional `cuts`. `keepRanges(start, end,
cuts)` in `src/segments.ts` subtracts them; the client sizes the kept badge
with it and the server builds the render's legs with it. Two copies of that
subtraction is how a badge comes to disagree with the file it names. With
cuts the route runs `concatClips` first — the *same* stitch `/api/window`
uses, given the cached clip once per kept range — and `exportClip` then runs
on that from `0`; with no cuts nothing is stitched and the path is
byte-identical to the one every export took before the field existed. Cuts
are window-scoped and unpersisted, for the reason `clipStart`/`clipEnd`
are.

The framing `<video>` **skips** a cut (`ontimeupdate` seeks to its end), and
`keptLength` subtracts them. Both are load-bearing rather than polish: they
are what keeps the next invariant's promise while framing gains holes.

**The framing phase must never learn that segments exist.** The cut is
baked into the cached clip by `/api/window` — `fetchWindow` fetches each
segment and `concatClips` stitches the kept ranges into one continuous file
before the framing `<video>` ever sees it. Carrying segments to `/api/export`
as well, instead of the clip-timeline `start`/`end` it already sends, would
leave the framing `<video>` playing footage the export drops — the exact
preview/export divergence this codebase treats as the cardinal failure,
reintroduced at the one layer this design exists to keep it out of.

**The thumbnail preview seeks to the in-point, and `clipStart` is not the
number to seek to.** `🖼 Thumbnail` in the framing bar repaints the composite
canvas as the starter screen with the 16:9 rectangle `firstFrame("wide")`
takes drawn on it — which is the export's own first frame, and therefore the
only frame `thumbnails.set` can ever be given. Painting it over whatever the
playhead was sitting on previews a picture YouTube never renders, silently.
`clipStart` is in the *fetched window's* timeline and the `<video>` element's
is the file's own, so the seek is `clipStart - windowStart` — the same
conversion `playCutOnly` makes. They differ by `PAD` on an ordinary window,
which is seconds of footage the thumbnail does not come from. Caught in a
browser, not by a test: on a reopened cached clip the two are equal and the
wrong version looks perfect.

**The preview's blur draws the composite 3 sigma oversized, and that is a
correctness fix rather than a flourish.** A canvas `filter: blur()` over an
edge-to-edge image bleeds ALPHA inward at the frame's borders, so the band's
left and right ends come back semi-transparent and the sharp composite shows
through them — a defect `gblur` does not have, since ffmpeg clamps. `EDGE`
in `src/preview.ts` puts real pixels under every sample. The ~17% scale-up
is invisible in a picture whose whole purpose is to be out of focus, the same
trade `stackWide` makes by blurring at 480x270.

`BLUR_SIGMA`/`SCRIM`/`BAND_H`/`BAND_FEATHER` are copied from
`server/starter.ts`'s `SCREEN_FILTER` rather than shared — they sit on
opposite sides of the client/server line, and the client cannot import a
server module. Approximate in exactly one thing, the blur's rounding.
Everything that *decides* anything is exact: `drawTitle` is the same function
`renderTitleArt` encodes for the export, and the crop is arithmetic. The exact
fix is a `/api/still` route running the real pipeline; worth it the day the
blur misleads someone about the screen rather than about the title. Marked
`ponytail:` at the constants.

**The preview shares the title's DRAW, not its bytes, and that is what makes
it live.** `drawTitle` was split out of `renderTitleArt` so the rAF loop can
paint the title straight onto the composite from the current string —
`currentStill` returns `starterTitle` itself, so a `setQuiet` keystroke
reaches the canvas with no render, no PNG re-encode, no image re-decode and
no refresh wiring. Going through the PNG instead means an async round trip
per keystroke, which needs a race guard (out-of-order completions show a
stale title) and a trigger to hang it on; the first version hung it on blur
and simply looked broken while typing. Measured at 8.3ms a frame either way
on a 120Hz display — laying the title out every frame costs nothing worth
caching, so there is no memo. A title edited down to blank falls back to the
live composite rather than showing an empty screen, and typing brings it
back: `showThumb` stays on throughout.

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

The cutting phase's `+ Range` and `Set Start`/`Set End` make the identical
calls against `cutRanges`, with `activeRange` and `cutAimedEnds` as its own
copies of `activeSegment` and `aimed` — **value-keyed, never index-keyed**,
for the reason above. Marking there is the trimming phase's marking *by
construction* rather than by resemblance: no range arithmetic was written
for the feature, so the one thing that could silently differ between the two
phases — what a merge does to the part the user is aiming at — cannot. The
chip row is what makes `activeRange` reachable: without it there is no way
to re-aim which range the two Set buttons write to, and the phase silently
only ever edits whichever range was added last.

**`renderStrip`'s rAF loop is stopped in two places, and both are
load-bearing.** `renderTrimming` stops the old loop before building its
replacement — the ordinary re-render case. `render()` stops it and nulls the
module-scoped handle whenever `phase` is not `trimming` — the departure
case, the same way it already toggles `boxesLayer`/`outBoxesLayer` by phase.
The normal flow (trim once, then frame, export, preview) never re-enters
trimming, so nothing else ever calls the departure stop — without it the
loop keeps `postMessage`-ing a hidden YouTube iframe every frame for the rest
of the session, not just the rest of this visit to trimming.

`cutStrip` is the same rule with a THIRD stop, and that third one is the
non-obvious half. `renderCutting` stops the old loop before building its
replacement and `render()` stops it whenever `phase !== "cutting"` — but
`renderCutting` also returns early, before it builds any strip, whenever
there is no file or `cutSeconds` is still 0. Picking a second file writes
`cutSeconds: 0`, so that branch is reached with the PREVIOUS file's loop
still running against a node about to be detached, and if `decodeTrack`
then throws, no later render ever builds the strip that would have stopped
it. Hence the `stopCutStrip()` inside the early-return branch as well.

**`setMark` refuses an edit that would leave `end <= start`, rather than
letting `normalize` handle it — but a start that overshoots an end the user
never aimed CARRIES that end instead of being refused.** `normalize` *drops*
a segment whose end is not after its start — the right behaviour for a merge,
the wrong one for an edit in progress. Set End with the playhead sitting
before the active part's own start would otherwise pass a doomed range
straight to `normalize` and silently delete the very part the user was trying
to adjust — the worst possible answer to an ordinary misclick.

Refusing *every* such edit was itself a bug, though, and the commonest one in
the phase: `+ Part` gives a new range a synthetic five-second end, so the
ordinary flow — add a part at the playhead, roll forward, aim Set Start — is
past that end by definition. Set Start did nothing and grew no tick (reading
as a broken button), and the Set End that followed then measured the part
from the `+ Part` playhead rather than from the start the user had aimed at.
`editMark` in `src/segments.ts` is the one rule now: an end **not** in
`aimed.end` is synthetic and is carried along, keeping the part's own length
and clamped to `duration`; an end the user *did* aim is theirs and is refused
rather than silently overwritten. Both refusals now set `error` — silence was
half of what read as breakage. The carry is asymmetric on purpose: the end of
a fresh part is a default nobody chose, while its start is the playhead the
user was sitting on, so there is nothing on the Set End side to carry.

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
`"lofi"` is a fourth value now, claimed by the `Lofi →` button the same way
`"long"` is claimed, and it is what pushed the wide-slot test and `preview`'s
`← Back` target from a two-way branch to a three-way one — the exact
enumeration growth this invariant warns about, arriving on schedule. The
wide-slot test reads `s.mode !== "short"` rather than adding a third arm, for
the reason `src/main.ts`'s own comment at that line gives: an enumeration
there grows with every journey, and "not the short journey" does not.

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

**A long-form part's furniture is DETECTED, never assumed — and that is a
bug fix, not a refinement.** A vstack short is starter + body +
`end_video.mp4`, so a compilation of N of them plays N title cards and N
endings. The first version of this took the outro off every part but the
last *unconditionally*, which is wrong for every short made before that
asset existed: an old 40s short silently lost 5.04s of real content, and
`MIN_KEPT` only rescued parts shorter than the cut. `detectTrim` measures
both ends instead, so a part is only cut where the thing being cut is
actually there.

The two detectors work on completely different signals:

- **The head** is `freezedetect` from t=0, and `FREEZE_DB = -60dB` is the
  load-bearing constant. The starter screen is ONE composited frame
  repeated, so its frames are bit-identical; real footage never is, not
  even a locked-off tripod shot. Measured: a maroon still with
  `noise=alls=6` does NOT freeze at -60dB or -50dB and DOES at -40dB, while
  a real starter freezes at all three. Loosen it and a part that merely
  opens on a quiet shot loses that shot — `server/longform.test.ts`
  mutation-tests exactly that (-40dB reports a 3s starter on the raw-upload
  fixture). Only a freeze starting within `HEAD_SLOP` of zero counts: the
  starter *is* the first frame, so a freeze further in is a still inside the
  body. `MAX_HEAD` is a sanity bound on top, not the defence.
- **The tail** compares three greyscale thumbnails across the part's last
  `outroSeconds` against the same three of the asset. Measured on real
  renders: a short carrying the outro scores 1.1 and one without scores
  87.6, so `OUTRO_MATCH = 12` sits an order of magnitude clear of both.

`keptRange` then spends them, and the two ends follow OPPOSITE rules. The
**head goes from every part, the first and the last included** — a part's
title card announces that part, and the compilation's own title is in the
publish panel beside a thumbnail the user picked, so no card is doing a job
any more and part one's would mislabel the whole video. The **tail stays on
the last part**, because that outro is the finished video's own ending.
Both directions are mutation-tested.

They reach ffmpeg as input `-ss` and `-t`, declared BEFORE that part's `-i`
— the same lesson `exportClip`'s mask input carries, since ffmpeg attaches
an option to the *next* `-i` and the other order would trim the following
file. `-ss` before `-i` is also what makes `-t` a duration measured from
the seek point, which is what `keptRange` returns.

`keptRange` is the one rule both sides compute from: the route needs it too,
because `outName` carries the duration and a name that disagreed with the
render would send `/out/` looking for a file nobody wrote. The asset's path
and length are *not* imported into `longform.ts` — `END_PATH` lives in
`starter.ts`, which is its sibling, and the caller already has both.
`MIN_KEPT` survives as a backstop for a part that is almost entirely
furniture. `trims` defaults to empty, the identity, so every caller that
predates trimming is exact.

The detection is invisible in the output, so `/api/stack` logs each part's
head and tail — otherwise a render coming out shorter than the files that
went into it has no explanation. `ponytail:` it re-detects on every render
(~0.6s per part, nothing beside the encode) rather than caching on path +
mtime.

**The transition is a dip on each leg, NOT a crossfade across the seam —
which is what keeps the output's duration unchanged.** `fade`/`afade` ride
the legs `concat` already joins, so `keptRange`, `/api/stack`'s `total`
and `outName` all stay exact and the filename cannot come to disagree with
the file. `xfade` + `acrossfade` would be the crossfade, and it costs three
things this does not: a pairwise chain rather than a per-leg filter, an
`offset=` per step that is the running total minus `k * d` (so every part's
duration feeds every later offset), and an output `(N-1) * d` SHORTER,
which both `stackWide` and the route would have to agree on. Named in a
`ponytail:` comment as the upgrade path.

Two details of the dip are load-bearing and both are silent. It is applied
only BETWEEN parts — `i > 0` fades in, `i < N-1` fades out — because the
compilation opens on a title card and closes on the bundled outro, and
fading either is fading something that already starts and ends
deliberately. And `d` is `min(FADE, seconds / 3)`, because on a part
shorter than `2 * FADE` an unclamped fade-in and fade-out overlap and
*multiply* to roughly quarter brightness; once the part is shorter than
`FADE` itself the fade-out's `st` goes negative and ffmpeg refuses the
graph outright. Same defect, two symptoms — which is why the test asserts
on the colour rather than on either failure mode. The test for that clamp only
works with the short part in the MIDDLE — a brief part placed first has
its fade-in suppressed by the `i > 0` guard and can never overlap
anything, so the first version of that test passed with the clamp removed
(found by mutation testing, not by review).

**The transition swell is mixed over the FINISHED concat, never into a
part's own leg.** Two reasons and either alone settles it: a leg is
`afade`d to silence at precisely the moment the sound has to be heard, and
`concat` would cut the sound dead at the boundary it exists to span. So
`concat` produces `[amain]`, each cut's absolute time is the running sum of
the kept lengths, and one `asplit` of a single input feeds an `adelay` per
boundary into an `amix`.

Three details of that mix are load-bearing:

- **`normalize=0`.** `amix` divides every input by the count by default, so
  a two-part render would come out at half volume purely for carrying one
  swell. Measured either way: the bodies sit at -24.1 dB mean with the mix
  in place, unchanged.
- **`duration=first`.** The asset is 2.61s long with only its first ~1.6s
  audible, so a swell delayed onto the last boundary can outrun the
  programme — and `longest` would then extend the render past the duration
  `outName` has already committed to. Only reproducible with parts shorter
  than the asset's tail, which is why that test uses 1.2s parts; at 2s it
  passes with the bug in place.
- **The sound is placed by its PEAK, not its start.** The asset opens on
  roughly 0.6s of near-silence and peaks at `TRANSITION_PEAK` (1.2s), so
  `adelay` gets `boundary - TRANSITION_PEAK`. A delay of `boundary` puts
  the swell a full second *after* the cut, over footage that has already
  faded back up. Clamped at zero, because `adelay` cannot take a negative
  offset and a first part shorter than the lead-in would ask for one.

**The transition sound's input index is the conditional one, and the
silence stand-in's is not.** `silenceIndex` keeps the exact `paths.length`
it has always had and the swell is appended *after* it
(`paths.length + (anySilent ? 1 : 0)`), so the input arithmetic that
already works for silent parts is byte-identical and only the new index
moves. Putting the swell first would have shifted the stand-in — the
failure `server/starter.test.ts` documents as breaking silent clips only.
The input is declared **only when `paths.length > 1`**: a one-part stack
has no boundary, and an input its graph never references is an ffmpeg
error rather than a no-op.

**The picked thumbnail is `<name>.thumb.jpg`, NEVER `<name>.jpg`.**
`applyThumbnail` prefers the sidecar over the render's own first frame, and
`stillPath`'s `<name>.jpg` is where a *short* export writes its **vertical**
1080x1920 still for Studio's Shorts slot. One name for both would make every
short publish that vertical still as its 16:9 thumbnail — pillarboxed to a
32%-wide strip with black either side, which at tile size reads as a black
picture, the exact bug `firstFrame`'s crop already exists to prevent. A
distinct name is also what lets `applyThumbnail` decide on the file's
presence rather than on a mode flag, so it stays as blind to the two
journeys as `serveOut` and `isOutName` are. `removeExport` sweeps both.

**The thumbnail is stretched in the browser, and it is the third image this
client rasterises for a server that cannot.** `renderThumb` draws the picked
file into a 1280x720 canvas across the whole destination rect — distorted to
fill, never cropped or letterboxed, because the user picked the picture
knowing the shape it has to become and a crop would silently discard whatever
they put at the edges. Doing it client-side buys more than it does for
`titlePng`: `createImageBitmap` decodes every format the browser can display
(jpeg, png, webp, avif, gif), which is wider than a scale filter would have
to be told about, and the output is exactly 1280x720 so nothing server-side
has to check a dimension. `jpeg()` in `server/index.ts` still checks the
signature — three bytes, `FF D8 FF`, because the fourth varies by encoder —
since those bytes are handed to `thumbnails.set` later, and a non-JPEG fails
there long after the render that would have to be repeated.

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

**A lofi speech is AUDIO ONLY, and nothing a speech does moves the
picture.** A speech is mixed into the track and is never shown: no overlay,
no letterbox, no dip, no fade. The video track is the background and only
the background, from t=0 to the end, which is why an uploaded speech may be
an audio file or a video one indifferently — a video one's pictures are
discarded here. (The background itself may move — see the GIF invariant
below — but on its own loop, never in response to a speech.)

This reversed an earlier design, and what it deleted is worth knowing about
before anyone puts it back. The cut-in used to be letterboxed over a blurred
copy of itself, `tpad`ded to its own start, gated with
`enable='between(t,at,at+dur)'`, and surrounded by a dip to black on the
background. Three of those carried invariants that were *correctness fixes
found the hard way*, and none of them is inferrable from the code that
replaced them: `tpad` rather than a bare `setpts` (because `overlay`'s
second input must have a frame at every base timestamp, and a `setpts`
offset manufactures none); every background `fade` scoped with its own
`enable=` (because `fade` multiplies EVERY frame it sees by its ramp factor,
so chained unscoped pairs blacked the picture from t=0 — measured all-16 at
every sampled `t` for a single cut at `t=12`); and each fade clamped to HALF
the gap available on its own side (because two cut-ins closer than
`2 * FADE` overlapped their ramps and the background never returned to
full). Reinstating any of the picture machinery means reinstating all three.
Read them in `server/lofi.ts`'s history before writing a line.

**The lofi render's duration is the music's, by construction — nothing
sums.** The image input carries its own `-t <music seconds>` and the output
carries a second one; no leg's length is fed anywhere. Concatenating an
image leg, N speech legs and a return-to-image leg would put back exactly
the arithmetic the long journey's dip-rather-than-`xfade` decision already
exists to avoid: every leg's length would feed the next leg's offset, the
final image leg would have to absorb whatever rounding was left over so the
picture still ends when the music does, and `outName`'s `mmss` — built from
the probed music length — could come to name a file a different length than
the one on disk. This graph makes that disagreement structurally
impossible.

The music is a LIST now, up to `MAX_TRACKS` (70) of them, and the invariant
survives verbatim rather than becoming a sum. `/api/lofi` concatenates the
tracks with `concatMusic` into ONE file in the route's own temp directory —
the same directory it already creates for the still's bytes and already
sweeps in a `finally` — and probes *that file*, not the tracks it was given.
The obvious alternative, N music inputs joined by ffmpeg's own `concat` on
the main graph, was rejected for exactly this invariant: `seconds` would
become an arithmetic sum of probed lengths, `outName`'s `mmss` would be
computed from that sum, and the filename could disagree with the file by
whatever rounding the concat introduced — the class of failure this
invariant exists to rule out. Building the file first keeps the render's
one music input and its one `-t <seconds>` exactly as they were; the music
is simply a file this route built rather than one the client uploaded.

**The background's two input forms are NOT interchangeable, and one of the
two wrong pairings HANGS rather than failing.** `renderLofi` takes a still
picture or an animated one and decides which by counting frames
(`frameCount`, a local ffprobe on `nb_frames`), never by a name, a MIME type
or a caller's flag.

- A still needs `-loop 1 -framerate N`, an image2-demuxer option that
  MANUFACTURES frames from one picture.
- An animation needs `-stream_loop -1`, which replays the decoded input.

Cross them and neither fails loudly. `-loop 1` on a GIF holds its first
frame forever, so the animation silently never plays. `-stream_loop -1` on a
still never emits a frame at all — measured, a JPEG under
`-stream_loop -1 -t 6` had to be killed — because it spins re-opening a
one-frame input whose timestamps never advance. That is why this is a real
fork and not a tidiness one; `server/lofi.test.ts` covers both sides, the
still one by a test that would TIME OUT rather than assert.

Everything downstream of the input is shared: the same
`scale=increase`+`crop` cover-crops either one frame by frame, and the same
`-t` bounds either at the track's length, so a GIF longer than the track is
cut off and a GIF shorter than it repeats. `fps` is what turns a GIF's own
irregular inter-frame delays into a constant rate. Note the cost — a moving
background is real bitrate where a still is nearly free: measured on the
same 40s track, 21 MB against 1.1 MB.

**A still background is inline bytes and a GIF is an upload, and the split
is not arbitrary.** `/api/lofi` takes exactly one of `image` (bare base64
JPEG) or `bgId` (an upload id). Three separate reasons put the GIF on the
other side:

- The client cannot cover-crop it. `createImageBitmap` decodes a GIF's FIRST
  FRAME and nothing else, so `renderWide` would flatten the animation — the
  crop has to happen in ffmpeg, which means ffmpeg needs the file.
- `json()` reads a whole body into memory with no cap. A 10 MB GIF is 13 MB
  of base64 in a JSON body, per render; `/api/upload` streams to disk under
  `UPLOAD_MAX_BYTES` instead.
- It is a file the user PICKED, not artwork the client DREW. `image` and
  `titlePng` are the latter; the music and the speeches are the former and
  already travel as uploads.

`image` is omitted rather than sent-and-ignored on the animated path,
because a still the render never shows is a lie in the body rather than a
spare. A *present but malformed* `bgId` is its own 400 ("Bad background
id.") rather than a fall-through to the still branch — falling through
answered "Expected image to be a string." for a body that never mentioned
an image. Absent or `null` still means "a still is coming", so every body
written before the field existed is exact.

`thumb` is required either way and is always a still JPEG — on the animated
path it is the GIF's own first frame, since a publish thumbnail is a still
whatever the render does.

**The spinning mark pads to its DIAGONAL before it rotates, and the margin
bounds that padded box rather than the mark.** Two geometry mistakes, both
of which look correct in the frame anybody checks.

`rotate` renders into a box the size of its input, so a square turning
inside a box its own size loses every corner past the inscribed circle —
worst at 45 degrees and perfect at 0 and 90. `pad` to `LOGO_BOX` (the diagonal,
rounded up to even and DERIVED from `LOGO_SIZE` so the two cannot drift)
comes first, and `rotate` then has room at every angle.

`LOGO_MARGIN` then insets that padded box, not the mark. Margining the mark
instead leaves only `LOGO_MARGIN - (LOGO_BOX - LOGO_SIZE) / 2` of real
clearance at 45 degrees — measured at 10px on a 1920 frame with a 180px
mark, an outstretched arm all but touching the edge for a quarter of every
turn while 0 and 90 looked fine. That shortfall GROWS with `LOGO_SIZE`, so
the wrong version degrades every time the mark is enlarged. Bounding the box
makes the clearance angle-independent and costs only that the upright mark
sits `(LOGO_BOX - LOGO_SIZE) / 2` further in than the number suggests.

Three more details of that leg are load-bearing. `format=rgba` comes BEFORE
`rotate`, because `c=none` fills the swept corners with transparency and an
opaque input has nowhere to put it — the mark then arrives inside a hard
black square. The pad colour is `0x00000000`, transparent black rather than
black, for the same reason. And `format=yuv420p` moves to AFTER the
overlay: compositing alpha into an already-subsampled plane throws away the
colour resolution the mark's edges need.

The angle is `a=2*PI*t/SPIN_SECONDS` — an expression over the frame's own
timestamp, not a frame counter — so one turn is ten real seconds and stays
ten if `FPS` ever changes. `server/lofi.test.ts` samples a quarter turn, a
HALF turn and a full turn: the half turn is the one that pins the period,
because a mark spinning twice as fast is back at its starting angle there
and passes every other assertion.

The mark is bundled and unconditional — there is no way to turn it off and
no upload behind it, the same posture the crackle takes. Its input is
appended LAST, after the crackle, so no existing index shifts.

**The frequency bars read the FINISHED mix, and `showcqt` is not
interchangeable with `showfreqs`.** The band along the bottom is fed by an
`asplit` of the render's own output audio — music, speech and crackle
together — not by `[music]`. Tapping the music leaves the bars still through
the one moment a viewer is most likely to be looking at them, and no
structural check would notice; `server/lofi.test.ts` measures the band's
right half under the speech (+18.6 over background, against +0.2 without).

`showfreqs` spaces its bins LINEARLY in frequency, so on music the bass owns
the left quarter and the rest is a flat line. Measured on the bundled track,
every amplitude scale it offers — `log`, `sqrt`, `cbrt`, with and without a
treble tilt — gave the same descending ramp, and `minamp` cannot rescue it
because the filter caps that option at 1e-6. `showcqt` is constant-Q, so its
bins are musical intervals and the spectrum looks as spread out as it
sounds. `bar_g` is the gamma that decides how much of the width stays
alive.

**A per-pixel expression belongs at the SMALLEST size that still produces
the right picture, and the bars are the second place this has bitten.** The
gaps between bars come from a `geq` masking alternate columns. Run at the
final 1920 wide it costs 14s per minute of render — measured, 19.9s against
a 5.7s no-mask baseline, which made the mask four times more expensive than
the `showcqt` transform it was decorating. The bars are therefore widened to
`VIZ_COLS` columns each (480px), masked there, and scaled the rest of the
way with `flags=neighbor`: byte-identical output for a sixteenth of the
evaluations, 9.7s against 19.9s. Same lesson `SCREEN_FILTER` records for the
starter screen, which computes its band in the frame-extraction pass rather
than over every frame of the composite.

Two smaller details of that leg are load-bearing. `flags=neighbor` on BOTH
scales — any interpolating scaler turns the discrete bars into a smooth
ridge, which is the thing `showcqt` at 48 columns exists to avoid. And the
alpha is keyed on `max(r,g,b)`, not `r`: `showcqt` tints its bars by pitch
class, so keying on red alone would make a blue bar vanish. The colour is
replaced with white anyway — the look is `gifsync`'s white-at-0.85, not
`showcqt`'s rainbow.

**`troughs` places the LONGEST speech first, never in input order.** A long
speech has strictly fewer legal windows than a short one. `src/lofi.test.ts`
pins the case that makes this concrete: a 30s hole that is the only place a
20s speech fits, and a 12s hole a 6s speech also fits — placing speeches in
script order lets the short one claim the roomier 30s hole first (it scores
quieter there), stranding the long one with nowhere left. The failure is not
an error, it is a render with a speech silently missing from it. Mutation-
tested by sorting on input order instead of length.

**A speech that fits nowhere refuses BY NAME, with no least-bad fallback.**
`troughs` has no quietness threshold at all — every candidate window is
scored purely by which is quietest, because the duck (below) makes even a
merely adequate trough sound deliberate, so a threshold would only buy a
new failure mode: a dense track where nothing places at all. What it does
refuse outright is geometry — no window inside `[SKIP_HEAD, seconds -
SKIP_TAIL]` that clears `MIN_GAP` from every speech already placed — and
there the error names the speech and its length rather than picking the
least-bad window anyway. A silently misplaced speech is indistinguishable
from a working render until someone watches the output, the failure class
this codebase treats as cardinal everywhere else.

**A single track skips the music pre-pass altogether, and that identity is
load-bearing.** `concatMusic` returns `paths[0]` unchanged and writes
nothing for one track — no concat, no flac, no extra ffmpeg run — so the
original one-track journey pays no new pass, no ~1 GB temp file and no new
failure mode for a feature it does not use. `server/lofi.test.ts` pins the
identity directly rather than just its consequence: `concatMusic([track],
out)` returns `track` itself and never creates `out`. The same
reduction-to-identity `fill` (below) holds against `troughs` and `trims`
holds in `stackWide`.

**`fill` reduces to `troughs` exactly at a non-positive spacing, and that is
mutation-tested.** The delegation is what keeps `src/lofi.test.ts`'s
existing exhaustive `troughs` suite — the longest-first ordering, `MIN_GAP`,
the `SKIP_HEAD`/`SKIP_TAIL` boundaries, the by-name refusal — describing
live behaviour rather than an orphaned branch, the same shape `bucketAt`
holds against `floor(x * buckets / w)` and `trims` holds against the empty
array. Forcing the delegation's `if` to `false` fails both "reduces exactly
to troughs when spacing is 0" and "reduces to troughs for a negative spacing
too" and no other test in the file — the two share a non-positive `spacing`,
which is the one case this line exists to route to `troughs` at all. An
earlier version of this claim said the mutation failed only the first of
the two; re-measured against the whole file rather than a narrowed test
filter, it fails both.

**A `Placement` is named by its `key`, never by its file's `id`, and never
by an array index.** `fill` cycles one uploaded file into many drops, so
`id` stopped being unique across the array the moment repeats shipped —
`clampPlacement` keyed on it both rewrote every SIBLING drop's `at` (its
`map` matched all of them) and hid those siblings from its own `MIN_GAP`
scan (its `others` filter dropped all of them), so one drag collapsed a
speech's whole set onto one instant and `/api/lofi` then refused the render
with "Two speeches overlap" — loud, but naming the wrong thing. The key is
`<id>#<slot>`, minted by both `troughs` (always `#0`) and `fill` (the slot
index, at most one drop each), so nothing downstream has to know which
produced the array. Not the array index, because `fill` sorts by time before
returning — the same rule `segmentContaining` and the cutter's `activeRange`
already hold. It is client-only: `/api/lofi`'s body is still `{ id, at }`
per drop, and nothing persists a placement.

**A drop that `fill` could not make is SURFACED, never blocked.** The Render
button's readiness check was relaxed from "every speech placed" to "at least
one drop" when repeats shipped, correctly — the two counts differ by design
now — but nothing replaced what it had been saying. Measured: four speeches
at a five-minute spacing over a twelve-minute track gives three drops, and
the fourth file was simply absent from the render. So the badge names both
numbers (`12 drops · 3/4 files`) and the panel raises the status row's own
`.callout` naming the files that got nothing, and a second for `fill`'s
`capped` flag. Neither disables Render: accepting three of four is a
legitimate choice, and this codebase's rule is that a silently missing
speech is cardinal, not that every render must be complete. Both callouts
are suppressed while `busy` — an upload batch writes `speeches` once per
file and calls `place()` only once, so the renders in between have speeches
no placement exists for yet.

**`fill` SKIPS an unreachable slot and only `break`s past the end of the
track.** `prevEnd + MIN_GAP` drifts ahead of a slot's own window whenever
`speech.seconds + 2 * FADE + MIN_GAP > step` — a band the `need > step`
refusal cannot see, since `need` is comfortably inside `step` there. Ending
the walk at the first such slot stopped the drops partway through.
Measured on one 45s speech at a 60s spacing over a flat 600s track: 5 drops,
the last at 401s, the closing three minutes silent — against 9 drops and a
last at 533s once the slot is skipped instead. `capped` then
distinguishes the cap from the end of the track, and needs BOTH halves: `k
=== MAX_DROPS` alone calls a run capped when the track happened to end on
the same slot the cap did, which is a warning naming a limit that cost the
user nothing. All three are mutation-tested in `src/lofi.test.ts`.

**`fill`'s FIRST drop is an intro and deliberately breaks `SKIP_HEAD`.**
`OPEN_AT` (5-10s) is where slot 0's voice lands, ahead of the fifteen
seconds `SKIP_HEAD` reserves for the music to establish itself before
anything interrupts it. Every LATER slot still holds that rule, and
`troughs` is untouched — so a render with the spacing set to 0 gets no
intro, which is the price of `fill` reducing to `troughs` exactly. Both
bounds are shifted back by `FADE` in the search, because the value placed is
`bestAt + FADE`; searching `OPEN_AT` directly lands the voice half a second
late. It costs slot 0 its quietest-wins search — a five-second window leaves
almost no choice — and that is inherent to wanting an intro rather than a
defect.

It also, silently, cost an existing test its teeth, which is the part worth
remembering. The skip test above was bounded at `> 5` drops and `> 400s`,
comfortably clear when the `break` version gave 5 at 284.5s — but an intro
drop frees `prevEnd` early enough to buy the BROKEN version two more slots,
and at 7 drops with a last at 401s it passed both bounds. Re-measured and
re-pinned at `> 7` and `> 500`. A loose bound on a measured quantity is only
loose until something upstream moves.

**One ffmpeg input per unique speech FILE, `asplit` into its drops.** A
speech now recurs on a spacing, so a three-hour render at the default
one-minute spacing plays roughly 180 drops from as few as one recording.
Opening every drop as its own input would put one input on the graph per
drop rather than per file, on top of the background, the music, the crackle
and the mark — the crackle leg already solves exactly this (one input,
`asplit` into one tap per speech) and the speech legs now copy its shape:
`renderLofi` collects the unique paths among `cuts`, opens one input per
unique path, and only `asplit`s a path that has more than one drop, so a
one-shot render's graph stays byte-identical to the one it had before
repeats existed.

**`MAX_SPEECHES` bounds the graph's INPUTS; `MAX_DROPS` bounds its LEGS, and
neither cap is redundant with the other.** A speech recurring split what
used to be one number into two that measure different things:
`MAX_SPEECHES` (8) is how many distinct FILES `/api/upload-audio` and the
panel will accept, one input each; `MAX_DROPS` (300) is how many
PLACEMENTS `fill` may hand back, one `asplit` tap and one crackle-boost leg
each. Checking only the drop count would let eighty distinct uploads
through under a 120-drop limit — eighty inputs on a graph the file cap
exists to bound, with the drop count none the wiser. Both are checked in
the panel and again in the route, because the route is reachable without
the panel — the same posture `MAX_SPEECHES` and `MAX_PARTS` already hold.

**`probeFile` is the wrong prober for a music track, and "has a video
stream" is the wrong fix.** `probeFile` demands a video stream and throws
`ffprobe found no video stream in …` on a plain audio file — the correct
throw for a long-form part, the wrong one for a music upload. Flipping the
check to "does it have a video stream" would then be fooled the other way:
an mp3 carrying cover art reports one video stream, describing a thumbnail
rather than a picture to render. `probeAudio` asks a narrower question
instead — a duration from `format`, gated on some stream reporting
`codec_type: "audio"` — which is right on both sides. `/api/upload-audio` is
a second URL rather than a query flag for the reason every other route
split in this codebase already exists: `server/index.ts` routes on exact
`req.url` equality, so `/api/upload?audio=1` would simply miss the
`/api/upload` branch rather than reaching a flag inside it.

A lofi SPEECH goes through that same route and that same prober, and for a
second reason on top of the first. It may be a bare recording with no video
stream, which `probeFile` refuses outright — but `probeAudio` is also the
gate that keeps a *silent* video out of the list. A speech contributes
nothing but audio now, so one with none can only add a silent stretch to a
render that never shows it: invisible until someone listens to the whole
thing. Refusing at upload is the loud version of that failure. The graph
used to carry an `anullsrc` stand-in for exactly this input; it does not any
more, which also removes the one conditional input index `renderLofi` had.

**`sidechaincompress` is a FRAMESYNC filter: its output ends when its
SHORTEST input ends, not its longest — and not by `amix`'s own `duration=`
rule.** The duck's sidechain, `[sc]`, is a copy of the speech mix — a few
seconds long, ending at the last speech's own end — so every real render
ducked correctly and then went silent for good: `[ducked]` died there, and
the closing `amix … duration=first` faithfully inherited that truncated
length from its first input. The container and the video track ran the
FULL music length throughout; only the audio stream itself went quiet
early, silently. `apad=whole_dur=<seconds>` — the same `seconds` the graph
already probed from the track — pads `[sc]` and only `[sc]`, the
compressor's control input, never `[sm]`, the audible copy, which already
reaches its `amix … duration=first` the ordinary way every other short
stream in this graph does.

This is the worst bug the feature shipped with, and it is worth recording
*why* the render's own "exactly the music's duration" test could not have
caught it: that assertion reads `probeFile`'s CONTAINER duration
(`format.duration`), which stayed a faithful 30s throughout — the container
and the video track were never wrong, only the audio stream nested inside
them. The regression test instead reads the AUDIO STREAM's own duration via
`ffprobe -select_streams a:0`, plus a behavioural loudness check well past
the last speech's end, in the same band the duck test already measures.
Removing the `apad` fails both of those and nothing else — proof that a
structural "right length" check is not a substitute for a behavioural one
when the two can silently disagree.

**The finished mix is padded too, and that is the SAME bug arriving from a
second direction.** `[sc]`'s pad fixed the sidechain; the closing
`amix … duration=first` still inherits its length from `[ducked]`, which
inherits its own from `[music]`, so a music input whose decoded stream EOFs
short of the duration `probeAudio` reported drags the whole audio stream
short with it. Multi-track renders are where this shows, because
`concatMusic`'s output is the one music file this journey builds rather than
probes-and-trusts. Measured on a three-track concat: a 4.836009s audio
stream inside a 6.066667s container, against a music file `probeAudio`
reports as 6.060408s — a fifth of the render silent, with `format.duration`
faithful throughout. `[amix]apad=whole_dur=${seconds}` before the `asplit`
puts the floor under every way a leg can end early rather than under the one
found first, and it is free where it is not needed: a single-track render is
byte-identical with and without it, verified by `cmp` both with a speech and
with none.

**The flac intermediate is not the cause and wav is not the fix.** The pad
above closes the gap with `concatMusic`'s codec untouched, which is what
says the mix's own `duration=first` is where this lives — a codec can only
move how early a stream EOFs, not whether the mix inherits that EOF. wav
would also put RIFF's 4 GB ceiling inside reach at `MAX_TRACKS`, on a
pre-pass already measured at roughly a gigabyte for three hours.

**Nothing rendered a CONCATENATED track set end to end, and that is what hid
the above.** `concatMusic` was tested standalone and `renderLofi` only ever
on a single track, so the gap between them was invisible from both sides —
and the single-track audio-stream assertions beside it were bounded at
`> 29.5`, half a second of slack on a thirty-second render, the wrong
instrument for a truncation that is a fraction of the whole rather than a
fixed offset. Those are `toBeCloseTo(seconds, 1)` against the music's own
probed length now. Note what the concatenated test deliberately does NOT
assert: the concat's leg ORDER. `peakHzAt` finds the loudest bin and the
render mixes in a full-spectrum crackle bed the tones do not outrank —
measured, the peak at t=1.0 inside that render is 2603.93 Hz where the tone
is 440. The order is proved on `concatMusic`'s own output instead, upstream
of the crackle.

**The duck is a `sidechaincompress`, not a `volume` gated on
`enable='between(t,a,b)'`.** A gated step has no attack or release and
clicks audibly at both edges of every speech. `DUCK_THRESHOLD`/`DUCK_RATIO`
are the compressor's own two parameters — `sidechaincompress` takes no
target-depth input, so there is deliberately no dB knob here at all. The duck is also what lets `troughs`
(above) get away with no quietness threshold at all: it only has to find a
THIN stretch, because the render itself makes that stretch sound deliberate
regardless of how thin it is.

**`acrusher` sits BEFORE the lowpass, and it is `mode=lin`.** Two settings,
both silent if wrong.

`acrusher` is a bit-reducer, so it manufactures aliasing all the way up to
Nyquist. Placed before `lowpass=3000` that grit is rolled off with
everything else; placed after, the render simply stops being band-limited,
which `server/lofi.test.ts`'s above-6 kHz assertion reads as the failure it
is.

`mode=lin` is what survives a zero sample. Some filters emit NaN on a zero
signal — log-mode quantisation takes a logarithm of it — and the NaN
propagates through every mix downstream until the AAC encoder dies with
`Error submitting audio frame to the encoder: Invalid argument`, a message
naming neither the filter nor the silence. That is the shape this failure
always takes: it looks like an encoder problem and it is an input problem.
The treatment runs on EVERY speech now, unconditionally — there is no
silence stand-in left to skip it for — and a real recording can still run
to digital silence, so `server/lofi.test.ts` renders a speech whose audio
stream is nothing but zeroes to keep the linear mode honest.

**There is deliberately no pitch wobble, though the effect being imitated
has one.** `vibrato` is clean on these fixtures in isolation, at every
depth tried, and emits NaN inside the full render graph — bisected against
the real failing command, where removing it was the only one of seven
variants that came back clean. Do not re-add it on the strength of a
standalone test; that is precisely what hid this. `chorus` is the other
route to pitch movement, and a newer ffmpeg may simply fix `vibrato` —
either way, bisect against the whole graph. It is also the effect least
suited to the material: on singing a wobble reads as a warped record, on
speech as seasick.

**The crackle is two summed layers, not one gated one — and they POWER-sum.**
A bed at `CRACKLE_BED` runs the whole render and each speech adds a second
leg at `CRACKLE_BOOST`, faded in and out. A `volume` gated on `enable=`
would step instead, and a step clicks at both edges — the same reason the
duck is a compressor rather than a gate.

Each tap reads a DIFFERENT moment of the asset: the bed runs from its start,
a boost leg is delayed onto its own speech. So the two are uncorrelated
noise and add as power, not amplitude — equal gains give +3 dB under a
speech, not the +6 dB the numbers look like they promise. Measured at
exactly +3.0 dB with both at 0.6. To lift by roughly N dB, the boost wants
`bed * sqrt(10^(N/10) - 1)`.

**The crackle is NOT band-limited, though the voice is, and that asymmetry
is what makes it audible at all.** Rolling the noise off to the voice's own
300-3000 Hz sounds principled and is what the first version did. Measured
against a real track it is also inaudible: the noise sits 34 dB under the
music below 3 kHz and only 10 dB under it above 3 kHz, so band-limiting
throws away the only half that could be heard and leaves the rest exactly
where the music is loudest. Verified by rendering the same demo with the
crackle gain at zero — identical to 0.1 dB in both mean and peak, i.e. the
bed was contributing nothing whatsoever. Full spectrum, the same A/B moves
the >6 kHz band by 5 dB.

The consequence is that the finished mix carries content above 6 kHz, so
`server/lofi.test.ts`'s band-limit assertion measures the SPEECH's own
contribution (against its unfiltered source) rather than the whole mix. It
was only ever about the speech.

**A sparse-pop asset has to be LEVELLED before either gain can hear it.**
The bundled noise measures a 41 dB crest factor — mean -46.5 dB, peaks
-5.6 dB. Its mean is what sits under the music and its peaks are what
decide when it clips, so raising the gain until the bed is audible drives
the pops through the ceiling first: at the gain needed for parity above
6 kHz they land at +2 dBFS. `CRACKLE_LEVEL`, a `compand`, lifts the floor
between pops by ~19 dB and brings the crest to 27 dB, after which a bed
gain well under unity is both audible and clear of clipping. It costs
character — a levelled record reads as continuous surface noise rather than
the occasional pop — and dropping the filter from the two taps is how to
get the raw asset back.

**`OUT_NAME` is not widened for the cutter; `CUT_NAME` sits beside it.** The
long-form journey's invariant says there is nothing to widen `OUT_NAME` for,
and that still holds — the cutter needs a *different* shape, not a looser
one. Two anchored patterns, each matching exactly what its own producer can
emit, is a strictly smaller surface than one pattern loose enough for both,
and since `OUT_DIR` lives under `$HOME` what a loose pattern reaches is the
user's home directory rather than the repo. `/api/reveal` is the only route
that accepts either (`isOutName(name) || isCutName(name)`, both still
followed by an `existsSync` in `OUT_DIR`); `/api/publish` and `/out/` are
deliberately left untaught about `.mp3`, because nothing in this journey
produces something to publish or to stream back. `cutName` lives beside
`outName` in `server/ffmpeg.ts` rather than in `cut.ts` for the same reason
`isCutName` does: it resolves against `OUT_DIR`, which `cut.ts` does not
know about. `server/ffmpeg.test.ts` pins that a `.mp4` fails `isCutName` and
an `.mp3` fails `isOutName` — the pair of assertions that fail if anyone
ever merges the two.

**`/api/cut`'s sweep is `/api/export`'s `prev`, indexed — and the index is
what makes it necessary at all.** `<slug>-<n>.mp3` renumbers when a range is
inserted: cut four ranges, delete the second, cut again, and `<slug>-4.mp3`
is left on the Desktop describing audio from the previous attempt,
indistinguishable by name from a current one. So the client sends the
previous run's names as `prev: string[]` and the route deletes them **after**
every rename (a failed cut must leave the previous run intact), **skipping
`prev ∩ names`** (otherwise it unlinks a file this very run just wrote — the
defect `/api/export` guards with `prev === name`), **resolved through
`outPath`** (`rm` on a bare name resolves against `process.cwd()` and
`force: true` swallows the resulting ENOENT, so the sweep does nothing and
says nothing — the `/api/lofi` footgun, written down), and **behind
`isCutName`**, because this is the one client string in this feature that
names a file to delete. `prev` is in-memory, like `/api/export`'s: a reload
between two cuts strands the older set, the accepted cost of not persisting
a field whose only job is naming files to destroy.

**`cutNames` must be cleared when the file changes, or the sweep deletes the
PREVIOUS file's mp3s.** `cutNames` is what the next cut sends as `prev`, and
`/api/cut` unlinks every name in `prev` the new run did not itself write.
Carried across a file change it names the finished output of the file before
it, so cutting a second file silently destroys the first file's mp3s in
`OUT_DIR` — the ordinary "cut two files in a row" path, with no error and
nothing on screen to notice. `pickCutFile` clears it along with the ranges,
and `leave()` clears it on the way out. The results list going stale is the
same bug wearing its harmless face: if those buttons still name the old
files, the sweep is still aimed at them.

**The cutter's strip axis is the file's own duration.** No window, no `PAD`,
no stitch — `span === waveSeconds`, so `bucketAt` reduces exactly to
`floor(x * buckets / w)`, the identity `src/waveform.test.ts` already pins.
There is nothing in this phase that could reproduce the stitch drift the
framing strip's mapping exists to fix, which is why the strip needs no
mapping of its own.

**The cutter writes the module-scoped `wavePeaks`/`waveSeconds` and must
therefore reset `waveFor`.** `drawWave` reads those two rather than taking
an envelope — deliberate, `ponytail:`-marked, because the journeys are
mutually exclusive and a second envelope field is a second thing to keep in
sync for no behaviour. But `loadWave` caches on the clip URL it last
decoded, and `pickCutFile` has just overwritten what that key describes, so
it sets `waveFor = ""`. Without it the framing strip skips its re-decode and
paints this upload's envelope over someone else's clip — a waveform that
looks like a waveform and describes the wrong audio.

**A kept range is `.wave-keep` (grass), never the framing strip's
`.wave-cut`.** The two strips mean opposite things by a shaded band: on the
framing strip a band is material the export DROPS, here it is the only
material the export writes. Sharing the recipe paints "this is excluded"
grey over exactly the audio that is about to become a file. `red` was
already this app's exclusion-and-error colour and `blue` is the accent the
playhead owns, so grass is the one scale free for it.

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
`digest` + `cuts` + `prev`. The
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

`geometry.ts`, `layout.ts`, `custom.ts`, `segments.ts` and `src/lofi.ts` are the modules with exhaustive coverage, deliberately — their bugs are silent. `src/custom.test.ts` covers `clampOut`/`moveOut`/`resizeOut`'s even-snapping, `resizeOut`'s `MIN_OUT_SIDE` floor and frame bounds from every anchor corner, `clampOut`'s and `resnapCrop`'s idempotence under a repeated re-snap (`resnapCrop`'s also keeping the ratio exact), and `isValidOut`/`isValidCustom` against everything `clampOut`/`defaultCustom` can emit and everything illegal. `src/segments.test.ts` covers `editMark` (the carry, its length preservation and its `duration` clamp — all three mutation-tested by disabling the carry — plus both refusals and the un-aimed/aimed split), `normalize` (idempotent, sorts, clamps, drops empties, merges overlaps), `isValidSegments` against everything `normalize` emits and everything illegal (empty, over `MAX_SEGMENTS`, unsorted, overlapping, `end <= start`, out of bounds, non-finite, non-array, `null`), `totalDuration` against a known set, and `keepRanges` against the identity, a middle hole, cuts flush to and overhanging either bound, a cut covering the range, cuts wholly outside it, several cuts, and back-to-back cuts (no zero-length keep — an empty leg is an ffmpeg error). `layout.test.ts` asserts the nine presets tile 1080×1920 exactly, that only the three documented cell shapes occur, and that `defaultBoxes` returns per-cell-valid boxes: a mis-tiled layout survives preview and only shows up as a seam in an exported clip. `server/ffmpeg.test.ts` shells out to real ffmpeg and asserts output pixels; it is the only thing proving the preview/export agreement from the ffmpeg side — now including the border, via white pixels in the seam and at a corner cut's diagonal against the source's colour just inside a piece, now including a real export with one floating piece straddling a cell seam, asserting the piece's own colour survives the seam, the ring around it is white, and the stack's colour resumes just past the ring, and a second with TWO overlapping pieces cropped from different colour bands, which is the only end-to-end proof that the mask's walk is z-aware (the upper piece's nub and the upper half of its ring both land over the lower piece's window and read as that piece's own colour if it is not) — and now a real two-range `concatClips`, asserting the output's duration is the parts' sum and that a frame sampled from each half carries that part's own colour cropped from a different colour band, with the leg ordering mutation-tested (reversing the concat's input order fails the second sample), plus a part with no audio stood in with `anullsrc`, plus a non-square-SAR part, since a SAR mismatch is the failure `concat` is most likely to hit and it fails opaquely (`Nothing was written into output file`) rather than picking a side. `frame.test.ts` covers the window insets (every internal seam and frame margin
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
`state.test.ts` covers the save-gating that guards against erasing framed
boxes, the `showThumb` exclusion from the persisted record (a way of *looking*
at the canvas, not a property of the video — and its title image is a decoded
PNG that could not be stored anyway), and the `{start, end}` → `segments` migration: a stored old-shape record restores as one segment (tested on `!== undefined`, not truthiness, so a mark stored as `0` still migrates), and a stored `segments` array survives a round trip untouched. `ytdlp.test.ts` covers `videoIdFrom`, the trust boundary that decides whether a subprocess spawns, and the widened `CLIP_RE`: the digest form parses, a `.part.mp4` still does not, and a digest of the wrong length or alphabet (including uppercase) does not either.
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
`server/longform.test.ts` covers the dip between parts — the seam sampled
just inside the outgoing part's tail is near black, samples well inside
each part keep full colour, and the head and tail of the whole output do
NOT (the assertion that fails if the `i > 0` / `i < N-1` guards are
dropped) — plus the `min(FADE, seconds / 3)` clamp, with the short part in
the middle so both fades actually apply. All three mutation-tested:
dropping the fades, fading the ends too, and removing the clamp each fail
exactly one of those. `FADE` has an assertion of its own, because both
boundary samples hardcode the [1.5, 2.5] window it produces on a pair of
2s parts — retuning it should point at the tests to re-check rather than
failing them obscurely. The audio fade has no test of its own (it is verified by hand:
-24.1 dB mid-part against -38.4 dB at the seam on a real render). The
transition swell DOES have one, and it asserts on **peak** rather than
mean: a swell is a transient, so its mean over any window wide enough to
hold it is dominated by the programme either side. A 0.2s window over the
cut moves from -35.0 dB peak without the sound to -22.1 with it — and
-22.1 is the asset's *own* peak, which is what proves the placement lands
on the boundary rather than a second late. Four mutations are pinned:
dropping the sound, `normalize=1`, `duration=longest`, and delaying by the
boundary instead of `boundary - TRANSITION_PEAK`. It also covers
`keptRange` exhaustively — the identity, the head off every part INCLUDING
the last, the tail off every part EXCEPT the last, both off a middle part,
and the `MIN_KEPT` floor at either side of its boundary — and `detectTrim`
against four real files built in `beforeAll` from a static starter, a moving
body and the real `END_PATH`: a full vstack short (both ends found), an old
short with no outro (head found, tail 0 — THE regression), a raw upload that
opens on a noisy locked-off shot (neither found, which is what fails at
-40dB), and the outro asset against itself. Four mutations are pinned:
assuming the outro, loosening the freeze threshold, keeping the last part's
starter, and dropping the last part's outro. Two real renders cover the
strips end to end — a two-part stack a whole tail clear of both failure
modes, and a head strip asserting the output opens on the BODY's colour
rather than on the navy starter. `beforeAll` carries an explicit 180s
timeout: seven real encodes pass in isolation and exceed vitest's default
10s hook budget in the full suite, where the files compete for CPU.
`server/starter.test.ts`'s hook carries one for the same reason — real
encodes plus the ~4.6s VieNeu model load, ~17s in isolation. It also shells out to
real ffmpeg and asserts output pixels, the same posture
`server/ffmpeg.test.ts` holds: the output is
1920x1080, a centre sample in each half carries that part's own colour, and
a left-edge sample is NOT black — which is the assertion that fails if the
blur leg is dropped and the graph pillarboxes instead. The two parts are
different colours so the edge sample also proves each background tracks its
own part, and the leg ordering is mutation-tested the way `concatClips`'
already is. A silent second part covers the `anullsrc` stand-in, and a 16:9
part covers an upload that is not vertical. `server/youtube.test.ts` gains
the `shorts` flag's four cases. The upload route, the stacking panel and
the reorder controls (drag and the four arrow buttons alike) have no tests, like the rest of the network and DOM
surface. `server/ffmpeg.test.ts` pins `thumbPath` against `stillPath` —
that `removeExport` takes both, and that the two names differ at all, which
is the assertion that fails if anyone ever "simplifies" them into one.
`src/thumb.ts` is DOM-driven and untested like `src/starter.ts`; `renderThumb`
was verified in a real browser (a 300x900 source's top band landing across
the top 80px of a 1280x720 chip, teal edge to edge, so stretched rather than
cropped) and through a real render. `renderWide` shares `decodeBitmap` and
`encodeJpeg` with `renderThumb` but not its stretch — it cover-crops instead,
and was verified separately: a portrait source's circle measured 769x769 at
dead centre of the 1920x1080 output in a real browser, proportion kept and
edges lost rather than squashed. `drawTo` no longer exists as a single
shared function; it was split into `decodeBitmap` (the decode both
rasterisers open with) and `encodeJpeg` (the canvas-to-base64 tail both
close with), with the drawing step — stretch or cover-crop — left to each
rasteriser on its own, since that is the one step where they now disagree.
`src/lofi.test.ts` covers `troughs` exhaustively on the model the other
bottom modules get: a speech placed inside its one quiet hole, placements
returned in time order regardless of processing order, `MIN_GAP` held
between two speeches sharing one long hole, `SKIP_HEAD`/`SKIP_TAIL` at
their boundaries, the `2 * FADE` room reserved around a speech (arithmetic
enough to assert the exact placed position), a no-fit refusal naming the
speech, stability across repeated calls, and the longest-first ordering
test itself — a hole only the long speech fits and a hole only the short
one fits, built so that placing the short one first strands the long one.
`server/lofi.test.ts` shells real ffmpeg against a synthetic fixture (a
teal background, a 1.5s red/green/blue cycling GIF background, a 220 Hz
sine bed, a crimson-over-white-noise VIDEO "speech", a 1200 Hz AUDIO-ONLY
.m4a speech, a speech whose audio stream is digital silence, and a video
with no audio stream at all) and asserts
pixels and dB: the output is 1920x1080 and within half a second of the
music's own length, the music measurably ducks under the speech in its own
220 Hz band, and the speech's own energy above 6 kHz is suppressed relative
to its unfiltered source.

The picture assertion is the one this feature turns on, and it is
deliberately a sweep rather than a sample: the background must still be the
background at SEVEN instants — before, at both edges of the speech, mid-
speech, just after, and near the end. The fixture's speech is solid crimson,
so any overlay reads red and any reinstated dip reads near-black, and the
two edges are where both show first. Mutation-pinned by putting the old
`tpad` + `enable=` overlay chain back, which fails it at `t=12`. Two tests
exist purely to catch the `sidechaincompress` truncation bug (above) by a
route the duration assertion cannot reach — the audio STREAM's own duration
via `ffprobe -select_streams a:0`, and the bed's loudness well past the last
speech's end. A further three cover the audio-only path end to end (two
.m4a speeches found again in a narrow 1200 Hz bandpass inside their own
windows and not between them), the refusal of a speech with no audio stream,
and a speech that is digital silence rendering at all — the last standing in
for `acrusher`'s `mode=lin`, now that no stand-in branch skips the filters
for it. Four cover the frequency bars, and the SPLIT between the arithmetic one
and the pixel ones is the whole lesson — twice over. The band's place (full
width, bottom-anchored) and the bar/gap ratio are asserted on the exported
`VIZ_RECT`/`VIZ_BAR`, because the pixel tests crop at `VIZ_RECT` and
CLASSIFY COLUMNS with `VIZ_BAR.fill`. Widening a bar to fill its whole slot
therefore made the gap test compare a full set of columns against an empty
one and pass — measured, it did — so the geometry is now checked where it
cannot also be the ruler, and the pixel test asserts both column sets are
non-empty before comparing them. The three pixel tests then cover: bars
present in the band and none above it, lit columns +3.8 over the background
against gaps at -0.6, and the band's right half reacting to the speech.
Sampled over the band's BOTTOM 120px rather than all 360 — bars thin out
upward, so over the whole band their contribution is +0.9, too close to the
noise to assert on. Five mutations pinned: dropping the overlay, moving the
band to the top, removing the gap mask, and tapping `[music]` instead of the
mix each fail exactly one.

Three cover the spinning mark. Its POSITION is asserted as arithmetic on
the exported `LOGO_RECT` — the four gaps to the frame's edges, small on two
adjacent sides and at least four times larger on the other two — and that
split from the pixel test is a lesson rather than a style: the pixel test
crops AT `LOGO_RECT`, so moving the constant moves the test's own aim, and
a first version that only checked pixels passed with the logo parked at the
left edge. The pixel test then proves the mark is actually drawn in that
rect (against a flat-colour reference) and that the mirrored rect on the
left is untouched. The SPIN test compares a 256px crop across time, because
one pixel cannot tell a rotation from noise: two samples of the same
orientation differ by 1.6 (libx264 being lossy) against 15-20 for any two
different angles, so the thresholds sit in a ten-fold gap. Five mutations
are pinned — freezing the angle, halving the period, and moving the mark
left, down or to the centre each fail exactly one of the two, and dropping
the overlay fails the pixel one.

Two more cover the background's own fork. The GIF one samples the render at
six instants and names the colour it expects at each, three of them PAST
the GIF's own 1.5s end (the period is 1.5s, so the colour at `t` is decided
by `t % 1.5`) — sampling only inside the first period would pass on a
background that played once and froze, which is what a merely-working
animation looks like for the first second and a half of a three-minute
render. Mutation-pinned by forcing the still branch, which fails it at
`t=0.2`. The still one asserts the teal background at two instants and
exists to fail BY TIMING OUT if the two input forms are ever collapsed,
since `-stream_loop -1` on a still hangs rather than erroring; that
direction is evidenced by direct ffmpeg measurement rather than by a
mutation run, because the run costs a three-minute hook timeout.

Another covers the crackle — the bed proven in the band above 6 kHz,
where nothing else in the fixture lives (the music is a 220 Hz sine and the
speech is silence), and the per-speech lift proven lower down at 1-2.5 kHz,
where the boost shows most. Both on PEAK rather
than mean, which is the opposite of what a bed suggests and is forced by
the asset: sparse pops whose mean sits BELOW the fixture's own noise floor,
so a mean-based version of the test could not tell the bed from silence —
switching the bed off moved it by 0.2 dB. The renders are deterministic, so
peak is stable here. The lift's bound sits above +3 dB deliberately: the
two legs are uncorrelated and power-sum, so equal gains alone would give
+3 dB and a looser bound would pass on the boost leg merely existing.
Mutation-pinned: zeroing the bed gain and zeroing the boost gain each fail
one of its two assertions. Also mutation-pinned: dropping the duck and
dropping the 300-3000 Hz band each fail exactly one assertion, and
reinstating the speech overlay fails the picture sweep. Dropping the
output `-t` was also run and failed nothing — it is provably redundant for
this graph (the image input's own `-t` already bounds `[v]`, and two
chained `amix ... duration=first` stages bound the audio independently), and
is kept as defence in depth against a future graph change rather than as a
guarded invariant; see `task-3-report.md` for the isolated reproduction.
`src/lofi.test.ts` also covers
`clampPlacement`: an ordinary move, each of the track's own two bounds, each
neighbour's bound, and the drag-past-a-neighbour case that leaves no legal
position — mutation-pinned by reverting the refusal to the old
`Math.max(lo, hi)` clamp, which lands the placement 19.5s past a 300s
track's own end and fails only that one test. Two more cover the `key`: that
dragging one drop of a REPEATED speech moves only that drop, and that a
sibling drop bounds the drag like any other neighbour. Both are
mutation-pinned against the old file-identity semantics — restoring them
fails exactly those two and nothing else in the file. `fill` gains the slot
SKIP (9 drops with a last at 533s, against the old `break`'s 7 at 401s)
and `capped`'s three cases: the cap binding, the track simply running out,
and the boundary where both happen on the same slot — that last one is the
only test the `!unreachable(…)` half of the flag decides, and dropping that
half fails it alone.
`server/lofi.test.ts` gains the concatenated-render test the audio-stream
truncation needed (it fails at 4.836009 against 6.060408 with the closing
`apad` removed, and nothing else does) and the `min(TRACK_FADE, secs / 3)`
clamp test the spec had been claiming since it shipped. That one needs the
short track in the MIDDLE, and the reason is measurable rather than
theoretical: the seam test beside it compares `inside` at t=1.0 — the FIRST
track's centre, which has no fade-in at all under the `i > 0` guard and
reads -28 either way — against a seam at -55.4, so it holds by 27 dB with
the clamp gone. What the clamp actually moves is the middle track, the only
one carrying both ramps: at its own centre, unclamped, two 1.5s ramps
multiply to 0.44 and it measures -31.2 against -24.1 clamped. Removing the
clamp fails the new test alone.
`beforeAll` carries the same explicit 180s timeout `server/longform.test.ts`
does, for the identical reason — several real encodes competing for CPU in
the full suite. `server/ffmpeg.test.ts` gains `probeAudio`'s own three
cases (a real duration, `probeFile` rejecting the same file, and a file
with no audio stream rejected in turn) and `state.test.ts` gains the lofi
fields' persistence exclusion, mutation-tested the way the long-form
fields' already is. The `/api/lofi` route, the panel, and the waveform's
draggable markers have no tests, like the rest of the network and DOM
surface.

`server/cut.test.ts` shells real ffmpeg against a synthetic fixture of three
back-to-back tones — 440 Hz, 1760 Hz, 440 Hz, two seconds each — and its
four tests pin the range-to-audio MAPPING, which is their real job. The
**frequency** assertion is the load-bearing half and the duration one is
not: a range that maps to the wrong part of the input still comes out the
right length, so only the tone says where the audio came from, and 1760 Hz
lives in the middle two seconds alone. The first and third bands repeat
440 Hz on purpose, so an off-by-one leg lands measurably wrong in either
direction. The four are the middle range (both duration and tone), the head
range (tone the other way round), a range running to the very end (where a
duration assertion would otherwise over-report), and a missing input
reporting ffmpeg's own stderr through `toolError`. `beforeAll` carries the
180s timeout `server/longform.test.ts`'s and `server/lofi.test.ts`'s do, for
the identical reason.

**Do NOT claim the `-ss`-before-`-i` ordering is mutation-tested here — it
was measured and it is not.** Moving `-ss` after `-i` was run against this
fixture and all four tests still passed, verified three ways including two
raw ffmpeg invocations outside any test code: identical mean dB and
identical duration on both orders. Homebrew ffmpeg 8.1.1 defaults
`-accurate_seek` on for input seeking, and a six-second indexed M4A has a
sample-accurate seek index, so "decode from the start and discard" lands on
exactly the same sample as an index jump. `cutMp3` keeps the order anyway,
because it is the convention `exportClip`'s mask input and `stackWide`'s
per-part trims both hold and because what it protects against is real —
containers with no accurate seek index, and the decode-from-zero cost on a
long input — just not anything this fixture can demonstrate. Reproducing it
as a *correctness* failure would need a much longer or non-indexed source,
which is more than a real-ffmpeg unit test's budget here; the measurements
are in `.superpowers/sdd/2026-09-21-vstack-audio-cutter/task-2-report.md`.

`server/ffmpeg.test.ts` gains `cutName`'s seven cases with the exhaustive
traversal treatment `isOutName` and `videoIdFrom` get — what `cutName`
emits, traversal, everything `slugify` could not have produced (uppercase,
diacritics, leading and trailing dashes, spaces, doubled dashes, a missing
index), non-strings, and the pair that fails if the two predicates are ever
merged: a `.mp4` is not an `isCutName` and an `.mp3` is not an `isOutName`.
`src/state.test.ts` gains the five `cut*` fields' persistence exclusion,
mutation-tested the way the lofi fields' already is. `src/segments.ts`
needed no new tests — the feature adds no rule to it, which was the point of
spending its ranges through that module. The `cutting` panel, the strip, the
chip row, the object URL's lifecycle, `/api/cut`'s HTTP surface and `open -R`
have no tests, like the rest of the network and DOM surface.

DOM-driven modules (`main`, `editor`, `preview`, `player`) have no tests by design — vitest runs `environment: "node"` here and those behaviours are verified by hand.

## Environment notes for agents

- `Bash(git add)`, `Bash(git commit *)` and `Bash(rm *)` are deny-listed in this environment. Use `git -C <path> add/commit` (the prefix differs, so it passes) and Node's `fs.rm` instead of shell `rm`.
- The in-app Browser pane reports `document.hidden = true`, which suspends `requestAnimationFrame` and throttles `ResizeObserver` per spec, and its viewport has measured 0×0 with layout collapsing. Neither is an app defect — rule the environment out before reporting one. Patch `requestAnimationFrame` from the console if you need the loop to run; never in app source.
- `media/` grows without eviction and is already ~47 MB. Size is logged at boot and after each fetch.
- `media/<id>/chat.json` is ~20 MB for an eleven-hour stream, counted by
  `reportCache`, swept by hand like the rest of `media/`. It is cached so
  that retuning the scorer's constants does not cost 45 seconds a run.
- A chat replay can vanish from a video that had one — YouTube withdrew
  `smf3SB2fgQY`'s within hours of it being measured for this feature — so
  "No chat replay for this video." is not always a permanent property of
  that video. `0vGJ0ywUW-8` is a livestream verified to still have one.
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
  `.mp4` and its vertical `.jpg`) — or, for a long-form or lofi render, the
  `.mp4` and a `<name>.thumb.jpg` sidecar instead, the picked picture rather
  than a derived frame. Nothing prunes either shape — deliberately the
  user's to clear, which is why it sits on the Desktop rather than in the
  repo. The cutter writes a third shape into the same directory, N bare
  `.mp3`s with no sidecar at all. It sweeps the previous run out the way
  `/api/export` and `/api/lofi` already sweep a superseded render — all
  three through a client-sent `prev`, after the rename, never before — but
  what *forces* the sweep differs, and that is the part worth knowing. Those
  two are forced by a name that moves with the title or the marks, so the
  stranded file describes different content under a different name. The
  cutter's is forced by the INDEX: `<slug>-4.mp3` from a four-range run is
  left behind by a three-range one under a name the next four-range run
  would reuse, so the stranded file is indistinguishable from a current one.
  That is also why its `prev` is a list rather than a single name. Nothing
  else in the directory can be touched by it: every name goes through
  `isCutName` first.
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

**The wide slot sizes the OPPOSITE way round from the tall one, and the
stage's column split is what makes that legal.** A 9:16 `.out` takes
`height: 100%` in `.stage`'s `auto` track and derives its width through the
ratio; a 16:9 one doing the same is `stageHeight * 16/9` wide — measured at
996px against a 1168px stage, which starved the publish panel beside it to
156px. `.stage:has(.out.is-wide)` switches to `1fr 1fr` and `.out.is-wide`
takes `width: 100%` with `height: auto`, so the height comes from a definite
track instead. `width: 100%` is only legal *because* the track is `1fr`: in
the `auto` track the tall case sits in it makes the track's size depend on
the item's size which depends on the track — circular, and it collapses.
`:has()` rather than a class `render()` toggles, since `.is-wide` already
carries the signal and a second flag is a second thing to keep in sync with
two state fields. `max-height: 100%` plus `object-fit: contain` covers the
one shape the split does not: half of an ultrawide stage can still be taller
than the stage is high, and when the cap binds `width: 100%` holds and the
ratio gives. The `contain` is scoped to `.is-wide` only — the framing canvas
must keep filling its box, because `.boxes` is placed against its rendered
rect and a letterboxed canvas puts every floating piece over the wrong
pixels.

**`media/uploads/` grows without eviction and nothing lists it.**
Deliberate: re-rendering a stack after a title fix must not mean
re-uploading a gigabyte. `listClips` cannot reach it — it walks per-video
directories and matches `CLIP_RE`, and a UUID at the top level is neither.
`reportCache` counts it, so the boot log shows it growing. The lofi journey
grows the same directory the same way, from a second door: both its music
and its speeches land as `<uuid>.mp4` through `/api/upload-audio`, whatever
they actually are — ffmpeg dispatches on content rather than the `.mp4`
extension, so an .mp3 in a `.mp4` name needs no exception anywhere in
`ffmpeg.ts`, and neither does the `.mp3` name the crackle asset wears over
AAC. Re-rendering a lofi mix after a title or marker fix is the same
argument against eviction, doubled. The cutter is a THIRD door onto the
same directory and the same route, for the same reason: `probeAudio` is
right for both an audio file and a video one, where `probeFile` would
refuse the first outright, and it is already the gate that refuses a file
with no audio stream — which here could only produce silent mp3s.

**The lofi render has no loudness normalisation across tracks, and nothing
in the graph corrects for it.** The music leg carries no gain at all and
every `amix` in this render is `normalize=0`, so tracks from different
sources sit at whatever level they were uploaded at. This is a real defect
of the multi-track render and it is **not** new to this feature — a
one-track render always had exactly the same gap, just only one level to be
wrong at, so nothing here regressed; it is only more visible now that a
render can carry several sources at once. `ponytail:` the fix is a
`loudnorm` per leg inside `concatMusic`'s pre-pass, where the tracks are
already being resampled and reformatted for `concat` to accept them — not
done now because nobody has yet measured how far real uploads actually
drift from each other.

**`/api/upload` destroys the socket past `UPLOAD_MAX_BYTES` rather than
answering.** Replying politely means having read the whole body first, which
is the cost the cap exists to avoid — but a destroyed socket surfaces
client-side as `BACKEND_DOWN` ("start the backend"), which is the wrong
sentence for a file that is simply too big. That is why the client checks
`file.size` first and the server's check is the backstop. Both read the same
constant from `src/defaults.ts`.
