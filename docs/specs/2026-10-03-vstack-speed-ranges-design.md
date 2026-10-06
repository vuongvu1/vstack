# vstack — speed-up ranges in the framing phase

2026-10-03

Extends `2026-09-10-vstack-framing-cuts-design.md`, which gave the framing
strip red **cuts**. Supersedes nothing. Adds one more kind of band to the
same strip — a **speed range** — and two optional fields to `/api/export`'s
body (`speeds`, `badgePngs`). No new route, no new phase, no new `mode`, no
filename change. Applies to every layout, tall (`TALL`) and wide (`WIDE`)
alike, because both are the one framing strip and the one export path.

## What the user asked for

> "Beside the cut section, I want to also have a speed up section. When
> selected, a new range (different colour) is displayed in the play bar and
> the user can adjust the range, and choose the speed-up option (x2, x4, x8,
> x16…). During the speed-up section the video has a speed-up icon with the
> current option (e.g. x2) and an effect indicating that it's speeding up.
> Available for both the short and long (wide) cutter."

Decisions taken in brainstorming:

- Scope: the framing strip only — tall shorts and wide layouts. Not the long
  journey (no strip there) and not the audio cutter.
- Audio inside a speed range: **muted**, with a bundled **whoosh** played at
  the range's start. Time-compressed speech is noise past x4.
- Effect: **VHS fast-forward** — rolling horizontal tracking lines and a
  slight colour split — plus a `▶▶ x4` badge, for the whole range.
- Speed is **per range**: x2, x4, x8 or x16.
- The whoosh is a user-supplied asset.

## The model

```ts
type SpeedRange = { start: number; end: number; speed: Speed };
type Speed = 2 | 4 | 8 | 16;          // SPEEDS = [2, 4, 8, 16]
```

`AppState.speeds: SpeedRange[]`, in the **clip timeline** — the same
coordinate system as `cuts`, `clipStart`, `clipEnd`. Empty by default,
**not persisted** and cleared on a fresh window, for the reason `cuts` are:
they belong to a fetched window and `restore` has none to attach them to.
Capped at `MAX_SPEEDS = 4`.

### Cut beats speed

A cut and a speed range may overlap. The cut wins: what a cut drops is
dropped whatever speed it would have played at. A speed range is therefore
only ever spent on *kept* footage.

### `planLegs`, the one shared rule

```ts
type Leg = { start: number; end: number; speed: 1 | Speed };
planLegs(start: number, end: number, cuts: Segment[], speeds: SpeedRange[]): Leg[]
```

New in `src/segments.ts`, pure, imports nothing. It takes `keepRanges(start,
end, cuts)` and splits each kept range at every speed range's bounds,
tagging each piece with its speed (1 outside any speed range). Speed ranges
are normalised among themselves first: sorted, clamped, empties dropped, and
overlapping ranges merged — the merged range keeps the **earlier** range's
speed, the same "earlier start survives" rule `normalize` already holds for
segments. Adjacent legs of equal speed are joined, so no zero-information
seam reaches ffmpeg.

`legsDuration(legs) = Σ (end - start) / speed` is the output length.

Both sides compute from `planLegs`: the client for the kept badge, the
`SHORTS_MAX_S` warning and Export's gate; the server for the stitch legs and
the effect windows. One rule, so a badge cannot disagree with a render.

**`planLegs` reduces to `keepRanges` exactly when `speeds` is empty** (every
leg speed 1, same bounds). That identity is what keeps the cut tests
describing live behaviour, and it is mutation-tested.

## Client

### The strip

- `+ Speed` sits beside `+ Cut`, capped at `MAX_SPEEDS`. It drops a
  `SPEED_S = 4` second band at the playhead, clamped inside
  `[clipStart, clipEnd]`, at `DEFAULT_SPEED = 4`. Reads live state
  (`getState()`), never the render's snapshot — the `+ Box` rule.
- Each range renders as a **violet** band (`.wave-speed`, `--violet-a5`
  fill, `--violet-9` edges): red is cut and error, grass is keep, blue is
  the playhead, and violet is the one scale free.
- Two drag handles and a `×`, wired exactly as the cut bands are: `setQuiet`
  + in-place reposition mid-drag, one notifying `setState` on pointer-up that
  normalises the speed list (so dragging into a neighbour merges).
  Handles and `×` stop click propagation.
- A small chip on the band, `x4`, opens a four-option `<select>` (x2 / x4 /
  x8 / x16). Changing it is a `setState`.
- A speed band and a cut band may overlap on the strip; the cut is drawn on
  top, which is also what the render does.
- The kept badge becomes `Σ legs` length: `0:42 kept` already reads
  `keptLength`; `keptLength` now returns `legsDuration(planLegs(...))`.

### The preview

The framing `<video>`'s existing `ontimeupdate` (~4 Hz) gains one branch:
inside a speed range, `playbackRate = speed` and `muted = true`; outside,
`1` and the user's own mute. Chrome accepts rates up to 16, which is why x16
is the ceiling. The cut skip runs first, so a cut inside a speed range is
still skipped.

The composite canvas rAF loop, when the playhead is in a speed range,
paints the VHS lines and the badge over the finished composite (after the
gutter paint — the badge sits over the frame, not over a cell):

- **Badge**: `drawBadge(ctx, speed, frame)` in a new `src/speed.ts` — a
  rounded dark pill, top-right, `▶▶ x4` in `TITLE_FONT`. The *same* function
  rasterises the export's PNG (`renderBadge(speed, frame) → base64 PNG`), the
  `drawTitle`/`renderTitleArt` split, so the badge is exact in preview.
- **VHS**: two or three bright, semi-transparent horizontal bands rolling
  downward at a fixed rate, plus a ±`VHS_SHIFT` px red/blue offset strip
  under each band. Approximate, `ponytail:`-marked at its constants, like
  the starter screen's blur: the export's version is the authority, and the
  preview only has to read as "fast-forwarding".

### The request

`/api/export` gains:

- `speeds: SpeedRange[]` — optional, default `[]`.
- `badgePngs: Record<"2"|"4"|"8"|"16", string>` — optional; must hold a PNG
  for **exactly** the speeds `speeds` uses. Bare base64, the `titlePng`
  posture.

## Server

### Validation (`/api/export`)

- `speeds` an array of at most `MAX_SPEEDS`; each `start < end`, finite,
  inside `[start, end]` of the export; each `speed ∈ SPEEDS`.
- `badgePngs`' keys equal the set of speeds used; each value is length-capped
  and passes the PNG signature check `titlePng` already gets, and its size
  must be `badgeSize(layout.frame)` (`pngSize`), or 400.
- `planLegs(...)` must leave something (`legsDuration > 0`), the existing
  "cuts must leave something to export" check, widened.

### The stitch carries speed

`ConcatPart` gains an optional `speed` (default 1). A leg with `speed > 1`:

- video: `trim=a:b,setpts=(PTS-STARTPTS)/speed` before the existing
  `scale/setsar/fps/format` — `fps` after `setpts` drops the surplus frames,
  so x16 does not encode sixteen times the frames;
- audio: **not** the clip's own sound — cut from the shared `anullsrc`
  stand-in for `(b - a) / speed` seconds, the path a silent part already
  takes. So `anySilent` becomes "any part silent *or sped*", and the input
  arithmetic is untouched: the stand-in stays at `parts.length`.

With speeds the route always stitches (as with cuts), so `exportClip` always
runs from 0 on a file that is already exactly `legsDuration` long. With no
cuts and no speeds nothing is stitched — byte-identical to today.

`concatClips` is shared with `/api/window`, which never passes `speed`; its
default keeps that call identical.

### `exportClip` gains an `fx` stage

```ts
type Fx = { at: number; until: number; badge: string /* png path */ };
ExportOpts.fx?: Fx[];        // output-timeline seconds; absent = today
```

The route computes each sped leg's **output** window by walking `planLegs`
and summing `(end - start) / speed`; consecutive sped legs separated only by
a cut-out piece are separate windows.

Inside `buildFilter`'s graph, after the mask overlay produces `[v]`:

1. **VHS**: the tracking lines are a function of row and time only, so —
   the lofi CRT stage's lesson — they are built on a **one-pixel-wide
   column** per frame (`geq` over `1 x H`), stretched across, and spent by
   `blend` in screen mode, **in planar RGB** (`format=gbrp` around the stage;
   on YUV, `screen` turns the picture purple — `crtLegs`' measured bug). The
   colour split is a `rgbashift=rh=-VHS_SHIFT:bh=VHS_SHIFT`. Both are gated
   by `enable='between(t,at,until)+…'` across every window — one stage, not
   one per window.
2. **Badge**: one `-loop 1 -i <badge.png>` input **per distinct speed**,
   overlaid top-right with an `enable=` over that speed's windows. Inputs are
   appended **after** the mask (input 1) so no existing index moves, and
   declared before `-ss` for the mask's reason.

Audio: when `fx` is non-empty, one more input, `speedup-whoosh.mp3`,
appended last; `asplit` into one tap per window, each `adelay`'d onto its
`at`, mixed over `[0:a]` with `amix=normalize=0:duration=first` — the
transition swell's three lessons (`normalize=0` or the programme halves,
`duration=first` or the whoosh outruns `-t`). The whoosh is placed by its
**start**, not a peak: it should begin with the speed-up. `WHOOSH_GAIN` is
the knob.

### The asset

`server/assets/speedup-whoosh.mp3`, supplied by the user, owned by
`starter.ts` beside `TITLE_SOUND_PATH` (the short journey's sounds live
there), and added to `checkStarter`'s list — the short journey's four
become five. It must carry audio; its length is taken on trust, and
`duration=first` keeps a long one from extending the render.

### Wide vs tall

Nothing differs. `badgeSize(frame)` scales the pill to the frame's short
side, and the VHS column is `frame.h` tall. The starter screen (tall) and
the outro are later passes over `body.mp4`, but the starter is built from
its FIRST FRAME, so `speedFilter` gates every video effect with `gt(t,0)*`:
frame 0 is never touched, even when a range opens the clip. The whoosh is
audio and still starts at the window.

## What does not change

- `outName`: the marks are unchanged, so the name is too. A speed edit
  overwrites the render of the same marks, like a crop tweak.
- The thumbnail (`firstFrame`, `titleCard`) and the starter screen come from
  body.mp4's first frame, which the stage excludes (`gt(t,0)`), so a range
  opening the clip leaves them clean, as the preview's thumbnail shows.
- `/api/window`, `segments`, the trimming phase, the long journey, lofi,
  the cutter, the reader.

## Testing

- `src/segments.test.ts` — `planLegs`: identity with `keepRanges` at empty
  speeds (mutation-tested), a speed range inside a keep, one straddling a
  cut (cut wins), two overlapping speed ranges (earlier speed wins), equal
  adjacent legs joined, clamping at the outer bounds; `legsDuration` against
  a known set.
- `server/ffmpeg.test.ts` — real ffmpeg:
  - `concatClips` with a x4 leg: output duration is the sum with that leg
    quartered; the sped leg's audio is silent (mean below -60 dB) while the
    x1 leg's is not; frame sampled inside the sped leg carries its colour.
  - a real export with one speed range: badge pixels present top-right
    inside the window and absent outside it; a flat grey stays grey inside
    the window (channels equal — fails if the VHS stage runs in YUV); a lit
    row's brightness changes between two instants in the window (the lines
    roll); the whoosh's band is louder just after `at` than just before.
  - the no-speed export is unchanged: `fx` absent produces the same graph
    string as before (string pin).
- `server/index.ts` validation: speeds outside start/end, a bad speed,
  badge keys not matching the speeds used, a non-PNG badge — 400 each.
- `src/speed.ts` and the strip are DOM, verified in a real browser, like the
  rest of the DOM surface.

## Open knobs

`SPEED_S`, `DEFAULT_SPEED`, `MAX_SPEEDS`, `VHS_SHIFT`, the line count and
roll rate, `WHOOSH_GAIN`, badge size and inset. All constants; none needs a
UI.

## As built

- The badge size and the VHS constants (`BADGE`, `BADGE_INSET`, `VHS_ROLL`,
  `VHS_GAP`, `VHS_BAND`, `VHS_GAIN`) live in `src/defaults.ts`, shared by
  client and server rather than copied.
- The stage is `ExportOpts.speed: SpeedFx` (windows, a badges map and the
  whoosh), built once by `speedFilter` with one gated `enable=`, not a
  per-window `Fx` list. `ConcatPart.speed` carries the same into the stitch.
- The whoosh is trimmed to each window and faded out over `min(0.3s, window)`.
  Its input loops (`-stream_loop -1`, revised 2026-10-04), so a band longer
  than the asset repeats it rather than falling silent after one play.
- The preview draws the lines and the badge but not the red/blue colour
  split. Its `drawVhs` starts one gap early so a band's tail over the top
  rows is drawn, matching the export.
- The framing bar's kept badge shows when cuts or speeds exist.
- `exportClip` throws when a speed stage meets `start !== 0` (windows are
  output seconds of a stitched input), and `doExport` clamps cuts to
  `[clipStart, clipEnd]` like speeds.
- The Testing section's route-level 400 tests and "no-speed graph string
  pin" were not written: the plan ruled route tests out, and only
  `speedFilter(windows: []) === ""` is pinned.
- Known gaps: `playbackRate` is not reset on leaving framing (self-heals on
  the next `timeupdate`); the whoosh in a real export was checked only by the
  real-ffmpeg test with a synthetic tone, not by ear.

### Revised 2026-10-04 at the user's request

- The VHS lines are removed (`VHS_ROLL/GAP/BAND/GAIN` deleted from
  `src/defaults.ts`; `drawVhs` and the stage's `geq`/`blend` legs gone), and
  the pill badge with them. The badge is now outlined white `▶▶ xN` text
  (the title's stroke-and-shadow recipe) right-aligned in the same BADGE box.
- In their place: motion blur in the stitch — `tmix=frames=min(speed, 8)`
  before `setpts` on a sped leg — and, in the preview, a half-alpha motion
  trail approximating it.
- The red/blue colour split is kept (`rgbashift`, still export-only), with
  the badge overlays, whoosh, `gt(t,0)` gate and `start === 0` guard as they
  were. Earlier sections describing the lines, `VHS_SHIFT` (now
  `SPLIT_SHIFT`) and the planar-RGB blend are superseded by this note.

## Revised 2026-10-06: the original sound, no whoosh

The user disliked the whoosh. It is gone — asset, `WHOOSH_PATH`, boot check,
and the stage's audio graph — and a speed range now keeps the clip's own
sound, sped: `concatClips` puts `atempo=<speed>` on a sounded sped leg (pitch
kept; `atempo` takes 0.5-100, so x16 fits in one filter), and the framing
`<video>` plays the band unmuted at `playbackRate`, which keeps pitch too.
Everything above about muting and the whoosh is superseded by this.

At x8 and x16 the sped sound is a warble, so `speedGain` drops those legs to
`FAST_GAIN` (0.3, ~-10.5 dB) in both the stitch (`volume=` after `atempo`) and
the framing `<video>` (`volume`). x2 and x4 keep full level.

