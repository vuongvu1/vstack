# Audio cutter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fifth journey — `idle` → `cutting` → `idle` — that turns an uploaded audio or video file into one `.mp3` per marked range in `OUT_DIR`.

**Architecture:** A new phase with a persistent `<video>` in `sourceSlot` playing a local object URL, a waveform strip in `barSlot` reusing `decodeTrack`/`drawWave`/`bucketAt`, ranges held in `src/segments.ts` with no new range arithmetic, and one new server module `server/cut.ts` (a sibling of `ffmpeg.ts`) behind one new route `/api/cut`. It reaches no other phase and claims no `mode`.

**Tech Stack:** Vite + vanilla TS frontend, zero-dependency `node:http` backend, real `ffmpeg`/`ffprobe` subprocesses, vitest (`environment: "node"`).

**Spec:** `docs/specs/2026-09-21-vstack-audio-cutter-design.md`

## Global Constraints

Copied from the spec and `CLAUDE.md`; every task's requirements include these.

- Node runs `server/*.ts` with **type stripping**: no `enum`, no `namespace`, no constructor parameter properties. Non-erasable syntax is a boot crash.
- `import type` for type-only imports; **explicit `.ts` extensions** on relative imports.
- No default exports, no barrel files, no `any`, no `console.log`/`.info` (`.error`/`.warn` only).
- `strict` + `noUncheckedIndexedAccess`: indexing yields `T | undefined`; guard with `?? fallback`, never `!`.
- `Bash(git add)`, `Bash(git commit *)` and `Bash(rm *)` are deny-listed. Use `git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add/commit` and Node's `fs.rm`.
- Branch is `feat/audio-cutter`, already cut. The spec is already committed as `4b110fe`.
- ffmpeg encoder is `libmp3lame`, quality `-q:a 2`. `-ss` goes **before** `-i`.
- `OUT_NAME` must not be widened. `CUT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d+\.mp3$/` is a separate anchored pattern.
- New client state fields are **session-only** — `save()` must not persist them.
- Visual values come from the `@radix-ui/colors` custom properties already in `style.css`; reuse the existing `.bar`, `.bar-row`, `.bar-end`, `.strip`, `.wave`, `.btn-solid`, `.btn-gray` recipes rather than new literals.
- Run the full suite with `pnpm test` (currently 409 tests) and the type gate with `pnpm build`.

---

## File Structure

| file | responsibility |
|---|---|
| `server/ffmpeg.ts` (modify) | gains `cutName(base, n)` and `isCutName(name)` beside `outName`/`isOutName` — the two things that resolve against `OUT_DIR` |
| `server/cut.ts` (create) | `cutMp3(src, range, out)` — the one ffmpeg pass. Sibling of `ffmpeg.ts`; imports `toolError` and nothing from `ffmpeg.ts` |
| `server/cut.test.ts` (create) | real-ffmpeg coverage: duration and dominant frequency per range |
| `server/ffmpeg.test.ts` (modify) | `cutName`/`isCutName` traversal cases |
| `server/index.ts` (modify) | `/api/cut`, and `/api/reveal` accepting a cut name |
| `src/api.ts` (modify) | `cut()` wrapper + `CutResult` |
| `src/state.ts` (modify) | `cutting` phase, six session-only fields |
| `src/state.test.ts` (modify) | persistence-exclusion test, mutation-tested |
| `src/main.ts` (modify) | idle button, persistent `cutVideo`, `renderCutting()`, `render()` wiring, strip loop stop |
| `src/style.css` (modify) | `.cut-results` list only — everything else reuses existing recipes |
| `CLAUDE.md` (modify) | the journey, the invariants, the testing posture |

---

### Task 1: `cutName` and `isCutName`

**Files:**
- Modify: `server/ffmpeg.ts` (beside `outName`/`isOutName`, around lines 110-181)
- Test: `server/ffmpeg.test.ts`

**Interfaces:**
- Consumes: `slugify` from `../src/format.ts` (already imported in `ffmpeg.ts`)
- Produces: `cutName(base: string, n: number): string`, `isCutName(name: unknown): name is string`

- [ ] **Step 1: Write the failing tests**

Append to `server/ffmpeg.test.ts`, after the existing `describe("outName — the traversal guard", …)` block:

```ts
describe("cutName", () => {
  it("slugifies the base and appends a 1-based index", () => {
    expect(cutName("Hôm nay trời đẹp quá", 1)).toBe("hom-nay-troi-dep-qua-1.mp3");
    expect(cutName("clip", 12)).toBe("clip-12.mp3");
  });

  it("produces a name that isCutName accepts", () => {
    expect(isCutName(cutName("Hôm nay trời đẹp quá", 3))).toBe(true);
    expect(isCutName(cutName("2024", 1))).toBe(true);
  });
});

// The second client-supplied path component on the `/out/` side, and the one
// that names files to DELETE (see `/api/cut`'s sweep). Same exhaustive
// treatment isOutName gets.
describe("cutName — the traversal guard", () => {
  it("accepts what cutName emits", () => {
    expect(isCutName("an-com-chua-1.mp3")).toBe(true);
    expect(isCutName("a-1.mp3")).toBe(true);
    expect(isCutName("2024-10.mp3")).toBe(true);
  });

  it("rejects traversal", () => {
    expect(isCutName("../secret-1.mp3")).toBe(false);
    expect(isCutName("a/b-1.mp3")).toBe(false);
    expect(isCutName("a\\b-1.mp3")).toBe(false);
    expect(isCutName("/etc/passwd")).toBe(false);
    expect(isCutName("..")).toBe(false);
  });

  it("rejects anything slugify could not have produced", () => {
    expect(isCutName("An-Com-1.mp3")).toBe(false); // uppercase
    expect(isCutName("ăn-cơm-1.mp3")).toBe(false); // diacritics
    expect(isCutName("-lead-1.mp3")).toBe(false); // leading dash
    expect(isCutName("has space-1.mp3")).toBe(false);
    expect(isCutName("a--b-1.mp3")).toBe(false); // slugify collapses runs
    expect(isCutName("trailing-1-.mp3")).toBe(false);
    expect(isCutName("no-index.mp3")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isCutName(undefined)).toBe(false);
    expect(isCutName(null)).toBe(false);
    expect(isCutName(3)).toBe(false);
  });

  // THE assertion that fails if anyone ever merges the two patterns: each
  // producer's names must be rejected by the other's guard, or a cut could
  // reach /api/publish and an export could reach the cut sweep.
  it("does not overlap isOutName in either direction", () => {
    expect(isCutName("an-com-0130-0205.mp4")).toBe(false);
    expect(isOutName("an-com-chua-1.mp3")).toBe(false);
  });
});
```

Add `cutName` and `isCutName` to the existing import block from `./ffmpeg.ts` at the top of that file (alphabetical: after `concatClips`, and after `isCutName` before `isOutName` respectively).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run server/ffmpeg.test.ts -t "cutName"`
Expected: FAIL — `cutName is not a function` / import error.

- [ ] **Step 3: Implement**

In `server/ffmpeg.ts`, immediately after `outPath`:

```ts
/** One cut mp3's filename — the base the user typed, slugified, plus the
 *  range's 1-based index.
 *
 *  Indexed rather than marked with `<mmss>-<mmss>` the way `outName` is, and
 *  that choice is what makes `/api/cut`'s sweep necessary: inserting a range
 *  renumbers every later file, so a second cut can leave a `-4.mp3` behind
 *  describing audio from the previous attempt. See the sweep in
 *  `server/index.ts`. */
export function cutName(base: string, n: number): string {
  return `${slugify(base)}-${n}.mp3`;
}
```

And immediately after `isOutName`:

```ts
/** Anchored to exactly what `cutName` emits, and deliberately NOT a widened
 *  `OUT_NAME`.
 *
 *  The long-form journey's invariant says there is nothing to widen
 *  `OUT_NAME` for, and that still holds — this needs a *different* shape,
 *  not a looser one. Two anchored patterns, each matching one producer, is a
 *  strictly smaller surface than one pattern loose enough for both, and
 *  since `OUT_DIR` lives under `$HOME` what a loose pattern reaches is the
 *  user's home directory.
 *
 *  This is also the one client string in the API that names files to
 *  *delete*: `/api/cut`'s `prev` is checked with it before anything is
 *  unlinked. */
const CUT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d+\.mp3$/;

export function isCutName(name: unknown): name is string {
  return typeof name === "string" && CUT_NAME.test(name);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run server/ffmpeg.test.ts`
Expected: PASS, including every pre-existing case in that file.

- [ ] **Step 5: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add server/ffmpeg.ts server/ffmpeg.test.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: name a cut mp3, and guard that name

cutName/isCutName sit beside outName/isOutName because they resolve
against OUT_DIR. OUT_NAME is deliberately not widened: the cutter needs a
different shape, not a looser one, and two anchored patterns are a smaller
surface than one loose enough for both.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `server/cut.ts` — the ffmpeg pass

**Files:**
- Create: `server/cut.ts`
- Test: `server/cut.test.ts`

**Interfaces:**
- Consumes: `Segment` from `../src/segments.ts`, `toolError` from `./errors.ts`
- Produces: `cutMp3(src: string, range: Segment, out: string): Promise<void>`, `MP3_QUALITY: string`

- [ ] **Step 1: Write the failing test**

Create `server/cut.test.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cutMp3 } from "./cut.ts";

const run = promisify(execFile);

let dir = "";
/** Six seconds of three back-to-back tones, two seconds each: 440 Hz, then
 *  1760 Hz, then 440 Hz again.
 *
 *  Three flat tones rather than anything subtle so a single bandpass says
 *  which part of the input an output came from — a duration assertion alone
 *  passes when a range maps to the wrong audio, and mapping is exactly what
 *  the `-ss`/`-i` ordering decides. The first and third bands repeat 440 Hz
 *  on purpose: the middle range is the only one that reads as 1760 Hz, so an
 *  off-by-one leg lands somewhere measurably wrong in either direction. */
let src = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vstack-cut-"));
  src = join(dir, "src.m4a");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=1760:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]",
    "-map", "[a]", "-y", src,
  ]);
  // 180s, like server/longform.test.ts's and server/lofi.test.ts's hooks:
  // real encodes compete for CPU in the full suite and exceed vitest's
  // default 10s hook budget there while passing in isolation.
}, 180_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Mean dB over a whole file, optionally through a filter first — the same
 *  shape `server/lofi.test.ts`'s `loudness` uses. */
async function meanDb(path: string, pre = ""): Promise<number> {
  const { stderr } = await run("ffmpeg", [
    "-hide_banner", "-i", path,
    "-af", pre === "" ? "volumedetect" : `${pre},volumedetect`,
    "-f", "null", "-",
  ]);
  const mean = /mean_volume: (-?[0-9.]+) dB/.exec(stderr);
  return mean ? Number(mean[1]) : -91;
}

async function seconds(path: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=nk=1:nw=1", path,
  ]);
  return Number(stdout.trim());
}

describe("cutMp3", () => {
  it("writes a range's own audio, at its own length", async () => {
    const out = join(dir, "mid.mp3");
    await cutMp3(src, { start: 2, end: 4 }, out);
    expect(await seconds(out)).toBeGreaterThan(1.8);
    expect(await seconds(out)).toBeLessThan(2.2);
    // THE assertion. A range that maps to the wrong part of the input still
    // has the right duration — only the tone says where it came from, and
    // 1760 Hz lives in the middle two seconds alone.
    const high = await meanDb(out, "bandpass=f=1760:width_type=h:width=200");
    const low = await meanDb(out, "bandpass=f=440:width_type=h:width=100");
    expect(high).toBeGreaterThan(low + 20);
  });

  it("maps the first range to the head of the input", async () => {
    const out = join(dir, "head.mp3");
    await cutMp3(src, { start: 0, end: 2 }, out);
    const high = await meanDb(out, "bandpass=f=1760:width_type=h:width=200");
    const low = await meanDb(out, "bandpass=f=440:width_type=h:width=100");
    expect(low).toBeGreaterThan(high + 20);
  });

  it("does not over-report a range that runs to the very end", async () => {
    const out = join(dir, "tail.mp3");
    await cutMp3(src, { start: 4, end: 6 }, out);
    expect(await seconds(out)).toBeLessThan(2.2);
  });

  it("reports ffmpeg's own stderr when the input is missing", async () => {
    await expect(cutMp3(join(dir, "nope.m4a"), { start: 0, end: 1 }, join(dir, "x.mp3")))
      .rejects.toThrow(/ffmpeg/);
  });
}, 180_000);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run server/cut.test.ts`
Expected: FAIL — `Failed to load ./cut.ts`.

- [ ] **Step 3: Implement**

Create `server/cut.ts`:

```ts
/** The audio cutter's one ffmpeg pass.
 *
 *  Sits BESIDE `ffmpeg.ts`, `starter.ts`, `longform.ts` and `lofi.ts` rather
 *  than above any of them: every path is the caller's, so it needs neither
 *  `MEDIA_DIR` nor `OUT_DIR`, and it imports nothing from `ffmpeg.ts` at
 *  all. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Segment } from "../src/segments.ts";
import { toolError } from "./errors.ts";

const run = promisify(execFile);

/** VBR, roughly 190 kbps. Deliberately not configurable: the user picked a
 *  file and wants the audio out of it, and a bitrate knob is a setting to
 *  explain rather than a decision anyone has to make. */
export const MP3_QUALITY = "2";

/** One range of `src`, re-encoded to mp3 at `out`.
 *
 *  `-ss` goes BEFORE `-i`, the same lesson `exportClip`'s mask input and
 *  `stackWide`'s per-part trims both carry: ffmpeg attaches an option to the
 *  *next* `-i`, so the other order would seek nothing, and `-ss` before the
 *  input is also what makes `-t` a duration measured from the seek point
 *  rather than from zero.
 *
 *  Re-encoding rather than stream-copying, so the in-point is exact. A copy
 *  snaps to the nearest frame boundary and silently moves the mark the user
 *  aimed at — the preview/export divergence this codebase treats as the
 *  cardinal failure, in the one phase whose entire job is where a cut lands.
 *
 *  `-vn` because the output is audio: a video input's picture is discarded
 *  here, the way a lofi speech's is.
 *
 *  ponytail: one pass per range. N is capped at `MAX_SEGMENTS` and these
 *  files are short, so a single decode with N outputs is not worth the
 *  mapping. */
export async function cutMp3(src: string, range: Segment, out: string): Promise<void> {
  try {
    await run("ffmpeg", [
      "-v", "error",
      "-ss", String(range.start),
      "-i", src,
      "-t", String(range.end - range.start),
      "-vn",
      "-c:a", "libmp3lame",
      "-q:a", MP3_QUALITY,
      "-y", out,
    ]);
  } catch (err) {
    throw toolError("ffmpeg", err);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run server/cut.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Mutation-test the ordering**

Temporarily move `"-ss", String(range.start),` to *after* `"-i", src,` and re-run. Expected: both tone tests fail (durations still right, tones wrong). Restore the order and re-run to PASS. Do not commit the mutation.

- [ ] **Step 6: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add server/cut.ts server/cut.test.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: cut one range of an upload to mp3

A sibling of ffmpeg.ts: every path is the caller's. -ss before -i so the
seek applies to the input and -t is measured from it, and a re-encode
rather than a copy so the in-point is exact rather than snapped to the
nearest frame. The test asserts the output's dominant frequency as well as
its duration -- a range mapped to the wrong audio still has the right
length, and mapping is what the argument order decides.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `/api/cut` and the reveal widening

**Files:**
- Modify: `server/index.ts` — new route before `/api/reveal` (which is at ~line 1082), plus the `isOutName` check inside `/api/reveal`

**Interfaces:**
- Consumes: `cutMp3` (Task 2), `cutName`/`isCutName` (Task 1), plus `isUploadId`, `uploadPath`, `probeAudio`, `outPath`, `OUT_DIR` from `./ffmpeg.ts` and `isValidSegments` from `../src/segments.ts`
- Produces: `POST /api/cut` → `{ names: string[] }`

- [ ] **Step 1: Extend the imports**

In `server/index.ts`, add `cutName` and `isCutName` to the existing `./ffmpeg.ts` import block, `cutMp3` as a new `import { cutMp3 } from "./cut.ts";`, and `isValidSegments` to the existing `../src/segments.ts` import block (verify what that block already pulls in before editing — `MAX_SEGMENTS` and `normalize` may already be there).

- [ ] **Step 2: Write the route**

Insert immediately before the `if (req.url === "/api/reveal")` block:

```ts
  // The audio cutter. Takes an upload id and ranges, never a path — the same
  // posture /api/stack and /api/lofi hold.
  if (req.url === "/api/cut") {
    const raw = await json<Record<string, unknown>>(req);
    const base = readTitle(raw.base, "base");
    if (!isUploadId(raw.id)) return send(res, 400, { error: "Bad upload id." });
    const src = uploadPath(raw.id);
    if (!existsSync(src)) {
      return send(res, 404, { error: "That upload is no longer on disk." });
    }
    // The duration is the SERVER's, probed here: a length the client
    // reported could put a range past the end of the file, which ffmpeg
    // answers with an empty output rather than an error anyone can read.
    // `probeAudio` rather than `probeFile` because the input may legitimately
    // have no video stream — and it is also the gate that already refused a
    // file with no audio stream, back at /api/upload-audio.
    const { seconds } = await probeAudio(src);
    // The SAME predicate `restore` uses on the client, so the two sides
    // cannot come to disagree about what a legal range is. It also covers
    // the count (>= 1, <= MAX_SEGMENTS), the sort, the overlaps and the
    // bounds, so there is nothing left to check here by hand.
    if (!isValidSegments(raw.ranges, seconds)) {
      return send(res, 400, { error: "ranges must be sorted, non-overlapping and inside the file." });
    }
    const ranges = raw.ranges;

    await mkdir(OUT_DIR, { recursive: true });
    const names = ranges.map((_, i) => cutName(base, i + 1));
    // Every partial is tracked before the first render starts: `node --watch`
    // SIGTERMs this process on any server edit, and a killed process never
    // reaches the `finally` while the ffmpeg it spawned keeps writing.
    const partials = names.map((name) => outPath(name).replace(/\.mp3$/, `.${randomUUID()}.part.mp3`));
    for (const p of partials) inFlight.add(p);
    try {
      for (const [i, range] of ranges.entries()) {
        const partial = partials[i];
        const name = names[i];
        if (partial === undefined || name === undefined) continue;
        await cutMp3(src, range, partial);
        await rename(partial, outPath(name));
      }
      // The sweep, and every property of it is deliberate. An index-based
      // name renumbers when a range is inserted, so a second cut with fewer
      // ranges leaves a file behind that is indistinguishable by name from a
      // current one.
      //
      // AFTER the renames, never before: a failed cut must leave the
      // previous run intact. Skipping anything just written, which would
      // otherwise unlink a file from this very run — the defect
      // /api/export guards with `prev === name`. Through `outPath`, because
      // `rm` on a bare name resolves against process.cwd() and
      // `force: true` swallows the resulting ENOENT silently, so the sweep
      // would do nothing and say nothing. And behind `isCutName`, because
      // this is the one client string in the API that names a file to
      // delete.
      const prev = Array.isArray(raw.prev) ? raw.prev : [];
      for (const stale of prev) {
        if (!isCutName(stale) || names.includes(stale)) continue;
        await rm(outPath(stale), { force: true }).catch((err: unknown) => {
          console.warn(`vstack: could not remove the previous out/${stale}:`, err);
        });
      }
      console.warn(`vstack: cut ${names.length} mp3 file(s) from ${String(raw.id)}`);
      return send(res, 200, { names });
    } finally {
      for (const p of partials) {
        inFlight.delete(p);
        await rm(p, { force: true }).catch((err: unknown) => {
          console.error("vstack: cut partial cleanup failed:", err);
        });
      }
    }
  }
```

- [ ] **Step 3: Widen `/api/reveal` only**

In the `/api/reveal` block, replace:

```ts
    if (!isOutName(body.name)) return send(res, 400, { error: "Bad output name." });
```

with:

```ts
    // Two producers, two anchored patterns — see isCutName. Widening
    // OUT_NAME to cover both would loosen the guard on a path that reaches
    // `open -R` under $HOME. /api/publish and /out/ are deliberately NOT
    // taught about .mp3: nothing in the cutter produces something to publish
    // or to stream back.
    if (!isOutName(body.name) && !isCutName(body.name)) {
      return send(res, 400, { error: "Bad output name." });
    }
```

- [ ] **Step 4: Verify the server still boots and typechecks**

Run: `pnpm build`
Expected: no TypeScript errors.

Run: `pnpm server` in a second terminal; expected: the usual boot lines, no exit. Then, with a real upload id from a manual `/api/upload-audio` (or simply confirm the 400 path):

```bash
curl -s -X POST 127.0.0.1:8787/api/cut -H 'content-type: application/json' \
  -d '{"id":"not-a-uuid","base":"x","ranges":[{"start":0,"end":1}]}'
```
Expected: `{"error":"Bad upload id."}`

- [ ] **Step 5: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add server/index.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: add /api/cut

Takes an upload id and ranges, never a path. isValidSegments is the same
predicate the client restores with, so the two sides cannot disagree about
a legal range, and the duration it checks against is the server's own
probe rather than a length the client reported.

The sweep of a previous run's names runs after the renames, skips anything
just written, resolves through outPath, and is gated on isCutName -- the
one client string here that names a file to delete. /api/reveal accepts
both name shapes; /api/publish and /out/ are left alone.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The client's wire and state

**Files:**
- Modify: `src/api.ts`, `src/state.ts`
- Test: `src/state.test.ts`

**Interfaces:**
- Produces: `cut(body): Promise<CutResult>` where `CutResult = { names: string[] }`; `AppState` gains `cutFile`, `cutSeconds`, `cutRanges`, `cutBase`, `cutNames`, `cutUploadId`; `Phase` gains `"cutting"`

- [ ] **Step 1: Write the failing state test**

Append to `src/state.test.ts`, inside the existing describe that covers the persistence exclusions (match the surrounding style — read the lofi-field exclusion test first and mirror it):

```ts
  it("does not persist the cutter's session fields", () => {
    setState({
      videoId: "abc12345678",
      phase: "cutting",
      cutBase: "an com chua",
      cutRanges: [{ start: 1, end: 2 }],
      cutSeconds: 120,
      cutUploadId: "8f14e45f-ceea-467a-9e2f-9c8d0e6a1b23",
      cutNames: ["an-com-chua-1.mp3"],
    });
    save();
    const raw = localStorage.getItem("vstack:abc12345678") ?? "{}";
    const record = JSON.parse(raw) as Record<string, unknown>;
    // Mutation-tested the way the lofi fields' exclusion is: putting any of
    // these into save()'s record fails here. A cut is over when its files
    // are on disk, and cutUploadId names a file the user may have swept from
    // media/uploads/ by hand — a restored id pointing at nothing would look
    // like a working panel right up until Cut.
    expect(record).not.toHaveProperty("cutBase");
    expect(record).not.toHaveProperty("cutRanges");
    expect(record).not.toHaveProperty("cutSeconds");
    expect(record).not.toHaveProperty("cutUploadId");
    expect(record).not.toHaveProperty("cutNames");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/state.test.ts -t "cutter"`
Expected: FAIL — `cutBase` is not a known `AppState` key (TypeScript error under vitest).

- [ ] **Step 3: Add the state**

In `src/state.ts`, extend the `Phase` union with `"cutting"` and add to `AppState`, after the lofi fields:

```ts
  /** The picked file, held so the strip and the <video> both have it and so
   *  a re-pick replaces rather than accumulates. `null` until picked.
   *
   *  NOT persisted, and not persistable: a `File` handle does not survive a
   *  reload, and the object URL built from it is revoked on leaving the
   *  phase. */
  cutFile: File | null;
  /** The upload's id once `/api/upload-audio` has answered. `""` while the
   *  upload is still in flight, which is what the Cut button waits on —
   *  marking ranges does not.
   *
   *  NOT persisted, `music`'s reason exactly: it names an upload the user may
   *  have swept from `media/uploads/` by hand, and a restored id pointing at
   *  a file that is gone would look like a working panel until Cut. */
  cutUploadId: string;
  /** The picked file's own decoded length, from `decodeTrack`. The strip's
   *  axis and the bound every range is validated against. */
  cutSeconds: number;
  /** The ranges to cut, one mp3 each. Spent entirely through
   *  `src/segments.ts` — `normalize` merges and sorts them, `editMark` moves
   *  a mark, `isValidSegments` is what the server re-checks.
   *
   *  NOT persisted: a cut is over when its files are on disk. */
  cutRanges: Segment[];
  /** What each output file is named after, before `slugify` and the index.
   *  Cut is gated on it being non-blank, the way Export is gated on
   *  `starterTitle`. */
  cutBase: string;
  /** The previous cut's filenames, sent as `prev` so an index-based rename
   *  does not strand them. In-memory like `outName`: a reload between two
   *  cuts strands the older set, which is the accepted cost of not
   *  persisting a field whose only job is naming files to destroy. */
  cutNames: string[];
```

Add them to the `initial` state object with `null`, `""`, `0`, `[]`, `""`, `[]`. Do **not** touch `save()` or `restore()`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the API wrapper**

In `src/api.ts`, after the `lofi` wrapper:

```ts
/** What `/api/cut` answers with: one filename per range, in range order.
 *  No url and no size — this journey never plays its output back, it reveals
 *  it in Finder. */
export type CutResult = { names: string[] };

/** Cuts the uploaded file into one mp3 per range. `id` is the UUID `upload`
 *  returned; `ranges` are seconds in the file's own timeline, which is the
 *  only timeline this journey has — there is no window and no PAD here.
 *
 *  `prev` is the previous cut's names, so an index-based rename does not
 *  leave the superseded files on the Desktop. Omitted on the first cut of a
 *  session. */
export async function cut(body: {
  id: string;
  base: string;
  ranges: Segment[];
  prev?: string[];
}): Promise<CutResult> {
  return (await post("/api/cut", body)).json() as Promise<CutResult>;
}
```

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm build` — expected: clean.

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/api.ts src/state.ts src/state.test.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: add the cutter's state and its api wrapper

Six session-only fields and the cutting phase. None of them is persisted:
a cut is over when its files are on disk, cutUploadId names a file the
user may have swept by hand, and a File handle does not survive a reload
at all. The exclusion is mutation-tested the way the lofi fields' is.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The phase in the UI

**Files:**
- Modify: `src/main.ts` — the persistent shell (~line 135), `renderIdle` (~line 3336), `render()` (~line 3440-3490), plus a new `renderCutting()`
- Modify: `src/style.css` — one new `.cut-results` recipe

**Interfaces:**
- Consumes: `cut` from `./api.ts` (Task 4), the `cut*` state fields (Task 4), and the existing `decodeTrack`, `drawWave`, `bucketAt`, `peaks`, `el`, `mmss`, `bell`, `guard`, `normalize`, `editMark`, `segmentContaining`, `MAX_SEGMENTS`, `reveal`
- Produces: nothing other tasks consume

- [ ] **Step 1: Add the persistent node**

Beside `lofiPanel` in the shell (~line 135), add:

```ts
// The cutter's own media node. A <video> rather than an <audio> for both
// input kinds: a video upload has a picture to show and an audio-only file
// plays through the same element with a blank frame. Built once and only
// ever hidden, like every other child of sourceSlot — see the module-level
// comment on the persistent shell.
const cutVideo = el("video", { controls: true, preload: "auto", hidden: true });
```

and include it in the `sourceSlot` children list alongside `lofiPanel`.

- [ ] **Step 2: Add the way in**

In `renderIdle`, after the `chat` button:

```ts
  const cutter = el("button", {
    className: "btn-gray",
    textContent: "Audio cutter →",
    title: "Cut an audio or video file into mp3s",
    disabled: busy,
  });
  // No `mode` here, for the reason the chat button's comment right above
  // gives: this journey reaches neither `preview` nor `/api/publish`, so
  // there is nothing downstream that could read a stale value.
  cutter.onclick = () => setState({ phase: "cutting", error: "" });
```

and add `cutter` to the third `bar-row`'s children.

- [ ] **Step 3: Write `renderCutting`**

Add near `renderLofiPanel`. The module-scoped strip handle mirrors `strip`:

```ts
// The cutter's strip owns a rAF loop, like the trimming and framing strips.
// Stopped in two places, and both are load-bearing: renderCutting stops the
// old one before building its replacement (the re-render case), and render()
// stops it whenever `phase !== "cutting"` (the departure case). Nothing calls
// back into renderCutting on the way out, so without the second one the loop
// reads a hidden element for the rest of the session.
let cutStrip: { el: HTMLElement; stop(): void } | null = null;

// The object URL behind cutVideo. Revoked on leaving the phase — it is the
// one piece of this phase's state that is not a plain value, which is why it
// lives here rather than in AppState.
let cutUrl = "";

// Which range Set Start / Set End write to. Module-scoped for the reason
// `activeSegment` is: nothing about it is persisted and barSlot is rebuilt
// on every render, so it must survive that rebuild without causing one.
let activeRange = 0;

// Which ends the user has AIMED, keyed by the mark's own value — the same
// shape and the same reasoning as the trimming phase's `aimed` set. It is
// what `editMark`'s `endAimed` reads: an end nobody chose is carried, an end
// the user chose is defended. Index-keyed it would follow the wrong range as
// soon as normalize merged two of them.
const cutAimedEnds = new Set<number>();

function stopCutStrip(): void {
  cutStrip?.stop();
  cutStrip = null;
}

function releaseCutUrl(): void {
  if (cutUrl !== "") URL.revokeObjectURL(cutUrl);
  cutUrl = "";
  cutVideo.removeAttribute("src");
  cutVideo.load();
}

/** Picks a file: plays it locally at once, decodes its envelope for the
 *  strip, and uploads it in parallel.
 *
 *  The object URL is what makes scrubbing live before the upload finishes —
 *  only the Cut button waits on the id. A user marking ranges in a
 *  40-minute recording should not be watching a progress bar first. */
async function pickCutFile(file: File): Promise<void> {
  releaseCutUrl();
  cutUrl = URL.createObjectURL(file);
  cutVideo.src = cutUrl;
  setState({
    cutFile: file,
    cutUploadId: "",
    cutRanges: [],
    cutSeconds: 0,
    error: "",
    busy: `Reading ${file.name}…`,
  });
  try {
    // decodeTrack, not loadWave: a flat strip is cosmetic on the framing bar
    // and fatal here, since the strip is the only thing the user aims at.
    const { env, seconds } = await decodeTrack(file);
    // ponytail: this phase writes the module-scoped envelope `drawWave`
    // reads rather than growing it a parameter. The journeys are mutually
    // exclusive — no state exists in which a framing clip and a cut upload
    // are both on screen — and a second envelope field is a second thing to
    // keep in sync for no behaviour.
    wavePeaks = env;
    waveSeconds = seconds;
    setState({ cutSeconds: seconds, busy: `Uploading ${file.name}…` });
    const { id } = await upload(file, true);
    setState({ cutUploadId: id, busy: "" });
  } catch (err) {
    setState({ busy: "", error: err instanceof Error ? err.message : String(err) });
  }
}

function renderCutting(): Node[] {
  const s = getState();
  const busy = s.busy !== "";
  cutVideo.hidden = s.cutFile === null;

  const pick = el("input", { type: "file", accept: "audio/*,video/*", disabled: busy });
  pick.onchange = () => {
    const file = pick.files?.[0];
    if (file) void pickCutFile(file);
  };

  const rows: Node[] = [el("div", { className: "bar-row" }, pick)];
  if (s.cutFile === null || s.cutSeconds === 0) {
    const back = el("button", { className: "btn-gray", textContent: "← Back", disabled: busy });
    back.onclick = () => {
      stopCutStrip();
      releaseCutUrl();
      setState({ phase: "idle", cutFile: null, cutRanges: [], error: "" });
    };
    rows.push(el("div", { className: "bar-row" }, back));
    return rows;
  }

  const span = s.cutSeconds;
  stopCutStrip();
  cutStrip = buildCutStrip(span, s.cutRanges);
  rows.push(el("div", { className: "bar-row" }, cutStrip.el));

  const addRange = el("button", {
    textContent: "+ Range",
    title: "Start a range at the playhead",
    disabled: busy || s.cutRanges.length >= MAX_SEGMENTS,
  });
  addRange.onclick = () => {
    const cur = getState();
    const at = Math.min(cutVideo.currentTime, Math.max(0, span - 1));
    const added = { start: at, end: Math.min(at + 5, span) };
    const next = normalize([...cur.cutRanges, added], span);
    // segmentContaining, never an index or a `start ===` search: normalize
    // merges, and a merged part keeps the EARLIER one's start, so equality
    // returns -1 exactly when two ranges touch. This is the same call the
    // trimming phase's `+ Part` makes.
    activeRange = segmentContaining(next, added.start, added.end);
    setState({ cutRanges: next, error: "" });
  };

  const setMarkAt = (which: "start" | "end") => () => {
    const cur = getState();
    const seg = cur.cutRanges[activeRange];
    if (seg === undefined) return;
    // `editMark(seg, which, t, duration, endAimed)` returns the edited
    // Segment or `null` when the edit would leave `end <= start` — a refusal
    // rather than a silent drop, because `normalize` DELETES such a range and
    // that is the worst possible answer to an ordinary misclick.
    //
    // `endAimed` is what makes the carry asymmetric: an end nobody aimed is
    // synthetic (`+ Range` gave it one) and is carried along keeping the
    // range's own length, while an end the user DID aim is theirs and the
    // edit is refused instead. Value-keyed, never index-keyed, for the reason
    // the trimming phase's own `aimed` set documents: normalize sorts and
    // merges, so an index-keyed flag follows the wrong range the moment two
    // of them touch.
    const edited = editMark(seg, which, cutVideo.currentTime, span, cutAimedEnds.has(seg.end));
    if (edited === null) {
      setState({
        error:
          which === "start"
            ? "That start is past the range's own end."
            : "That end is before the range's own start.",
      });
      return;
    }
    if (which === "end") {
      cutAimedEnds.delete(seg.end);
      cutAimedEnds.add(edited.end);
    }
    const next = normalize(
      cur.cutRanges.map((r, i) => (i === activeRange ? edited : r)),
      span,
    );
    // Re-aim AFTER normalising: dragging a mark into a neighbour merges the
    // two, so the active index can point at an untouched range once the merge
    // lands even though the edited range survives inside the merged one.
    activeRange = segmentContaining(next, edited.start, edited.end);
    setState({ cutRanges: next, error: "" });
  };

  const setStart = el("button", { textContent: "Set Start", disabled: busy || s.cutRanges.length === 0 });
  setStart.onclick = setMarkAt("start");
  const setEnd = el("button", { textContent: "Set End", disabled: busy || s.cutRanges.length === 0 });
  setEnd.onclick = setMarkAt("end");

  const drop = el("button", {
    className: "btn-gray",
    textContent: "Remove",
    disabled: busy || s.cutRanges.length === 0,
  });
  drop.onclick = () => {
    const cur = getState();
    const next = cur.cutRanges.filter((_, i) => i !== activeRange);
    activeRange = Math.max(0, Math.min(activeRange, next.length - 1));
    setState({ cutRanges: next, error: "" });
  };

  rows.push(el("div", { className: "bar-row" }, addRange, setStart, setEnd, drop));

  const base = el("input", {
    type: "text",
    placeholder: "File name",
    value: s.cutBase,
    disabled: busy,
    className: "field-grow",
  });
  const go = el("button", {
    className: "btn-solid",
    textContent: "Cut →",
    disabled: busy || s.cutBase.trim() === "" || s.cutRanges.length === 0 || s.cutUploadId === "",
  });
  // Quiet, so a keystroke does not rebuild this very input and drop the
  // cursor — which means Cut's own `disabled` has to be flipped in here
  // rather than waiting for a render that may never come. Same pattern the
  // framing bar's Export button uses.
  base.oninput = () => {
    setQuiet({ cutBase: base.value });
    go.disabled = base.value.trim() === "" || getState().cutRanges.length === 0
      || getState().cutUploadId === "";
  };
  go.onclick = () =>
    void guard("Cutting…", async () => {
      const cur = getState();
      // Re-checked here rather than trusted from the button, which is
      // toggled in place by a quiet handler.
      if (cur.cutBase.trim() === "") throw new Error("Type a file name first.");
      const { names } = await cut({
        id: cur.cutUploadId,
        base: cur.cutBase,
        ranges: cur.cutRanges,
        ...(cur.cutNames.length > 0 ? { prev: cur.cutNames } : {}),
      });
      setState({ cutNames: names, error: "" });
      bell();
    });

  const done = el("button", { className: "btn-gray", textContent: "← Back", disabled: busy });
  done.onclick = () => {
    stopCutStrip();
    releaseCutUrl();
    setState({ phase: "idle", cutFile: null, cutRanges: [], error: "" });
  };

  rows.push(el("div", { className: "bar-row" }, base, el("span", { className: "bar-end" }, done, go)));

  if (s.cutNames.length > 0) {
    const list = el("div", { className: "cut-results" });
    for (const name of s.cutNames) {
      const show = el("button", { className: "btn-gray", textContent: name, disabled: busy });
      show.onclick = () => void reveal(name);
      list.append(show);
    }
    rows.push(el("div", { className: "bar-row" }, list));
  }
  return rows;
}
```

- [ ] **Step 4: Write `buildCutStrip`**

A read-only strip: the waveform canvas, one band per range, a playhead, click-to-seek. Model it on the framing strip's construction (`src/main.ts` ~1900-2050) but without the drag handles — the ranges are aimed with the buttons above.

```ts
/** The cutter's strip: the file's own envelope, a band per range, and a
 *  playhead.
 *
 *  Its axis is the file's own duration — there is no window and no PAD in
 *  this journey — so `bucketAt` reduces exactly to `floor(x * buckets / w)`,
 *  the identity `src/waveform.test.ts` already pins. No drag handles: the
 *  ranges are aimed with Set Start / Set End, which is the whole reason this
 *  phase could reuse `src/segments.ts` unchanged. */
function buildCutStrip(span: number, ranges: Segment[]): { el: HTMLElement; stop(): void } {
  const wave = el("div", { className: "wave" });
  const canvas = el("canvas");
  wave.append(canvas);
  for (const [i, r] of ranges.entries()) {
    const band = el("div", { className: "wave-cut" });
    band.style.left = `${(100 * r.start) / span}%`;
    band.style.width = `${(100 * (r.end - r.start)) / span}%`;
    if (i === activeRange) band.classList.add("is-active");
    wave.append(band);
  }
  const head = el("div", { className: "strip-head" });
  wave.append(head);
  wave.onclick = (e) => {
    const box = wave.getBoundingClientRect();
    const frac = (e.clientX - box.left) / Math.max(1, box.width);
    cutVideo.currentTime = Math.min(span, Math.max(0, frac * span));
  };
  const resize = new ResizeObserver(() => drawWave(canvas, span));
  resize.observe(wave);
  let raf = 0;
  const tick = () => {
    head.style.left = `${(100 * cutVideo.currentTime) / span}%`;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return {
    el: wave,
    stop() {
      cancelAnimationFrame(raf);
      resize.disconnect();
    },
  };
}
```

- [ ] **Step 5: Wire `render()`**

In `render()`, beside the existing `lofiPanel.hidden = …` line:

```ts
  cutVideo.hidden = s.phase !== "cutting" || s.cutFile === null;
```

In the phase dispatch, beside the `lofi` arm:

```ts
  else if (s.phase === "cutting") barSlot.replaceChildren(...renderCutting());
```

And the departure stop, beside the existing `if (phase !== "trimming")` strip stop:

```ts
  // The departure case — see the comment on `cutStrip`. renderCutting only
  // runs while the phase is `cutting`, so nothing else ever stops this loop.
  if (s.phase !== "cutting") stopCutStrip();
```

Also pause `cutVideo` wherever `render()` already pauses the media it is hiding — `display: none` does not pause anything, and the cutter's audio would otherwise play under the next phase.

- [ ] **Step 6: Add the one CSS recipe**

In `src/style.css`, beside the existing `.wave-cut`:

```css
.cut-results { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.wave-cut.is-active { outline: 2px solid var(--blue-9); outline-offset: -2px; }
```

- [ ] **Step 7: Typecheck**

Run: `pnpm build`
Expected: clean. Fix any `noUncheckedIndexedAccess` fallout with `?? fallback`, never `!`.

- [ ] **Step 8: Verify by hand in a real browser**

With `pnpm server` and `pnpm dev` both running, at `http://localhost:5173`:

1. `Audio cutter →` from idle. The bar shows a file picker and `← Back`.
2. Pick an **mp4 with sound**. The picture appears in the source slot and plays immediately, before the upload finishes.
3. The strip draws a waveform whose peaks line up with what you hear.
4. `+ Range` twice, aim each with Set Start / Set End. Bands appear and move; the active one is outlined.
5. Type a base name. `Cut →` enables only once the upload has landed.
6. Cut. Two files appear as buttons; clicking one reveals it in Finder; both play and hold the right audio.
7. Cut again with one range removed. The stale third file is **gone** from `~/Desktop/vstack/`.
8. Pick an **mp3** (no video stream). Everything above works; the media element shows a blank frame.
9. `← Back` to idle, then into `trimming` on a normal short: no cutter audio plays underneath, and the strip loop has stopped (no rAF churn in the profiler).

Note: the in-app Browser pane reports `document.hidden = true`, which suspends `requestAnimationFrame` — check the playhead in a real browser window, not that pane.

- [ ] **Step 9: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/main.ts src/style.css
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: add the cutting phase

A file picker, a local object URL so scrubbing is live before the upload
lands, the framing strip's waveform machinery on the file's own axis, and
ranges spent entirely through src/segments.ts -- no new range arithmetic
anywhere in the feature.

The strip's rAF loop is stopped in both places the trimming strip's is:
on re-render and on leaving the phase. Nothing calls back into
renderCutting on the way out.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the spec pointer**

In the opening paragraph's chain of specs, after the lofi entry, add that `docs/specs/2026-09-21-vstack-audio-cutter-design.md` supersedes nothing and adds a FIFTH journey, `idle` → `cutting` → `idle`, whose output is one mp3 per marked range in `OUT_DIR` and which reaches no other phase.

- [ ] **Step 2: Update the architecture map**

Add `server/cut.ts` (`MP3_QUALITY`, `cutMp3`) to the module list, `cutName`/`isCutName` to `server/ffmpeg.ts`'s line, and note the route count moving from 15 to 16.

Add to the layering paragraph: `cut.ts` sits beside `ffmpeg.ts`, `starter.ts`, `longform.ts` and `lofi.ts` — every path is the caller's, and it imports nothing from `ffmpeg.ts` at all, not even `probeAudio` (the route probes).

- [ ] **Step 3: Add the invariants**

Under "Invariants", add:

- **`OUT_NAME` is not widened for the cutter; `CUT_NAME` sits beside it.** Two anchored patterns, each matching one producer, is a strictly smaller surface than one loose enough for both — and `/api/reveal` is the only route that accepts either. `/api/publish` and `/out/` are deliberately untaught: nothing in this journey produces something to publish or stream back.
- **`/api/cut`'s sweep is `/api/export`'s `prev`, indexed.** After the renames, skipping anything just written, resolved through `outPath`, gated on `isCutName`. An index-based name renumbers when a range is inserted, so a second cut with fewer ranges leaves a file behind that is indistinguishable by name from a current one.
- **The cutter's strip axis is the file's own duration.** No window, no `PAD`, no stitch — `bucketAt` reduces to the identity, and there is nothing here that could reproduce the stitch drift the framing strip's mapping exists to fix.

- [ ] **Step 4: Update the phase sentence and the testing posture**

Change "Seven phases" to eight and describe `cutting` as the second dead end. Under "Testing posture", add `server/cut.test.ts`: the three-tone fixture, why the frequency assertion rather than the duration one is the load-bearing half, and the `-ss`/`-i` mutation it pins. Note that the panel, the strip and the route's HTTP surface have no tests, like the rest of the DOM and network surface.

- [ ] **Step 5: Run the full gate**

Run: `pnpm test`
Expected: PASS — 409 existing tests plus the new ones (4 in `server/cut.test.ts`, 5 in `server/ffmpeg.test.ts`, 1 in `src/state.test.ts`).

Run: `pnpm build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add CLAUDE.md
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "docs: record the audio cutter journey in CLAUDE.md

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: the phase and the shell and the strip and the ranges to Task 5, the upload to Task 5 (it reuses `/api/upload-audio` unchanged, so there is nothing to build), `server/cut.ts` to Task 2, `/api/cut` to Task 3, names and the sweep to Tasks 1 and 3, errors across Tasks 3 and 5, testing to Tasks 1, 2 and 4, and the documentation to Task 6.

**Verified signatures.** `editMark(seg, which, t, duration, endAimed): Segment | null` is `src/segments.ts`'s real shape and Task 5 uses it verbatim. `guard`, `bell`, `reveal`, `el`, `decodeTrack`, `drawWave`, `wavePeaks`/`waveSeconds`, `segmentContaining` and `normalize` all already exist in `src/main.ts` or its imports — read each at its definition before use rather than assuming the option bag, and note `wavePeaks`/`waveSeconds` are `let` module bindings the picker writes.

**Type consistency.** `cutName(base, n)` / `isCutName(name)` are used under those names in Tasks 1, 3 and 6; `cutMp3(src, range, out)` in Tasks 2 and 3; `cut({ id, base, ranges, prev })` → `{ names }` in Tasks 4 and 5; the six `cut*` state fields in Tasks 4 and 5 under identical names.
