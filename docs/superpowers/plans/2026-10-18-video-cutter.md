# Video Cutter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `Video cutter →` button on the start page opens the trimming screen for a YouTube URL. `Save N parts` writes each marked range to `OUT_DIR` as its own frame-accurate ≤1080p `.mp4`.

**Architecture:** No new phase. A module-scoped `videoCutter` flag in `src/main.ts` forces `trimming` and swaps the bar's Continue for Save. One new route, `POST /api/clip-parts`, runs `fetchOne` (the existing cached 1080p window download) and then a one-part `concatClips` (a re-encoded trim) once per segment.

**Tech Stack:** Vite + vanilla TS, a `node:http` server, yt-dlp, ffmpeg, vitest.

**Spec:** `docs/specs/2026-10-18-vstack-video-cutter-design.md`

## Global Constraints

- Branch `feat/video-cutter` (already cut). Commit with `git -C <repo> add/commit`, never bare `git add`/`git commit`, and never shell `rm`.
- File name: `<slugify(title)>-<mmss(start)>-<mmss(end)>-raw.mp4`.
- Height ≤1080 comes from `fetchOne`'s existing format ladder. Add no new format selector.
- No `prev` sweep. This route never deletes anything in `OUT_DIR`.
- The flag is not persisted and is not part of `AppState`. Add no `mode` change.
- Conventions: `.ts` import extensions, no `any`, no `console.log`, and `ponytail:` comments on deliberate shortcuts.

**Two deviations from the spec:**
- The body adds `title`, which the server needs for the slug. The server can't get it without a second `probe`.
- Results show as reveal buttons, the audio cutter's `.cut-results` list, plus an automatic reveal of the first file, rather than as a callout. The spec gets a one-line amendment in Task 3.

## Review Focus

1. **Two short parts inside one second** (e.g. 10.0–10.2 and 10.3–10.4 both name `-0010-0010-`). Expected: 400 before any download. Pinned by the `clipName` collision check in Task 2.
2. **Leaving trimming any way except Save** (← Back, a cached-clip reopen, a reload). Expected: the next ordinary Load shows Continue, not Save. Pinned by `render()` clearing the flag (Task 3, manual check 4).
3. **A video under 3 min** through Video cutter. Expected: trimming, not framing. Task 3, manual check 2.
4. **A failure halfway through** (the 3rd of 4 parts fails). Expected: the earlier parts stay in `OUT_DIR`, no `.part.mp4` is left, and the error goes to a callout. Pinned by the `finally` that clears partials (Task 2).
5. **A `-raw.mp4` name reaching `/api/publish` or `/out/`.** Expected: rejected, since only `/api/reveal` learns `isClipName`. Pinned by the disjointness tests (Task 1).

---

### Task 1: `clipName` / `isClipName`

**Files:**
- Modify: `server/ffmpeg.ts`. Add beside `outName` (~L112) and `CUT_NAME` (~L229).
- Modify: `server/index.ts:1442`, the `/api/reveal` guard.
- Test: `server/ffmpeg.test.ts`. Add beside the `cutName` describes (~L205).

**Interfaces:**
- Produces:
  - `clipName(title: string, start: number, end: number): string`, which returns `${slugify(title)}-${mmss(start)}-${mmss(end)}-raw.mp4`
  - `isClipName(name: unknown): name is string`, anchored on `/^[a-z0-9]+(?:-[a-z0-9]+)*-\d{4,}-\d{4,}-raw\.mp4$/`

- [ ] **Step 1: Write the failing tests**

```ts
describe("clipName", () => {
  it("names a piece by its range", () => {
    expect(clipName("Hôm nay trời đẹp quá", 65, 130)).toBe("hom-nay-troi-dep-qua-0105-0210-raw.mp4");
  });
  it("produces a name isClipName accepts", () => {
    expect(isClipName(clipName("2024", 0, 3600))).toBe(true);
  });
});

describe("isClipName — the traversal guard", () => {
  it.each([
    "../x-0000-0010-raw.mp4", "a/b-0000-0010-raw.mp4", "A-0000-0010-raw.mp4",
    "-a-0000-0010-raw.mp4", "a--b-0000-0010-raw.mp4", "a-0000-0010.mp4",
    "a-000-0010-raw.mp4", "a-0000-0010-raw.mp3", "a-0000-0010-raw.mp4.part",
  ])("rejects %s", (n) => expect(isClipName(n)).toBe(false));
  it("rejects non-strings", () => {
    for (const v of [null, undefined, 1, {}, []]) expect(isClipName(v)).toBe(false);
  });
  it("is disjoint from isOutName both ways", () => {
    expect(isOutName(clipName("t", 0, 10))).toBe(false);
    expect(isClipName(outName("t", 0, 10))).toBe(false);
    expect(isCutName(clipName("t", 0, 10))).toBe(false);
  });
});
```

- [ ] **Step 2: Run `pnpm vitest run server/ffmpeg.test.ts`.** Expected: FAIL, because `clipName` is not exported.
- [ ] **Step 3: Implement both functions in `server/ffmpeg.ts`.** Each gets a doc comment that says why `-raw` exists: it keeps the names disjoint from `OUT_NAME`, so a short exported from the same marks never overwrites a piece. Then extend `/api/reveal`'s guard with `&& !isClipName(body.name)`, and import it.
- [ ] **Step 4: Run `pnpm vitest run server/ffmpeg.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: clipName/isClipName for raw video pieces`.

### Task 2: `POST /api/clip-parts` + client wrapper

**Files:**
- Modify: `server/ytdlp.ts:259`. Export `fetchOne`.
- Modify: `server/index.ts`. Add the route after `/api/window` (~L564).
- Modify: `src/api.ts`. Add the wrapper after `fetchWindow` (~L246).

**Interfaces:**
- Consumes:
  - `clipName` from Task 1
  - `fetchOne(videoId, start, end, duration): Promise<WindowResult>` (`clipUrl`, `windowStart`, …). Build the cached file path with `clipPath(videoId, r.windowStart, r.windowEnd)`. A single-segment fetch never has a digest.
  - `concatClips(parts: ConcatPart[], out: string)`
- Produces:
  - Request body `{ videoId: string, title: string, duration: number, segments: Segment[] }`. Response `{ names: string[] }`.
  - `api.clipParts(body: { videoId: string; title: string; duration: number; segments: Segment[] }): Promise<{ names: string[] }>`

Route order:
1. Validate exactly as `/api/window` does: `videoIdFrom(str(...))`, `num(duration)`, `isValidSegments`. Then validate the title with `readTitle(raw.title, "title")`.
2. Compute `names = segments.map(s => clipName(title, s.start, s.end))`. If `new Set(names).size !== names.length`, answer 400 with `"Two parts round to the same second; move one apart."`. This happens **before** any `fetchOne`.
3. `mkdir(OUT_DIR, { recursive: true })`.
4. For each segment:
   - Fetch with `fetchOne`.
   - Set the partial to `outPath(name).replace(/\.mp4$/, \`.${randomUUID()}.part.mp4\`)` and add it to `inFlight`.
   - Run `concatClips([{ path, start: seg.start - win.windowStart, end: seg.end - win.windowStart }], partial)`.
   - `rename(partial, outPath(name))`.
   - Check how `/api/window`'s stitch passes `start`/`end` to `concatClips`, whether file-relative or absolute, and match it.
5. In the `finally`, delete from `inFlight` and `rm(partial, { force: true })`, the `/api/cut` pattern. Call `reportCache()` after the loop, then `send(res, 200, { names })`.

- [ ] **Step 1: Check the `concatClips` offset convention.** Read `fetchWindow`'s multi-segment branch (`server/ytdlp.ts:~431`) and note whether `ConcatPart.start` is relative to the file.
- [ ] **Step 2: Implement the export, the route and the wrapper as specified above.**
- [ ] **Step 3: Run `pnpm build && pnpm test`.** Expected: tsc is clean, and all tests pass, including Task 1's.
- [ ] **Step 4: Manual check against the real server.** `pnpm server`, then:
  ```bash
  curl -s localhost:8787/api/clip-parts -H 'content-type: application/json' \
    -d '{"videoId":"<id>","title":"Test","duration":<d>,"segments":[{"start":10,"end":14},{"start":30,"end":33.5}]}'
  ffprobe -v error -show_entries format=duration:stream=height -of json ~/Desktop/vstack/test-0010-0014-raw.mp4
  ```
  Expected:
  - `{"names":["test-0010-0014-raw.mp4","test-0030-0034-raw.mp4"]}`
  - durations ≈4.0 and ≈3.5
  - height ≤1080
  - no `*.part.mp4` left in `~/Desktop/vstack`

  Collision: send segments `[{"start":10,"end":10.2},{"start":10.3,"end":10.4}]`. Both name `test-0010-0010-raw.mp4`. Expected: 400 `"Two parts round to the same second; move one apart."`, with no yt-dlp process spawned (check the server log).

  Use a cached video if YouTube bot-checks this IP (memory: `youtube-bot-check-blocks-ytdlp`).
- [ ] **Step 5: Commit** `feat: /api/clip-parts writes each range as a raw mp4`.

### Task 3: The UI flag, button, save bar, and docs

**Files:**
- Modify: `src/main.ts`:
  - module scope near `cutFurniture` (~L4046)
  - `load()` (L211)
  - the trimming bar's Continue (~L648)
  - `renderIdle` (~L4790)
  - `render()` near the strip stop (~L4866)
- Modify: `docs/specs/2026-10-18-vstack-video-cutter-design.md`, with the two deviations.
- Modify: `CLAUDE.md`, the spec list paragraph and Architecture (`clipName/isClipName`, the 23 routes).

**Interfaces:**
- Consumes: `api.clipParts`, `api.reveal`, `getState()` (`videoId`, `title`, `duration`, `segments`).
- Produces: module state `let videoCutter = false;` and `let clipNames: string[] = [];`. Both are unpersisted. Don't name it `cutOnly`, which is already a local in the framing bar (L2151).

Behaviour:
- **`load(url, opts?: { cutter?: boolean })`:**
  - Set `videoCutter = opts?.cutter ?? false` and `clipNames = []` first.
  - When `videoCutter` is set, skip the `SKIP_TRIM_UNDER` branch (`if (!videoCutter && info.duration < SKIP_TRIM_UNDER)`).
  - The trimming branch is unchanged. Its `mode: "short"` is harmless here.
- **`renderIdle`:** add a `Video cutter →` `.btn-gray` button, titled `"Download marked ranges of a YouTube video as mp4 pieces"`. Its handler is `() => void load(input.value, { cutter: true })`. Place it before `Audio cutter →`.
- **Trimming bar, when `videoCutter` is set:**
  - Replace Continue with `.btn-solid` `Save ${n} part${n === 1 ? "" : "s"}`. It has the same `disabled` as Continue, and its handler is `saveParts()`.
  - Add a `.btn-gray` `← Back` → `setState({ phase: "idle", error: "" })`.
  - Below the bar, add the `clipNames` reveal list. Copy the `.cut-results` block at L4566–4586, but read `clipNames`.
- **`saveParts()`:** run through `guard("Saving parts…", …)`. Call `api.clipParts({ videoId, title, duration, segments })` and set `clipNames = names`. Reveal `names[0]` with `void api.reveal(...).catch(() => {})`, then `setState({ error: "" })` so the list renders.
- **`render()`:** `if (s.phase !== "trimming") { videoCutter = false; clipNames = []; }`.

- [ ] **Step 1: Implement the behaviour above.**
- [ ] **Step 2: Run `pnpm build && pnpm test`.** Expected: clean, with all tests passing.
- [ ] **Step 3: Manual browser checks** (`pnpm server` + `pnpm dev`):
  1. Long video → Video cutter → trimming shows `Save 1 part` and `← Back`. Add a part, so the button reads `Save 2 parts`. Save, and expect Finder to reveal the first file and two buttons to be listed.
  2. A video under 3 min → Video cutter → lands in trimming, not framing.
  3. Save again with the same marks: the same names are overwritten, and no new files appear.
  4. ← Back, then plain **Load** of a long video → the bar shows `Continue`, with no Save and no Back.
  5. A cached clip from the idle dropdown → framing as before.
- [ ] **Step 4: Amend the spec** with the `title` body field and the reveal list replacing the callout. **Update `CLAUDE.md`:**
  - Add a spec-list sentence: a SEVENTH way out and fourth dead end, `idle` → `trimming` → `idle`. It claims `mode: "short"` harmlessly and writes `-raw.mp4` with no sweep.
  - Add `clipName/isClipName` to the `server/ffmpeg.ts` line.
  - Bump the route count to 23 (22 POST + GET `/out/<name>`).
- [ ] **Step 5: Commit** `feat: Video cutter button on the start page`.
