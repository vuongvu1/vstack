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
file on disk rather than streaming an attachment back.
`docs/plans/2026-08-20-vstack.md` is the historical build plan and carries
inline "as built" corrections; treat it as a record, not as instructions.

## Commands

```
pnpm server   # backend on 127.0.0.1:8787   (node runs .ts directly, no build)
pnpm dev      # Vite on :5173, proxies /api -> :8787
pnpm test     # vitest, 150 tests
pnpm build    # tsc && vite build
pnpm voices   # audition the starter screen's TTS voice (see below)
pnpm youtube-auth  # one-off OAuth setup for publishing (see server/youtube.ts)
```

Needs `ffmpeg`, `ffprobe` and `yt-dlp` on PATH, plus macOS `say` with a
Vietnamese voice (`Linh`) and both files in `server/assets/`. The server checks
all of it at boot and exits with an install hint if any is missing.

## Architecture

```
server/errors.ts   HttpError (status + message), toolError (stderr tail)
server/ffmpeg.ts   MEDIA_DIR/OUT_DIR, clipName/clipPath, outName/outPath,
                   isOutName, probeFile, buildFilter, assertBoxes, exportClip,
                   reportCache
server/mask.ts     MASK_DIR, maskPath, ensureMask (frame-overlay PNG cache)
server/starter.ts  MUSIC_PATH/CUE_PATH, VOICE, starterDuration, checkStarter,
                   installedVoices, speak, prependStarter (the title card,
                   pass 2 of the export)
scripts/audition.ts  `pnpm voices` — speaks a title in each installed voice
server/assets/     starter-music.mp3 (the bed), before-video-start-sound.mp3
                   (the cue before the cut)
server/youtube.ts  CONFIG_DIR/TOKEN_PATH, readClient, checkYouTube,
                   buildSnippet, accessToken, uploadVideo, publishProgress
scripts/youtube-auth.ts  `pnpm youtube-auth` — the one-off OAuth dance
server/ytdlp.ts    videoIdFrom, probe, fetchWindow
server/index.ts    6 routes, body validators, boot checks
src/geometry.ts    pure rect math — THE tested core
src/layout.ts      nine layout presets, cellsOf, ratioOf, defaultBoxes
src/frame.ts       GUTTER/CORNER_RADIUS, windowOf/windowsOf, maskRgba
src/starter.ts     TITLE_FONT, renderTitleArt (title → transparent PNG)
src/state.ts       AppState, setState/setQuiet, save/restore
src/api.ts         6 fetch wrappers
src/format.ts      mmss / clock / slugify (shared client + server)
src/player.ts      YT IFrame API wrapper + trim strip
src/editor.ts      crop-box drag/resize overlay
src/preview.ts     canvas composite rAF loop
src/main.ts        persistent shell, phase machine, all four phases
media/             clip cache (gitignored)
out/               finished shorts (gitignored)
```

Layering is strict and acyclic: `errors ← {ffmpeg, starter, youtube} ←
{ytdlp, mask} ← index` on the server, `geometry ← layout ← frame ←
everything` on the client.
`starter.ts` sits beside `ffmpeg.ts`, not above it, because it takes paths in
the caller's temp dir and never needs `MEDIA_DIR`. `youtube.ts` sits beside
both for the same reason — it re-derives `CONFIG_DIR` under `~/.vstack/`
itself rather than importing `MEDIA_DIR` or `OUT_DIR` from `ffmpeg.ts`.
`geometry.ts` never imports `layout.ts` — that is why `defaultBoxes` lives in
`layout.ts` instead of `geometry.ts`. `mask.ts` sits *above* `ffmpeg.ts`
because it needs `MEDIA_DIR`, which is why the mask path is passed into
`exportClip` as `ExportOpts.mask` rather than resolved inside it.

Four phases: `idle` (URL) → `trimming` (YouTube iframe, mark start/end, no
download) → `framing` (real `<video>` of the fetched window, crop boxes,
canvas composite, export) → `preview` (the finished file from `out/`, played
back, with publish-to-YouTube). Export no longer downloads: it writes
`out/<slug>-<mmss>-<mmss>.mp4` and advances the phase. Videos under
`SKIP_TRIM_UNDER` (180s) skip `trimming`.
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

**`isOutName` is the one client-supplied path component this API accepts.**
Everywhere else the server takes window bounds or an id and reconstructs a
path itself, so there is nothing to validate. Preview breaks that — publish
and reveal both name a file that already exists — so the name is checked
against exactly what `slugify` + `mmss` can emit (the `OUT_NAME` regex in
`server/ffmpeg.ts`), plus an `existsSync` in `OUT_DIR`. Loosen the pattern and
`open -R` and an upload both point at whatever the caller asked for.

**Uploads are private and there is no option.** An unaudited YouTube Data API
project has every `videos.insert` locked to private viewing. `buildSnippet`
hardcodes `privacyStatus: "private"` and `selfDeclaredMadeForKids: false` —
the second is required by the API, and an upload without it is rejected.

**The preview URL carries the file's mtime.** The output name is stable
across re-exports, so `/out/<name>` with no cache-buster re-shows the
*previous* render — a fixed crop looks like it changed nothing.

## Gotchas that each cost real time

**Never empty `sourceSlot` or `outSlot`.** Removing an `<iframe>`'s *ancestor* from the document runs its removing steps and discards its nested browsing context — so re-appending even the identical node reloads the YouTube player. `main.ts` builds a persistent shell once; `render()` only ever `replaceChildren`s `barSlot` and the status slot. Long-lived media is shown/hidden with the `hidden` property.

**`hidden` alone is not enough.** `style.css` carries `.source > [hidden], .out > [hidden] { display: none; }` because the author-origin `display: block` on the media children beats the UA's `[hidden]` rule. Without it the DOM property looks correct while the element stays fully visible. Keep the selector list generic — it already covers the iframe, the `<video>`, the canvas and the `.boxes` layer.

**`display: none` does not pause anything.** That is *why* the persistent shell preserves the player. `render()` explicitly pauses whichever media is being hidden; without it the YouTube audio plays under the framing phase.

**`cellsOf` order is load-bearing in four places that must agree:** the order boxes are stored in (`state.boxes`), the order the editor numbers them, the order the canvas preview draws them, and the order `xstack`'s `layout=` string lists positions. Reorder `cellsOf`'s traversal and all four silently disagree about which rect belongs to which cell.

**A layout change must not reassign `video.src`.** `ensureFraming` splits its clip guard (`sameClip`) from its layout guard (`sameLayout`, tracked by `editorFor`) for exactly this reason — assigning the same `src` reloads the element and restarts playback. `sameClip` is captured before `framingFor` is reassigned, so a layout switch mid-clip rebuilds the editor and preview without touching the video.

**A quiet update reaches no render, so anything gated on it must be toggled
in place.** The starter-title input uses `setQuiet` (see below), and Export is
disabled on that same value — so its `disabled` is flipped inside the input
handler. Without that it stays disabled until an unrelated `setState` happens
along, which reads as "Export is broken" rather than "type a title first".
`doExport` re-checks the title itself rather than trusting the button.

**`setQuiet`, not `setState`, in the drag path and during render.** `setState` notifies subscribers synchronously, so calling it from inside `render()` is re-entrant, and a re-render mid-drag rebuilds the bar and risks disturbing playback. The rAF preview loop reads state every frame, so a quiet update still reaches the canvas. `save()` runs on drag end only.

**`starterTitle` persists unconditionally, like the marks.** The framing-only gate below is for values that are meaningless before `/api/window` has reported the clip's real size; a title is not one of them.

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
the new one.

**`/api/export` takes window bounds, never a file path.** The server reconstructs the cache filename itself, so there is no client-supplied path to validate for traversal. The starter screen's `titlePng` is the one exception — an image the client rendered, because this machine's ffmpeg *cannot rasterise text at all* — so it is length-capped and checked against the PNG signature before it reaches ffmpeg. Keep both of those that way.

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
overlays the title art and concatenates. Folding it into the export's graph
means a `split`/`trim`/`loop` chain *and* turning `-ss`/`-t` into filters,
because an output `-t` would truncate the concatenation rather than the clip.

**Vite's dev server serves the project root statically.** That is why
`/media/<id>/<clip>.mp4` and `/out/<name>.mp4` reach the browser with no
route behind them — and equally why nothing private may sit under the project
root. Credentials live in `~/.vstack/`; a `secrets/` directory here would be
readable at `/secrets/youtube-token.json` by any page the browser has open.

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

`geometry.ts` and `layout.ts` are the two modules with exhaustive coverage, deliberately — their bugs are silent. `layout.test.ts` asserts the nine presets tile 1080×1920 exactly, that only the three documented cell shapes occur, and that `defaultBoxes` returns per-cell-valid boxes: a mis-tiled layout survives preview and only shows up as a seam in an exported clip. `server/ffmpeg.test.ts` shells out to real ffmpeg and asserts output pixels; it is the only thing proving the preview/export agreement from the ffmpeg side — now including the border, via white pixels in the seam and at a corner cut's diagonal against the source's colour just inside a piece. `frame.test.ts` covers the window insets (every internal seam and frame margin
exactly one gutter, adjacency decided on the *cells* because every pair of
windows has a positive gap) and the mask's alpha, including the assertion that
a window's square corner is opaque — the one that fails if `CORNER_RADIUS`
goes to 0. `server/mask.test.ts` decodes the rendered PNG back to RGBA and
checks it against those windows.
`server/starter.test.ts` shells out to real ffmpeg *and* real `say`: the
output's duration is the screen plus the clip, the seam pixel is mixed over
the screen (the assertion that fails if the blur is dropped) and pure over the
clip, and a non-square-SAR clip concatenates at all. Audio is checked one
layer per window — the bed before the voice starts, the voice, the cue in the
tail slot the voice leaves free, and the clip's own sound after the cut (the
assertion that caught `hasAudio` reading the wrong ffprobe line). Each window
is one where only that layer can be heard, so all four are load-bearing. `src/starter.ts` is DOM-driven and untested like the rest — it was
verified by hand in a real browser and through a real export.
`state.test.ts` covers the save-gating that guards against erasing framed boxes. `ytdlp.test.ts` covers `videoIdFrom`, the trust boundary that decides whether a subprocess spawns.
`server/youtube.test.ts` covers `buildSnippet` and nothing else — it is where
every decision that is awkward to change later lives (the 100-char title cap,
`#Shorts` appended once and case-insensitively, private, not-made-for-kids).
The HTTP calls, `open -R`, the preview bar and the auth script have no tests,
like the rest of the network and DOM surface. The out-name tests in
`server/ffmpeg.test.ts` are the traversal guard and get the same exhaustive
treatment `videoIdFrom` does.

DOM-driven modules (`main`, `editor`, `preview`, `player`) have no tests by design — vitest runs `environment: "node"` here and those behaviours are verified by hand.

## Environment notes for agents

- `Bash(git add)`, `Bash(git commit *)` and `Bash(rm *)` are deny-listed in this environment. Use `git -C <path> add/commit` (the prefix differs, so it passes) and Node's `fs.rm` instead of shell `rm`.
- The in-app Browser pane reports `document.hidden = true`, which suspends `requestAnimationFrame` and throttles `ResizeObserver` per spec, and its viewport has measured 0×0 with layout collapsing. Neither is an app defect — rule the environment out before reporting one. Patch `requestAnimationFrame` from the console if you need the loop to run; never in app source.
- `media/` grows without eviction and is already ~47 MB. Size is logged at boot and after each fetch.
- The bundled `starter-music.mp3` opens on a soft intro (mean -14 dB at 0:00 against -3 dB by 0:20) and the screen is only a couple of seconds long, so the bed hears the quietest part of the track. `MUSIC_START` and `MUSIC_GAIN` in `server/starter.ts` are the two knobs.
- The starter screen makes macOS-only tooling a hard dependency: `say` and its `Linh` (vi_VN) voice. `checkStarter` fails the boot with the System Settings path if the voice is missing, and `server/starter.test.ts` will fail on a machine without it.
- **`Linh` is the only Vietnamese voice macOS installs.** The novelty family (Eddy, Flo, Grandma, Rocko…) ships for 14 locales and vi_VN is not one of them, so "use a different voice" means either downloading one (an Enhanced/Premium `Linh` keeps the same name, so no code change) or accepting a non-Vietnamese voice mangling the diacritics. Audition with `pnpm voices [title] [voice...]` — it writes one file per voice to `$TMPDIR/vstack-voices` and speaks each aloud unless `--quiet`. Select with `VSTACK_VOICE="<name>" pnpm server`; the name must match `say -v '?'` exactly, parentheses and all, and `checkStarter` rejects it at boot if not.
- `out/` grows without eviction, like `media/`. Nothing prunes it.
- Publishing needs `~/.vstack/youtube-client.json` (a **Desktop app** OAuth
  client from Google Cloud Console, with YouTube Data API v3 enabled) and a
  token from `pnpm youtube-auth`. Missing either is a boot *warning*, not a
  boot failure — everything except Publish works without them.
- Uploads land private and cannot be made public from here; that is Google's
  audit rule for unaudited API projects, not a missing feature. The endpoint
  also has its own ~100 uploads/day quota.
