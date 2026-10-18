# vstack — video cutter

Supersedes nothing. A seventh way out of `idle` and a fourth dead end:
download a YouTube video's marked ranges as raw `.mp4` pieces, one file per
range, for use in another editor.

## Flow

`idle` → `trimming` → `idle`. No new phase.

- `idle` gains **`Video cutter →`**, which reads the URL field (same as
  Load) and calls `load(url, { cutOnly: true })`.
- `cutOnly` is a module-scoped, unpersisted flag in `src/main.ts`, like
  `cutFurniture`. When it is set, `load()` always enters `trimming`, even
  for videos under `SKIP_TRIM_UNDER`, because marking ranges is the whole
  point here.
- Inside `trimming`, a set `cutOnly` swaps **Continue** for **`Save N
  parts`** (`.btn-solid`). Everything else on the bar is unchanged:
  `+ Part`, Set Start/End, nudges, `?t=` paste, `MAX_SEGMENTS`.
- When a save succeeds, the result names show in a callout and the files
  are revealed in Finder (`/api/reveal` on the first one). The user stays
  in `trimming`, so they can adjust and save again.
- `← Back` (or any other route back to `idle`) clears `cutOnly`. `render()`
  clears it whenever `phase !== "trimming"`, so no exit can leak it into a
  later short.
- `load()`'s trimming branch already sets `mode: "short"`, and that is
  harmless here: this flow never reaches `preview`.

## Server

`POST /api/clip-parts` takes `{ videoId, duration, segments }`.

- It validates with `videoIdFrom` and `isValidSegments` before any spawn,
  the same as `/api/window`.
- For each segment, `fetchOne` (exported from `ytdlp.ts`) fetches a cached
  padded window. Downloads are capped at 1080p and use the existing format
  ladder and cache.
- `concatClips([{ path, start, end }], partial)` with ONE part
  **re-encodes** the trim. This makes the cut frame-accurate, unlike `-c
  copy`, which snaps to keyframes 2–5s apart. No new ffmpeg function is
  needed.
- Each part is written to `OUT_DIR` under a UUID partial name tracked in
  `inFlight`, then renamed.
- The response is `{ names }`.

## Naming

The pattern is `<slug(title)>-<mmss start>-<mmss end>-raw.mp4`. It gets a
new anchored `CLIP_NAME`/`isClipName` beside `CUT_NAME`, and `/api/reveal`
accepts it.

- The `-raw` suffix keeps the names disjoint from `OUT_NAME`. Without it,
  a short exported from the same marks would overwrite a piece, and the
  short's sidecar logic would act on it.
- Names are addressed by range, not by index, so there is **no `prev`
  sweep**. Saving the same range again overwrites it, and a changed range
  gets a new name that can't be mistaken for the old one. Nothing here
  deletes a file.
- If two parts round to the same `mmss` pair, the server answers 400
  before fetching anything.

## Tests

- `server/ffmpeg.test.ts`: the usual exhaustive name-guard set for
  `isClipName`, plus the disjointness pair (a `-raw.mp4` name is not an
  `isOutName` name, and an `outName` is not an `isClipName` name).
- No new ffmpeg test: a one-part `concatClips` is already covered.
- The route, the button and the flag are not tested, like the rest of the
  network and DOM surface.

## Out of scope

Resolutions above 1080p, stream copy, joining parts into one file, and
uploads (use the audio cutter's flow for local files).

## As built

- The body also carries `title` (through `readTitle`): the server needs it
  for the slug and has no title without a second `probe`.
- `clipName` was already taken (the `media/` cache name), so the pair is
  `pieceName`/`isPieceName`, and the flag is `videoCutter`, since `cutOnly`
  is a local in the framing bar.
- Results show as the audio cutter's `.cut-results` reveal buttons, not a
  callout; the first file is still revealed automatically.
- The flag is set just before `load()`'s trimming `setState`, not at its
  top: `guard`'s busy render is still in `idle`, and `render()` would clear
  it there.
- The name carries the video id: `<slug>-<videoId>-<mmss>-<mmss>-raw.mp4`.
  The slug alone collides across videos (60-char cut, `"clip"` fallback for
  non-Latin titles), which would silently overwrite another video's piece.
- The cutter never writes the per-video record: `save()` in `src/main.ts` is
  a no-op while `videoCutter` is set, so the cutter's ranges cannot replace
  the short's marks for the same video. It still READS the record, so it
  opens on the short's marks.
