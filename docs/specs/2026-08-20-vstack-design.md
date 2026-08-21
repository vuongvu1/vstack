# vstack — design

> **Superseded in part.** The two-box top/bottom model described below was
> replaced by nine layout presets composing 2–4 regions. See
> `docs/specs/2026-08-21-vstack-layouts-design.md`. The three phases,
> `/api/probe`, `/api/window` and the caching scheme below are still
> accurate. `/api/export`'s body is not: `boxTop`/`boxBottom` became
> `layoutId`/`boxes` (reflected in the Routes table below) — the new spec is
> the authority on their current shape.
>
> Four more spots below are two-box-era and equally superseded by that same
> doc — each is flagged in place so landing on it directly doesn't read as
> current: the persisted `State {…}` shape under Phase machine (`boxTop`/
> `boxBottom` are gone; it's `layoutId`/`boxes` now), the entire
> `## geometry.ts` section (`HALF`, `BOX_RATIO` and `MIN_BOX_H` no longer
> exist, `defaultBoxes` no longer returns `{top, bottom}`, and `maxBox`/
> `boxFromHeight`/`resizeFromCorner`/`isValidBox` all gained a `ratio`
> parameter), the `## Export` filter graph (`vstack=inputs=2` is now an
> `xstack` over 2–4 legs), and the "Any split other than 9:8 + 9:8" line
> under Out of scope.

Turn a region pair from a YouTube video into a 1080×1920 vertical short.

Two 9:8 crop boxes are placed on the source frame; the output stacks them
vertically. 9:8 + 9:8 = 9:16, so each box fills one 1080×960 half.

Local single-user tool. Not deployed.

## Use cases

1. **Facecam + content.** Top box grabs a small talking-head corner and blows
   it up; bottom box grabs gameplay or a screen share. The two boxes sit at
   very different zoom levels.
2. **Two speakers from one wide shot.** A side-by-side interview in a 16:9
   frame; each box takes one person.

Both are served by the same editor. (1) is why box sizing must be
independent — a linked-size design cannot express it.

## Constraint that shapes everything

A YouTube URL cannot feed a browser-only pipeline. The iframe player is
cross-origin: it plays, but not a single pixel can be read into canvas or
WebCodecs. Producing an output video therefore requires a server that fetches
the real bytes.

Second constraint: sources can be hours long. A 3h 1080p stream is 4–8 GB.
Downloading it before the user can scrub is unusable.

Both are resolved by splitting the session into two phases and only ever
materialising pixels for the seconds that matter.

## Two-phase flow

**Phase 1 — browse & trim.** Left side is the real YouTube iframe player.
Zero download, instant, handles a 3h stream, and YouTube's own scrub bar and
chapter markers come free. Start/End read `player.getCurrentTime()`. Trimming
needs no pixels, so the iframe's opacity is not a problem here.

**Phase 2 — frame & export.** The backend fetches only
`[start − pad, end + pad]` via `yt-dlp --download-sections` (YouTube serves
DASH fragments over HTTP range, so a 60s slice of a 3h stream is ~10–20 MB and
a few seconds). The left side swaps the iframe for a real `<video>` of that
local clip. Boxes are framed against real pixels, the canvas preview runs, and
export reads the same file.

`pad = 5s`. It has two jobs: it absorbs keyframe-sloppy stream-copy edges, and
it lets the final export seek frame-accurately (see Export).

Trim nudges after framing stay local while inside the pad. Outside it, a
"re-fetch window" button pulls a new slice and preserves the boxes.

**Videos under `SKIP_TRIM_UNDER` (3 min) skip phase 1** — auto-marked `0→duration`, opening
directly in framing mode. This is a conditional initial state, not a second
code path.

### Rejected alternatives

- **Range-proxy the raw googlevideo URL** so the browser streams the full
  source natively. One phase, real pixels throughout — but those URLs are
  IP-bound and expire, and DASH splits video and audio into separate streams,
  so it means muxing on the fly. Fragile plumbing for a phase that phase 1
  already covers at zero cost.
- **Low-res proxy of the whole video** (classic NLE workflow). A 3h stream at
  144p is still hundreds of MB and minutes of waiting.
- **Two CSS-clipped `<video>` copies as the preview.** Free audio, no render
  loop — but two decoders of one file drift out of sync, so the top and bottom
  halves show different moments. Disqualifying for a composite preview.
- **Server-rendered preview only.** Byte-identical to export, but framing
  becomes trial-and-error over a multi-second round trip. The framing loop is
  the whole app.

## Stack

Vite + vanilla TS, matching the sibling `gifsync` project: pnpm, `type:
module`, Vite 8, vitest 4, TS 7, `.nvmrc`, `tsc && vite build`,
`@radix-ui/colors` for the palette.

No framework. Drag interactions and a canvas render loop are imperative; a
reconciler adds a state-sync layer around code that does not want one.

**No server dependencies.** Node 24 runs `.ts` directly, so
`node server/index.ts` needs no tsx, no ts-node, no build step. Three JSON
routes on `node:http` + `node:child_process` is ~40 lines. No Express.

**Vite serves the clips, not the backend.** A `<video>` needs HTTP 206 range
replies to seek, and hand-rolled range handling is 30 easy-to-botch lines. The
cache lands in `media/` inside the project root; the browser loads
`/media/<videoId>/<a>-<b>.mp4` from Vite's static server, which already does
ranges. The backend only spawns processes and returns JSON. Vite dev proxies
`/api` → `:8787`.

### Prerequisites

`ffmpeg` and `yt-dlp` on PATH (`brew install yt-dlp`). Checked at server boot.

## Layout

```
vstack/
  server/
    index.ts     3 routes, boot checks
    ytdlp.ts     probe + window fetch (spawn)
    ffmpeg.ts    filter graph build + spawn
    errors.ts    HttpError + tool-failure wrapping
  src/
    main.ts      wiring + phase machine (DOM, render loop glue)
    state.ts     AppState + localStorage persistence
    geometry.ts  pure rect math  ← the tested core
    format.ts    mmss/clock/slugify
    api.ts       3 fetch wrappers
    player.ts    YT iframe + timeline strip (phase 1)
    editor.ts    box drag/resize overlay (phase 2)
    preview.ts   canvas render loop (phase 2)
  media/         clip cache (gitignored)
```

## Routes

| Route | In | Out | Does |
|---|---|---|---|
| `POST /api/probe` | `{url}` | `{videoId, duration, width, height, title, isLive}` | `yt-dlp --dump-json`, no video bytes, ~1s |
| `POST /api/window` | `{videoId, start, end, duration}` | `{clipUrl, windowStart, windowEnd, width, height}` | `--download-sections`, stream copy, cached |
| `POST /api/export` | `{videoId, windowStart, windowEnd, start, end, title, layoutId, boxes}` | the mp4, as the response body | one ffmpeg pass |

No job queue, no polling, no SSE. Single-user local: the export request
blocks, the UI shows a spinner, the browser saves the response via
`blob` → `<a download>`. A 30s clip is ~5–10s of ffmpeg.

yt-dlp prefers a source ≥1080p (see Coordinate spaces for why).

**`/window` returns the clip's actual `width`/`height`, and geometry uses
those — not probe's.** yt-dlp picks a format, so the fetched clip can differ in
resolution from what `--dump-json` advertised. Rects are stored in source
pixels, so framing against the wrong dimensions silently mis-crops. Probe's
dimensions are informational only (shown in the trim UI).

**`/export` takes window bounds, never a file path.** The backend reconstructs
the cache filename from `videoId` + `windowStart` + `windowEnd` itself. A
client-supplied path would need traversal validation; not accepting one removes
the question.

## Phase machine

```
idle ──probe──> trimming ──window──> framing ──export──> framing
                   ^                    │
                   └───── re-trim ──────┘   (outside pad → re-fetch)
```

`idle` — URL field. The raw URL is posted to `/api/probe` as-is; the server
extracts the video id by regex (`videoIdFrom`, checked against a host
allowlist) and rejects it there, before `yt-dlp` is ever spawned. There is no
client-side extraction or early-reject round trip to skip.

`trimming` — left: YT iframe. Right: 9:16 placeholder with probed title and
duration. Bottom: `[Set Start] [Set End]` plus a timeline strip showing the
marked range. A trim you cannot see is a trim you cannot verify, so the strip
is not optional. `Continue` enabled only when `end > start`.

`framing` — left: local `<video>` with the two box overlays. Right: the
1080×1920 canvas, CSS-scaled to fit. Bottom: transport plus the trim marks,
still adjustable within the pad.

CSS grid, two columns. Left sizes to the source aspect, right is a fixed 9:16
box. Both get `min-height: 0` so they shrink rather than overflow — the usual
grid footgun with media children.

> **Superseded** — see the note at the top of this file. This is the
> pre-layouts shape.

State `{videoId, start, end, boxTop, boxBottom, sourceW, sourceH}` persists to
`localStorage` keyed by video id. Five lines, and it survives the constant tab
refreshes of development. `sourceW`/`sourceH` are stored so restored rects can
be discarded if a re-fetch yields a different resolution — source-pixel rects
are meaningless against different dimensions.

## Boxes

Independent size (case 1 requires it), overlap allowed, clamped to source
bounds, aspect locked to 9:8 on every resize. Drag body to move; four corner
handles resize, scaling about the opposite corner.

Each box is labelled TOP / BOTTOM and tinted to match its half of the canvas.
Two identical rectangles on one frame is a coin flip every time you return to
the tab.

**Defaults on entering `framing`:** both boxes at max size, top pinned left,
bottom pinned right. That is case 2 framed correctly with zero clicks, and one
drag away from case 1.

## Coordinate spaces

Four exist: source pixels (e.g. 1920×1080), normalized 0..1, display CSS px,
and output (1080×1920 fixed).

**State stores source-pixel rects.** Normalized storage is a trap: it scales x
by width and y by height, so a 9:8 box in a 16:9 source has normalized
`w/h = 0.632` and every aspect check must un-warp it.

Source pixels means ffmpeg's `crop=w:h:x:y` and canvas
`drawImage(video, sx,sy,sw,sh, …)` both consume the stored value **raw, with
zero conversion**. That is what removes the risk of the two consumers
disagreeing — not a shared abstraction, but having nothing to convert.

Max box is `min(sourceW, sourceH × 9/8)` wide. For 1920×1080 that is
1215×1080, which *downscales* into the 1080×960 half. A 720p source maxes at
810×720, a 1.33× upscale — acceptable, but the reason yt-dlp prefers ≥1080p.

Crop rects are plain integers, **not** rounded to even. Chroma subsampling
constrains the *encoded frame*, which is a fixed 1080×960 — both even — not the
crop window ffmpeg reads. Even-rounding the crop would buy nothing and cost
exactness: with `w = round(h × 9/8)` the aspect error is 0, whereas
even-rounding leaves a ±2px slop that has to be tolerated in validation.

## geometry.ts

> **Superseded** — see the note at the top of this file. `geometry.ts` is now
> ratio-parameterised; nothing below this line reflects the shipped module.

```ts
export const OUTPUT = { w: 1080, h: 1920 };
export const HALF   = { w: 1080, h: 960 };
export const BOX_RATIO = 9 / 8;
export const MIN_BOX_H = 142;   // source px; blocks degenerate boxes
export const SKIP_TRIM_UNDER = 180;  // s; auto-mark 0→duration below this

maxBox(source: Size): Size
boxFromHeight(h, source): Size                       // aspect-lock + size clamp
clampToBounds(rect, source): Rect                    // slides, never resizes
moveBy(rect, dx, dy, source): Rect
resizeFromCorner(rect, corner, dx, dy, source): Rect // scales about opposite corner
defaultBoxes(source): { top: Rect; bottom: Rect }
displayScale(source: Size, displayW: number): number
toDisplay(rect, scale) / fromDisplay(rect, scale)
isValidBox(rect, source): boolean                    // shared with the server
```

Every function returns a rect that is aspect-correct and fully inside the
source. No caller can construct an invalid rect.

**Size is height-driven, not width-driven.** Aspect is locked, so `h`
determines `w` — a `snapAspect(w, h, …)` taking both is not just redundant, it
is not idempotent: deriving `h` from `w` and then `w` from `h` loses a pixel
each round, so a box re-snapped on every drag frame visibly shrinks. Canonical
form is `h` integer, `w = round(h × 9/8)`. `resizeFromCorner` converts a
horizontal drag to a height via the ratio and takes whichever axis moved more.

`isValidBox` is imported by the server (`../src/geometry.ts` — Node 24 strips
types), so client and server share one definition of a legal rect instead of
two that can drift.

**Critical ordering: clamping slides the rect, it never shrinks it.**
Shrinking would break the 9:8 lock, and a box off 9:8 produces a stretched
output half that goes unnoticed until export. Because `boxFromHeight` already
caps size at `maxBox`, sliding is always sufficient. Size-cap first, then
translate. Reversed, this ships a subtly squashed video.

## Preview

The entire composite:

```ts
ctx.drawImage(video, t.x, t.y, t.w, t.h, 0,   0, 1080, 960);
ctx.drawImage(video, b.x, b.y, b.w, b.h, 0, 960, 1080, 960);
```

Canvas backing store is 1080×1920, CSS-scaled into a 9:16 container. Context
created with `{ alpha: false }`.

The rAF loop runs unconditionally, so redraw-on-seek and redraw-on-drag need
no wiring. Audio comes from the left `<video>` staying unmuted; the canvas has
no audio track and needs none.

`ponytail:` always-on rAF, gate on `!video.paused` if battery ever matters.

## Export

> **Superseded** — see the note at the top of this file. The shipped filter
> graph composes 2–4 legs with `xstack`, not a fixed two-leg `vstack`.

```
ffmpeg -i media/<id>/<a>-<b>.mp4 -ss <start-clipStart> -t <end-start> \
 -filter_complex "[0:v]split=2[a][b];\
  [a]crop=TW:TH:TX:TY,scale=1080:960:flags=lanczos[t];\
  [b]crop=BW:BH:BX:BY,scale=1080:960:flags=lanczos[u];\
  [t][u]vstack=inputs=2[v]" \
 -map "[v]" -map 0:a? -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p \
 -c:a aac -b:a 128k -movflags +faststart -y out.mp4
```

- **`-ss` after `-i`**, not before. Fast-seek before the input snaps to a
  keyframe and drifts up to ~2s. Decoding 5s of pad buys frame accuracy for
  free — this is what the pad is for.
- **`-t` (duration), not `-to`** — sidesteps whether `-to` is input- or
  output-relative after a seek.
- **`split=2` then two crops**, not two `-i` of the same file: one decode.
- **`-map 0:a?`** — the `?` makes audio optional, so a silent source does not
  fail the export.
- `vstack` requires equal widths; both legs are 1080 by construction.
- `yuv420p` and `+faststart` for YouTube/QuickTime compatibility and
  upload-while-encoding.

Source fps preserved. No gap or divider — the halves tile 1920 exactly.

Output name: `<title-slug>-<mmss>-<mmss>.mp4`.

**Rects are validated before reaching the filter string.** `spawn` takes an
args array, so no shell is involved and this is not injection defense; it is
that numbers are the one thing interpolated into `crop=`, and a `NaN` or
out-of-bounds rect makes ffmpeg fail unreadably. Coerce to int, range-check
against the clip's source dimensions, and check `isValidBox` — which asserts
`w === round(h * 9/8)` exactly, integers only, and fully in bounds. Reject with
a clear message.

## Errors

The theme: do not build a taxonomy for another tool's error messages.

- **Boot check** — `yt-dlp --version`, `ffmpeg -version`; exit with the
  `brew install` hint if missing. Once, loudly, not per request.
- **Bad URL** — regex-extract the id, reject before any spawn.
- **yt-dlp failures** (private, geo-blocked, removed, members-only,
  bot-check) — return exit code plus the last ~5 lines of stderr, displayed
  verbatim. yt-dlp's messages are the best available diagnostic and they shift
  as YouTube changes; own categories would be a stale translation layer.
- **ffmpeg failures** — same, tail stderr.
- **Live streams** — `--dump-json` reports `is_live` (mapped to `isLive`); reject up front, since a
  section of an ongoing stream is not well-defined.
- **`end <= start`** — Export disabled client-side, no request.
- **Disk** — `media/` grows forever. Print total size at boot.
  `ponytail:` no eviction; add LRU when it becomes annoying.
- **Selection over 3 min** — soft warning (YouTube Shorts' own cap), not a
  block.

## Tests

Five files, each earning its place.

1. **`geometry.test.ts`** — aspect holds after every operation; clamping at
   all four edges and four corners; min/max size; integer dimensions (crop
   rects are deliberately *not* even-rounded — see Coordinate spaces);
   display↔source roundtrip. This is the code whose bugs are *silent* — a
   broken clamp does not throw, it ships a stretched video.
2. **`state.test.ts`** — `save()`/`restore()` against a Map-backed
   `localStorage` stub: a framed box pair survives an unrelated mark-only
   save, a half-set pair never overwrites a complete one, and malformed or
   unexpected storage contents (bad JSON, wrong shape, wrong types) are
   tolerated rather than thrown.
3. **`format.test.ts`** — `mmss`/`clock`/`slugify` edge cases: zero-padding,
   values over 59 minutes, negative and fractional input, all-punctuation
   titles.
4. **`ffmpeg.test.ts`** — one true integration test: synthesize a 2s source
   with known color blocks, run the real export command with known rects,
   extract the frame at t=1, assert 1080×1920 and that each output half
   samples the color its box covered. Proves the filter graph is correct
   *and* that ffmpeg and canvas agree on what a source rect means — the one
   assumption the whole design rests on.
5. **`ytdlp.test.ts`** — `videoIdFrom`'s extraction branches (query param,
   path tail, bare-id fallback) and, specifically, that the bare-id
   fallback's allowlist bypass does not leak into the URL-parsing branch: an
   11-char path tail on a non-YouTube host is still rejected. Pure and
   synchronous — no subprocess spawned, no network involved.

Skipped: DOM drag simulation, route tests, anything in `ytdlp.ts` that spawns
`yt-dlp` (network-dependent and flaky) — `probe`/`fetchWindow` themselves stay
untested; only the pure `videoIdFrom` above is. `ponytail:` noted in the
file.

## Out of scope

Stated so the implementation plan cannot quietly grow:

- Keyframed or moving boxes. Crop is static for the whole clip.
- Captions, text overlays, music, transitions.
- Multi-clip timeline.
- Deployment, multi-user, auth. Local single-user only.
- Non-YouTube sources. yt-dlp supports many; none designed for or tested.
- Any split other than 9:8 + 9:8. No 3-way, no other ratios. *(Superseded —
  see the note at the top of this file; nine presets ship 2–4 regions across
  three ratios.)*
- Server-side progress reporting. Spinner only.

## Note

Fetching YouTube video files conflicts with YouTube's Terms of Service absent
your own content or a license. Repeated in the README for whoever opens the
repo next.
