# Lofi Journey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fourth journey — one music track, one background image and some
speech `.mp4`s become a 1920x1080 video the length of the track, with each
speech cut into a quiet stretch of the music, band-limited, and the music
ducked under it.

**Architecture:** Quiet stretches are detected **client-side** from the
envelope `src/main.ts` already decodes (`OfflineAudioContext` → `peaks()`),
by a new pure module `src/lofi.ts`. The render is **one ffmpeg pass** in a
new `server/lofi.ts`: the image is the base video, each speech is
`overlay`'d onto it inside its own time window, and the music is ducked by
`sidechaincompress` against the speech bed. Overlay rather than concat, so
the output's duration is the music's by construction and `outName`'s `mmss`
cannot come to disagree with the file. Everything after the render —
`preview`, `/out/<name>`, Reveal, Publish, the `.thumb.jpg` sidecar — is
existing code that needs no changes.

**Tech Stack:** TypeScript (Node type-stripping on the server, Vite on the
client), zero dependencies, `node:http`, real `ffmpeg`/`ffprobe`
subprocesses, vitest (`environment: "node"`).

**Spec:** `docs/specs/2026-09-16-vstack-lofi-design.md` — read it, including
its amendment block, before starting any task.

**Branch:** `feat/lofi`, already created and holding the spec commit.

## Global Constraints

Copied from CLAUDE.md and the spec. Every task's requirements include these.

- **No non-erasable TypeScript in `server/`** — no `enum`, no `namespace`, no
  constructor parameter properties. Node runs `server/*.ts` with type
  stripping, so these are a *boot crash*, not a compile error.
- `import type` for type-only imports; **explicit `.ts` extensions** on every
  relative import.
- No default exports, no barrel files, no `any`, **no `console.log`/`.info`**
  — `.error`/`.warn` only.
- `strict` + `noUncheckedIndexedAccess`: indexing yields `T | undefined`;
  guard with `?? fallback`, never `!`.
- **Layering is strict and acyclic.** `server/lofi.ts` is a SIBLING of
  `ffmpeg.ts`, `longform.ts` and `starter.ts`: it may import `probeFile` from
  `ffmpeg.ts` and `toolError` from `errors.ts`, and **nothing else from
  `server/`**. It re-derives its own asset path. It never imports
  `longform.ts` or `starter.ts`.
- `src/lofi.ts` is a bottom-layer client module beside `geometry.ts` and
  `segments.ts`: **it imports nothing**.
- Deliberate simplifications get a `ponytail:` comment naming the upgrade
  path.
- Visual values come from the `@radix-ui/colors` custom properties already
  imported in `style.css`; new UI uses the hand-rolled token layer
  (`--radius-*`, `--space-*`, `--control-height`) and the existing button
  classes (bare `<button>` = soft accent, `.btn-solid` = the one advancing
  action, `.btn-gray` = step back).
- Constants fixed by the spec: `FADE = 0.5`, `MAX_SPEECHES = 8`,
  `BUCKETS_PER_SEC = 4`, `MIN_GAP = 20`, `SKIP_HEAD = 15`, `SKIP_TAIL = 10`,
  speech band `highpass=f=300` + `lowpass=f=3000`, `TRANSITION_GAIN = 1.0`,
  output `1920x1080`, publish `shorts: false`.
- Shell notes for this environment: `git add` / `git commit *` / `rm *` are
  deny-listed. Use `git -C <path> add` and `git -C <path> commit`, and Node's
  `fs.rm` instead of shell `rm`.
- Run the full suite with `pnpm test` (currently 367 tests). Never claim a
  pass without the output.

---

## File Structure

**Created:**

| file | responsibility |
|---|---|
| `src/lofi.ts` | Pure trough detection. Imports nothing. |
| `src/lofi.test.ts` | Exhaustive unit tests for the above. |
| `server/lofi.ts` | The one ffmpeg pass. Sibling of `ffmpeg.ts`. |
| `server/lofi.test.ts` | Real ffmpeg, real pixels, real dB. |

**Modified:**

| file | change |
|---|---|
| `src/defaults.ts` | `MAX_SPEECHES` (shared client + server, like `MAX_PARTS`). |
| `server/ffmpeg.ts` | `probeAudio`. |
| `server/ffmpeg.test.ts` | Tests for `probeAudio`. |
| `server/index.ts` | Extract the upload handler; add `/api/upload-audio` and `/api/lofi`. |
| `src/api.ts` | `upload(file, audio?)`, `lofi(body)`. |
| `src/state.ts` | `"lofi"` in `Phase` and `mode`; `music`/`bg`/`bgName`/`speeches`/`placements`. |
| `src/state.test.ts` | The new fields stay out of the persisted record. |
| `src/main.ts` | `Lofi →` entry, `lofiPanel`, the lofi bar, the marker strip, `doLofi`. |
| `src/style.css` | `.lofi-panel`, `.lofi-strip`, `.lofi-marker`. |
| `CLAUDE.md` | The journey, the invariants, the new modules. |

---

## Task 1: `src/lofi.ts` — trough detection

**Files:**
- Create: `src/lofi.ts`
- Create: `src/lofi.test.ts`
- Modify: `src/defaults.ts` (append `MAX_SPEECHES`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type Speech = { id: string; name: string; seconds: number }`
  - `export type Placement = { id: string; at: number }`
  - `export type TroughResult = { placements: Placement[] } | { error: string }`
  - `export function troughs(env: Float32Array, seconds: number, speeches: Speech[]): TroughResult`
  - `export const FADE = 0.5`, `BUCKETS_PER_SEC = 4`, `MIN_GAP = 20`,
    `SKIP_HEAD = 15`, `SKIP_TAIL = 10`
  - `src/defaults.ts`: `export const MAX_SPEECHES = 8`

- [ ] **Step 1: Write the failing test**

Create `src/lofi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BUCKETS_PER_SEC, FADE, MIN_GAP, SKIP_HEAD, SKIP_TAIL, troughs } from "./lofi.ts";

/** An envelope at `loud` everywhere except inside `holes`, which sit at
 *  `quiet`. Built at BUCKETS_PER_SEC so the tests speak in seconds. */
function envOf(
  seconds: number,
  holes: { from: number; to: number }[],
  loud = 0.8,
  quiet = 0.05,
): Float32Array {
  const env = new Float32Array(Math.round(seconds * BUCKETS_PER_SEC)).fill(loud);
  for (const h of holes) {
    for (let b = Math.round(h.from * BUCKETS_PER_SEC); b < Math.round(h.to * BUCKETS_PER_SEC); b++) {
      env[b] = quiet;
    }
  }
  return env;
}

const ok = (r: ReturnType<typeof troughs>) => {
  if ("error" in r) throw new Error(`expected placements, got: ${r.error}`);
  return r.placements;
};

describe("troughs", () => {
  it("places a speech inside the one quiet hole", () => {
    // 120s of music, quiet from 40s to 60s. A 6s speech needs 7s of room.
    const env = envOf(120, [{ from: 40, to: 60 }]);
    const [p] = ok(troughs(env, 120, [{ id: "a", name: "a.mp4", seconds: 6 }]));
    expect(p?.id).toBe("a");
    // `at` is where the speech's own picture starts — FADE past the window.
    expect(p?.at).toBeGreaterThanOrEqual(40);
    expect((p?.at ?? 0) + 6).toBeLessThanOrEqual(60);
  });

  it("returns placements in time order, one per speech", () => {
    const env = envOf(240, [{ from: 40, to: 60 }, { from: 150, to: 175 }]);
    const out = ok(
      troughs(env, 240, [
        { id: "a", name: "a.mp4", seconds: 6 },
        { id: "b", name: "b.mp4", seconds: 6 },
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.at).toBeLessThan(out[1]?.at ?? 0);
    expect(new Set(out.map((p) => p.id))).toEqual(new Set(["a", "b"]));
  });

  it("keeps MIN_GAP between two speeches sharing one long hole", () => {
    const env = envOf(240, [{ from: 40, to: 150 }]);
    const out = ok(
      troughs(env, 240, [
        { id: "a", name: "a.mp4", seconds: 6 },
        { id: "b", name: "b.mp4", seconds: 6 },
      ]),
    );
    const [first, second] = [...out].sort((x, y) => x.at - y.at);
    expect((second?.at ?? 0) - ((first?.at ?? 0) + 6)).toBeGreaterThanOrEqual(MIN_GAP);
  });

  // THE ordering test. Input order would drop the short speech into the big
  // hole (it is the quietest) and strand the long one, which fits nowhere
  // else. Longest-first places the long one there and the short one in the
  // small hole. Mutation: sorting by input order instead fails this.
  it("places the longest speech first", () => {
    const env = new Float32Array(300 * BUCKETS_PER_SEC).fill(0.8);
    const quiet = (from: number, to: number, level: number) => {
      for (let b = from * BUCKETS_PER_SEC; b < to * BUCKETS_PER_SEC; b++) env[b] = level;
    };
    quiet(40, 70, 0.02); // 30s and the quietest — the only hole a 20s speech fits
    quiet(150, 162, 0.05); // 12s, room for the 6s speech only
    const out = ok(
      troughs(env, 300, [
        { id: "short", name: "short.mp4", seconds: 6 },
        { id: "long", name: "long.mp4", seconds: 20 },
      ]),
    );
    expect(out).toHaveLength(2);
    const long = out.find((p) => p.id === "long");
    expect(long?.at).toBeGreaterThanOrEqual(40);
    expect((long?.at ?? 0) + 20).toBeLessThanOrEqual(70);
  });

  it("refuses a speech with no quiet stretch long enough, naming it", () => {
    const env = envOf(120, [{ from: 40, to: 48 }]);
    const r = troughs(env, 120, [{ id: "a", name: "long.mp4", seconds: 40 }]);
    expect("error" in r && r.error).toContain("long.mp4");
  });

  it("will not place a speech in the opening or over the ending", () => {
    // The only quiet stretches are inside SKIP_HEAD and inside SKIP_TAIL.
    const env = envOf(120, [{ from: 0, to: SKIP_HEAD }, { from: 120 - SKIP_TAIL, to: 120 }]);
    const out = ok(troughs(env, 120, [{ id: "a", name: "a.mp4", seconds: 4 }]));
    expect(out[0]?.at).toBeGreaterThanOrEqual(SKIP_HEAD);
    expect((out[0]?.at ?? 0) + 4).toBeLessThanOrEqual(120 - SKIP_TAIL);
  });

  it("is stable across repeated calls", () => {
    const env = envOf(240, [{ from: 40, to: 60 }, { from: 150, to: 175 }]);
    const speeches = [
      { id: "a", name: "a.mp4", seconds: 6 },
      { id: "b", name: "b.mp4", seconds: 8 },
    ];
    expect(troughs(env, 240, speeches)).toEqual(troughs(env, 240, speeches));
  });

  it("reserves 2 * FADE around each speech", () => {
    // The hole is exactly the speech plus its two dips and nothing more, so
    // there is exactly one legal window and its position is arithmetic.
    const env = envOf(120, [{ from: 50, to: 50 + 6 + 2 * FADE }]);
    const out = ok(troughs(env, 120, [{ id: "a", name: "a.mp4", seconds: 6 }]));
    expect(out[0]?.at).toBeCloseTo(50 + FADE, 1);
  });

  it("has no placements to make for no speeches", () => {
    expect(ok(troughs(envOf(60, []), 60, []))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /Users/vuhoangvuong/WORKSPACE/personal/vstack && pnpm vitest run src/lofi.test.ts
```

Expected: FAIL — `Failed to resolve import "./lofi.ts"`.

- [ ] **Step 3: Write `src/lofi.ts`**

```ts
/** Where a speech goes in a music track, found from the track's own
 *  loudness envelope.
 *
 *  Imports NOTHING, and sits at the bottom of the client layering beside
 *  `geometry.ts` and `segments.ts`. That is what lets vitest's `node`
 *  environment test it at all — the caller owns the decode — and what would
 *  let the server import it directly the day detection has to move, the way
 *  `ytdlp.ts` already reaches across for `geometry.ts`'s `PAD`. */

/** One uploaded speech, as the panel knows it. `seconds` is what
 *  `/api/upload` probed; `name` is the local filename, for the error
 *  message and the list row only. */
export type Speech = { id: string; name: string; seconds: number };

/** Where one speech's own picture starts, in the music's timeline. The dip
 *  to black that precedes it runs `FADE` earlier. */
export type Placement = { id: string; at: number };

export type TroughResult = { placements: Placement[] } | { error: string };

/** How long the dip at each edge of a cut-in takes.
 *
 *  The same 0.5s `longform.ts` uses, and declared here rather than shared
 *  for the same reason its BLUR_SIGMA is not shared with `starter.ts`: these
 *  sit on opposite sides of the client/server line, and one constant for two
 *  transitions means tuning either one moves the other. `server/lofi.ts`
 *  declares its own copy; `server/lofi.test.ts` pins the value. */
export const FADE = 0.5;

/** The envelope's resolution. Four buckets a second is fine enough to find
 *  the edge of a breakdown and coarse enough that one quiet beat inside a
 *  loud bar does not read as a hole. */
export const BUCKETS_PER_SEC = 4;

/** The least music between two speeches. Without it two speeches drop into
 *  the two halves of one long breakdown and read as one long interruption. */
export const MIN_GAP = 20;

/** No speech in the opening: the track needs to establish itself before it
 *  is interrupted. */
export const SKIP_HEAD = 15;

/** Nor over the ending, which is the track's own resolution. */
export const SKIP_TAIL = 10;

/** The envelope's midpoint, which is what "quiet for this track" is measured
 *  against.
 *
 *  GLOBAL, deliberately — where `server/chat.ts`'s scorer needs a rolling
 *  median because an eleven-hour stream's density drifts by an order of
 *  magnitude across it, a music track is stationary: its loud passages and
 *  its quiet ones interleave on a scale of bars, not hours.
 *
 *  ponytail: global. A track that is loud for its first half and quiet for
 *  its second would put every speech in the second half; go rolling (a
 *  +/- 60s window, `chat.ts`'s shape) the day one does. */
function median(env: Float32Array): number {
  const sorted = Array.from(env).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/** Mean of the envelope over the bucket range [from, to). */
function windowMean(env: Float32Array, from: number, to: number): number {
  let sum = 0;
  let n = 0;
  for (let b = from; b < to && b < env.length; b++) {
    sum += env[b] ?? 0;
    n++;
  }
  return n === 0 ? Infinity : sum / n;
}

/** Where each speech goes, or the first reason one of them cannot go
 *  anywhere.
 *
 *  Placement is greedy and **longest first**. A long speech has strictly
 *  fewer legal windows than a short one, so placing the short ones first can
 *  take the only window the long one had — and the failure is not an error,
 *  it is a render with a speech missing from it.
 *
 *  It does NOT fall back to a least-bad position for a speech that fits
 *  nowhere. A silently misplaced speech is indistinguishable from a working
 *  render until someone watches the output, which is the failure class this
 *  codebase exists to keep out of its own exports. */
export function troughs(
  env: Float32Array,
  seconds: number,
  speeches: Speech[],
): TroughResult {
  if (speeches.length === 0) return { placements: [] };
  if (!(seconds > 0) || env.length === 0) {
    return { error: "That track has no audio to measure." };
  }
  // Derived from the envelope rather than assumed to be BUCKETS_PER_SEC: the
  // caller builds it, and a caller that used a different resolution should
  // still get the right answer rather than a subtly shifted one.
  const perSec = env.length / seconds;
  // Floored away from zero: a track of pure digital silence would otherwise
  // divide every window by 0 and score them all NaN.
  const base = Math.max(median(env), 1e-6);

  const taken: { from: number; to: number }[] = [];
  const placements: Placement[] = [];

  // A stable sort on a copy: `speeches` is the caller's array, and the
  // longest-first pass must not reorder the panel's list as a side effect.
  const order = speeches
    .map((speech, i) => ({ speech, i }))
    .sort((a, b) => b.speech.seconds - a.speech.seconds || a.i - b.i);

  for (const { speech } of order) {
    // The dips at both edges are part of the room this speech needs, not
    // extra on top of it.
    const need = speech.seconds + 2 * FADE;
    const lo = SKIP_HEAD;
    const hi = seconds - SKIP_TAIL - need;
    let bestAt = -1;
    let bestScore = Infinity;
    // Stepped by BUCKET INDEX, never by an accumulated float stride: a
    // stride added a few thousand times drifts off the end of the envelope.
    // Same lesson `peaks()` in `waveform.ts` states for its bucket edges.
    for (let b = Math.ceil(lo * perSec); b <= Math.floor(hi * perSec); b++) {
      const from = b / perSec;
      const to = from + need;
      const clash = taken.some((r) => from < r.to + MIN_GAP && to > r.from - MIN_GAP);
      if (clash) continue;
      const score = windowMean(env, b, Math.ceil(to * perSec)) / base;
      if (score < bestScore) {
        bestScore = score;
        bestAt = from;
      }
    }
    if (bestAt < 0) {
      return {
        error:
          `${speech.name} (${Math.round(speech.seconds)}s) has no quiet stretch ` +
          `that long left in the track.`,
      };
    }
    taken.push({ from: bestAt, to: bestAt + need });
    placements.push({ id: speech.id, at: bestAt + FADE });
  }

  placements.sort((a, b) => a.at - b.at);
  return { placements };
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /Users/vuhoangvuong/WORKSPACE/personal/vstack && pnpm vitest run src/lofi.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Mutation-test the ordering rule**

Temporarily change the sort in `troughs` to input order:

```ts
    .sort((a, b) => a.i - b.i);
```

Run the suite again. Expected: `"places the longest speech first"` FAILS and
nothing else does. Restore the real sort and confirm the suite is green
again. If the mutation does **not** fail that test, the fixture is too
generous — widen the gap between the two holes' levels until it does.

- [ ] **Step 6: Add `MAX_SPEECHES` to `src/defaults.ts`**

Append (matching the file's existing comment density):

```ts
/** The most speeches one lofi render will take.
 *
 *  Shared client and server, like `MAX_PARTS`: the panel refuses the
 *  eleventh file before it is uploaded, and `/api/lofi` refuses it again
 *  because the route is reachable without the panel. Eight cut-ins over one
 *  track is already a lot of interruption; the cap is a sanity bound on the
 *  filter graph's size, not a judgement about music. */
export const MAX_SPEECHES = 8;
```

- [ ] **Step 7: Run the whole suite and commit**

```bash
cd /Users/vuhoangvuong/WORKSPACE/personal/vstack && pnpm test
```

Expected: all previous tests plus 8 new ones pass.

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/lofi.ts src/lofi.test.ts src/defaults.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "$(cat <<'EOF'
feat: find a music track's quiet stretches

troughs() scores every candidate window against the envelope's own median
and places the longest speech first — a long speech has fewer legal windows
than a short one, so input order can strand it, and a stranded speech is a
render with something missing rather than an error.

A speech that fits nowhere refuses by name instead of falling back to a
least-bad position.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `probeAudio` and `/api/upload-audio`

**Files:**
- Modify: `server/ffmpeg.ts` (add `probeAudio` beside `probeFile`, ~line 262)
- Modify: `server/ffmpeg.test.ts` (tests for it)
- Modify: `server/index.ts` (extract the upload handler; add the second URL)
- Modify: `src/api.ts` (`upload(file, audio?)`)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `export async function probeAudio(path: string): Promise<{ seconds: number }>`
  - `POST /api/upload-audio` → `{ id, duration }`
  - `api.upload(file: File, audio = false): Promise<UploadResult>`

- [ ] **Step 1: Write the failing test**

Append to `server/ffmpeg.test.ts` (it already has a `dir` from `mkdtemp` in
`beforeAll` and a `run` helper — reuse both):

```ts
describe("probeAudio", () => {
  let tone = "";

  beforeAll(async () => {
    tone = join(dir, "tone.mp3");
    await run("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-y", tone,
    ]);
  }, 60_000);

  it("reads an audio-only file's duration", async () => {
    const { seconds } = await probeAudio(tone);
    expect(seconds).toBeGreaterThan(2.8);
    expect(seconds).toBeLessThan(3.3);
  });

  // The whole reason this function exists: the music upload cannot go
  // through probeFile, which demands a video stream.
  it("is needed because probeFile rejects the same file", async () => {
    await expect(probeFile(tone)).rejects.toThrow(/no video stream/);
  });

  it("rejects a file with no audio stream", async () => {
    const silent = join(dir, "silent-probe.mp4");
    await run("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1:r=30",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-y", silent,
    ]);
    await expect(probeAudio(silent)).rejects.toThrow(/no audio stream/);
  });
});
```

Add `probeAudio` to that file's import from `./ffmpeg.ts`.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/vuhoangvuong/WORKSPACE/personal/vstack && pnpm vitest run server/ffmpeg.test.ts -t probeAudio
```

Expected: FAIL — `probeAudio is not exported by ./ffmpeg.ts`.

- [ ] **Step 3: Implement `probeAudio` in `server/ffmpeg.ts`**

Directly below `probeFile`:

```ts
/** An audio-only file's duration.
 *
 *  A separate function rather than a flag on `probeFile` because the two
 *  answer different questions and have different failure modes: `probeFile`
 *  throws when there is no VIDEO stream (`ffprobe found no video stream in
 *  …`), which is the correct answer for a part and the wrong one for a music
 *  track. This throws when there is no AUDIO stream, which is the only thing
 *  that makes a track useless here.
 *
 *  Note what it does not return: dimensions, fps, `hasAudio`. An mp3 with
 *  cover art HAS a video stream (one attached picture), so reporting those
 *  would hand the caller numbers that describe a thumbnail. */
export async function probeAudio(path: string): Promise<{ seconds: number }> {
  let stdout: string;
  try {
    ({ stdout } = await run("ffprobe", [
      "-v", "error",
      "-show_entries", "stream=codec_type:format=duration",
      "-of", "json",
      path,
    ]));
  } catch (err) {
    throw toolError("ffprobe", err);
  }
  const parsed = JSON.parse(stdout) as {
    streams?: { codec_type?: string }[];
    format?: { duration?: string };
  };
  if (!(parsed.streams ?? []).some((s) => s.codec_type === "audio")) {
    throw new Error(`ffprobe found no audio stream in ${path}`);
  }
  return { seconds: Number(parsed.format?.duration ?? 0) };
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd /Users/vuhoangvuong/WORKSPACE/personal/vstack && pnpm vitest run server/ffmpeg.test.ts -t probeAudio
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Extract the upload handler and add the second URL**

In `server/index.ts`, the current handler is `if (req.url === "/api/upload") {
… }` (around line 719). Change its condition to cover both URLs and branch
only where the prober is chosen. Replace the opening line:

```ts
  if (req.url === "/api/upload" || req.url === "/api/upload-audio") {
    // Two URLs rather than `?audio=1`, because this server routes on exact
    // `req.url` equality (see the comment on /api/publish/progress) and a
    // query string matches neither branch. They share every line but the
    // prober: a music track has no video stream, so `probeFile` — whose
    // whole job is to report dimensions — is the wrong trust boundary for
    // one, and `probeAudio` is the right one.
    const audio = req.url === "/api/upload-audio";
```

and replace the probe-and-answer block inside the `try` (currently
`const probed = await probeFile(partial); … return send(res, 200, {...})`)
with:

```ts
      // THE TRUST BOUNDARY, either way. Nothing else inspects these bytes,
      // and nothing needs to — ffmpeg is their only consumer, so "ffprobe
      // understands it" is exactly the property that matters.
      const probed = audio
        ? { seconds: (await probeAudio(partial)).seconds, width: 0, height: 0 }
        : await probeFile(partial);
      await rename(partial, final);
      console.warn(
        `vstack: uploaded ${id} (${Math.round(statSync(final).size / 1e6)} MB)`,
      );
      reportCache();
      return send(res, 200, {
        id,
        duration: probed.seconds,
        width: probed.width,
        height: probed.height,
      });
```

and the catch's message so it names the right thing:

```ts
      throw new HttpError(400, `That file is not ${audio ? "audio" : "video"} ffmpeg can read: ${
        err instanceof Error ? err.message : String(err)
      }`);
```

Add `probeAudio` to the `./ffmpeg.ts` import list at the top of the file.

- [ ] **Step 6: Teach the client wrapper the second URL**

In `src/api.ts`, change `upload`'s signature and body:

```ts
export async function upload(file: File, audio = false): Promise<UploadResult> {
  if (file.size > UPLOAD_MAX_BYTES) {
    throw new Error(
      `${file.name} is ${(file.size / 1e6).toFixed(0)} MB — the limit is ` +
        `${Math.round(UPLOAD_MAX_BYTES / 1e6)} MB.`,
    );
  }
  // The content type is informational — the server reads the bytes, not the
  // header — but sending `video/mp4` for a music track would be a lie in
  // the one place a future reader would trust.
  const res = await send(audio ? "/api/upload-audio" : "/api/upload", {
    method: "POST",
    headers: { "content-type": audio ? "application/octet-stream" : "video/mp4" },
    body: file,
  });
  return res.json() as Promise<UploadResult>;
}
```

`UploadResult` keeps its shape; `width`/`height` come back as `0` for audio,
which no caller of the audio path reads.

- [ ] **Step 7: Verify the route by hand**

```bash
cd /Users/vuhoangvuong/WORKSPACE/personal/vstack
ffmpeg -v error -f lavfi -i sine=frequency=440:duration=3 -y /tmp/vstack-tone.mp3
pnpm server &
sleep 3
curl -s -X POST --data-binary @/tmp/vstack-tone.mp3 http://127.0.0.1:8787/api/upload-audio
curl -s -X POST --data-binary @/tmp/vstack-tone.mp3 http://127.0.0.1:8787/api/upload
```

Expected: the first prints `{"id":"…","duration":3.0…,"width":0,"height":0}`;
the second prints a 400 whose message contains `no video stream`. Stop the
server (`kill %1`) and delete the two uploads it left in `media/uploads/`
with Node's `fs.rm` (shell `rm` is deny-listed).

- [ ] **Step 8: Run the whole suite and commit**

```bash
cd /Users/vuhoangvuong/WORKSPACE/personal/vstack && pnpm test
```

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add server/ffmpeg.ts server/ffmpeg.test.ts server/index.ts src/api.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "$(cat <<'EOF'
feat: accept an audio-only upload

probeFile demands a video stream, which is the right trust boundary for a
long-form part and the wrong one for a music track. probeAudio asks the
other question, and /api/upload-audio shares every other line of the
upload handler with /api/upload.

A second URL rather than a query flag: this server routes on exact req.url
equality, so /api/upload?audio=1 would have matched nothing at all.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `server/lofi.ts` — the render

**Files:**
- Create: `server/lofi.ts`
- Create: `server/lofi.test.ts`

**Interfaces:**
- Consumes: `probeFile` from `server/ffmpeg.ts`, `toolError` from
  `server/errors.ts`. **Nothing else from `server/`.**
- Produces:
  - `export type Cut = { path: string; at: number }`
  - `export async function renderLofi(opts: { image: string; music: string; cuts: Cut[]; out: string }): Promise<string>`
  - `export const WIDE = { w: 1920, h: 1080 }`, `FADE = 0.5`,
    `TRANSITION_PATH`, `TRANSITION_PEAK = 1.2`
  - `export async function checkLofi(): Promise<void>` — boot check, wired in
    Task 4

- [ ] **Step 1: Write the failing test**

Create `server/lofi.test.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeFile } from "./ffmpeg.ts";
import { FADE, renderLofi } from "./lofi.ts";

const run = promisify(execFile);

let dir = "";
/** A flat teal background picture. */
let bg = "";
/** 30s of a 220 Hz sine — the music bed. Long enough to hold a cut-in with
 *  SKIP_HEAD-sized room either side, short enough to encode in seconds. */
let music = "";
/** A 3s vertical "speech": a solid crimson frame over WHITE NOISE. The noise
 *  is what makes the band-limiting measurable — a sine would pass or fail
 *  the 6 kHz check purely on where its one frequency sits. */
let speech = "";
/** The same, silent, for the anullsrc stand-in. */
let mute = "";
let out = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vstack-lofi-"));

  bg = join(dir, "bg.jpg");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=0x108080:s=1920x1080",
    "-frames:v", "1", "-y", bg,
  ]);

  music = join(dir, "music.m4a");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=30",
    "-c:a", "aac", "-y", music,
  ]);

  speech = join(dir, "speech.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=0xC03030:s=1080x1920:d=3:r=30",
    "-f", "lavfi", "-i", "anoisesrc=d=3:c=white:a=0.5",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-shortest", "-y", speech,
  ]);

  mute = join(dir, "mute.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=0x30C030:s=1080x1920:d=2:r=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", mute,
  ]);

  out = join(dir, "out.mp4");
  // One cut-in at t=12, well clear of both ends.
  await renderLofi({ image: bg, music, cuts: [{ path: speech, at: 12 }], out });
  // Explicit, because several real encodes compete for CPU in the full
  // suite — `server/longform.test.ts`'s hook carries one for the same
  // reason.
}, 180_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** One frame at `t`, decoded to raw RGB, sampled at (x, y). Thresholds
 *  rather than equality: libx264 is lossy. */
async function pixelAt(path: string, t: number, x: number, y: number, width = 1920) {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-ss", String(t), "-i", path, "-frames:v", "1",
     "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 64 << 20 },
  );
  const buf = stdout as unknown as Buffer;
  const i = (y * width + x) * 3;
  return { r: buf[i] ?? 0, g: buf[i + 1] ?? 0, b: buf[i + 2] ?? 0 };
}

/** Mean and peak dB over a window, optionally through a filter first. */
async function loudness(path: string, t: number, dur: number, pre = "") {
  const { stderr } = await run("ffmpeg", [
    "-hide_banner", "-ss", String(t), "-t", String(dur), "-i", path,
    "-map", "0:a", "-af", pre === "" ? "volumedetect" : `${pre},volumedetect`,
    "-f", "null", "-",
  ]);
  const mean = /mean_volume: (-?[0-9.]+) dB/.exec(stderr);
  const max = /max_volume: (-?[0-9.]+) dB/.exec(stderr);
  return { mean: mean ? Number(mean[1]) : -91, max: max ? Number(max[1]) : -91 };
}

describe("FADE", () => {
  // The dip samples below are placed from this value.
  it("is the 0.5s the dip samples assume", () => {
    expect(FADE).toBe(0.5);
  });
});

describe("renderLofi", () => {
  it("is 1920x1080 and exactly as long as the music", async () => {
    const probed = await probeFile(out);
    expect(probed.width).toBe(1920);
    expect(probed.height).toBe(1080);
    // THE invariant: the render's duration is the track's, so the name
    // `/api/lofi` builds from it cannot come to describe a different file.
    expect(probed.seconds).toBeGreaterThan(29.5);
    expect(probed.seconds).toBeLessThan(30.5);
  });

  it("shows the background picture outside a cut-in", async () => {
    const p = await pixelAt(out, 4, 960, 540);
    expect(p.g).toBeGreaterThan(90);
    expect(p.b).toBeGreaterThan(90);
    expect(p.r).toBeLessThan(80);
  });

  it("shows the speech inside its cut-in", async () => {
    // Mid-speech, past its fade-in and before its fade-out.
    const p = await pixelAt(out, 13.5, 960, 540);
    expect(p.r).toBeGreaterThan(120);
    expect(p.g).toBeLessThan(90);
  });

  it("dips to black at the edge of a cut-in", async () => {
    // The crossing point: the background has faded out and the speech has
    // not faded in.
    const p = await pixelAt(out, 12, 960, 540);
    expect(p.r + p.g + p.b).toBeLessThan(120);
  });

  it("ducks the music under the speech", async () => {
    // Measured in a narrow band around the music's own 220 Hz, so the
    // speech's own energy cannot be mistaken for the bed's.
    const band = "bandpass=f=220:width_type=h:width=40";
    const before = await loudness(out, 6, 2, band);
    const during = await loudness(out, 13, 2, band);
    expect(during.mean).toBeLessThan(before.mean - 3);
  });

  it("band-limits the speech", async () => {
    // The source is white noise, so it carries real energy above 6 kHz; the
    // lowpass at 3 kHz is what has to remove it.
    const high = "highpass=f=6000";
    const inSpeech = await loudness(out, 13, 2, high);
    const source = await loudness(speech, 0.5, 2, high);
    expect(inSpeech.mean).toBeLessThan(source.mean - 12);
  });

  it("renders a silent speech through the stand-in", async () => {
    const quiet = join(dir, "quiet.mp4");
    await renderLofi({ image: bg, music, cuts: [{ path: mute, at: 12 }], out: quiet });
    const probed = await probeFile(quiet);
    expect(probed.hasAudio).toBe(true);
    expect(probed.seconds).toBeGreaterThan(29.5);
    const p = await pixelAt(quiet, 13, 960, 540);
    expect(p.g).toBeGreaterThan(120);
  }, 120_000);

  it("renders two cut-ins in their own windows", async () => {
    const two = join(dir, "two.mp4");
    await renderLofi({
      image: bg,
      music,
      cuts: [{ path: speech, at: 6 }, { path: mute, at: 20 }],
      out: two,
    });
    const first = await pixelAt(two, 7.5, 960, 540);
    expect(first.r).toBeGreaterThan(120);
    const second = await pixelAt(two, 21, 960, 540);
    expect(second.g).toBeGreaterThan(120);
    const between = await pixelAt(two, 14, 960, 540);
    expect(between.b).toBeGreaterThan(90);
    expect(between.r).toBeLessThan(80);
  }, 180_000);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/vuhoangvuong/WORKSPACE/personal/vstack && pnpm vitest run server/lofi.test.ts
```

Expected: FAIL — cannot resolve `./lofi.ts`.

- [ ] **Step 3: Write `server/lofi.ts`**

```ts
/** The lofi journey's one ffmpeg pass.
 *
 *  Sits BESIDE `ffmpeg.ts`, `longform.ts` and `starter.ts` rather than above
 *  any of them: it takes every path from the caller, needs neither
 *  `MEDIA_DIR` nor `OUT_DIR`, and may read `probeFile` and nothing else. */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { toolError } from "./errors.ts";
import { probeAudio, probeFile } from "./ffmpeg.ts";

const run = promisify(execFile);

/** YouTube's long-form shape. A lofi mix is a track long; there is no
 *  vertical case to configure. */
export const WIDE = { w: 1920, h: 1080 };

const FPS = 30;
const RATE = 44100;
const CRF = "20";

/** How long the dip at each edge of a cut-in takes.
 *
 *  The client's `src/lofi.ts` declares the same 0.5s and reserves `2 * FADE`
 *  around every speech it places. The two are deliberately NOT shared —
 *  they sit on opposite sides of the client/server line, the same split
 *  `src/preview.ts` and `server/starter.ts` already live with — so
 *  `server/lofi.test.ts` and `src/lofi.test.ts` each pin the value. Change
 *  one and change the other. */
export const FADE = 0.5;

/** The blur behind a cut-in's letterbox, computed at 480x270 and stretched
 *  back up. Same value and same reasoning as `longform.ts`'s: the upscale
 *  supplies most of the softening, and a gblur over a 1920x3413 intermediate
 *  costs roughly fifty times as much for a picture whose entire purpose is
 *  to be out of focus. */
const BLUR_SIGMA = 12;
const BG_W = 480;
const BG_H = 270;

/** The speech's own band. An AM-radio 300-3000 Hz is the whole "lofi
 *  effect" — it is what makes a clean recording sit inside the mix instead
 *  of on top of it. */
const SPEECH_HP = 300;
const SPEECH_LP = 3000;
/** Makeup for what the band takes out. */
const SPEECH_GAIN = 1.6;

/** The duck. `sidechaincompress` takes a threshold and a ratio, not a target
 *  depth, which is why there is no dB knob here — the depth is whatever
 *  those two produce against the track's own level.
 *
 *  A compressor rather than `volume=enable='between(t,a,b)'`: a step has no
 *  attack or release and clicks at both edges. It is also what makes a
 *  merely adequate trough sound deliberate, so the detector only has to find
 *  a thin stretch rather than a silent one. */
const DUCK_THRESHOLD = 0.03;
const DUCK_RATIO = 8;
const DUCK_ATTACK = 20;
const DUCK_RELEASE = 400;

/** The swell over each cut-in.
 *
 *  Re-derived here rather than imported from `longform.ts`, which is this
 *  module's SIBLING: a path is not a dependency, and importing across that
 *  line would put a cycle-shaped edge into a layering that is deliberately
 *  acyclic. Same call `longform.ts` itself made against `starter.ts`. */
const asset = (name: string) => fileURLToPath(new URL(`assets/${name}`, import.meta.url));
export const TRANSITION_PATH = asset("long-form-transition-sound.mp3");

/** Where the swell peaks inside the asset — it opens on ~0.6s of near
 *  silence, so it is placed by its peak and not by its start. A delay of the
 *  boundary itself would put the swell a second after the cut, over a
 *  picture that has already come back up. */
export const TRANSITION_PEAK = 1.2;
const TRANSITION_GAIN = 1.0;

/** One speech, and where its own picture starts in the music's timeline. Its
 *  duration is probed here rather than taken from the caller: the graph's
 *  fades, its `enable=` window and its audio delay all have to agree about
 *  it, and one prober is how they stay agreed. */
export type Cut = { path: string; at: number };

/** Boot check for the one asset this journey plays. Hard, like
 *  `checkLongform`'s: a missing file fails a render that is minutes of
 *  encoding away from discovering it. */
export async function checkLofi(): Promise<void> {
  if (!existsSync(TRANSITION_PATH)) {
    console.error(`vstack: bundled asset missing at ${TRANSITION_PATH}.`);
    process.exit(1);
  }
}

/** Renders the picture, the track and the cut-ins into one 1920x1080 file.
 *
 *  OVERLAY, not concat, and that is the load-bearing choice: the output's
 *  duration is the music's by construction (`-t`), so nothing sums, no leg's
 *  length feeds a later leg's offset, and the name `/api/lofi` builds from
 *  that duration cannot come to describe a different file. A concat of image
 *  legs and speech legs would put all of that arithmetic back.
 *
 *  Each speech is padded to its own start with `tpad` rather than shifted
 *  with `setpts`, and gated with `enable=`. The padding frames are black and
 *  are never drawn, because `enable=` is false while they pass; what it buys
 *  is that `overlay`'s second input always has a frame, which a bare `setpts`
 *  offset does not guarantee.
 *
 *  ponytail: `tpad` synthesises `at * FPS` black frames per cut-in — free to
 *  make, not free to push through the chain. Switch to a `setpts` offset if
 *  a long track with many cut-ins ever makes the encode drag, and re-check
 *  the timing assertions in `server/lofi.test.ts` when you do. */
export async function renderLofi(opts: {
  image: string;
  music: string;
  cuts: Cut[];
  out: string;
}): Promise<string> {
  const { image, music, cuts, out } = opts;
  // `probeAudio`, never `probeFile`: the track has no video stream, and
  // `probeFile` throws on exactly that. Task 2's prober, imported rather
  // than duplicated — `ffmpeg.ts` is the layer below this one, so there is
  // no layering reason to re-derive it the way the ASSET path is re-derived.
  const { seconds } = await probeAudio(music);
  if (!(seconds > 0)) throw new Error(`Could not read a duration from ${music}.`);

  const probed = await Promise.all(cuts.map((c) => probeFile(c.path)));
  const anySilent = probed.some((p) => !p.hasAudio);
  // Positional and conditional, exactly as `stackWide`'s inputs are: image,
  // music, the cuts, then the stand-in, then the swell. Appending the swell
  // AFTER the stand-in is what keeps the stand-in's index the arithmetic it
  // already was.
  const firstCut = 2;
  const silenceIndex = firstCut + cuts.length;
  const soundIndex = silenceIndex + (anySilent ? 1 : 0);

  const inputs: string[] = [
    "-loop", "1", "-framerate", String(FPS), "-t", String(seconds), "-i", image,
    "-i", music,
  ];
  for (const cut of cuts) inputs.push("-i", cut.path);
  if (anySilent) inputs.push("-f", "lavfi", "-i", `anullsrc=r=${RATE}:cl=stereo`);
  if (cuts.length > 0) inputs.push("-i", TRANSITION_PATH);

  const legs: string[] = [];

  // The base picture, cover-cropped so it fills the frame edge to edge, with
  // one fade pair per cut-in chained onto it. `fade=out` HOLDS black after it
  // completes rather than restoring, which is what makes N pairs read as N
  // dips instead of as one fade the picture never returns from.
  const bgFades = cuts
    .map((cut, i) => {
      const dur = probed[i]?.seconds ?? 0;
      const outAt = Math.max(0, cut.at - FADE);
      return `fade=t=out:st=${outAt}:d=${FADE},fade=t=in:st=${cut.at + dur}:d=${FADE},`;
    })
    .join("");
  legs.push(
    `[0:v]scale=${WIDE.w}:${WIDE.h}:force_original_aspect_ratio=increase,` +
      `crop=${WIDE.w}:${WIDE.h},fps=${FPS},setsar=1,${bgFades}format=yuv420p[bg]`,
  );

  cuts.forEach((cut, i) => {
    const idx = firstCut + i;
    const dur = probed[i]?.seconds ?? 0;
    // Clamped so a pathologically short cut-in cannot have its fade-in
    // overlap its fade-out, which multiplies to a clip that never reaches
    // full brightness. Same clamp, same reason, as `stackWide`'s.
    const d = Math.min(FADE, dur / 3);
    legs.push(
      `[${idx}:v]split=2[cbg${i}][cfg${i}]`,
      `[cbg${i}]scale=${BG_W}:${BG_H}:force_original_aspect_ratio=increase,` +
        `crop=${BG_W}:${BG_H},gblur=sigma=${BLUR_SIGMA},` +
        `scale=${WIDE.w}:${WIDE.h},setsar=1[cbgz${i}]`,
      // `decrease`, never a fixed height: an upload is whatever file the user
      // picked, and a cut-in wider than 16:9 would overflow the frame.
      `[cfg${i}]scale=${WIDE.w}:${WIDE.h}:force_original_aspect_ratio=decrease:` +
        `force_divisible_by=2,setsar=1[cfgz${i}]`,
      // floor(x/2)*2 on both axes: `force_divisible_by=2` makes the fitted
      // size even, not the centring offset, and an overlay at an odd offset
      // in yuv420p lands on a half-chroma-sample boundary.
      `[cbgz${i}][cfgz${i}]overlay=floor((W-w)/4)*2:floor((H-h)/4)*2,fps=${FPS},` +
        `setpts=PTS-STARTPTS,fade=t=in:st=0:d=${d},fade=t=out:st=${dur - d}:d=${d},` +
        `tpad=start_duration=${cut.at},format=yuv420p[cut${i}]`,
    );
  });

  // Chained overlays, each gated to its own window. `eof_action=pass` and
  // `repeatlast=0` are what stop a finished cut-in's last frame sticking over
  // the rest of the track.
  let base = "[bg]";
  cuts.forEach((cut, i) => {
    const dur = probed[i]?.seconds ?? 0;
    const label = i === cuts.length - 1 ? "[v]" : `[ov${i}]`;
    legs.push(
      `${base}[cut${i}]overlay=0:0:eof_action=pass:repeatlast=0:` +
        `enable='between(t,${cut.at},${cut.at + dur})'${label}`,
    );
    base = label;
  });
  if (cuts.length === 0) legs.push(`[bg]null[v]`);

  const fmt = `aformat=sample_fmts=fltp:channel_layouts=stereo`;
  legs.push(`[1:a]aresample=${RATE},${fmt}[music]`);

  if (cuts.length === 0) {
    legs.push(`[music]anull[a]`);
  } else {
    cuts.forEach((cut, i) => {
      const src = probed[i]?.hasAudio === true ? `${firstCut + i}:a` : `${silenceIndex}:a`;
      const dur = probed[i]?.seconds ?? 0;
      // `atrim` matters only for the stand-in, which carries no `-t` of its
      // own and would otherwise run for the length of the whole track.
      legs.push(
        `[${src}]atrim=0:${dur},asetpts=PTS-STARTPTS,` +
          `highpass=f=${SPEECH_HP},lowpass=f=${SPEECH_LP},volume=${SPEECH_GAIN},` +
          `adelay=${Math.round(cut.at * 1000)}:all=1,aresample=${RATE},${fmt}[sp${i}]`,
      );
    });
    const spLabels = cuts.map((_, i) => `[sp${i}]`).join("");
    legs.push(
      cuts.length === 1
        ? `[sp0]anull[speech]`
        : `${spLabels}amix=inputs=${cuts.length}:normalize=0:duration=longest[speech]`,
    );
    // One copy drives the duck, the other is heard. `normalize=0` on every
    // mix: amix divides by its input count by default, so the whole render
    // would come out quiet purely for carrying a second stream.
    legs.push(`[speech]asplit=2[sc][sm]`);
    legs.push(
      `[music][sc]sidechaincompress=threshold=${DUCK_THRESHOLD}:ratio=${DUCK_RATIO}:` +
        `attack=${DUCK_ATTACK}:release=${DUCK_RELEASE}[ducked]`,
    );
    // `duration=first` keeps the programme's length — the music's — so a
    // delayed stream cannot extend the render past the duration the caller
    // has already committed to in the filename.
    legs.push(`[ducked][sm]amix=inputs=2:normalize=0:duration=first[mix]`);

    const taps = cuts.map((_, i) => `[ts${i}]`).join("");
    legs.push(`[${soundIndex}:a]asplit=${cuts.length}${taps}`);
    cuts.forEach((cut, i) => {
      // Placed by the swell's PEAK, clamped at zero because `adelay` cannot
      // take a negative offset and a cut-in inside the lead-in would ask for
      // one. On the way IN only: leaving a cut-in has the voice ending and
      // the track coming back, and a second swell there is noise.
      const delay = Math.max(0, Math.round((cut.at - TRANSITION_PEAK) * 1000));
      legs.push(
        `[ts${i}]adelay=${delay}:all=1,volume=${TRANSITION_GAIN},` +
          `aresample=${RATE},${fmt}[tsd${i}]`,
      );
    });
    const delayed = cuts.map((_, i) => `[tsd${i}]`).join("");
    legs.push(
      `[mix]${delayed}amix=inputs=${cuts.length + 1}:normalize=0:duration=first[a]`,
    );
  }

  try {
    await run(
      "ffmpeg",
      [
        "-v", "error",
        ...inputs,
        "-filter_complex", legs.join(";"),
        "-map", "[v]",
        "-map", "[a]",
        "-t", String(seconds),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", CRF,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        "-y", out,
      ],
      { maxBuffer: 16 << 20 },
    );
  } catch (err) {
    throw toolError("ffmpeg", err);
  }
  return out;
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /Users/vuhoangvuong/WORKSPACE/personal/vstack && pnpm vitest run server/lofi.test.ts
```

Expected: PASS, 9 tests, in roughly 60-120s of real encoding.

If the overlay stalls or a cut-in never appears, the cause is almost
certainly the `tpad`/`enable` pairing — print the graph with
`console.warn(legs.join(";\n"))` and run the same `ffmpeg` command by hand
with `-v info` to see which filter is waiting.

- [ ] **Step 5: Mutation-test the four silent failures**

Run each of these one at a time, confirm the named test fails, then restore:

1. **Drop the duck** — replace the `sidechaincompress` leg with
   `[music]anull[ducked]`. Expected: `"ducks the music under the speech"`
   fails and nothing else does.
2. **Drop `-t`** — remove `"-t", String(seconds),` from the argv. Expected:
   `"is 1920x1080 and exactly as long as the music"` fails (the render runs
   past the track, because `tpad`'s padding and the swell both outlive it).
3. **Drop the fades** — set `bgFades` to `""` and remove the two `fade=`
   filters from each cut chain. Expected: `"dips to black at the edge of a
   cut-in"` fails.
4. **Drop the band** — remove `highpass`/`lowpass` from the speech chain.
   Expected: `"band-limits the speech"` fails.

If any mutation fails *more* than its own test, note which and why in the
commit message — a test that catches two mutations is fine, one that catches
none is not.

- [ ] **Step 6: Commit**

```bash
cd /Users/vuhoangvuong/WORKSPACE/personal/vstack && pnpm test
```

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add server/lofi.ts server/lofi.test.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "$(cat <<'EOF'
feat: render a lofi mix in one ffmpeg pass

The picture is the base video and each speech is overlaid into its own
window, so the output's duration is the music's by construction — nothing
sums, and the name the route builds from that duration cannot come to
describe a different file.

The speech is band-limited to 300-3000 Hz and the music is ducked under it
by sidechaincompress rather than by a gated volume, which has no attack or
release and clicks at both edges.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `/api/lofi`

**Files:**
- Modify: `server/index.ts` (the route, its imports, and the boot check)

**Interfaces:**
- Consumes: `renderLofi`, `checkLofi` (Task 3); `probeAudio` (Task 2);
  `MAX_SPEECHES` (Task 1); existing `readTitle`, `jpeg`, `isUploadId`,
  `uploadPath`, `outName`, `thumbPath`, `removeExport`, `isOutName`,
  `inFlight`, `OUT_DIR`.
- Produces: `POST /api/lofi` → `{ name, url, size, duration }`.

- [ ] **Step 1: Add the route**

In `server/index.ts`, directly after the `/api/stack` handler. Imports to
add: `renderLofi`, `checkLofi` from `./lofi.ts`; `probeAudio` (already added
in Task 2); `MAX_SPEECHES` from `../src/defaults.ts`; `removeExport` from
`./ffmpeg.ts` if it is not already imported.

```ts
  // The lofi render. Takes ids and bytes, never paths — `uploadPath` builds
  // every path from a UUID `isUploadId` has already reduced to 36 characters
  // of hex and dashes, and the picture is bytes with a signature rather than
  // a name.
  if (req.url === "/api/lofi") {
    const raw = await json<Record<string, unknown>>(req);
    const title = readTitle(raw.title, "title");
    // Required, like the stack's: a lofi video's thumbnail is the background
    // the user picked, and there is no frame worth deriving one from — every
    // frame outside a cut-in is that same picture anyway.
    const image = jpeg(raw.image, "image");
    if (!isUploadId(raw.music)) return send(res, 400, { error: "Bad music id." });
    const musicPath = uploadPath(raw.music);
    if (!existsSync(musicPath)) {
      return send(res, 404, { error: "That music upload is no longer on disk." });
    }

    const speeches = raw.speeches;
    if (!Array.isArray(speeches) || speeches.length === 0) {
      return send(res, 400, { error: "speeches must be a non-empty array." });
    }
    if (speeches.length > MAX_SPEECHES) {
      return send(res, 400, { error: `At most ${MAX_SPEECHES} speeches.` });
    }
    const cuts: { path: string; at: number }[] = [];
    for (const entry of speeches) {
      if (entry === null || typeof entry !== "object") {
        return send(res, 400, { error: "Each speech must be an object." });
      }
      const { id, at } = entry as { id?: unknown; at?: unknown };
      if (!isUploadId(id)) return send(res, 400, { error: "Bad upload id." });
      if (typeof at !== "number" || !Number.isFinite(at) || at < 0) {
        return send(res, 400, { error: "Each speech needs a finite at >= 0." });
      }
      const path = uploadPath(id);
      if (!existsSync(path)) {
        return send(res, 404, { error: "One of those uploads is no longer on disk." });
      }
      cuts.push({ path, at });
    }
    cuts.sort((a, b) => a.at - b.at);

    // Every bound is checked against durations the SERVER probed. The client
    // sends only positions: a length it reported could put a cut-in past the
    // end of the track, which ffmpeg renders as a graph that fails minutes
    // in rather than as an error anyone can read.
    const { seconds: musicLength } = await probeAudio(musicPath);
    const lengths = await Promise.all(cuts.map((c) => probeFile(c.path)));
    for (const [i, cut] of cuts.entries()) {
      const dur = lengths[i]?.seconds ?? 0;
      if (cut.at + dur > musicLength) {
        return send(res, 400, { error: "A speech runs past the end of the track." });
      }
      const prev = cuts[i - 1];
      const prevDur = lengths[i - 1]?.seconds ?? 0;
      if (prev !== undefined && cut.at < prev.at + prevDur) {
        return send(res, 400, { error: "Two speeches overlap." });
      }
    }

    await mkdir(OUT_DIR, { recursive: true });
    // Marks of 0 and the track's length, ceiled — `<slug>-0000-<mmss>.mp4`,
    // which today's OUT_NAME already accepts. That is the whole reason
    // /out/, /api/reveal and /api/publish need no changes here.
    const total = Math.ceil(musicLength);
    const name = outName(title, 0, total);
    const outFile = join(OUT_DIR, name);
    const partial = outFile.replace(/\.mp4$/, `.${randomUUID()}.part.mp4`);

    // `renderLofi` takes a path and the picture arrived as bytes, so it goes
    // to a temp dir this route sweeps in its own `finally` — the same shape
    // /api/export and /api/say already use. Not tracked in `inFlight`: it is
    // in $TMPDIR, is not servable, and has no name a client could request.
    const work = await mkdtemp(join(tmpdir(), "vstack-lofi-"));
    const imageFile = join(work, "bg.jpg");
    await writeFile(imageFile, image);

    inFlight.add(partial);
    try {
      await renderLofi({ image: imageFile, music: musicPath, cuts, out: partial });
      await rename(partial, outFile);
      await writeFile(thumbPath(outFile), image).catch((err: unknown) => {
        console.warn(`vstack: could not save the thumbnail beside ${name}:`, err);
      });
      // After the rename and the sidecar, never before: a failed render must
      // leave the render it was replacing intact. Skipped when the name is
      // unchanged, which would unlink the file just written.
      if (isOutName(raw.prev) && raw.prev !== name) await removeExport(raw.prev);
      const { size, mtimeMs } = statSync(outFile);
      console.warn(`vstack: mixed out/${name} (${Math.round(size / 1e6)} MB)`);
      return send(res, 200, {
        name,
        // The mtime is the cache-buster: the name is stable across
        // re-renders, so without it the <video> re-shows the previous one.
        url: `/out/${name}?t=${Math.round(mtimeMs)}`,
        size,
        duration: total,
      });
    } finally {
      inFlight.delete(partial);
      await rm(partial, { force: true }).catch((err: unknown) => {
        console.error("vstack: lofi partial cleanup failed:", err);
      });
      await rm(work, { recursive: true, force: true }).catch((err: unknown) => {
        console.error("vstack: lofi temp cleanup failed:", err);
      });
    }
  }
```

`mkdtemp`, `tmpdir`, `writeFile`, `rename`, `rm`, `statSync`, `randomUUID`
and `join` are all already imported in this file.

- [ ] **Step 2: Wire the boot check**

Find where `checkStarter()` and `checkLongform()` are awaited at boot and add
`checkLofi()` beside them, in the same style.

- [ ] **Step 3: Verify the route end to end by hand**

```bash
cd /Users/vuhoangvuong/WORKSPACE/personal/vstack
ffmpeg -v error -f lavfi -i sine=frequency=220:duration=30 -c:a aac -y /tmp/vstack-music.m4a
ffmpeg -v error -f lavfi -i color=c=0x108080:s=1920x1080 -frames:v 1 -y /tmp/vstack-bg.jpg
ffmpeg -v error -f lavfi -i color=c=0xC03030:s=1080x1920:d=3:r=30 \
  -f lavfi -i anoisesrc=d=3:c=white:a=0.5 -c:v libx264 -pix_fmt yuv420p -c:a aac \
  -shortest -y /tmp/vstack-speech.mp4
pnpm server &
sleep 3
MUSIC=$(curl -s -X POST --data-binary @/tmp/vstack-music.m4a http://127.0.0.1:8787/api/upload-audio | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')
SPEECH=$(curl -s -X POST --data-binary @/tmp/vstack-speech.mp4 http://127.0.0.1:8787/api/upload | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')
node -e '
const fs = require("fs");
const body = {
  title: "Lofi route check",
  music: process.argv[1],
  image: fs.readFileSync("/tmp/vstack-bg.jpg").toString("base64"),
  speeches: [{ id: process.argv[2], at: 12 }],
};
fs.writeFileSync("/tmp/vstack-lofi-body.json", JSON.stringify(body));
' "$MUSIC" "$SPEECH"
curl -s -X POST -H 'content-type: application/json' \
  --data-binary @/tmp/vstack-lofi-body.json http://127.0.0.1:8787/api/lofi
```

Expected: `{"name":"lofi-route-check-0000-0030.mp4","url":"/out/…?t=…",
"size":…,"duration":30}`, and that file exists in `~/Desktop/vstack/` with a
`.thumb.jpg` beside it. Then check the two refusals:

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"title":"x","music":"../../etc/passwd","image":"","speeches":[]}' \
  http://127.0.0.1:8787/api/lofi
```

Expected: `{"error":"Bad music id."}` — not a traversal, not a 500.

Stop the server and sweep the two files from `~/Desktop/vstack/` and the
uploads from `media/uploads/` with Node's `fs.rm`.

- [ ] **Step 4: Run the suite and commit**

```bash
cd /Users/vuhoangvuong/WORKSPACE/personal/vstack && pnpm test
```

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add server/index.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "$(cat <<'EOF'
feat: add /api/lofi

Takes a music upload id, a JPEG background and a speech id plus a position
each. Every bound is checked against durations the server probes itself —
a length the client reported could put a cut-in past the end of the track,
which fails minutes into a render rather than at the door.

The name is outName(title, 0, ceil(track)), which today's OUT_NAME already
accepts, so /out/, /api/reveal and /api/publish needed no changes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Client state and the API wrapper

**Files:**
- Modify: `src/state.ts`
- Modify: `src/state.test.ts`
- Modify: `src/api.ts`

**Interfaces:**
- Consumes: `Speech`, `Placement` from `src/lofi.ts` (Task 1).
- Produces:
  - `Phase` gains `"lofi"`; `mode` gains `"lofi"`.
  - `AppState` gains `music: { id: string; name: string; seconds: number } | null`,
    `bg: string`, `bgName: string`, `speeches: Speech[]`,
    `placements: Placement[]`.
  - `api.lofi(body): Promise<LofiResult>` where
    `LofiResult = { name: string; url: string; size: number }`.

- [ ] **Step 1: Write the failing test**

Append to `src/state.test.ts`, beside the existing exclusion tests:

```ts
describe("the lofi journey's state", () => {
  // Same rule `parts` and `thumb` already follow: these describe a session's
  // work, not a property of a video, and the picture is a megabyte-scale
  // data URL that has no business in localStorage. Mutation-tested: putting
  // any of them into save()'s record fails here.
  it("is not persisted", () => {
    setState({
      phase: "framing",
      videoId: "abc12345678",
      music: { id: "11111111-1111-4111-8111-111111111111", name: "track.mp3", seconds: 200 },
      bg: "/9j/base64",
      bgName: "bg.png",
      speeches: [{ id: "22222222-2222-4222-8222-222222222222", name: "a.mp4", seconds: 6 }],
      placements: [{ id: "22222222-2222-4222-8222-222222222222", at: 40 }],
    });
    save();
    const stored = JSON.parse(localStorage.getItem("vstack:abc12345678") ?? "{}");
    expect(stored).not.toHaveProperty("music");
    expect(stored).not.toHaveProperty("bg");
    expect(stored).not.toHaveProperty("bgName");
    expect(stored).not.toHaveProperty("speeches");
    expect(stored).not.toHaveProperty("placements");
  });
});
```

Match the file's existing setup helpers — read the surrounding tests and use
whatever they use to reset state and localStorage between cases.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/vuhoangvuong/WORKSPACE/personal/vstack && pnpm vitest run src/state.test.ts -t "lofi journey"
```

Expected: FAIL — the fields do not exist on `AppState`, so this is a type
error before it is an assertion failure.

- [ ] **Step 3: Add the state**

In `src/state.ts`:

```ts
export type Phase = "idle" | "trimming" | "framing" | "stacking" | "lofi" | "moments" | "preview";
```

```ts
  mode: "short" | "long" | "lofi";
```

and, beside `parts`:

```ts
  /** The lofi journey's music track, once uploaded. `null` until then, which
   *  is what the panel's Render button is gated on along with the rest.
   *
   *  NOT persisted, like `parts`: it names an upload the user may have swept
   *  from `media/uploads/` by hand, and a restored id pointing at a file
   *  that is gone would look like a working panel until Render. */
  music: { id: string; name: string; seconds: number } | null;
  /** The background picture as bare base64 JPEG at 1920x1080 — the render's
   *  base video. Its 1280x720 twin is the publish thumbnail, rendered from
   *  the same file at pick time. `""` until picked.
   *
   *  NOT persisted, for `thumb`'s reason: once a render lands the server has
   *  written the picture beside the output, so nothing downstream needs this
   *  copy. */
  bg: string;
  /** The picked picture's local filename, for display only — never sent.
   *  Same rule `UploadPart.name` and `thumbName` follow. */
  bgName: string;
  /** The uploaded speeches. Order is display order only: a speech's position
   *  in the render is its `at`, not its index here. NOT persisted. */
  speeches: Speech[];
  /** Where each speech goes, in the track's own timeline. Written by
   *  `troughs` when the speech set changes and by a marker drag after that.
   *  NOT persisted. */
  placements: Placement[];
```

with `import type { Placement, Speech } from "./lofi.ts";` at the top, and
these in `initial`:

```ts
  music: null,
  bg: "",
  bgName: "",
  speeches: [],
  placements: [],
```

Do **not** touch `save()` or `restore()`: leaving them alone is what the test
asserts.

- [ ] **Step 4: Run it and watch it pass**

```bash
cd /Users/vuhoangvuong/WORKSPACE/personal/vstack && pnpm vitest run src/state.test.ts
```

Expected: PASS, including every existing test in the file.

- [ ] **Step 5: Mutation-test the exclusion**

Add `bg: s.bg,` to the record `save()` writes. Expected: the new test fails
on `not.toHaveProperty("bg")`. Remove it again.

- [ ] **Step 6: Add the API wrapper**

In `src/api.ts`, beside `stack`:

```ts
/** What `/api/lofi` answers with — the same three fields `/api/stack` and
 *  `/api/export` return, `url` already carrying the file's mtime. */
export type LofiResult = { name: string; url: string; size: number };

/** Renders the track, the picture and the placed speeches into one
 *  1920x1080 file. `music` and every `speeches[].id` are the UUIDs `upload`
 *  returned; `image` is bare base64 JPEG at 1920x1080. */
export async function lofi(body: {
  title: string;
  music: string;
  image: string;
  speeches: { id: string; at: number }[];
  /** The previous render's name, so a title edit does not strand the file it
   *  replaces. Omitted on the first render of a session. */
  prev?: string;
}): Promise<LofiResult> {
  return (await post("/api/lofi", body)).json() as Promise<LofiResult>;
}
```

- [ ] **Step 7: Typecheck, run the suite and commit**

```bash
cd /Users/vuhoangvuong/WORKSPACE/personal/vstack && pnpm build && pnpm test
```

`pnpm build` is what catches the `Phase`/`mode` widening reaching a switch
that does not handle `"lofi"` yet. Fix any such site by falling through to
the existing default — the UI arrives in Task 6.

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/state.ts src/state.test.ts src/api.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "$(cat <<'EOF'
feat: hold the lofi journey's inputs in state

music, bg, bgName, speeches and placements sit beside parts and, like
parts and thumb, stay out of the persisted record: they describe a
session's work rather than a property of a video, and a restored upload id
pointing at a file the user has swept looks like a working panel right up
until Render.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: The `lofi` phase — panel, bar, markers

**Files:**
- Modify: `src/main.ts`
- Modify: `src/style.css`

**Interfaces:**
- Consumes: everything from Tasks 1 and 5.
- Produces: no exports — this is the DOM layer, untested by design.

This task is UI, so it has no unit tests: `main.ts` is DOM-driven and vitest
runs `environment: "node"` here. Its verification is Step 7, in a real
browser.

- [ ] **Step 1: Add the entry point**

In `renderIdle`, beside the `long` and `chat` buttons:

```ts
  const lofi = el("button", {
    className: "btn-gray",
    textContent: "Lofi →",
    title: "Mix a track, a picture and some speeches into one long video",
    disabled: busy,
  });
  // Claims `mode`, like every other exit from `idle` that reaches `preview`.
  // Miss it and an ordinary short would publish this journey's classification
  // — the failure the flag exists to prevent, in reverse.
  lofi.onclick = () => setState({ mode: "lofi", phase: "lofi", error: "" });
```

and add it to the last row: `rows.push(el("div", { className: "bar-row" }, long, lofi, chat));`

- [ ] **Step 2: Add the panel to the persistent shell**

Beside `stackPanel` (around line 121):

```ts
const lofiPanel = el("div", { className: "lofi-panel", hidden: true });
```

Append it to `sourceSlot`'s children where `stackPanel` is appended (around
line 133), and toggle it in `render()` beside `stackPanel.hidden`:

```ts
  lofiPanel.hidden = s.phase !== "lofi";
```

`sourceSlot` itself is never hidden — only its children — because hiding it
would put the YouTube iframe's ancestor into `display: none` and discard its
browsing context.

- [ ] **Step 3: Decode the track's envelope**

Beside `loadWave` (around line 1000), add the local-file twin:

```ts
/** The picked track's envelope, at `BUCKETS_PER_SEC`, and its length.
 *  Module-scoped like `wavePeaks`, and for the same reason: the bar is
 *  rebuilt on every render and the decode must not be. */
let lofiEnv: Float32Array | null = null;
let lofiSeconds = 0;

/** Decodes a picked music File into the envelope `troughs` scores, through
 *  the same 8 kHz mono OfflineAudioContext `loadWave` uses — that bounds the
 *  decode at ~8000 floats a second regardless of the source's rate, which
 *  for a six-minute track is the difference between 19 MB and 230 MB.
 *
 *  Unlike `loadWave` this one must NOT swallow its failures: a flat strip is
 *  a cosmetic loss on the framing bar, but here the envelope is what places
 *  every speech. */
async function decodeTrack(file: File): Promise<{ env: Float32Array; seconds: number }> {
  const Ctor = window.OfflineAudioContext ?? window.webkitOfflineAudioContext;
  if (!Ctor) throw new Error("This browser cannot decode audio.");
  const decoded = await new Ctor(1, 1, 8000).decodeAudioData(await file.arrayBuffer());
  const buckets = Math.max(1, Math.round(decoded.duration * BUCKETS_PER_SEC));
  return { env: peaks(decoded.getChannelData(0), buckets), seconds: decoded.duration };
}
```

Import `BUCKETS_PER_SEC`, `FADE`, `MIN_GAP`, `troughs` and the two types from
`./lofi.ts`, and `MAX_SPEECHES` from `./defaults.ts`.

- [ ] **Step 4: The pick handlers and the render action**

Beside `doStack` (around line 1437):

```ts
/** Uploads the track and decodes its envelope. Both, because the render
 *  needs the file server-side and the placement needs the envelope here —
 *  and doing them in one action is what keeps the two from disagreeing about
 *  which file is loaded. */
async function doPickMusic(file: File): Promise<void> {
  await guard("Reading the track…", async () => {
    const { env, seconds } = await decodeTrack(file);
    const { id } = await api.upload(file, true);
    lofiEnv = env;
    lofiSeconds = seconds;
    setState({
      music: { id, name: file.name, seconds },
      // A new track invalidates every position: they were found in the old
      // one's envelope.
      placements: [],
    });
    place();
  });
}

/** The background picture, rasterised twice: 1920x1080 for the render's base
 *  video and 1280x720 for the publish thumbnail. Both here rather than one
 *  server-side, because this machine's ffmpeg is the wrong tool for an image
 *  format and the browser decodes every format it can display. */
async function doPickBackground(file: File): Promise<void> {
  await guard("Reading the picture…", async () => {
    setState({
      bg: await renderWide(file),
      thumb: await renderThumb(file),
      bgName: file.name,
      thumbName: file.name,
    });
  });
}

async function doAddSpeeches(files: File[]): Promise<void> {
  if (files.length === 0) return;
  await guard("Uploading…", async () => {
    const existing = getState().speeches.length;
    if (existing + files.length > MAX_SPEECHES) {
      throw new Error(
        `That's ${existing + files.length} speeches — the limit is ${MAX_SPEECHES}.`,
      );
    }
    for (const [i, file] of files.entries()) {
      setState({ busy: `Uploading ${i + 1}/${files.length}…` });
      const { id, duration } = await api.upload(file);
      // Live state, not a snapshot: each iteration appends to what the
      // previous one wrote.
      setState({
        speeches: [...getState().speeches, { id, name: file.name, seconds: duration }],
      });
    }
    place();
  });
}

/** Re-runs detection for the current speech set. Called whenever that set
 *  changes and never on a drag — a drag is the user overriding one position,
 *  and re-detecting would throw it away. */
function place(): void {
  const s = getState();
  if (!lofiEnv || s.music === null || s.speeches.length === 0) {
    setState({ placements: [] });
    return;
  }
  const found = troughs(lofiEnv, lofiSeconds, s.speeches);
  if ("error" in found) {
    setState({ placements: [], error: found.error });
    return;
  }
  setState({ placements: found.placements, error: "" });
}

/** Renders the mix and moves to the preview phase. */
async function doLofi(): Promise<void> {
  const s = getState();
  const title = s.starterTitle.trim();
  if (title === "" || s.music === null || s.bg === "" || s.placements.length === 0) return;
  if (s.placements.length !== s.speeches.length) return;
  await guard("Mixing… (a five-minute track takes ~1-2 min)", async () => {
    const music = getState().music;
    if (music === null) return;
    const out = await api.lofi({
      title,
      music: music.id,
      image: getState().bg,
      speeches: getState().placements.map((p) => ({ id: p.id, at: p.at })),
      // In-memory, like the export's: a reload between two renders strands
      // the older file, which is the accepted cost of not persisting a field
      // whose only job is naming a file to delete.
      ...(getState().outName === "" ? {} : { prev: getState().outName }),
    });
    setState({
      phase: "preview",
      outName: out.name,
      outUrl: out.url,
      outSize: out.size,
      ytTitle: getState().ytTitle || defaultTitle(title),
      ytDescription: getState().ytDescription || LONG_DESCRIPTION_TEMPLATE,
      ytTags: getState().ytTags || LONG_TAGS_DEFAULT,
      ytVideoId: "",
      ytThumbnail: false,
    });
    bell();
  });
}
```

- [ ] **Step 5: `renderWide` in `src/thumb.ts`**

`doPickBackground` needs a 1920x1080 twin of `renderThumb`. Add it to
`src/thumb.ts` rather than to a new module — it is the same draw at a
different size, and splitting them would be two copies of the same
`createImageBitmap` dance:

```ts
/** The lofi background: the same stretch-to-fill draw `renderThumb` does, at
 *  the render's own 1920x1080.
 *
 *  Stretched for `renderThumb`'s reason — the user picked the picture
 *  knowing the shape it has to become, and a crop would silently discard
 *  whatever they put at the edges. Note this differs from what
 *  `server/lofi.ts` would do on its own (it cover-crops any picture it is
 *  handed); handing it a picture that is already exactly 1920x1080 is what
 *  makes that crop a no-op, so the two never disagree. */
export const WIDE_IMAGE = { w: 1920, h: 1080 };

export async function renderWide(file: File): Promise<string> {
  return drawTo(file, WIDE_IMAGE.w, WIDE_IMAGE.h);
}
```

and refactor `renderThumb`'s body into the shared `drawTo(file, w, h)`,
keeping every comment that is already there on the pieces it still explains
(the `createImageBitmap` failure message, the `bitmap.close()` in the
`finally`, the base64 preamble split).

- [ ] **Step 6: The panel, the bar and the marker strip**

`renderLofiPanel()` — modelled on `renderStackPanel`, three pickers and a
list:

```ts
function renderLofiPanel(): Node[] {
  const s = getState();
  const locked = Boolean(s.busy);

  const musicRow = el("div", { className: "lofi-row" });
  const musicPicker = el("input", { type: "file", accept: "audio/*", disabled: locked });
  musicPicker.onchange = () => {
    const file = musicPicker.files?.[0];
    // Cleared so picking the same file twice fires a second change event.
    musicPicker.value = "";
    if (file) void doPickMusic(file);
  };
  musicRow.append(
    el("h3", { textContent: "Track" }),
    s.music
      ? el("p", { className: "lofi-fact", textContent: `${s.music.name} — ${mmss(s.music.seconds)}` })
      : el("p", { className: "stack-empty", textContent: "Pick one music file." }),
    musicPicker,
  );

  const bgRow = el("div", { className: "lofi-row" });
  const bgPicker = el("input", { type: "file", accept: "image/*", disabled: locked });
  bgPicker.onchange = () => {
    const file = bgPicker.files?.[0];
    bgPicker.value = "";
    if (file) void doPickBackground(file);
  };
  bgRow.append(
    el("h3", { textContent: "Background" }),
    s.bg === ""
      ? el("p", { className: "stack-empty", textContent: "Pick one picture." })
      : el("img", { className: "lofi-chip", src: `data:image/jpeg;base64,${s.bg}`, alt: s.bgName }),
    bgPicker,
  );

  const speechRow = el("div", { className: "lofi-row" });
  const speechPicker = el("input", {
    type: "file",
    accept: "video/mp4",
    multiple: true,
    disabled: locked || s.speeches.length >= MAX_SPEECHES,
  });
  speechPicker.onchange = () => {
    const files = [...(speechPicker.files ?? [])];
    speechPicker.value = "";
    void doAddSpeeches(files);
  };
  const rows = s.speeches.map((speech) => {
    const at = s.placements.find((p) => p.id === speech.id);
    const drop = el("button", { textContent: "✕", ariaLabel: `Remove ${speech.name}`, disabled: locked });
    drop.onclick = () => {
      // Live state, the rule every handler here follows: the list is written
      // by quiet updates during a drag, so a snapshot would revert one.
      setState({ speeches: getState().speeches.filter((x) => x.id !== speech.id) });
      place();
    };
    return el(
      "div",
      { className: "lofi-speech" },
      el("span", { textContent: speech.name }),
      el("span", {
        className: "lofi-fact",
        textContent: at ? `${mmss(at.at)} · ${Math.round(speech.seconds)}s` : `${Math.round(speech.seconds)}s`,
      }),
      drop,
    );
  });
  speechRow.append(
    el("h3", { textContent: `Speeches (${s.speeches.length}/${MAX_SPEECHES})` }),
    ...(rows.length > 0
      ? rows
      : [el("p", { className: "stack-empty", textContent: "Add .mp4 files. They drop into the quiet parts." })]),
    speechPicker,
  );

  return [el("h2", { className: "publish-heading", textContent: "Lofi mix" }), musicRow, bgRow, speechRow];
}
```

`renderLofiBar()` — the strip with its markers, the title and Render. Build
the strip as a `<canvas>` inside a `position: relative` wrapper with one
absolutely positioned `.lofi-marker` per placement, each dragged with pointer
events:

```ts
function renderLofiBar(): Node[] {
  const s = getState();
  const busy = s.busy !== "";

  const strip = el("div", { className: "lofi-strip" });
  const canvas = el("canvas", { className: "lofi-wave" });
  strip.append(canvas);

  const secondsOf = (id: string) =>
    getState().speeches.find((x) => x.id === id)?.seconds ?? 0;

  for (const p of s.placements) {
    const marker = el("div", { className: "lofi-marker", title: `${mmss(p.at)}` });
    const width = lofiSeconds > 0 ? (secondsOf(p.id) / lofiSeconds) * 100 : 0;
    marker.style.left = `${lofiSeconds > 0 ? (p.at / lofiSeconds) * 100 : 0}%`;
    marker.style.width = `${width}%`;
    marker.onpointerdown = (e: PointerEvent) => {
      if (busy) return;
      marker.setPointerCapture(e.pointerId);
      const rect = strip.getBoundingClientRect();
      const grab = e.clientX - rect.left - (p.at / lofiSeconds) * rect.width;
      marker.onpointermove = (move: PointerEvent) => {
        const x = move.clientX - rect.left - grab;
        const want = (x / rect.width) * lofiSeconds;
        // Quiet: a notifying update per pointer frame would rebuild the very
        // node being dragged. The canvas is repainted from here directly for
        // the same reason the framing overlay calls `place()` itself.
        setQuiet({ placements: clampPlacement(getState().placements, p.id, want) });
        drawLofiStrip(strip, canvas);
      };
      marker.onpointerup = () => {
        marker.onpointermove = null;
        marker.onpointerup = null;
        // One notifying update at the end of the drag, so the panel's own
        // timestamps catch up.
        setState({ placements: getState().placements });
      };
    };
    strip.append(marker);
  }

  const title = el("input", {
    type: "text",
    placeholder: "Title (names the file)",
    className: "field-grow",
    value: s.starterTitle,
    disabled: busy,
  });

  const back = el("button", { className: "btn-gray", textContent: "← Back", disabled: busy });
  // The uploads stay in state, for the stacking bar's reason: stepping back
  // to pick a different journey must not throw away files already sent.
  // `outName` is cleared for that bar's OTHER reason — it names a file to
  // DELETE on the next render, and a short export would otherwise unlink
  // this journey's output with no error and no badge.
  back.onclick = () =>
    setState({
      phase: "idle",
      outName: "",
      outUrl: "",
      outSize: 0,
      starterTitle: "",
      ytTitle: "",
      ytDescription: "",
      ytTags: "",
      ytVideoId: "",
      ytThumbnail: false,
    });

  const ready = (live: AppState) =>
    live.starterTitle.trim() !== "" &&
    live.music !== null &&
    live.bg !== "" &&
    live.speeches.length > 0 &&
    live.placements.length === live.speeches.length;

  const go = el("button", {
    className: "btn-solid",
    textContent: "Render →",
    disabled: busy || !ready(s),
  });
  go.onclick = () => void doLofi();
  lofiBtn = go;

  // Quiet, and the button flipped in place: the title reaches state through
  // a quiet update, so without this Render stays disabled until some
  // unrelated setState happens along — which reads as a broken button rather
  // than as "type a title first".
  title.oninput = () => {
    setQuiet({ starterTitle: title.value });
    if (lofiBtn) lofiBtn.disabled = Boolean(getState().busy) || !ready(getState());
  };

  return [
    el("div", { className: "bar-row" }, strip),
    el("div", { className: "bar-row" }, title, back, el("div", { className: "bar-end" }, go)),
  ];
}
```

With these two helpers beside it:

```ts
/** Moves one placement, keeping it inside the track and MIN_GAP clear of its
 *  neighbours. The drag path's bound, not a legality rule — `/api/lofi`
 *  checks only that speeches fit and do not overlap, so an older body still
 *  renders. Same asymmetry `moveOut`'s `margin` has against `isValidOut`. */
function clampPlacement(placements: Placement[], id: string, want: number): Placement[] {
  const others = placements.filter((p) => p.id !== id);
  const mine = getState().speeches.find((x) => x.id === id);
  if (!mine) return placements;
  let lo = FADE;
  let hi = lofiSeconds - mine.seconds - FADE;
  for (const other of others) {
    const seconds = getState().speeches.find((x) => x.id === other.id)?.seconds ?? 0;
    if (other.at < want) lo = Math.max(lo, other.at + seconds + MIN_GAP);
    else hi = Math.min(hi, other.at - MIN_GAP - mine.seconds);
  }
  const at = Math.min(Math.max(want, lo), Math.max(lo, hi));
  return placements.map((p) => (p.id === id ? { ...p, at } : p));
}

/** Paints the track's envelope across the strip. `bucketAt` with `span` and
 *  the decoded length equal — the stitch case it exists for cannot happen
 *  here, and passing both keeps the call honest rather than reaching for the
 *  `floor(x * buckets / w)` it reduces to. */
function drawLofiStrip(strip: HTMLElement, canvas: HTMLCanvasElement): void {
  const env = lofiEnv;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!env || w === 0 || h === 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext("2d");
  if (!g) return;
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  g.fillStyle = getComputedStyle(canvas).getPropertyValue("--blue-8").trim() || "#0090ff";
  const mid = h / 2;
  let peak = 0;
  for (const v of env) if (v > peak) peak = v;
  const gain = peak > 0 ? Math.min(WAVE_GAIN, 1 / peak) : 1;
  for (let x = 0; x < w; x++) {
    const b = bucketAt(x, w, lofiSeconds, lofiSeconds, env.length);
    if (b < 0) continue;
    const amp = (env[b] ?? 0) * gain * mid;
    g.fillRect(x, mid - amp, 1, Math.max(1, amp * 2));
  }
  // The markers are DOM siblings positioned in %, so they follow a resize on
  // their own and only the canvas needs repainting here.
  void strip;
}
```

Declare `let lofiBtn: HTMLButtonElement | null = null;` beside the existing
`stackBtn`.

- [ ] **Step 7: Wire the phase into `render()`**

Beside the existing `stacking` branch:

```ts
  } else if (s.phase === "lofi") {
    barSlot.replaceChildren(...renderLofiBar());
    lofiPanel.replaceChildren(...renderLofiPanel());
```

and widen the wide-slot test so a lofi preview gets the 16:9 shape:

```ts
  // Not `=== "long"`: every journey but the short one renders 16:9, and an
  // enumeration here grows with each new one.
  outSlot.classList.toggle("is-wide", s.phase === "preview" && s.mode !== "short");
```

and the `preview` bar's `← Back` target, wherever it currently branches on
`mode === "long"`:

```ts
  const backTo = s.mode === "long" ? "stacking" : s.mode === "lofi" ? "lofi" : "framing";
```

and the publish call's `shorts` flag, which must be `false` here too — find
where the preview panel passes `shorts` and make it `s.mode === "short"`.

Finally, paint the strip after the bar is in the document (the canvas has no
size until then) — in the same place the framing bar's `drawWave` is called
from, add the lofi equivalent guarded on the phase.

- [ ] **Step 8: Add the CSS**

In `src/style.css`, beside the stacking panel's rules, using the existing
token layer only:

```css
.lofi-panel { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-4); }
.lofi-row { display: flex; flex-direction: column; gap: var(--space-2); }
.lofi-row h3 { margin: 0; font-size: 14px; color: var(--slate-11); }
.lofi-fact { margin: 0; color: var(--slate-11); font-variant-numeric: tabular-nums; }
.lofi-chip { width: 100%; border-radius: var(--radius-2); border: 1px solid var(--slate-6); }
.lofi-speech { display: flex; align-items: center; gap: var(--space-2); }
.lofi-speech span:first-child { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* The strip. Square-cornered and `overflow: hidden` for `.strip`'s reason —
   a rounded end reads as a fade, and a marker at either extreme would paint
   its square corner past a rounded track's. */
.lofi-strip { position: relative; width: 100%; height: 56px; overflow: hidden;
  background: var(--slate-3); border-radius: var(--radius-2); }
.lofi-wave { position: absolute; inset: 0; width: 100%; height: 100%; }
.lofi-marker { position: absolute; top: 0; bottom: 0; min-width: 4px;
  background: var(--amber-a5); border-left: 2px solid var(--amber-9);
  border-right: 2px solid var(--amber-9); cursor: ew-resize; touch-action: none; }
```

- [ ] **Step 9: Verify in a real browser**

```bash
cd /Users/vuhoangvuong/WORKSPACE/personal/vstack && pnpm server &
cd /Users/vuhoangvuong/WORKSPACE/personal/vstack && pnpm dev
```

Open `http://localhost:5173` in a real browser — **not** the in-app Browser
pane, which reports `document.hidden = true` (suspending `requestAnimationFrame`
per spec) and has measured a 0x0 viewport. Check, in order:

1. `Lofi →` on the idle bar opens the panel with the strip empty.
2. Picking a track draws its waveform and shows its name and length.
3. Picking a picture shows the chip.
4. Adding two speeches places two markers in visibly quiet parts of the
   waveform, and the panel lists each one's timestamp.
5. Dragging a marker moves it, will not cross its neighbour, and will not
   leave the strip. The panel's timestamp updates when the drag ends.
6. Removing a speech removes its marker and re-places the rest.
7. `Render →` is disabled until the title, the track, the picture and the
   speeches are all there.
8. A render lands on `preview` with the 16:9 slot (`.out.is-wide`), the video
   plays, and `← Back` returns to the lofi panel with everything still in it.
9. The output in `~/Desktop/vstack/` opens on the picture, cuts to each
   speech with a dip either side, and the music ducks under each one.

- [ ] **Step 10: Commit**

```bash
cd /Users/vuhoangvuong/WORKSPACE/personal/vstack && pnpm build && pnpm test
```

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/main.ts src/style.css src/thumb.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "$(cat <<'EOF'
feat: the lofi phase

A third panel under sourceSlot, a waveform strip with one draggable marker
per speech, and a Render button gated on all four inputs. Detection runs
when the speech set changes and never on a drag — a drag is the user
overriding one position, and re-detecting would throw it away.

The wide-slot test is now `mode !== "short"` rather than `=== "long"`:
every journey but the short one renders 16:9, and an enumeration there
grows with each new journey.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Document the journey

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing executable.

- [ ] **Step 1: Update the spec index at the top of `CLAUDE.md`**

Append to the running list of specs, in its existing voice: the lofi design
doc supersedes nothing and adds a **fourth journey**; the short journey, the
long journey and the chat-moments dead end are unchanged by it.

- [ ] **Step 2: Update the Architecture block**

Add `server/lofi.ts` (`WIDE`, `FADE`, `TRANSITION_PATH`/`TRANSITION_PEAK`,
`checkLofi`, `Cut`/`renderLofi`) beside `server/longform.ts`, `src/lofi.ts`
(`Speech`/`Placement`, `BUCKETS_PER_SEC`, `MIN_GAP`, `SKIP_HEAD`/`SKIP_TAIL`,
`troughs`) beside `src/segments.ts`, `probeAudio` in `server/ffmpeg.ts`, and
`renderWide` in `src/thumb.ts`. Update the route count (13 → 15) and the
layering paragraph: `lofi.ts` sits beside `ffmpeg.ts`/`longform.ts`/
`starter.ts` and imports `probeFile` and `probeAudio` only; `src/lofi.ts`
sits at the bottom beside `geometry.ts` and `segments.ts` and imports
nothing.

- [ ] **Step 3: Update the phase paragraph**

Seven phases now, across three journeys and one dead end:
`idle → lofi → preview` is the third journey. `lofiPanel` is a third child of
`sourceSlot` under the same rule `publishForm` and `stackPanel` follow.

- [ ] **Step 4: Add the invariants**

One paragraph each, in the file's own voice, for the six silent failures this
feature introduces:

1. **The render's duration is the music's, by construction.** Overlay rather
   than concat; `-t` closes the output. Nothing sums, so `outName`'s `mmss`
   cannot come to disagree with the file. A concat of image and speech legs
   puts that arithmetic back, and its last leg has to absorb the rounding.
2. **Detection places the longest speech first.** A long speech has strictly
   fewer legal windows; input order can take the only one it had, and the
   result is a render with a speech missing rather than an error.
   Mutation-tested in `src/lofi.test.ts`.
3. **A speech that fits nowhere refuses by name.** No least-bad fallback — a
   misplaced speech is indistinguishable from a working render until someone
   watches the output.
4. **`probeFile` is the wrong prober for a music track**, which has no video
   stream — and an mp3 with cover art HAS one, describing a thumbnail.
   `probeAudio` asks the other question; `/api/upload-audio` is a second URL
   because this server routes on exact `req.url` equality.
5. **A cut-in is padded with `tpad` and gated with `enable=`, not shifted
   with `setpts` alone.** The padding frames are black and never drawn, and
   what it buys is that `overlay`'s second input always has a frame.
6. **The duck is a compressor, not a gated `volume`.** A step has no attack
   or release and clicks at both edges — and the duck is what lets the
   detector settle for a thin stretch rather than a silent one.

Also extend the existing `mode` invariant: `"lofi"` is a fourth value, and
the wide-slot test is now `mode !== "short"` rather than an enumeration.

- [ ] **Step 5: Update the testing-posture paragraph**

`src/lofi.ts` joins `geometry`/`layout`/`custom`/`segments` as an
exhaustively covered pure module, with the longest-first rule
mutation-tested. `server/lofi.test.ts` shells real ffmpeg and asserts
pixels and dB, with four mutations pinned (the duck, `-t`, the fades, the
band). The panel, the markers and the route have no tests, like the rest of
the DOM and network surface.

- [ ] **Step 6: Note the two growth paths**

`media/uploads/` now grows from two journeys, and `~/Desktop/vstack/` gets a
`.mp4` plus a `.thumb.jpg` per lofi render. Both are still swept by hand.

- [ ] **Step 7: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add CLAUDE.md
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "$(cat <<'EOF'
docs: describe the lofi journey in CLAUDE.md

Six new invariants, all silent: the duration-by-construction rule that
makes overlay the right shape, longest-first placement, the refusal rather
than a least-bad fallback, probeAudio against probeFile, tpad against a
bare setpts, and the compressor against a gated volume.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Verification before calling this done

- [ ] `pnpm test` — every test passes, and the count has grown by ~20.
- [ ] `pnpm build` — `tsc` clean (this is the gate that catches non-erasable
      TS and the widened `Phase`/`mode` unions).
- [ ] The nine browser checks in Task 6, Step 9, in a real browser.
- [ ] One real render published as a private draft, confirming it uploads
      **without** `#Shorts` and with the background as its thumbnail.
- [ ] `git -C … log --oneline main..feat/lofi` shows one commit per task, and
      the spec commit at the base.
