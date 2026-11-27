# Per-box time offsets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `− N +` control on every framing crop box that shifts that box's footage by N seconds in the exported video, correct across multi-part trims, cuts and speed-ups.

**Architecture:** For each distinct non-zero offset the export builds a "twin" stitch from the PAD'd per-part downloads with every leg moved by the offset (pure `shiftLegs`, then the existing `concatClips`); the main timeline is rebuilt from the same sources at offset 0. `buildFilter` then feeds each box from its own source input. The preview does not shift; it badges shifted boxes.

**Tech Stack:** Vite + vanilla TS client, `node:http` server, ffmpeg, vitest.

**Spec:** `docs/specs/2026-11-26-vstack-box-offsets-design.md`

## Global Constraints

- `MAX_OFFSET = PAD` (5), exported from `src/geometry.ts`. Offsets are integers in `[-MAX_OFFSET, MAX_OFFSET]`.
- An export with every offset 0 (or the field absent) is byte-identical to today's: same `buildFilter` string, same route path, no extra passes.
- Input indices in `exportClip`: 0 clip, 1 mask, then badges, then twins LAST. Twin inputs declared before `-ss`.
- Audio always maps from input 0.
- Shifted range leaving its file SLIDES back inside, never shrinks.
- Server never takes a path from the body; part files are rebuilt with `clipPath`.
- Preview does not shift (`ponytail:` comment naming the hidden-`<video>`-per-offset upgrade path).
- Conventions per CLAUDE.md: `import type`, `.ts` extensions, no `enum`/`any`/default exports, erasable syntax only, `console.error/warn` only.
- The user commits himself (guard-vcs hook). "Commit" steps = stop and propose the message; do not run `git commit`.

## Review Focus

1. Two parts of one stitch at different resolutions, with a cut removing all of part 0's range → twin must still be the main clip's size (Task 2 test).
2. A shifted leg crossing a segment seam → each piece reads its own part, no bleed (Task 1 + Task 4 tests).
3. A shift past the video's own start (part window clamped at 0) → slides, twin duration equals main's (Task 1 test).
4. A stale/hand-edited localStorage offset (non-integer, 99, too many entries) → dropped to 0 on restore (Task 5 test).
5. Same offset on two boxes → one twin, not two (Task 3 test).

---

### Task 1: `MAX_OFFSET` and pure `shiftLegs`

**Files:**
- Modify: `src/geometry.ts` (beside `PAD`)
- Modify: `src/segments.ts`
- Test: `src/segments.test.ts`

**Interfaces:**
- Produces:
  - `export const MAX_OFFSET = PAD;` in `src/geometry.ts`. (`segments.ts` imports nothing — the route and client import `MAX_OFFSET` from `geometry.ts`.)
  - In `src/segments.ts`:
    ```ts
    /** Clip time [clipStart, clipEnd] lives in file `file` from fileStart; the file is fileLength s long. */
    export type LegSource = { file: number; clipStart: number; clipEnd: number; fileStart: number; fileLength: number };
    /** File-relative range in source `file`. */
    export type ShiftedLeg = { file: number; start: number; end: number; speed: 1 | Speed };
    export function shiftLegs(legs: Leg[], sources: LegSource[], offset: number): ShiftedLeg[];
    ```

- [ ] **Step 1: Write failing tests** in `describe("shiftLegs")`:
  - `identity at offset 0`: one source `{file:0, clipStart:0, clipEnd:30, fileStart:5, fileLength:40}`, legs `[{start:2,end:8,speed:1}]` → `[{file:0,start:7,end:13,speed:1}]`.
  - `moves by the offset`: same, offset 3 → `start:10,end:16`; offset -2 → `5,11`.
  - `splits a leg at a seam`: sources `[{file:0,clipStart:0,clipEnd:10,fileStart:5,fileLength:20},{file:1,clipStart:10,clipEnd:20,fileStart:5,fileLength:20}]`, leg `{start:8,end:12,speed:1}`, offset 3 → `[{file:0,start:16,end:18,…},{file:1,start:8,end:10,…}]`.
  - `slides at the file start, keeping length`: `{fileStart:0,…}`, leg `{start:1,end:4}`, offset -3 → `{start:0,end:3}`.
  - `slides at the file end, keeping length`: fileLength 20, file range `[15,18]` + offset 4 → `{start:17,end:20}`.
  - `keeps speed`: leg speed 4 → output speed 4.
  - `duration preserved`: for the seam fixture and offsets −5..5, `legsDuration(shiftLegs(...))` (map to `Leg` shape) equals `legsDuration(legs)` within 1e-9.
- [ ] **Step 2: Run** `pnpm vitest run src/segments.test.ts` — FAIL, `shiftLegs` not exported.
- [ ] **Step 3: Implement.** Split each leg at every source's `[clipStart, clipEnd]` it overlaps; map piece to `fileStart + (t - clipStart) + offset`; slide by `max(0, -start)` / `-max(0, end - fileLength)`. Add `MAX_OFFSET` to geometry.
- [ ] **Step 4: Run** same command — PASS. Then mutation check by hand: remove the seam split (map whole leg via the source containing `leg.start`) → `splits a leg at a seam` fails. Restore.
- [ ] **Step 5: Propose commit** `feat: shiftLegs maps clip legs onto shifted source files`.

### Task 2: `concatClips` forced shape

**Files:**
- Modify: `server/ffmpeg.ts` (`concatClips`, ~line 678)
- Test: `server/ffmpeg.test.ts`

**Interfaces:**
- Produces: `concatClips(parts: ConcatPart[], out: string, shape?: { width: number; height: number; fps: string }): Promise<string>`. Absent → `probed[0]` as today.

- [ ] **Step 1: Failing test** `concatClips honours a forced shape`: two lavfi fixtures, part A 640x360, part B 320x180 (each 2s, with audio). Call `concatClips([{path:B,start:0,end:1}], out, {width:640,height:360,fps:"30/1"})`; `probeFile(out)` → `width 640, height 360`. Second assertion: without `shape` → 320x180 (unchanged behaviour).
- [ ] **Step 2: Run** `pnpm vitest run server/ffmpeg.test.ts -t "forced shape"` — FAIL (320).
- [ ] **Step 3: Implement** `const shape = forced ?? probed[0]`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Propose commit** `feat: concatClips takes a forced output shape`.

### Task 3: Twin inputs in `buildFilter` / `exportClip`

**Files:**
- Modify: `server/ffmpeg.ts` (`buildFilter` ~470, `ExportOpts` ~434, `exportClip` ~582)
- Test: `server/ffmpeg.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `buildFilter(layout, boxes, customs = [], sources?: { boxes: number[]; customs: number[]; twinBase: number })` — `boxes[i]`/`customs[j]` = 0 for main or `k ≥ 1` for twin k (1-based into `ExportOpts.twins`); twin k is ffmpeg input `twinBase + k - 1`. Absent/all-0 → today's exact string.
  - `ExportOpts.twins?: string[]` plus `ExportOpts.sourceOf?: { boxes: number[]; customs: number[] }` (same 0/k meaning). `exportClip` appends `-i twin` per entry after badges, computes `twinBase = 2 + badgeCount`.
  - `export function distinctOffsets(cells: number[], customs: number[]): number[]` — sorted ascending, non-zero, unique; and `export function sourceIndex(offset: number, distinct: number[]): number` → 0 for 0 else `distinct.indexOf(offset) + 1`. (Server-side, in `ffmpeg.ts`.)

- [ ] **Step 1: Failing tests:**
  - `buildFilter with no sources is unchanged`: snapshot-free — compare `buildFilter(L, B, C)` to `buildFilter(L, B, C, {boxes:[0,0], customs:[0], twinBase:3})` → equal strings.
  - `buildFilter feeds a box from its twin`: 2-cell layout, `sources {boxes:[0,1], customs:[], twinBase:2}` → string contains `[0:v]split=1[c0]` and `[2:v]split=1[c1]` and still contains the unchanged `xstack=inputs=2`.
  - `distinctOffsets dedupes`: `([3,0],[3,-2])` → `[-2,3]`; `sourceIndex(3,[-2,3]) === 2`.
  - Real export `a twin feeds its cell`: main fixture solid red 2s, twin fixture solid blue 2s, same size; 2-cell layout, `twins:[blue]`, `sourceOf {boxes:[0,1], customs:[]}`; sample centre of cell 0 → red, cell 1 → blue.
- [ ] **Step 2: Run** `pnpm vitest run server/ffmpeg.test.ts -t "twin|distinctOffsets|no sources"` — FAIL.
- [ ] **Step 3: Implement.** One `split` per source actually used (`[0:v]` for source 0, `[${twinBase+k-1}:v]` for twin k), labels `[c i]`/`[k j]` unchanged so the rest of the graph is untouched. When every source is 0, emit exactly today's single `[0:v]split=…` line.
- [ ] **Step 4: Run** — PASS; full `pnpm vitest run server/ffmpeg.test.ts` green (the existing xstack mutation pins still hold).
- [ ] **Step 5: Propose commit** `feat: exportClip feeds boxes from shifted twin inputs`.

### Task 4: Route — validation, part resolution, timelines

**Files:**
- Modify: `server/ytdlp.ts` (add `partPath`)
- Modify: `server/ffmpeg.ts` (add `buildTimelines`)
- Modify: `server/index.ts` (`/api/export`, ~690–960)
- Test: `server/ffmpeg.test.ts`, `server/ytdlp.test.ts`

**Interfaces:**
- Consumes: `shiftLegs`, `LegSource` (Task 1), `concatClips(…, shape)` (Task 2), `distinctOffsets`, `sourceIndex`, `ExportOpts.twins/sourceOf` (Task 3), `MAX_OFFSET`.
- Produces:
  - `server/ytdlp.ts`: `export async function partPath(videoId: string, seg: Segment): Promise<string | null>` — `windowStart = max(0, floor(seg.start - PAD))`; readdir `media/<id>/`, `parseClipName`, digest `""`, same `windowStart`, `windowEnd >= seg.end`; returns `clipPath(...)` or `null`.
  - `server/ffmpeg.ts`: `export async function buildTimelines(opts: { legs: Leg[]; files: string[]; sources: LegSource[]; offsets: number[]; shape: {width:number;height:number;fps:string}; dir: string }): Promise<{ main: string; twins: string[] }>` — `main` = `concatClips(shiftLegs(legs,sources,0) mapped to files, dir/main.mp4, shape)`; one twin per entry of `offsets` (already distinct, non-zero) at `dir/twin-<o>.mp4`.

- [ ] **Step 1: Failing tests:**
  - `ytdlp.test.ts` `partPath finds the un-digested part`: `MEDIA_DIR` is a fixed constant, so write fixtures under `MEDIA_DIR/<unique-test-id>/` (empty files suffice — `partPath` only reads names) and remove that dir in `afterAll` with `fs.rm`; use that id as the videoId with `<id>/7-25.mp4`, `<id>/0-18-abcdef12.mp4`; `partPath(id,{start:12,end:20})` → path ending `7-25.mp4`; `{start:40,end:45}` → `null`.
  - `ffmpeg.test.ts` `buildTimelines shifts each part on its own` (the anti-goal): two part fixtures 12s each whose colour changes every second (lavfi `color` segments concatenated, or `testsrc`-free: build with `geq` from `floor(T)` → known grey level per second; part 2 uses a different hue so parts are distinguishable). Sources mimic a 2-segment stitch with `fileStart` 5. Legs = whole clip. `offsets [2]`. Sample the twin at output t = clipEnd₁ − 0.5 (just before the seam): colour equals PART 1's second `fileStart + t + 2`, not part 2's. Sample at t = 1: twin's second equals main's second + 2.
  - Same test with legs from `planLegs(0, 14, [{start:3,end:4}], [{start:6,end:8,speed:2}])`: twin duration equals main duration within one frame (1/30).
- [ ] **Step 2: Run** `pnpm vitest run server/ffmpeg.test.ts server/ytdlp.test.ts -t "partPath|buildTimelines"` — FAIL.
- [ ] **Step 3: Implement `partPath`, `buildTimelines`.**
- [ ] **Step 4: Implement the route.** Read `raw.offsets` (absent → `[]`; else array, length ≤ cells, each `Number.isInteger` and `|o| ≤ MAX_OFFSET`, else 400 "Bad offsets."); each `customs[j].offset` same rule (400 "Bad custom offset."), stripped before `assertCustoms`. If all zero → existing path untouched. Otherwise:
  - single range (`digest === ""`): `files=[input]`, one source `{file:0, clipStart:windowStart, clipEnd:windowEnd, fileStart:0, fileLength:source.seconds}` — clip time is source time here, so `fileStart` is 0 and `clipStart` is `windowStart`.
  - stitch: require `raw.segments`, `isValidSegments(segs, Infinity)` and `segmentDigest(segs) === digest` (400 `"Trim ranges don't match this clip — re-open it from Trim to use offsets."`); per segment `partPath` (404 `"Part ${i+1} of this clip is no longer cached; re-fetch it from Trim."`), cumulative `clipStart`, `fileStart = seg.start - part.windowStart`, `fileLength` from `probeFile`.
  - `buildTimelines` with `shape` = the cached clip's probe; `exportClip` with `input: main, start: 0, twins, sourceOf` mapped through `sourceIndex`.
- [ ] **Step 5: Run** `pnpm vitest run` — all green; `pnpm build` clean.
- [ ] **Step 6: Propose commit** `feat: /api/export honours per-box offsets`.

### Task 5: Client state — offsets persisted and restored

**Files:**
- Modify: `src/custom.ts` (`CustomBox` gains `offset?: number`)
- Modify: `src/state.ts` (`AppState.offsets: number[]`, `Saved.offsets`, `save`, `normalizeSaved`/`restore`)
- Modify: `src/main.ts` (layout switch clears `offsets` alongside `boxes`)
- Test: `src/state.test.ts`, `src/custom.test.ts`

**Interfaces:**
- Produces: `AppState.offsets: number[]` (cellsOf order, initial `[]`); `export function cleanOffset(v: unknown): number` in `src/geometry.ts` → integer in range else 0.

- [ ] **Step 1: Failing tests:**
  - `cleanOffset`: `3→3`, `-5→-5`, `6→0`, `1.5→0`, `"3"→0`, `null→0`.
  - `state.test.ts` `offsets persist under the framing gate`: framing with full boxes and `offsets:[0,3]` → restored `[0,3]`; same save from `trimming` → stored offsets carried forward, not overwritten.
  - `restore drops bad offsets`: stored `[0, 9, "x"]` on a 2-cell layout → `[0, 0]` (truncated to cell count, cleaned).
  - `a custom's offset survives restore`: custom `{…, offset: -2}` → `-2`; `offset: 7` → `0`.
  - `isValidCustom ignores offset`: valid custom plus `offset: 3` still valid.
- [ ] **Step 2: Run** `pnpm vitest run src/state.test.ts src/custom.test.ts src/geometry.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Gate `offsets` exactly as `boxes` is gated in `save()` (line ~534).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Propose commit** `feat: persist per-box offsets`.

### Task 6: UI — the `− N +` control, canvas badge, request body

**Files:**
- Modify: `src/editor.ts` (`mountEditor` opts gain `offset?: { get(i: number): number; set(i: number, v: number): void; disabled: string | null }`)
- Modify: `src/main.ts` (`sourceEditor` mount ~1546; `doExport` ~1727)
- Modify: `src/preview.ts` (badge)
- Modify: `src/api.ts` (`exportClip` body: `offsets?: number[]`, `segments?: Segment[]`; `customs` carries `offset`)
- Modify: `src/style.css`

**Interfaces:**
- Consumes: `AppState.offsets`, `CustomBox.offset`, `MAX_OFFSET` (Tasks 1, 5).

- [ ] **Step 1: Editor control.** Source overlay only. Per node: `.box-offset` group above the box's top edge — `−` button, label (`0`, `+N`, `-N`), `+` button; buttons `disabled` at ±`MAX_OFFSET`, all disabled with `title = disabled` when `disabled !== null`. `pointerdown` stops propagation (as `.box-remove` does). Click → `set(i, v)`, label updated in place. Cells and pieces both (pieces' source nodes are the second editor mount, if separate, or labelFrom ≥ cells).
- [ ] **Step 2: main.ts wiring.** `set` writes `setQuiet({ offsets })` or the custom's `offset` (read `getState()`, never the render snapshot — the `+ Box` lesson), then `save()`. `disabled` = `"Offsets need this clip's trim ranges — re-open it from Trim."` when `s.clipDigest !== ""` and `s.segments.length < 2`, else `null`.
- [ ] **Step 3: Request body.** `offsets: s.offsets` (send only if any non-zero), `customs` as-is (offset rides along), `segments: s.segments` when `clipDigest !== ""` and any offset non-zero.
- [ ] **Step 4: Canvas badge.** In the preview draw loop, after the composite and before the mask, for each box with offset ≠ 0 draw `+3s`/`-2s` in its top-left corner (cell rect or `custom.out`), skipped when `showThumb`. `// ponytail: preview does not shift; upgrade = one hidden <video> per distinct offset synced to currentTime + offset.`
- [ ] **Step 5: Verify.** `pnpm build` clean; `pnpm vitest run` green. By hand (`pnpm server` + `pnpm dev`): set cell 2 to `+3`, label reads `+3`, canvas badge shows `+3s`, reload keeps it, export a single-range clip and a 2-part clip with one cut — in the output, cell 2 shows the moment 3 s later than cell 1, and at the join no footage from the other part. Switch layout → cell offsets reset, piece offsets kept.
- [ ] **Step 6: Propose commit** `feat: per-box offset control in framing`.

### Task 7: Docs

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1:** Add the spec to the spec list (one sentence: supersedes nothing, adds `offsets` + `segments` + `customs[i].offset` to `/api/export`'s body). Add to Invariants: "**Offsets are export-only; the preview badges, never shifts.**" and "**With any offset on, main and twins are built from the same part files by `shiftLegs`, never main from the cached stitch**" with the one-frame-per-seam reason; "twins are the last inputs". Add `shiftLegs`/`LegSource` to the `src/segments.ts` architecture line, `buildTimelines`/`distinctOffsets` to `server/ffmpeg.ts`, `partPath` to `server/ytdlp.ts`; bump the test count.
- [ ] **Step 2: Propose commit** `docs: per-box offsets in CLAUDE.md`.
