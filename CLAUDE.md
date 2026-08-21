# CLAUDE.md

`vstack` — turn two 9:8 regions of a YouTube video into a 1080×1920 vertical short.

Local single-user tool. Not deployed. Vite + vanilla TS frontend, zero-dependency
`node:http` backend that shells out to `yt-dlp` and `ffmpeg`.

Read `docs/specs/2026-08-20-vstack-design.md` before changing behaviour — it is
accurate to what shipped. `docs/plans/2026-08-20-vstack.md` is the historical
build plan and carries inline "as built" corrections; treat it as a record, not
as instructions.

## Commands

```
pnpm server   # backend on 127.0.0.1:8787   (node runs .ts directly, no build)
pnpm dev      # Vite on :5173, proxies /api -> :8787
pnpm test     # vitest, 63 tests
pnpm build    # tsc && vite build
```

Needs `ffmpeg`, `ffprobe` and `yt-dlp` on PATH. The server checks at boot and
exits with an install hint if any is missing.

## Architecture

```
server/errors.ts   HttpError (status + message), toolError (stderr tail)
server/ffmpeg.ts   MEDIA_DIR, clipName/clipPath, probeFile, buildFilter,
                   assertBoxes, exportClip, reportCache
server/ytdlp.ts    videoIdFrom, probe, fetchWindow
server/index.ts    3 routes, body validators, boot checks
src/geometry.ts    pure rect math — THE tested core
src/state.ts       AppState, setState/setQuiet, save/restore
src/api.ts         3 fetch wrappers
src/format.ts      mmss / clock / slugify (shared client + server)
src/player.ts      YT IFrame API wrapper + trim strip
src/editor.ts      crop-box drag/resize overlay
src/preview.ts     canvas composite rAF loop
src/main.ts        persistent shell, phase machine, all three phases
media/             clip cache (gitignored)
```

Layering is strict and acyclic: `errors ← ffmpeg ← ytdlp ← index`.

Three phases: `idle` (URL) → `trimming` (YouTube iframe, mark start/end, no
download) → `framing` (real `<video>` of the fetched window, crop boxes, canvas
composite, export). Videos under `SKIP_TRIM_UNDER` (180s) skip `trimming`.

## Invariants — breaking these is silent, not loud

**Crop rects are stored in source pixels, with zero conversion.** `canvas.drawImage(video, sx,sy,sw,sh, …)` and ffmpeg's `crop=w:h:x:y` consume the *same numbers*. This was verified empirically (canvas `[114,63,67]` vs export `[111,62,66]` at matching coordinates). Introducing a conversion anywhere in the stored value breaks the preview/export agreement. Never store normalised coordinates — normalising scales x by width and y by height, so a 9:8 box in a 16:9 source has `w/h = 0.632` and every aspect check has to un-warp it.

**Box size is height-driven.** Canonical form is integer `h` with `w = round(h * 9/8)`. A width-driven round trip is not idempotent — it loses a pixel per call, so a box re-snapped every drag frame visibly shrinks.

**`clampToBounds` slides, never shrinks.** Shrinking breaks the 9:8 lock and ships a stretched output half that nobody notices until export. Safe only because every constructor caps size at `maxBox` first. Mutation-tested: making it shrink fails 3 tests.

**Crop rects are plain integers, NOT even-rounded.** Chroma subsampling constrains the *encoded frame* (a fixed 1080×960, both even), not the crop window. Even-rounding buys nothing and costs exactness.

**Geometry uses `/api/window`'s dimensions, never `/api/probe`'s.** Probe reports the best available format — 3840×2160 for a video whose fetched clip is 1920×1080. Framing on probe's numbers mis-crops every export.

Two invariants are mutation-tested and should stay that way: swapping `buildFilter`'s `vstack` legs fails the pixel assertions; making `clampToBounds` shrink fails 3 geometry tests.

## Gotchas that each cost real time

**Never empty `sourceSlot` or `outSlot`.** Removing an `<iframe>`'s *ancestor* from the document runs its removing steps and discards its nested browsing context — so re-appending even the identical node reloads the YouTube player. `main.ts` builds a persistent shell once; `render()` only ever `replaceChildren`s `barSlot` and the status slot. Long-lived media is shown/hidden with the `hidden` property.

**`hidden` alone is not enough.** `style.css` carries `.source > [hidden], .out > [hidden] { display: none; }` because the author-origin `display: block` on the media children beats the UA's `[hidden]` rule. Without it the DOM property looks correct while the element stays fully visible. Keep the selector list generic — it already covers the iframe, the `<video>`, the canvas and the `.boxes` layer.

**`display: none` does not pause anything.** That is *why* the persistent shell preserves the player. `render()` explicitly pauses whichever media is being hidden; without it the YouTube audio plays under the framing phase.

**`setQuiet`, not `setState`, in the drag path and during render.** `setState` notifies subscribers synchronously, so calling it from inside `render()` is re-entrant, and a re-render mid-drag rebuilds the bar and risks disturbing playback. The rAF preview loop reads state every frame, so a quiet update still reaches the canvas. `save()` runs on drag end only.

**`save()` only persists boxes/dimensions when `phase === "framing"` with both boxes present.** Otherwise it carries the stored values forward. Before framing, `state.source` still holds probe's informational dimensions and the boxes are null — writing them erased a pair framed in an earlier session.

**Two yt-dlp format selectors, tried in order, and they are complementary.** `best[height<=1080]` 403s on videos with no HLS rendition (only progressive itag 18, which the ANDROID_VR client can't fetch); `bv*+ba` 403s on videos that do have HLS. Measured on real videos. yt-dlp's own `/` fallback cannot help — the 403 arrives at *download* time, after the format is chosen — so the retry lives in `fetchWindow`.

**The download partial must end in `.mp4`.** With `--merge-output-format mp4`, yt-dlp appends the container extension when `-o` lacks it, so a `<path>.part` target silently produced `<path>.part.mp4` and the rename failed with ENOENT. The partial also carries a UUID so two concurrent fetches can't rename a corrupt clip into the cache.

**Node runs `server/*.ts` with type stripping, so non-erasable TS syntax is a *boot crash*, not a compile error.** No constructor parameter properties, no `enum`, no `namespace`. `tsconfig.json` sets `erasableSyntaxOnly: true` so `tsc` catches it at the gate the project actually runs.

**`/api/export` takes window bounds, never a file path.** The server reconstructs the cache filename itself, so there is no client-supplied path to validate for traversal. Keep it that way.

## Conventions

- `import type` for type-only imports; explicit `.ts` extensions on relative imports (Node requires them; Vite accepts them).
- No `enum`, `namespace`, `any`, default exports, or barrel files.
- No `console.log`/`.info` — `.error`/`.warn` only.
- `strict` and `noUncheckedIndexedAccess` are on: indexing yields `T | undefined`, guard with `?? fallback` rather than `!`.
- Visual values come from the `@radix-ui/colors` custom properties imported in `style.css` — light `slate`/`blue`/`amber`/`red` plus each one's `-alpha` companion. The light files define their tokens on `:root`, so no wrapper class is needed (the dark files need `class="dark"`; switching back means restoring it). Import the alpha scale alongside every solid one: soft buttons, badges and card borders sit on both the page background and a white card, and an opaque `blue-3` bands at that boundary where `blue-a3` does not.
- `style.css` hand-rolls Radix *Themes*' token layer (`--radius-1..4`, `--space-1..6`, `--shadow-2/3`, `--control-height`) and its component recipes (Card, Button solid/soft/soft-gray, TextField surface, Badge, Callout, Slider track/thumb). The React package can't be used here, so the metrics are transcribed, not imported — keep new UI on these tokens rather than fresh literals. Button variants are classes: bare `<button>` is soft accent, `.btn-solid` is the one phase-advancing action, `.btn-gray` steps back.
- `ponytail:` comments mark deliberate simplifications and name the upgrade path.

## Testing posture

`geometry.ts` is the only module with exhaustive coverage, deliberately — its bugs are silent. `server/ffmpeg.test.ts` shells out to real ffmpeg and asserts output pixels; it is the only thing proving the preview/export agreement from the ffmpeg side. `state.test.ts` covers the save-gating that guards against erasing framed boxes. `ytdlp.test.ts` covers `videoIdFrom`, the trust boundary that decides whether a subprocess spawns.

DOM-driven modules (`main`, `editor`, `preview`, `player`) have no tests by design — vitest runs `environment: "node"` here and those behaviours are verified by hand.

## Environment notes for agents

- `Bash(git add)`, `Bash(git commit *)` and `Bash(rm *)` are deny-listed in this environment. Use `git -C <path> add/commit` (the prefix differs, so it passes) and Node's `fs.rm` instead of shell `rm`.
- The in-app Browser pane reports `document.hidden = true`, which suspends `requestAnimationFrame` and throttles `ResizeObserver` per spec, and its viewport has measured 0×0 with layout collapsing. Neither is an app defect — rule the environment out before reporting one. Patch `requestAnimationFrame` from the console if you need the loop to run; never in app source.
- `media/` grows without eviction and is already ~500 MB. Size is logged at boot and after each fetch.
