# Follow-ups

Everything below was found during the build and deliberately *not* fixed, with the
reasoning. Nothing here is a known-broken feature — the app works end to end. Ordered
by what I would pick up first.

## 1. `restore()`'s validation paths have no regression test

`src/state.ts`'s `restore` now drops any box that fails `isValidBox` and coerces marks
through `Number.isFinite`. Both were verified by hand (injecting a right-size/wrong-aspect
box and a string `end` into `localStorage`) and neither has an automated test.

This guards silent data loss and stops the client generating requests its own server
rejects, so it deserves coverage on exactly the reasoning used for the `save()` gating
tests that *do* exist. It was parked only because the review process allows one fix wave
at the final gate and it had been spent — not because the two cases differ on merit.

`state.ts` is pure logic over `localStorage` and vitest runs `environment: "node"`, so a
`Map`-backed stub on `globalThis.localStorage` is enough. See `src/state.test.ts` for the
existing pattern.

## 2. The Re-fetch tooltip overpromises

`src/main.ts`'s Re-fetch button says "Download this window again", but `fetchWindow`'s
`existsSync` cache check means clicking it without moving the marks is a no-op cache hit.

The original finding was that the button could *never* be enabled — `inWindow` is
unconditionally true, because `windowStart = max(0, floor(start − PAD))` and framing's only
mark input is bounded by the clip's own span. That is fixed; the button is live. But the
copy now claims something it doesn't do for the most likely way it's invoked.

Either soften the tooltip, or give `/api/window` a `force` flag that bypasses the cache
check. The latter is more useful — a forced re-download is the point when a cached clip is
suspect.

## 3. `media/` grows without eviction, and near-duplicate windows multiply

The cache key is the *padded* window (`floor(start − 5)`–`ceil(end + 5)`), so a
one-second mark nudge is a cache miss and a whole new multi-tens-of-MB download. One
video accumulated 17 clips, several of them near-identical long windows.

Size is now reported at boot and after each fetch, so it can't grow silently. Two cheap
improvements if it becomes annoying:

- Snap window bounds to a coarse grid (e.g. `windowStart = floor((start − PAD)/15)*15`,
  `windowEnd` up to the next 15) so nudges hit the cache. Safe — both the client's
  `inWindow` test and the server's window check derive from the returned bounds. Deferred
  because it changes cache keys.
- An LRU or an age-based sweep.

## 4. Default boxes frame onto a pillarboxed source's black bars

`defaultBoxes` pins the two boxes to the left and right frame edges, which is correct for
the two-speaker wide-shot case. For a source that is 4:3 content pillarboxed inside a 16:9
frame (238px bars each side — the Rick Astley test video is exactly this), the defaults
include the bars.

Left alone deliberately: the framing UI shows real pixels under the boxes, so the user sees
it immediately and one drag fixes it. Auto-detecting content bounds with ffmpeg
`cropdetect` is real scope for a problem one drag already solves.

## 5. Smaller, all deliberate

- **Multi-pointer drags** aren't keyed by `pointerId`, so a second concurrent pointer
  overwrites the first. Mouse-first desktop tool, self-recovering, no touch target stated.
- **`isValidBox` admits one pixel of slack** on width-constrained sources (it accepts an `h`
  one greater than `maxBox.h`). Still integer, still exactly 9:8, still in bounds — safe to
  crop. `isValidBox` answers "is this legal", not "is this in the image of the constructors".
- **A bad video id returns 500, not 4xx.** Distinguishing "Video unavailable" from a genuine
  tool failure means parsing yt-dlp's prose, which the design explicitly rejects as a stale
  translation layer. The user sees the same verbatim message either way.
- **A failed fetch leaves an empty `media/<videoId>/` directory.** Cosmetic.
- **Orphaned partials from a hard-killed process are unrecoverable** — the partial name
  carries a UUID, so no later request revisits them. They can never be renamed into the
  served path, so they cannot poison the cache; they just sit there under the same
  no-eviction trade-off as everything else in `media/`.
- **A client disconnect mid-export leaves ffmpeg running** to completion. Correct for the
  deliberately blocking, no-queue design.
- **`assertBoxes` runs twice** (route and `exportClip`). Cheap, in-process, and it is the
  defense-in-depth that justifies `buildFilter` having no guard of its own.
- **A genuine ffmpeg failure can echo the temp path** to the client. Same precedent as the
  verbatim yt-dlp stderr; unauthenticated localhost tool.
- **`ProbeResult`/`WindowResult` are declared twice** (`src/api.ts` and `server/ytdlp.ts`),
  structurally identical with no shared source of truth. The server already imports from
  `src/`, so sharing the types costs nothing.
- **The output filename is derived twice** — the server slugifies into a
  `content-disposition` nothing reads, because the client downloads from a Blob with its own
  `download` attribute. One derivation is dead.
- **`fromDisplay` has no production caller** while `editor.ts` hand-rolls the same
  display→source conversion inline. Two ways to do one thing, and the exported one is unused.
- **There is no way to load a second video** without reloading the page — nothing returns to
  the `idle` phase. A "Load another" control is ~5 lines and would also make
  `ensureSourcePlayer`'s superseded-mount guards earn their keep.
- **`ProbeResult.isLive` is dead on both sides** — the route 400s live videos before
  returning, so it is always `false`, and the client never reads it.
- **`.nvmrc` says `lts/*`** but this machine ran Node 23.10.0 during the build, which is not
  an LTS and not the Node 24 the spec names. Type-stripping semantics are exactly the thing
  that varies across those.

## Things that are NOT bugs, recorded so they don't get "fixed"

- **Black bands in an export** are usually the source's own letterbox/pillarbox reproduced
  faithfully. Measure the source before assuming a crop bug — one investigation ruled out
  the scaler and `split` before finding 1444×1080 content inside a 1920×1080 frame.
- **The in-app Browser pane** reports `document.hidden = true` (suspending `rAF`, throttling
  `ResizeObserver`) and has measured a 0×0 viewport with layout collapsing. Rule the
  environment out before filing an app defect.
