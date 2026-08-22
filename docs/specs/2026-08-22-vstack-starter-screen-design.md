# vstack — the starter screen

Date: 2026-08-22
Status: implemented
Extends: `docs/specs/2026-08-21-vstack-layouts-design.md` (adds `starterTitle`
and `titlePng` to `/api/export`'s body) and
`docs/specs/2026-08-22-vstack-frame-borders-design.md` (the finished
composite is now a *segment* of the output, not the whole of it)

## Problem

An exported short opens on a frame of somebody else's video with no idea what
it is. It needs a title card: a beat of the clip's own first frame, blurred,
with the title over it, read aloud in Vietnamese over a music bed, and a cue
sound in the gap between the voice ending and the clip starting.

So: a required title field in the framing bar, and a starter screen prepended
to every export.

## The constraint that shapes everything

**This machine's ffmpeg has no `drawtext`.** Homebrew ffmpeg 8.1.1 here is
configured without libfreetype, libass *and* librsvg — `ffmpeg -h
filter=drawtext` answers `Unknown filter 'drawtext'`, and the `svg_pipe`
demuxer that is present has no decoder behind it. The server therefore cannot
rasterise a glyph at all, by any route.

**Rejected — require a fuller ffmpeg.** A `brew install ffmpeg` that happens
to include freetype is not something the app can assert into existence, and
the boot check's job is to name what is missing, not to demand a rebuild.

**Chosen — render the title in the browser.** `src/starter.ts` draws the
wrapped, outlined title onto a 1080×1920 transparent canvas and hands the
server bare base64 PNG. This is the same shape as the frame mask: an RGBA
image the export overlays, never something the server computes. The browser
also has the fonts — Comic Sans MS with full Vietnamese coverage — which no
ffmpeg build would give us.

The cost is a new client-supplied value in the request body, which is
otherwise a thing this API deliberately avoids (`/api/export` takes window
bounds, never a path). It is checked at the boundary: base64 length capped,
PNG signature verified against the decoded bytes, written to the export's own
temp dir. `Buffer.from(s, "base64")` never throws — it stops at the first
invalid character — so the signature check, not the decode, is what rejects a
non-PNG.

## Shape

Two ffmpeg passes, not one.

1. `exportClip`, unchanged: the composite lands in the temp dir as
   `body.mp4`.
2. `prependStarter`: extract `body.mp4`'s first frame to a PNG, then one
   ffmpeg that blurs it, overlays the title art, and concatenates the result
   in front of the clip.

Doing it inside the export's own filter graph would mean a
`split` → `trim=end_frame=1` → `loop` chain feeding a filter that is already
there for the mask, plus turning `-ss`/`-t` into `trim` filters so an output
`-t` couldn't truncate the concatenation. Extracting the still first makes the
background an ordinary `-loop 1 -t <D> -i` image input.

### Duration

`starterDuration(voiceSeconds) = max(1.6, 0.35 + voiceSeconds + 0.45)`.

Three layers, each with its own slot inside that:

- `starter-music.mp3` runs the whole length as a bed, faded out at the end.
- The voice starts after the 0.35s lead-in.
- `before-video-start-sound.mp3` is the cue, placed in the 0.45s tail — the
  slot between the last syllable and the cut to the clip.

The tail is therefore sized by the cue (0.43s). A longer cue file would be
clipped at the cut rather than pushing the clip later; that is the right trade
for a fixed asset, but it is a trade. The 1.6s floor exists because a one-word
title reads in about half a second, which is too fast to register as a screen
at all.

The bed is the one part that needs tuning rather than deciding. The screen is
only a couple of seconds long, so it hears whatever the track opens with — and
the bundled one opens soft (mean −14 dB at 0:00 against −3 dB by 0:20).
`MUSIC_START` (where in the track to drop in, default 0) and `MUSIC_GAIN` are
the knobs; the default plays the file from its beginning, which is the least
surprising reading of "play this music".

### The graph

Inputs: `0` still, `1` title art, `2` clip, `3` music, `4` voice, `5` cue, and
`6` — only when the clip has no audio stream — `anullsrc` as its stand-in.
The music carries `-ss`/`-t` as *input* options, so ffmpeg seeks and then stops
decoding at the screen's length rather than chewing through all 2m36s.

```
[0:v]gblur=sigma=30,fps=<clip fps>,format=yuv420p,setsar=1[bg]
[bg][1:v]overlay=0:0:format=auto[intro]
[2:v]setsar=1[clip]
[intro][clip]concat=n=2:v=1:a=0[v]
[3:a]afade=t=out:st=<D-0.35>:d=0.35,volume=0.35,aformat=…[music]
[4:a]adelay=350:all=1,aformat=…[voice]
[5:a]adelay=<(D-0.45)*1000>:all=1,volume=0.9,aformat=…[cue]
[music][voice][cue]amix=inputs=3:duration=longest:normalize=0,apad,atrim=duration=<D>,aformat=…[ai]
[2:a]aformat=…[am]                       ← or [6:a]atrim=duration=<clip>,aformat=…
[ai][am]concat=n=2:v=0:a=1[a]
```

Five things in there are load-bearing, and three of them were failures first:

- **`fps=` on the intro leg.** An image input defaults to 25 fps regardless of
  the clip; `concat` wants matching parameters.
- **`setsar=1` on *both* legs.** `scale=` in the export's filter graph carries
  the *source's* sample aspect through to the composite, so an anamorphic
  YouTube upload composites to 1080×1920 at SAR 1214:1215. `concat` refuses a
  SAR mismatch outright — `Nothing was written into output file` — rather than
  picking a side. Square pixels are also what a 1080×1920 short is supposed to
  have.
- **`apad` then `atrim`.** `amix` alone ends with its longest input, which is
  none of the three layers' lengths; the pair pins the screen's audio to
  exactly the screen's video.
- **`afade` on the bed.** The music's input `-t` ends it mid-bar, and a hard
  stop clicks.
- **The `anullsrc` branch.** `exportClip` maps audio with `0:a?`, so a silent
  source really does produce a video-only file, and `concat` needs the same
  stream count in both segments.

### Text to speech

`say -v Linh -f <file> -o voice.aiff`, then ffprobe for its duration.

Via a file, not argv: `say -f` cannot mistake a title beginning with `-` for
an option, and there is no argv length ceiling to think about. `execFile`
means no shell either way.

The voice and both audio assets are boot checks (`checkStarter`), alongside
the existing three binaries. All of them are hard requirements of every
export, so a missing one should stop the server rather than fail the render
after the download and the encode have already been paid for.

## Modules

`src/starter.ts` — `TITLE_FONT` and `renderTitleArt(title)`. Greedy word wrap,
then the largest font size from 150px down that fits both the width and half
the frame's height. Outline first for every line, then fill for every line: a
per-line stroke-then-fill lets the next line's outline overlap the previous
line's fill.

`server/starter.ts` — `MUSIC_PATH`, `CUE_PATH`, `VOICE`, `starterDuration`,
`checkStarter`, `speak`, `prependStarter`. Both assets live in
`server/assets/`, beside the module, rather than in `media/` — which is the
gitignored clip cache. Depends only on `errors.ts`, so the
server layering stays acyclic: `errors ← {ffmpeg, starter} ← {ytdlp, mask} ←
index`. It takes paths in the caller's temp dir rather than reaching for
`MEDIA_DIR`, which is why it does not sit above `ffmpeg.ts` the way `mask.ts`
does.

`server/index.ts` — `readTitle` and `png` validators; the export route renders
`body.mp4`, speaks the title, and streams `prependStarter`'s output.

`src/state.ts` — `starterTitle` in `AppState` and in the stored record. It is
persisted *unconditionally*, like the marks and unlike the boxes: the
framing-only gate exists for values that are meaningless before `/api/window`
has reported the clip's real size, which a title is not.

`src/main.ts` — the input, and Export gated on a non-blank title. The input
updates state with `setQuiet` for the same reason the URL field does, so no
render follows a keystroke — which means the Export button is flipped *in
place* in the same handler. Without that it stays disabled until some
unrelated `setState` happens along, which reads as "Export is broken" rather
than "type a title first". `doExport` re-checks the title itself rather than
trusting the button it was clicked from.

## Testing

**`server/starter.test.ts`** shells out to real ffmpeg and real `say`, and
covers, against a 1-second fixture clip that is green on the left and red on
the right:

- `speak` reports a duration for a Vietnamese title, and the screen is longer
  than the voice.
- The output's duration is the screen plus the clip, at 1080×1920; the title
  art shows over the screen and is gone over the clip; the seam pixel is
  *mixed* over the screen — which is the assertion that fails if the blur is
  dropped — and pure over the clip.
- Audio, one layer per window, each window chosen so only that layer can be
  heard there: the bed before the voice starts, the voice, the cue in the tail
  slot, and **the clip's own sound** after the cut. The bed's threshold is
  small (0.0005) because the bundled track opens soft — still three orders of
  magnitude above the silence floor. The cue's is high (0.5) because the bed
  alone peaks near a tenth, so nothing but the cue can clear it.

  The last of the four is a regression assertion. `probeMain` originally read
  `-of default=nk=1` and took the first line, which is the *video* stream's —
  so `hasAudio` was false for every clip that had audio, and every export
  silently replaced the clip's sound with the silence stand-in. Every
  stream-shape assertion still passed.
- A non-square-SAR clip concatenates instead of failing. The fixture uses
  40:41 rather than the 1214:1215 seen in the wild because libx264
  normalises a SAR that close to square back to 1:1, which would make the
  fixture prove nothing.

**`src/state.test.ts`** covers the title surviving a save from `trimming`,
where `framed` is false and boxes are carried forward instead of written.

`src/starter.ts` is DOM-driven and untested, like `main`/`editor`/`preview`/
`player`. It was verified by hand: rendered in a real browser, checked for
Vietnamese diacritics in Comic Sans, and round-tripped through a real export.

## Out of scope

- Previewing the starter screen in the canvas. The preview loop composites
  the clip; the screen is an export-time segment.
- A non-Vietnamese voice, or a voice picker. One constant.
- Controls for blur strength, screen duration, font, or either sound.
  Constants in the two modules.
- Reusing the starter title as the download filename. The filename still
  comes from YouTube's title, which is what names the clip.
- Caching the spoken title. `say` takes under a second and the export around
  eight.
