# vstack — horizontal output for the short journey

Status: approved design, 2026-10-02. Extends the layouts doc
(2026-08-21), the frame-borders doc (2026-08-22), the starter-screen doc
(2026-08-22), the publish doc (2026-08-23) and the custom-boxes doc
(2026-08-25). Supersedes none of them: every tall behaviour they describe
is unchanged, byte for byte. Adds a second OUTPUT SHAPE to the short
journey — not a new journey, not a new phase, not a new `mode`.

## Intent

After trimming and fetching a window, the user can choose in `framing`
whether the export is a **short** (1080x1920, vertical — today) or a
**long** (1920x1080, horizontal — a normal YouTube video cut from the same
source). Long has its own small set of layouts and keeps the up-to-two
floating custom boxes.

Long output differs from short in three ways:

- **No starter screen** — no title card, no TTS voice reading the title.
- **Keeps the outro** — `end_video.mp4` still closes the video.
- **Thumbnail is the starter screen's look, horizontal** — the blurred
  band + title drawn over the composite's first frame, at 1280x720. It
  exists only as the thumbnail; it never appears in the video.

Success: pick Long in the framing bar, choose a 16:9-frame layout, crop,
export a 1920x1080 `.mp4` ending on the outro, preview it, and publish it
as an ordinary (non-Shorts) video with the title-card thumbnail.

Throughout this doc "tall" means the existing 1080x1920 frame and "wide"
the new 1920x1080 one, to keep them apart from the long-form JOURNEY
(`mode === "long"`, `/api/stack`), which this feature does not touch.

## Decisions taken

| Question | Answer |
|---|---|
| Wide thumbnail | Title card (blurred band + title) over the wide composite's first frame, thumbnail only |
| Wide layouts | Full (1 cell), 2 side by side, 2x2 grid |
| Outro in a wide frame | Letterboxed over a blurred copy of itself, `stackWide`'s treatment |
| Publish prefill | Short's title/description, short's tags minus `shorts`; `shorts: false` |
| Where orientation lives | A property of the LAYOUT — no new state field, no new request field |

## 1. Geometry, layouts, state

### `src/geometry.ts`

`OUTPUT` is deleted and replaced by two constants:

```ts
export const TALL: Size = { w: 1080, h: 1920 };
export const WIDE: Size = { w: 1920, h: 1080 };
```

Deleting rather than aliasing is deliberate: every reader of `OUTPUT` then
fails to compile and has to say which frame it means. A surviving `OUTPUT`
would be read as "the" frame by some forgotten call site, silently tall.

### `src/layout.ts`

`Layout` gains `frame: Size`. The nine existing presets get `frame: TALL`
with their ids, rows and labels unchanged, so every stored tall record and
every cached mask keeps working. Three presets are added with
`frame: WIDE`:

| id | label | rows | cell | ratio |
|---|---|---|---|---|
| `w-1` | Full | `{h:1080, cols:1}` | 1920x1080 | 16/9 ≈ 1.778 |
| `w-2h` | 2 side by side | `{h:1080, cols:2}` | 960x1080 | 8/9 ≈ 0.889 |
| `w-2x2` | 2x2 grid | `{h:540, cols:2}` ×2 | 960x540 | 16/9 ≈ 1.778 |

- `cellsOf` reads `layout.frame.w` instead of `OUTPUT.w`. Row heights of
  every preset sum to its own `frame.h`, and `frame.w` divides by every
  `cols`, so exact tiling stays structural.
- `ratioOf` is unchanged. The documented ratio set grows from three
  values to five (1.125, 0.5625, 2.25, 16/9, 8/9).
- New `isWide(layout): boolean` (`layout.frame.w > layout.frame.h`) and
  `DEFAULT_WIDE_LAYOUT` (`w-1`), exported as a value like
  `DEFAULT_LAYOUT`.
- The min-box floor rule is unchanged and needs no special case: for 8/9,
  `ceil(max(142, 142 / 0.889)) = 160`; for 16/9 it is 142.

### `src/custom.ts` and `src/frame.ts`

Every function that bounds by the frame takes it as an explicit
`frame: Size` parameter, with **no default**: `clampOut`, `moveOut`,
`resizeOut`, `isValidOut`, `isValidCustom`, `defaultCustom`, `windowOf`,
`maskRgba`. A default of `TALL` would make every call site that forgot it
silently tall — the failure the `OUTPUT` deletion exists to prevent.

- `custom.ts` still imports only `geometry.ts`; the frame arrives as a
  value, the same way `GUTTER` already arrives as `margin`.
- `frame.ts`'s `windowsOf(layout)` reads `layout.frame` and passes it to
  `windowOf`; edge adjacency is tested against `frame.w`/`frame.h`.
- Even-snapping, the ring/nub mask walk, the per-piece `clip()` rule, the
  alpha formula and `GUTTER`'s evenness are frame-agnostic and unchanged.

### `src/state.ts`

- **No new field.** Orientation is `resolveLayout(state.layoutId).frame`.
- `restore` validates each custom with `isValidCustom(c, source,
  layout.frame)`. A hand-edited record pairing a wide layout with
  tall-frame pieces (an `out` at y=1500) drops the pieces rather than
  mounting them off-frame — the same posture `restore` already takes on an
  over-count.
- Switching ORIENTATION clears both `boxes` and `customs`: a tall `out`
  rect is meaningless in a 1080-tall frame. Switching layout WITHIN an
  orientation keeps `customs`, as today.
- Orientation persists per video because `layoutId` already does —
  reopening a clip reopens it in the orientation it was last framed in.

## 2. Export pipeline (`/api/export`)

The body keeps its shape. The server branches on `isWide(layout)`, where
`layout` is the `layoutById` lookup it already does.

### Validation

- `assertBoxes(layout, boxes, source)` — unchanged signature; per-cell
  ratios already come from `cellsOf(layout)`.
- `assertCustoms(customs, source, layout.frame)` — pieces bounded by the
  layout's own frame.
- `titlePng` is still required in both orientations (on wide it is the
  thumbnail's title art). New check: its IHDR width and height (bytes
  16–23, big-endian, after the existing signature check) must equal
  `layout.frame`. A tall PNG on a wide export would otherwise overlay
  off-centre with no error. Implemented as a small pure function so it can
  be tested directly.
- Wide: `voice` and `voiceTitle` are not required and not read, and
  `speak` is never called — no ~4.6s model load. Tall: unchanged.

### Render, wide

1. `concatClips` for framing cuts — unchanged.
2. `exportClip` — unchanged. `buildFilter` already derives `xstack`
   positions from `cellsOf(layout)`, and `ensureMask(layout, …)` renders a
   `layout.frame`-sized mask. Mask filenames are keyed on layout id, so a
   wide mask can never collide with a tall one.
3. **`appendOutro({ main, outro, out })`**, new in `server/longform.ts`,
   replaces `prependStarter` for wide. One ffmpeg pass:
   - Leg 0: `main`, `fps` + `setsar=1` + `yuv420p`.
   - Leg 1: `outro` letterboxed over its own blurred copy — the same
     480x270 blur and `decrease` + `force_divisible_by=2` foreground
     `stackWide` uses, shared from that module rather than copied.
   - `concat=n=2:v=1:a=1`, audio `aformat`-normalised on both legs,
     `anullsrc` stand-in trimmed to the body's length when `main` is
     silent (appended LAST, so its index is the conditional one).
   - No dip, no transition swell: the short's own outro is a hard cut too.
   - `END_PATH` is passed by the caller, keeping `longform.ts` a sibling
     of `starter.ts` rather than an importer of it.
4. `rename(partial, out)`, then the thumbnail (section 3), then the `prev`
   sweep — the same order as today.

### Sidecar collision

`outName` ignores orientation, so re-exporting the same title and marks in
the other orientation lands on the same `.mp4` name and leaves the other
orientation's sidecar behind:

- wide → tall: a stale `<name>.thumb.jpg` remains, and `applyThumbnail`
  prefers it, so the short would publish the wide card as its thumbnail.
- tall → wide: a stale vertical `<name>.jpg` remains (harmless to publish,
  but wrong to leave beside a video it does not belong to).

So after the rename, a tall export removes `thumbPath(out)` and a wide one
removes `stillPath(out)`. Best-effort, like `saveStill`.

### Unchanged

`isOutName`, `OUT_NAME`, `/out/`, `/api/reveal`, `/api/publish`, `prev`
semantics, the partial's UUID and the SIGTERM `inFlight` sweep.

## 3. Thumbnail and publish

### Thumbnail (wide)

New `titleCard({ main, title, out })` in `server/starter.ts`, which owns
`SCREEN_FILTER`: first frame of `main` → feathered blur/scrim band → title
PNG overlaid → scaled to 1280x720 (exactly 16:9, no crop) → `-q:v 3` →
written to `thumbPath(out)`, i.e. `<name>.thumb.jpg`.

- The first frame of the body is the in-point — the same frame the
  framing bar's `🖼 Thumbnail` toggle already seeks to.
- Writing the picked-thumbnail sidecar name is the point: `applyThumbnail`
  already prefers that file when present, so publishing needs no change
  and stays as blind to orientation as it is to journeys.
- Best-effort. On failure it warns and `applyThumbnail` falls back to
  `firstFrame(video, …, "wide")` — the plain composite frame. The video is
  the product.
- No vertical `<name>.jpg` is saved for wide; Studio's Shorts slot does not
  apply.

**Title size — readable at every size YouTube shows a thumbnail.** The
tall rules (150px max, shrinking to a 48px floor, block ≤ half the frame)
are tuned for a full-screen phone. A thumbnail's smallest common surface
is a ~168x94 tile (sidebar, mobile list), which scales a 1080-tall frame
by ~0.087: a 48px title lands at ~4px there, unreadable. Wide therefore
gets its own rules, tall keeps today's exactly:

| rule | tall (unchanged) | wide |
|---|---|---|
| max size | 150 | 220 |
| min size | 48 | **120 — a floor, never shrunk past** |
| max lines | none | 3 |
| max block height | `h / 2` (960) | `0.7 × h` (756) |

120px → ~10.5px on the smallest tile, the legibility floor. At 120px a
line holds roughly 26 characters of this font, so about 75 fit in three
lines; at 220px about 14 a line.

**A title that does not fit is SURFACED, not shrunk and not truncated.**
It is drawn at the floor size (lines past the third are dropped from the
thumbnail art only) and the framing bar shows a `.badge-warn` beside the
title field: "too long for a readable thumbnail — shorten to ~75
characters" — the same in-bar warning shape the over-3-minutes badge
uses. Export stays enabled: a cramped thumbnail is the user's call, and
this codebase's rule is that a silent defect is cardinal, not that every
render must be perfect. The badge is toggled in place from the title
input's `oninput`, under the same quiet-update rule Export's `disabled`
already follows.

**The fit is a pure function.** The size/wrap loop moves out of
`drawTitle` into `fitTitle(measure, title, rules) → { size, lines, fits }`
in `src/starter.ts`, with the text measurer injected (`(text, size) =>
width`). `drawTitle(ctx, title, frame)` picks the rules by orientation,
calls it with `ctx.measureText`, and paints. That makes the sizing
testable in node with a fake measurer, where today it is DOM-only.

**Band height.** `BAND_H = 820` is 43% of 1920 but 76% of 1080.
`SCREEN_FILTER` becomes a function of the band height: tall keeps 820
(byte-identical output, tested), wide uses 860 — the 756px maximum block
plus feather. More of the frame goes soft than on a short, which is free
here: the card is a thumbnail only and never reaches the video. The client
mirror constants in `src/preview.ts` follow the same split.

### Publish (preview phase)

- `shorts: s.mode === "short" && !isWide(resolveLayout(s.layoutId))`.
- Tags prefill: new `WIDE_TAGS_DEFAULT` in `src/defaults.ts`, derived from
  `TAGS_DEFAULT` with `shorts` removed (derived, so the two cannot drift).
- Title (`defaultTitle`) and description (`defaultDescription(videoId)`)
  are unchanged; the description template already carries no shorts tag.
- `.out.is-wide` on `preview` becomes `s.mode !== "short" ||
  isWide(layout)`.
- `← Back` from `preview` still goes to `framing`; `mode` stays `"short"`.

## 4. Framing UI

- **Toggle**: a `Short | Long` segmented pair at the start of the framing
  bar's first row, before the layout picker. The picker lists only the
  current orientation's presets.
- **Switching orientation** goes through `setState` (it changes the bar):
  `layoutId` → that orientation's default (`1-1` / `w-1`), `boxes` →
  `defaultBoxes(source, layout)`, `customs` → `[]`, then `save()`.
- **Hidden in wide**: the voice dropdown, the voice-title field and the
  Try button. The title field stays — it names the file, draws the
  thumbnail and prefills the upload — and its label drops the screen
  wording. Export's disabled-until-title rule is unchanged. The
  `SHORTS_MAX_S` over-length warning is suppressed in wide.
- **Every `OUTPUT` reader** in `main.ts`, `preview.ts`, `editor.ts` and
  `src/starter.ts` reads `resolveLayout(layoutId).frame`: the composite
  canvas's `width`/`height`, the cell outlines' percentage positions, the
  output overlay's `bounds`, `drawTitle`/`renderTitleArt(title, frame)`,
  and the thumbnail preview's band. The 16:9 crop guide is not drawn in
  wide — the whole frame is the thumbnail.
- `.out.is-wide` is also set during wide framing.

**CSS trap.** `.out.is-wide` carries `object-fit: contain`, and the
framing canvas must never get it: `.boxes` is placed against the canvas's
rendered rect, and a letterboxed canvas puts every floating piece over the
wrong pixels. Today this is safe only because the canvas is never wide.
The rule is rescoped to `.out.is-wide > video`.

- The cached-clip picker and a reload need no extra wiring: orientation is
  the layout, and the layout is already restored.

## 5. Testing

Pure, exhaustive (the bottom modules):

- `src/layout.test.ts` — every preset tiles its OWN frame exactly; the
  ratio set is the documented five; `defaultBoxes` returns per-cell-valid
  boxes on every wide preset; the tall presets' cells are unchanged (the
  regression fence).
- `src/custom.test.ts` — the existing suite run against both frames; a
  tall-frame `out` (y=1500) fails `isValidOut` in `WIDE`;
  `defaultCustom(source, i, WIDE)` lands inside 1920x1080.
- `src/frame.test.ts` — wide windows: every seam and margin exactly one
  gutter, a window's square corner opaque.
- `src/state.test.ts` — restoring a wide layout with tall-frame customs
  keeps the layout and drops the customs; tall records unchanged.
- `src/starter.test.ts` (`fitTitle`, fake measurer of N px per character
  per px of size) — wide never returns a size below 120 or above 220,
  never more than 3 lines, and reports `fits: false` for a title that
  needs a fourth line at the floor; a short title gets the max size; tall
  rules reproduce today's sizes for a set of titles (the regression
  fence). Mutation: removing the wide floor fails the overflow case.

Real ffmpeg, asserting pixels:

- `server/ffmpeg.test.ts` — a `w-2h` export is 1920x1080, each half
  carries its own source colour band, the seam is white. Mutation: swapping
  the `xstack` positions fails it.
- `server/longform.test.ts` (`appendOutro`) — duration is body + 5.04s; a
  sample inside the body carries the body's colour; the outro's left edge
  is NOT black (fails if the blur leg is dropped and it pillarboxes); a
  silent body renders through the stand-in. Mutations: dropping the blur,
  reversing the legs.
- `server/starter.test.ts` (`titleCard`) — output is 1280x720; a pixel in
  the band is mixed against sharp outside it (fails if the blur is
  dropped); the tall `SCREEN_FILTER` at band 820 is byte-identical to
  today's.
- The IHDR check accepts a frame-sized PNG and rejects a mismatched one,
  tested as a pure function.
- `server/youtube.test.ts` — `WIDE_TAGS_DEFAULT` through `buildSnippet`
  carries no `shorts`.

DOM — the toggle, canvas sizing, the `contain` rescoping, the hidden voice
row — is verified by hand in a real browser, like the rest of the DOM
surface.

## Out of scope

- Column-based layouts ("1 big left + 2 stacked right"). The row model
  cannot express them; Full plus a floating custom box covers the facecam
  case.
- A horizontal outro asset. The letterboxed vertical one stands in; a
  bundled `end_video_wide.mp4` would replace leg 1 of `appendOutro`.
- An orientation-aware `outName`. The sidecar sweep above is the cheaper
  answer to the one collision it would prevent.
- Any change to the long-form journey (`/api/stack`) or the lofi journey.
- A separate, shorter "thumbnail text" field. The too-long callout asks
  the user to shorten the one title; a second field is the upgrade if
  titles routinely need to be longer than a thumbnail can carry.
- An actual-size tile preview (the card drawn at 168x94 in the framing
  bar). The floor makes it unnecessary for size; add it if contrast or
  font choice ever turns out to be the problem instead.
