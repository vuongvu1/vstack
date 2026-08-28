# Framing-phase trim over a waveform — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the framing phase's clip trimmable by dragging `clipStart`/`clipEnd` over a waveform decoded from the local clip in the browser.

**Architecture:** No API changes. `/api/export` already carries `clipStart`/`clipEnd`; this makes them draggable. The waveform comes from `fetch(clipUrl)` → `decodeAudioData` through an 8 kHz mono `OfflineAudioContext` → a pure peak reduction in a new `src/waveform.ts`. The framing bar's native `<input type="range">` scrubber is replaced by a hand-built strip, the same pattern `src/player.ts`'s trimming `.strip` already uses.

**Tech Stack:** Vanilla TS, Vite, vitest (`environment: "node"`), Web Audio API, Radix Colors custom properties.

**Spec:** `docs/specs/2026-08-28-vstack-framing-trim-design.md`

**Branch:** `framing-trim` (already created; the spec is committed at `16eaf3f`).

## Global Constraints

- `import type` for type-only imports; explicit `.ts` extensions on relative imports.
- No `enum`, `namespace`, `any`, default exports, or barrel files.
- No `console.log`/`.info` — `.error`/`.warn` only.
- `strict` and `noUncheckedIndexedAccess` are on: indexing a `Float32Array` or array yields `T | undefined`. Guard with `?? 0`, never `!`.
- `erasableSyntaxOnly: true` — no constructor parameter properties.
- Colours come from the Radix custom properties in `style.css`. Canvas cannot read CSS variables directly; use `getComputedStyle(el).getPropertyValue("--blue-8")` so the dark theme flips for free.
- `PAD` stays at `5`. Do not change it.
- `setQuiet` in the drag path, `setState` on drag end. A quiet update reaches no render, so anything gated on it must be toggled in place.
- Run `pnpm test` (272 tests currently green) before each commit.

---

### Task 1: The pure peak reduction

**Files:**
- Create: `src/waveform.ts`
- Test: `src/waveform.test.ts`

**Interfaces:**
- Consumes: nothing. This module imports nothing, like `segments.ts` and `geometry.ts`.
- Produces: `peaks(samples: Float32Array, buckets: number): Float32Array` — per-bucket maximum absolute amplitude, length exactly `max(0, buckets)`.

- [ ] **Step 1: Write the failing test**

Create `src/waveform.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { peaks } from "./waveform.ts";

describe("peaks", () => {
  it("takes the maximum absolute amplitude per bucket", () => {
    const s = new Float32Array([0.1, 0.9, -0.2, 0.3, -1, 0.4]);
    expect(Array.from(peaks(s, 3))).toEqual([0.9, 0.3, 1]);
  });

  it("uses absolute value, so a negative trough is a peak", () => {
    expect(Array.from(peaks(new Float32Array([-0.7, 0.2]), 1))).toEqual([0.7]);
  });

  it("returns exactly `buckets` entries when the length does not divide evenly", () => {
    // 7 samples into 3 buckets: edges are computed from the index rather
    // than by accumulating a float stride, which would drift and leave the
    // last bucket reading past the end or stopping short of it.
    const s = new Float32Array([1, 2, 3, 4, 5, 6, 7]);
    const out = peaks(s, 3);
    expect(out.length).toBe(3);
    expect(Array.from(out)).toEqual([2, 4, 7]);
  });

  it("never leaves a bucket empty when there are more buckets than samples", () => {
    // Every bucket must still report something, or the strip draws gaps at
    // a zoom the user did not ask for.
    const out = peaks(new Float32Array([0.5, 0.25]), 4);
    expect(out.length).toBe(4);
    expect(Array.from(out).every((v) => v > 0)).toBe(true);
  });

  it("returns zeros for a silent clip rather than an empty array", () => {
    expect(Array.from(peaks(new Float32Array([0, 0, 0]), 2))).toEqual([0, 0]);
  });

  it("returns an empty array for zero or negative buckets", () => {
    expect(peaks(new Float32Array([1]), 0).length).toBe(0);
    expect(peaks(new Float32Array([1]), -3).length).toBe(0);
  });

  it("returns zeros when there are no samples at all", () => {
    // A clip with no audio track decodes to nothing; the strip must stay
    // flat rather than throw.
    expect(Array.from(peaks(new Float32Array([]), 3))).toEqual([0, 0, 0]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/waveform.test.ts`
Expected: FAIL — `Failed to resolve import "./waveform.ts"`.

- [ ] **Step 3: Write the implementation**

Create `src/waveform.ts`:

```ts
/** Peak-per-bucket reduction over one decoded audio channel.
 *
 *  This module imports nothing and knows nothing about Web Audio, which is
 *  the whole point: `decodeAudioData` does not exist under vitest's `node`
 *  environment, so taking a bare `Float32Array` rather than an `AudioBuffer`
 *  is what keeps the one piece of arithmetic here testable at all. The
 *  caller owns the decode and the drawing.
 *
 *  Peak, not RMS. At the zoom a framing clip is viewed at — marks plus two
 *  PADs, so tens of seconds — peaks are what make the gaps between phrases
 *  legible. Peak is the wrong statistic over a whole multi-hour video, where
 *  continuous speech saturates every bucket, but nothing here ever sees one:
 *  the clip is bounded by the trimming phase before it is fetched. */
export function peaks(samples: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(Math.max(0, buckets));
  if (out.length === 0 || samples.length === 0) return out;
  for (let b = 0; b < out.length; b++) {
    // Edges from the index, never an accumulated float stride: a stride
    // added `buckets` times drifts, and the final bucket ends up reading
    // past the end of the array or stopping short of it. `to` is floored to
    // at least `from + 1` so a bucket count above the sample count still
    // reports the sample it lands on instead of an empty range reading 0.
    const from = Math.floor((b * samples.length) / out.length);
    const to = Math.max(from + 1, Math.floor(((b + 1) * samples.length) / out.length));
    let max = 0;
    for (let i = from; i < to && i < samples.length; i++) {
      const v = samples[i] ?? 0;
      const abs = v < 0 ? -v : v;
      if (abs > max) max = abs;
    }
    out[b] = max;
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/waveform.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the full suite and commit**

```bash
pnpm test
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/waveform.ts src/waveform.test.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: add the pure peak-envelope reduction"
```

---

### Task 2: Make `keptLength` phase-aware and testable

`keptLength` currently reads `totalDuration(s.segments)`. That equals `clipEnd − clipStart` in *both* the single-segment and stitch cases today, which is exactly why reading the wrong one after this feature lands is silent. Once framing can trim, the Export gate, the `SHORTS_MAX_S` over-length warning and the kept-duration badge would all report the untrimmed length.

**Files:**
- Modify: `src/state.ts` (add the export; it already imports from `./segments.ts`)
- Modify: `src/main.ts:88-90` (delete the local function), and its four call sites at `src/main.ts:512`, `src/main.ts:515`, `src/main.ts:1251`, `src/main.ts:1298`
- Test: `src/state.test.ts` (append)

**Interfaces:**
- Consumes: `totalDuration` from `./segments.ts`.
- Produces: `keptLength(s: KeptLengthInput): number`, exported from `./state.ts`, where
  `type KeptLengthInput = Pick<AppState, "phase" | "segments" | "clipStart" | "clipEnd">`.
  A structural subset rather than the whole `AppState` deliberately: `initial`
  is **not** exported from `state.ts`, so a test taking a full `AppState`
  would have to either export it or hand-build twenty irrelevant fields. A
  full `AppState` still satisfies `Pick`, so `main.ts`'s four call sites are
  unchanged.

- [ ] **Step 1: Write the failing test**

Extend the existing `./state.ts` import at `src/state.test.ts:5` — it currently
reads `import { restore, save, saveVoice, savedTitle, savedVoice, setState } from "./state.ts";`
— by adding `keptLength` in alphabetical position. Do not add a second import
line. Then append:

```ts
describe("keptLength", () => {
  it("reads the segments outside framing, where clip bounds are still 0", () => {
    expect(
      keptLength({
        phase: "trimming",
        segments: [{ start: 10, end: 20 }, { start: 50, end: 65 }],
        clipStart: 0,
        clipEnd: 0,
      }),
    ).toBe(25);
  });

  it("reads the clip bounds in framing, so a framing trim is counted", () => {
    // The segments still say 25s; the trim says 12. Framing must report the
    // trim, because that is what /api/export will render.
    expect(
      keptLength({
        phase: "framing",
        segments: [{ start: 10, end: 20 }, { start: 50, end: 65 }],
        clipStart: 3,
        clipEnd: 15,
      }),
    ).toBe(12);
  });

  it("agrees with the segments in framing before any trim", () => {
    // The coincidence this function exists to survive: an untrimmed single
    // segment's marks ARE its clip bounds, so both readings match.
    expect(
      keptLength({
        phase: "framing",
        segments: [{ start: 10, end: 40 }],
        clipStart: 10,
        clipEnd: 40,
      }),
    ).toBe(30);
  });

  it("never reports a negative length", () => {
    expect(
      keptLength({
        phase: "framing",
        segments: [{ start: 0, end: 5 }],
        clipStart: 9,
        clipEnd: 4,
      }),
    ).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/state.test.ts`
Expected: FAIL — `keptLength is not a function` / no export named `keptLength`.

- [ ] **Step 3: Add the export to `src/state.ts`**

Extend the existing `./segments.ts` import (it currently pulls `isValidSegments`) to also pull `totalDuration`, then add:

```ts
/** The kept length — what decides whether this is too long for a Short. NOT
 *  `lastMark − firstMark`: a two-part cut with a two-minute gap between the
 *  parts spans four minutes and keeps forty seconds.
 *
 *  Two readings, one per phase, and they are not interchangeable. Before
 *  `/api/window` answers, `clipStart`/`clipEnd` are both 0 and the segments
 *  are the only truth. Once framing owns a clip the trim can move
 *  `clipStart`/`clipEnd` inside the fetched window, and the segments no
 *  longer describe what will be exported.
 *
 *  These two agreed exactly until framing could trim — a single segment's
 *  marks ARE its clip bounds, and a stitch's `clipEnd − clipStart` is the
 *  sum of its parts — which is precisely why reading the wrong one is
 *  silent rather than loud. */
export function keptLength(
  s: Pick<AppState, "phase" | "segments" | "clipStart" | "clipEnd">,
): number {
  return s.phase === "framing"
    ? Math.max(0, s.clipEnd - s.clipStart)
    : totalDuration(s.segments);
}
```

- [ ] **Step 4: Delete the local copy in `src/main.ts` and import the new one**

Delete lines 85-90 of `src/main.ts` (the doc comment and the local `function keptLength`). Add `keptLength` to the existing `./state.ts` import in `src/main.ts`. The four call sites need no edit — the name is unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS, 276 tests (272 + 4 new).

- [ ] **Step 6: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/state.ts src/state.test.ts src/main.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "refactor: make keptLength phase-aware ahead of the framing trim"
```

---

### Task 3: The strip's styles

**Files:**
- Modify: `src/style.css:399-404` (replace the `.scrub` rule)

**Interfaces:**
- Consumes: nothing.
- Produces: classes `.wave`, `.wave-cut`, `.wave-handle`. Task 5 also reuses the existing `.strip-head` (`src/style.css:387`) for the playhead — do not duplicate it.

- [ ] **Step 1: Replace the `.scrub` rule**

Delete the `.scrub` rule at `src/style.css:399-404` (including its comment, which describes a control that no longer exists) and put this in its place:

```css
/* The framing phase's own strip: the clip's waveform, the kept range's two
   handles, and the playhead. Hand-built rather than an <input type="range">
   for the reason the trimming strip is — a native range carries one thumb,
   and this needs two of them plus a painted background. `touch-action:none`
   so a drag on a handle is a drag rather than a scroll gesture. */
.wave {
  position: relative;
  flex: 1 1 240px;
  height: 48px;
  min-width: 160px;
  border-radius: var(--radius-3);
  background: var(--slate-a4);
  cursor: pointer;
  overflow: hidden;
  touch-action: none;
}

.wave > canvas {
  display: block;
  width: 100%;
  height: 100%;
}

/* Everything outside the kept range — dimmed, never hidden. That footage is
   PAD: the material the handles are dragged across, so it has to stay
   legible while reading as excluded. `pointer-events:none` so it does not
   eat the strip's own click-to-seek. */
.wave-cut {
  position: absolute;
  inset-block: 0;
  background: var(--slate-a7);
  pointer-events: none;
}

.wave-handle {
  position: absolute;
  inset-block: 0;
  width: 10px;
  margin-left: -5px;
  background: var(--blue-9);
  cursor: ew-resize;
  touch-action: none;
}
```

- [ ] **Step 2: Verify nothing else references `.scrub`**

Run: `grep -rn "scrub" src/`
Expected: only `src/main.ts` hits, all inside `renderFraming` — those are rewritten in Task 4. If `style.css` still matches, the delete was incomplete.

- [ ] **Step 3: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/style.css
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "style: add the framing waveform strip, drop the native scrubber's rule"
```

---

### Task 4: Decode the clip and draw the waveform

**Files:**
- Modify: `src/main.ts` — add module-scoped decode state near `videoEl` (`src/main.ts:748`), and replace the `scrub` element and its handlers inside `renderFraming` (`src/main.ts:1166-1203`)

**Interfaces:**
- Consumes: `peaks` from `./waveform.ts` (Task 1).
- Produces: `renderWave(s: AppState): HTMLElement` — the strip element, used by Task 5's row assembly. Module-scoped `wavePeaks: Float32Array | null`, `waveFor: string`, and `drawWave(canvas: HTMLCanvasElement): void`.

- [ ] **Step 1: Add the Safari-prefixed constructor's type**

Safari historically exposes only `webkitOfflineAudioContext`. Add this beside the other `declare global` block in `src/main.ts` (or at the top of the file if there is none):

```ts
declare global {
  interface Window {
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  }
}
```

- [ ] **Step 2: Add the decode + draw helpers**

Add near `videoEl` (`src/main.ts:748`), and add `import { peaks } from "./waveform.ts";` to the imports:

```ts
/** How many buckets the clip is reduced to. Fixed rather than matched to the
 *  canvas width so a resize redraws from the same envelope instead of
 *  re-decoding megabytes of audio; 900 is comfortably above any width this
 *  bar reaches, and `drawWave` samples down from it per pixel. */
const WAVE_BUCKETS = 900;

/** The framing clip's peak envelope, and the clip URL it came from. Cached
 *  module-scoped for the same reason `framingFor` is: this bar is rebuilt on
 *  every render, and decoding per render would re-fetch and re-decode the
 *  same megabytes each time. */
let wavePeaks: Float32Array | null = null;
let waveFor = "";
/** Disconnected and replaced on every render — the bar is rebuilt each time,
 *  so an observer per built canvas would otherwise accumulate one per
 *  render for the life of the phase. */
let waveResize: ResizeObserver | null = null;

/** Decodes the local clip's audio into a peak envelope, then re-renders.
 *
 *  Through an 8 kHz *mono* OfflineAudioContext rather than a live
 *  AudioContext: `decodeAudioData` resamples to its context's own rate, so
 *  this bounds the decode at ~8000 floats per second of clip regardless of
 *  the source's 44.1 kHz stereo. A ten-minute clip costs ~19 MB of
 *  Float32Array instead of the ~230 MB a native-rate stereo decode would.
 *
 *  Every failure is swallowed and leaves the strip flat. A clip with no
 *  audio track is a real case this app already handles at export
 *  (`hasAudio`), and the waveform is a nicety: it must never block trimming,
 *  dragging or Export. */
async function loadWave(clipUrl: string): Promise<void> {
  if (waveFor === clipUrl) return;
  waveFor = clipUrl;
  wavePeaks = null;
  try {
    const res = await fetch(clipUrl);
    if (!res.ok) return;
    const bytes = await res.arrayBuffer();
    const Ctor = window.OfflineAudioContext ?? window.webkitOfflineAudioContext;
    if (!Ctor) return;
    // length 1: this context is never rendered, only used to decode.
    const decoded = await new Ctor(1, 1, 8000).decodeAudioData(bytes);
    // A clip that raced a phase change while decoding must not paint over
    // whatever is on screen now.
    if (waveFor !== clipUrl) return;
    wavePeaks = peaks(decoded.getChannelData(0), WAVE_BUCKETS);
  } catch {
    /* No audio track, an unsupported decode, a failed read: flat strip. */
    return;
  }
  render();
}

/** Paints the envelope as a centred amplitude band.
 *
 *  The accent is read off the element rather than hardcoded, so the strip
 *  follows the CMD+Shift+0 dark theme the way every other surface does —
 *  canvas cannot read a custom property any other way. */
function drawWave(canvas: HTMLCanvasElement): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext("2d");
  if (!g) return;
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const env = wavePeaks;
  if (!env || env.length === 0) return;
  g.fillStyle = getComputedStyle(canvas).getPropertyValue("--blue-8").trim() || "#0090ff";
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const b = Math.min(env.length - 1, Math.floor((x * env.length) / w));
    const amp = (env[b] ?? 0) * mid;
    // At least 1px tall, so silence reads as a centre line rather than a
    // hole in the strip.
    g.fillRect(x, mid - amp, 1, Math.max(1, amp * 2));
  }
}
```

- [ ] **Step 3: Kick the decode off from `ensureFraming`**

`ensureFraming` returns early when `sameClip && sameLayout`, so anything below
that guard runs only on a genuine change. Add the call on the line
immediately **after** `if (!sameClip) videoEl.src = s.clipUrl;` (`src/main.ts:834`)
and before the `if (!canvasEl)` block:

```ts
  // Fire-and-forget: the waveform is a nicety and must never gate the phase,
  // so this is deliberately not awaited and every failure inside it is
  // swallowed. `loadWave` no-ops when the clip URL has not changed, which is
  // what makes it safe on the layout-switch path — that path reaches here
  // with `sameClip` true and must not re-decode (nor, per the guard above,
  // reassign video.src).
  void loadWave(s.clipUrl);
```

- [ ] **Step 4: Verify the build and the suite still pass**

Run: `pnpm build && pnpm test`
Expected: `tsc` clean, 276 tests PASS. The strip is not on screen yet — Task 5 mounts it.

- [ ] **Step 5: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/main.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: decode the framing clip's audio into a peak envelope"
```

---

### Task 5: The strip, its handles, and the drag

**Files:**
- Modify: `src/main.ts` — replace the `scrub` element and its handler block (`src/main.ts:1166-1203`), rewrite the comment at `src/main.ts:1241-1250`, and swap `scrub` for the strip in the second `bar-row` (`src/main.ts:1312`)

**Interfaces:**
- Consumes: `drawWave`, `waveResize`, `wavePeaks` (Task 4); `keptLength` (Task 2); `setQuiet`, `setState`, `getState`, `save` from `./state.ts`.
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Add the minimum-length floor**

Add beside `WAVE_BUCKETS`:

```ts
/** The framing trim's floor. `/api/export` rejects a window whose end is not
 *  after its start, so a handle dragged onto its neighbour would produce a
 *  400 rather than a short clip. One second is also the shortest trim worth
 *  making. */
const MIN_CLIP_S = 1;
```

- [ ] **Step 2: Replace the `scrub` element and its handlers**

Delete `const scrub = el("input", {...})` and the whole `if (videoEl) { ... }` block at `src/main.ts:1166-1203`, keeping the `play` button above it. Put this in its place:

```ts
  // The clip's own strip: waveform, the kept range's handles, the playhead,
  // and click-to-seek. `s.clipStart`/`s.clipEnd` are in the same coordinate
  // system as `s.windowStart`/`s.windowEnd` — source seconds for a single
  // range, the stitch's own timeline for a stitch — while the <video>'s
  // currentTime is 0-based clip-file time. `span` converts between them.
  const span = Math.max(1e-6, s.windowEnd - s.windowStart);
  const pctOf = (sourceT: number) => `${(100 * (sourceT - s.windowStart)) / span}%`;

  const wave = el("div", { className: "wave" });
  const canvas = el("canvas");
  const cutL = el("div", { className: "wave-cut" });
  const cutR = el("div", { className: "wave-cut" });
  const handleL = el("div", { className: "wave-handle", title: "Drag to move the cut's start" });
  const handleR = el("div", { className: "wave-handle", title: "Drag to move the cut's end" });
  const head = el("div", { className: "strip-head" });
  wave.append(canvas, cutL, cutR, handleL, handleR, head);

  /** Repositions everything the drag moves. Called directly rather than
   *  through a render because the drag writes with `setQuiet`, which by
   *  design reaches no render — the same reason the output overlay has to
   *  call the source overlay's `place()` by hand. */
  const place = () => {
    const cur = getState();
    cutL.style.left = "0";
    cutL.style.width = pctOf(cur.clipStart);
    cutR.style.left = pctOf(cur.clipEnd);
    cutR.style.right = "0";
    handleL.style.left = pctOf(cur.clipStart);
    handleR.style.left = pctOf(cur.clipEnd);
  };
  place();

  if (videoEl) {
    const v = videoEl;
    // Event *properties*, not addEventListener: this bar is rebuilt on every
    // render while the <video> outlives all of them, so listeners would
    // stack one per render.
    v.onplay = v.onpause = () => {
      play.textContent = v.paused ? "Play" : "Pause";
    };
    // ontimeupdate rather than a rAF loop: it fires ~4Hz, which is enough
    // for a playhead on a strip this wide, and it needs no teardown when the
    // phase changes — the trimming strip's rAF loop needs two stop sites
    // precisely because it has no such owner.
    v.ontimeupdate = () => {
      head.style.left = `${(100 * v.currentTime) / span}%`;
    };
    // The element may already be playing by the time a re-render builds
    // these: neither event fires again.
    play.textContent = v.paused ? "Play" : "Pause";
    head.style.left = `${(100 * v.currentTime) / span}%`;
    play.onclick = () => {
      if (v.paused) void v.play();
      else v.pause();
    };
    // Click-to-seek on the strip body, matching the trimming strip. Handles
    // stop their own clicks below, so a drag never also seeks.
    wave.onclick = (e) => {
      const box = wave.getBoundingClientRect();
      const frac = (e.clientX - box.left) / Math.max(1, box.width);
      v.currentTime = Math.min(span, Math.max(0, frac * span));
    };
  }

  /** One handle's drag. Clamped to the fetched window on the outside and to
   *  its neighbour (less `MIN_CLIP_S`) on the inside — this is what replaces
   *  the "marking is confined to trimming" argument the old comment below
   *  used to make. */
  const dragHandle = (which: "start" | "end") => (down: PointerEvent) => {
    down.preventDefault();
    down.stopPropagation();
    const box = wave.getBoundingClientRect();
    const target = down.target as HTMLElement;
    target.setPointerCapture(down.pointerId);
    const at = (e: PointerEvent) =>
      s.windowStart + (span * (e.clientX - box.left)) / Math.max(1, box.width);
    const move = (e: PointerEvent) => {
      const cur = getState();
      const t = Math.min(s.windowEnd, Math.max(s.windowStart, at(e)));
      if (which === "start") {
        setQuiet({ clipStart: Math.min(t, cur.clipEnd - MIN_CLIP_S) });
      } else {
        setQuiet({ clipEnd: Math.max(t, cur.clipStart + MIN_CLIP_S) });
      }
      place();
    };
    const up = () => {
      target.releasePointerCapture(down.pointerId);
      target.onpointermove = null;
      target.onpointerup = null;
      // One notifying update at the end, so the kept-duration badge, the
      // over-length warning and Export's gate all catch up in a single
      // render rather than one per pointermove.
      const cur = getState();
      setState({ clipStart: cur.clipStart, clipEnd: cur.clipEnd });
    };
    target.onpointermove = move;
    target.onpointerup = up;
  };
  handleL.onpointerdown = dragHandle("start");
  handleR.onpointerdown = dragHandle("end");
  // Without this a click that ends on a handle bubbles to the strip and
  // seeks the video to wherever the drag finished.
  handleL.onclick = handleR.onclick = (e) => e.stopPropagation();

  // One observer, replaced per render: the canvas is a new node each time,
  // and an observer per built canvas would accumulate for the life of the
  // phase.
  waveResize?.disconnect();
  waveResize = new ResizeObserver(() => drawWave(canvas));
  waveResize.observe(wave);
```

- [ ] **Step 3: Rewrite the now-false comment at `src/main.ts:1241-1250`**

That comment justifies skipping a window check with *"with marking confined to trimming, nothing reachable from here can move them out of it."* This task is what makes that false. Replace the whole comment with:

```ts
  // No window check here, but the reason has changed: this phase CAN now
  // move clipStart/clipEnd, so "marking is confined to trimming" no longer
  // holds. What holds instead is that the only thing that moves them is
  // `dragHandle` above, which clamps to [windowStart, windowEnd] on the
  // outside and to its neighbour less MIN_CLIP_S on the inside — so the
  // pair cannot leave the fetched window or invert. `/api/window` reported
  // that window as containing the marks by construction (windowStart =
  // max(0, floor(start − PAD)) for a single range; 0 and the probed
  // duration for a stitch), and the server re-validates the pair regardless.
```

- [ ] **Step 4: Mount the strip in the bar**

At `src/main.ts:1312`, change `el("div", { className: "bar-row" }, play, scrub),` to:

```ts
    el("div", { className: "bar-row" }, play, wave),
```

- [ ] **Step 5: Verify build and suite**

Run: `pnpm build && pnpm test`
Expected: `tsc` clean (no unused `scrub`, no missing `SHORTS_MAX_S` import change), 276 tests PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/main.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: trim the clip by dragging clipStart/clipEnd over the waveform"
```

---

### Task 6: Browser verification

`main.ts` is DOM-driven and untested by design, so this task is the test. Run `pnpm server` and `pnpm dev` in two terminals.

**Note for agents:** the in-app Browser pane reports `document.hidden = true` and has measured a 0×0 viewport. Neither is an app defect — use a real browser window for these checks.

- [ ] **Step 1: Verify the waveform appears**

Open a video, mark a short range, Continue into framing. Expected: the strip under Play shows a waveform within a second or two of the phase appearing, with the middle portion bright and a dimmed band at each end (that dimmed band is `PAD` — 5s each side).

- [ ] **Step 2: Verify the playhead and click-to-seek**

Press Play. Expected: the dark playhead line tracks across the strip. Click somewhere on the strip. Expected: the video seeks there and the line jumps.

- [ ] **Step 3: Verify the drag and its clamps**

Drag the left handle right. Expected: the dimmed region grows, the kept-duration badge in the top row falls, and the handle stops before reaching the right handle. Drag it hard left past the strip's edge. Expected: it stops at the strip's left edge, never leaves it.

- [ ] **Step 4: Verify the over-length warning follows the trim**

Mark a range longer than 3 minutes so the `over 3 min` badge shows, Continue, then drag a handle until under 3 minutes. Expected: the badge disappears. This is the `keptLength` change from Task 2 — if the badge is stuck, `keptLength` is still reading the segments.

- [ ] **Step 5: Verify a trimmed export is actually shorter**

Trim ~5 seconds off with the handles, type a title, Export. Expected: the finished file in `~/Desktop/vstack/` is the trimmed length, and the preview phase plays exactly what the bright region showed.

- [ ] **Step 6: Verify a clip with no audio does not break anything**

Open a cached clip from the idle dropdown that has no audio track, or temporarily point `loadWave` at a nonexistent URL. Expected: a flat strip, no console error, handles and Export still work.

- [ ] **Step 7: Verify the dark theme**

Press CMD+Shift+0. Expected: the waveform's colour flips with the rest of the UI rather than staying light-theme blue.

- [ ] **Step 8: Verify Safari decodes**

Open the same clip in Safari. Expected: the waveform draws. Safari historically
exposed only the prefixed `webkitOfflineAudioContext` and the callback form of
`decodeAudioData`; Task 4's `Ctor` fallback covers the first. If the strip is
flat in Safari but drawn in Chrome, the callback form is the cause — wrap the
`decodeAudioData` call in a `new Promise` that passes resolve/reject as its
second and third arguments, and keep the promise form as the primary path.

- [ ] **Step 9: Verify the trim does not survive a reload, and that this is harmless**

Trim a few seconds, then reload the page. Expected: the app returns to
trimming with the marks intact and the framing trim gone. This is by design —
`clipStart`/`clipEnd` are window-scoped like `clipUrl` and `clipDigest`, and
`save()` deliberately does not persist them. Confirm only that nothing is
broken or half-restored; do **not** add them to `save()`.

- [ ] **Step 10: Update `CLAUDE.md`**

Add to the invariants section:

```
**`keptLength` reads the clip bounds in framing and the segments
everywhere else.** The two agreed exactly until framing could trim — a
single segment's marks ARE its clip bounds, and a stitch's `clipEnd −
clipStart` is the sum of its parts — so reading the wrong one is silent.
After a framing trim the segments describe a longer cut than `/api/export`
will render, which would mis-gate Export, mis-report the badge and hide the
`SHORTS_MAX_S` warning. Before `/api/window` answers, `clipStart`/`clipEnd`
are both 0, so the trimming phase must keep reading the segments.
```

Update the architecture map: add `src/waveform.ts   peaks (pure peak-per-bucket envelope)` beside `src/segments.ts`, and note in the framing-phase description that the bar's strip is hand-built rather than an `<input type="range">`.

- [ ] **Step 11: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add CLAUDE.md
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "docs: record the framing trim's keptLength invariant"
```
