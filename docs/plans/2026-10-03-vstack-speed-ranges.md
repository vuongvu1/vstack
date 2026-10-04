# Speed-up ranges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Violet "speed" bands on the framing strip that play their footage at x2/x4/x8/x16 in the export — muted, with a whoosh, a VHS fast-forward look and a `▶▶ x4` badge — and preview the same in the browser.

**Architecture:** One pure rule, `planLegs`, turns the clip bounds + cuts + speed ranges into ordered legs; the client sizes the kept badge from it and the server builds the render from it. The existing `concatClips` stitch learns a per-leg `speed` (time only: `setpts`, silence). `exportClip` learns an optional `speed` stage (looks only: VHS lines, colour split, badge PNG overlays, whoosh mix) gated by `enable=` on output-time windows.

**Tech Stack:** TypeScript (Node type-stripping server, Vite client), ffmpeg filter graphs, vitest with real ffmpeg.

**Spec:** `docs/specs/2026-10-03-vstack-speed-ranges-design.md`

## Global Constraints

- Speeds are exactly `2 | 4 | 8 | 16` (`SPEEDS`); at most `MAX_SPEEDS = 4` ranges.
- A fresh speed range is `SPEED_S = 4` seconds at `DEFAULT_SPEED = 4`.
- Cut beats speed wherever they overlap.
- Overlapping speed ranges merge; the merged range keeps the EARLIER range's speed.
- Band colour is violet (`--violet-*`); red stays cut, grass stays keep.
- No cuts and no speeds → the export path is byte-identical to today (no stitch, no fx stage).
- `outName` is unchanged by speeds.
- Every `blend` in the VHS stage runs in planar RGB (`format=gbrp`), never YUV.
- Badge PNG is exactly `BADGE` (324x130) for both frames; inset `BADGE_INSET = 48` from top and right.
- `speeds` is not persisted (cleared wherever `cuts` is cleared).
- Repo conventions: `import type` for types, `.ts` extensions, no `enum`/`any`/default exports, `strict` + `noUncheckedIndexedAccess`, no `console.log`.
- **Commits:** the user commits himself — a hook blocks `git commit`. Every "Commit" step means: leave the changes in the working tree and record the proposed message in the hand-off.

## Review Focus

1. A speed range wholly swallowed by a cut — the client must not send a badge for a speed no leg uses, or the server's "badges must match" check 400s. Both sides derive "speeds used" from `planLegs`. Pinned in Task 1 ("drops a speed range a cut swallows whole").
2. The outer clip handles dragged inward past a speed range — the request must not carry a speed range outside `[clipStart, clipEnd]`, or the route 400s. `doExport` sends `normalizeSpeeds(s.speeds, clipStart, clipEnd)`. Pinned in Task 1 ("clamps to the bounds it is given").
3. A tiny output window — a 1s range at x16 is 0.0625s of output. The whoosh's `afade` and the `enable=` windows must survive it. Pinned in Task 3 (x16 window test).
4. Two touching speed ranges of different speeds — two windows, two badges, no join. Pinned in Task 1 (`planLegs` and `speedWindows`).
5. A silent clip with a speed range — the stitch must still emit an audio stream, because the whoosh mix reads `[0:a]`. Pinned in Task 2 (silent sped part test).

---

### Task 1: The speed model in `src/segments.ts`

**Files:**
- Modify: `src/segments.ts` (append after `keepRanges`)
- Test: `src/segments.test.ts` (append)

**Interfaces:**
- Consumes: `Segment`, `keepRanges`, the module-private `finite` (all existing in `src/segments.ts`).
- Produces:
  - `export const SPEEDS: readonly [2, 4, 8, 16]`
  - `export type Speed = 2 | 4 | 8 | 16`
  - `export type SpeedRange = { start: number; end: number; speed: Speed }`
  - `export type Leg = { start: number; end: number; speed: 1 | Speed }`
  - `export const MAX_SPEEDS = 4`
  - `export function isSpeed(n: unknown): n is Speed`
  - `export function normalizeSpeeds(ranges: SpeedRange[], lo: number, hi: number): SpeedRange[]`
  - `export function isValidSpeeds(v: unknown, start: number, end: number): v is SpeedRange[]`
  - `export function planLegs(start: number, end: number, cuts: Segment[], speeds: SpeedRange[]): Leg[]`
  - `export function legsDuration(legs: Leg[]): number`
  - `export function speedWindows(legs: Leg[]): { at: number; until: number; speed: Speed }[]`

- [ ] **Step 1: Write the failing tests**

Append to `src/segments.test.ts` (add the new names to its existing import from `./segments.ts`):

```ts
describe("planLegs", () => {
  it("is keepRanges with every leg at speed 1 when there are no speeds", () => {
    // The identity that keeps every cut test describing live behaviour.
    const cuts = [{ start: 12, end: 14 }, { start: 20, end: 21 }];
    expect(planLegs(10, 30, cuts, [])).toEqual(
      keepRanges(10, 30, cuts).map((k) => ({ ...k, speed: 1 })),
    );
  });

  it("splits a keep around a speed range inside it", () => {
    expect(planLegs(0, 10, [], [{ start: 2, end: 5, speed: 4 }])).toEqual([
      { start: 0, end: 2, speed: 1 },
      { start: 2, end: 5, speed: 4 },
      { start: 5, end: 10, speed: 1 },
    ]);
  });

  it("lets a cut win where it overlaps a speed range", () => {
    expect(planLegs(0, 10, [{ start: 3, end: 4 }], [{ start: 2, end: 6, speed: 2 }])).toEqual([
      { start: 0, end: 2, speed: 1 },
      { start: 2, end: 3, speed: 2 },
      { start: 4, end: 6, speed: 2 },
      { start: 6, end: 10, speed: 1 },
    ]);
  });

  it("drops a speed range a cut swallows whole", () => {
    // Review focus 1: no leg carries x8, so no x8 badge may be asked for.
    expect(planLegs(0, 10, [{ start: 2, end: 6 }], [{ start: 3, end: 5, speed: 8 }])).toEqual([
      { start: 0, end: 2, speed: 1 },
      { start: 6, end: 10, speed: 1 },
    ]);
  });

  it("joins touching speed ranges of equal speed into one leg", () => {
    expect(
      planLegs(0, 10, [], [
        { start: 2, end: 4, speed: 4 },
        { start: 4, end: 6, speed: 4 },
      ]),
    ).toEqual([
      { start: 0, end: 2, speed: 1 },
      { start: 2, end: 6, speed: 4 },
      { start: 6, end: 10, speed: 1 },
    ]);
  });

  it("keeps touching ranges of different speeds as separate legs", () => {
    expect(
      planLegs(0, 10, [], [
        { start: 2, end: 4, speed: 2 },
        { start: 4, end: 6, speed: 8 },
      ]),
    ).toEqual([
      { start: 0, end: 2, speed: 1 },
      { start: 2, end: 4, speed: 2 },
      { start: 4, end: 6, speed: 8 },
      { start: 6, end: 10, speed: 1 },
    ]);
  });

  it("clips a speed range that starts before the outer bounds", () => {
    expect(planLegs(2, 8, [], [{ start: 0, end: 4, speed: 4 }])).toEqual([
      { start: 2, end: 4, speed: 4 },
      { start: 4, end: 8, speed: 1 },
    ]);
  });
});

describe("normalizeSpeeds", () => {
  it("sorts and merges overlaps, keeping the earlier range's speed", () => {
    expect(
      normalizeSpeeds([
        { start: 4, end: 8, speed: 2 },
        { start: 1, end: 5, speed: 16 },
      ], 0, 100),
    ).toEqual([{ start: 1, end: 8, speed: 16 }]);
  });

  it("does not merge ranges that only touch", () => {
    expect(
      normalizeSpeeds([
        { start: 1, end: 2, speed: 2 },
        { start: 2, end: 3, speed: 4 },
      ], 0, 100),
    ).toEqual([
      { start: 1, end: 2, speed: 2 },
      { start: 2, end: 3, speed: 4 },
    ]);
  });

  it("drops empties and illegal speeds", () => {
    expect(
      normalizeSpeeds([
        { start: 1, end: 1, speed: 4 },
        { start: 2, end: 3, speed: 3 as Speed },
        { start: Number.NaN, end: 3, speed: 4 },
      ], 0, 100),
    ).toEqual([]);
  });

  it("clamps to the bounds it is given", () => {
    // Review focus 2: the outer handles moved inward past a range.
    expect(normalizeSpeeds([{ start: 0, end: 10, speed: 4 }], 2, 6)).toEqual([
      { start: 2, end: 6, speed: 4 },
    ]);
    expect(normalizeSpeeds([{ start: 0, end: 1, speed: 4 }], 2, 6)).toEqual([]);
  });
});

describe("isValidSpeeds", () => {
  it("accepts an empty list and whatever normalizeSpeeds emits", () => {
    expect(isValidSpeeds([], 0, 10)).toBe(true);
    const norm = normalizeSpeeds([
      { start: 6, end: 9, speed: 16 },
      { start: 1, end: 3, speed: 2 },
    ], 0, 10);
    expect(isValidSpeeds(norm, 0, 10)).toBe(true);
  });

  it("rejects everything illegal", () => {
    const ok = { start: 1, end: 2, speed: 4 };
    expect(isValidSpeeds(null, 0, 10)).toBe(false);
    expect(isValidSpeeds("x", 0, 10)).toBe(false);
    expect(isValidSpeeds([null], 0, 10)).toBe(false);
    expect(isValidSpeeds([[1, 2]], 0, 10)).toBe(false);
    expect(isValidSpeeds(Array.from({ length: MAX_SPEEDS + 1 }, (_, i) => ({ start: i, end: i + 0.5, speed: 2 })), 0, 10)).toBe(false);
    expect(isValidSpeeds([{ ...ok, speed: 3 }], 0, 10)).toBe(false);
    expect(isValidSpeeds([{ ...ok, start: -1 }], 0, 10)).toBe(false);
    expect(isValidSpeeds([{ ...ok, end: 11 }], 0, 10)).toBe(false);
    expect(isValidSpeeds([{ ...ok, end: 1 }], 0, 10)).toBe(false);
    expect(isValidSpeeds([{ ...ok, start: Number.NaN }], 0, 10)).toBe(false);
    expect(isValidSpeeds([{ start: 3, end: 4, speed: 2 }, ok], 0, 10)).toBe(false);
    expect(isValidSpeeds([{ start: 1, end: 3, speed: 2 }, { start: 2, end: 4, speed: 2 }], 0, 10)).toBe(false);
  });
});

describe("legsDuration", () => {
  it("divides each leg by its speed", () => {
    expect(legsDuration([{ start: 0, end: 2, speed: 1 }, { start: 2, end: 6, speed: 4 }])).toBe(3);
  });
});

describe("speedWindows", () => {
  it("places each sped leg in OUTPUT time", () => {
    expect(
      speedWindows([
        { start: 0, end: 2, speed: 1 },
        { start: 2, end: 6, speed: 4 },
        { start: 6, end: 7, speed: 1 },
        { start: 8, end: 10, speed: 2 },
      ]),
    ).toEqual([
      { at: 2, until: 3, speed: 4 },
      { at: 4, until: 5, speed: 2 },
    ]);
  });

  it("keeps touching legs of different speeds as two windows", () => {
    expect(
      speedWindows([
        { start: 2, end: 4, speed: 2 },
        { start: 4, end: 8, speed: 8 },
      ]),
    ).toEqual([
      { at: 0, until: 1, speed: 2 },
      { at: 1, until: 1.5, speed: 8 },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/segments.test.ts`
Expected: FAIL — `planLegs` (etc.) is not exported.

- [ ] **Step 3: Implement**

Append to `src/segments.ts`:

```ts
/** The framing strip's playback rates. A closed set rather than a number,
 *  because each one is a badge PNG the client renders and a branch the
 *  server's validator has to know — and Chrome's `playbackRate` stops at 16. */
export const SPEEDS = [2, 4, 8, 16] as const;
export type Speed = (typeof SPEEDS)[number];

/** A sped-up range on the framing strip, in the clip timeline — the same
 *  coordinate system as `cuts`. */
export type SpeedRange = { start: number; end: number; speed: Speed };

/** One piece of the export, in order: a kept range and the rate it plays at. */
export type Leg = { start: number; end: number; speed: 1 | Speed };

/** Bounds the export's stitch graph the way `MAX_CUTS` does — not measured. */
export const MAX_SPEEDS = 4;

export function isSpeed(n: unknown): n is Speed {
  return SPEEDS.includes(n as Speed);
}

/** Sorted, clamped into `[lo, hi]`, empties and illegal speeds dropped, and
 *  overlaps merged. A merged range keeps the EARLIER range's speed — the
 *  same "earlier start survives" rule `normalize` holds for segments.
 *  Touching ranges are not merged: they may carry different speeds. */
export function normalizeSpeeds(ranges: SpeedRange[], lo: number, hi: number): SpeedRange[] {
  const clean: SpeedRange[] = [];
  for (const r of ranges) {
    if (!finite(r?.start) || !finite(r?.end) || !isSpeed(r.speed)) continue;
    const start = Math.min(Math.max(lo, r.start), hi);
    const end = Math.min(Math.max(lo, r.end), hi);
    if (end > start) clean.push({ start, end, speed: r.speed });
  }
  clean.sort((a, b) => a.start - b.start);
  const merged: SpeedRange[] = [];
  for (const r of clean) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r.start < last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** The server's gate on `/api/export`'s `speeds`. Empty is legal (no speed
 *  ranges); otherwise sorted, non-overlapping, inside `[start, end]`, legal
 *  speeds only — a superset of nothing `normalizeSpeeds` cannot emit. */
export function isValidSpeeds(v: unknown, start: number, end: number): v is SpeedRange[] {
  if (!Array.isArray(v) || v.length > MAX_SPEEDS) return false;
  let prevEnd = Number.NEGATIVE_INFINITY;
  for (const r of v) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) return false;
    const { start: a, end: b, speed } = r as SpeedRange;
    if (!finite(a) || !finite(b) || !isSpeed(speed)) return false;
    if (a < start || b > end || !(b > a) || a < prevEnd) return false;
    prevEnd = b;
  }
  return true;
}

/** The export, as ordered legs: `keepRanges` with each kept range split at
 *  every speed range's bounds. Cut beats speed, because only kept footage is
 *  ever split. `speeds` must be normalised. With no speeds this is exactly
 *  `keepRanges` at speed 1 — the identity the cut tests rely on. */
export function planLegs(start: number, end: number, cuts: Segment[], speeds: SpeedRange[]): Leg[] {
  const legs: Leg[] = [];
  const push = (a: number, b: number, speed: 1 | Speed) => {
    if (!(b > a)) return;
    const last = legs[legs.length - 1];
    // Only ever true inside one keep: two keeps are separated by a cut of
    // positive length, so one's end never equals the next one's start.
    if (last !== undefined && last.end === a && last.speed === speed) last.end = b;
    else legs.push({ start: a, end: b, speed });
  };
  for (const keep of keepRanges(start, end, cuts)) {
    let at = keep.start;
    for (const r of speeds) {
      if (r.end <= at) continue;
      if (r.start >= keep.end) break;
      push(at, r.start, 1);
      const to = Math.min(r.end, keep.end);
      push(Math.max(at, r.start), to, r.speed);
      at = to;
      if (at >= keep.end) break;
    }
    push(at, keep.end, 1);
  }
  return legs;
}

/** How long the export is: each leg's length over its rate. */
export function legsDuration(legs: Leg[]): number {
  return legs.reduce((sum, l) => sum + (l.end - l.start) / l.speed, 0);
}

/** Where each sped leg lands in the OUTPUT — what the export's effects are
 *  gated on. One window per sped leg; `planLegs` has already joined equal
 *  neighbours, so two windows that touch differ in speed. */
export function speedWindows(legs: Leg[]): { at: number; until: number; speed: Speed }[] {
  const out: { at: number; until: number; speed: Speed }[] = [];
  let t = 0;
  for (const l of legs) {
    const len = (l.end - l.start) / l.speed;
    if (l.speed !== 1) out.push({ at: t, until: t + len, speed: l.speed });
    t += len;
  }
  return out;
}
```

Note: `push(at, r.start, 1)` is a no-op when `r.start <= at` because of the `b > a` guard.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/segments.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation check of the identity**

Temporarily change `push(at, keep.end, 1)` to `push(at, keep.end, 2)`. Run the same command: the identity test must FAIL. Revert.

- [ ] **Step 6: Commit**

Proposed message: `feat: planLegs — the speed-range rule shared by client and server`

---

### Task 2: `concatClips` carries a per-leg speed

**Files:**
- Modify: `server/ffmpeg.ts` (`ConcatPart` type just above `concatClips`; the `anySilent` line and the per-part leg loop inside `concatClips`)
- Test: `server/ffmpeg.test.ts` (inside `describe("concatClips")`, plus one helper near `pixelAt`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ConcatPart` gains `speed?: number` (default 1). A part with `speed > 1` plays `(end - start) / speed` seconds of picture and silence.

- [ ] **Step 1: Add the loudness helper and the failing tests**

Near `pixelAt` in `server/ffmpeg.test.ts`:

```ts
/** Mean and peak dB of the audio in `[t, t + dur)`. -91 is ffmpeg's floor
 *  for digital silence — what volumedetect reports when nothing matched. */
async function loudness(path: string, t: number, dur: number) {
  const { stderr } = await run(
    "ffmpeg",
    ["-hide_banner", "-ss", String(t), "-t", String(dur), "-i", path,
     "-map", "0:a", "-af", "volumedetect", "-f", "null", "-"],
  );
  const mean = /mean_volume: (-?[0-9.]+) dB/.exec(stderr);
  const max = /max_volume: (-?[0-9.]+) dB/.exec(stderr);
  return { mean: mean ? Number(mean[1]) : -91, max: max ? Number(max[1]) : -91 };
}
```

Inside `describe("concatClips")`:

```ts
  it("plays a sped part at its speed and silences it", async () => {
    // Same banded source as the ordering test: 0-3 red, 3-6 green, 6-9 blue,
    // 9-12 white, with a tone throughout. [0,2] at x1 then [6,8] at x4 is
    // 2 + 0.5 = 2.5 seconds, the sped half blue and silent.
    const banded = join(dir, "banded-speed.mp4");
    await run("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i",
      "color=c=red:s=320x240:d=3:r=30[a];" +
        "color=c=green:s=320x240:d=3:r=30[b];" +
        "color=c=blue:s=320x240:d=3:r=30[c];" +
        "color=c=white:s=320x240:d=3:r=30[d];" +
        "[a][b][c][d]concat=n=4:v=1:a=0",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
      "-y", banded,
    ]);
    const out = join(dir, "stitch-speed.mp4");
    await concatClips(
      [
        { path: banded, start: 0, end: 2 },
        { path: banded, start: 6, end: 8, speed: 4 },
      ],
      out,
    );

    const probed = await probeFile(out);
    expect(probed.seconds).toBeGreaterThan(2.3);
    expect(probed.seconds).toBeLessThan(2.7);

    const sped = await pixelAt(out, 2.25, 160, 120, 320);
    expect(sped.b).toBeGreaterThan(150);
    expect(sped.r).toBeLessThan(80);

    expect((await loudness(out, 0.5, 1)).mean).toBeGreaterThan(-40);
    expect((await loudness(out, 2.05, 0.4)).max).toBeLessThan(-80);
  });

  it("gives a silent clip's sped part an audio stream", async () => {
    // Review focus 5: the whoosh mix reads [0:a] of this output, so a silent
    // source must still come out with sound (silence) after a speed leg.
    const out = join(dir, "silent-speed.mp4");
    await concatClips([{ path: src, start: 0, end: 2, speed: 8 }], out);
    const probed = await probeFile(out);
    expect(probed.hasAudio).toBe(true);
    expect(probed.seconds).toBeLessThan(0.6);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run server/ffmpeg.test.ts -t "concatClips"`
Expected: the first new test FAILS on duration (~4s, not 2.5) and on the silence assertion. The second may fail on duration.

- [ ] **Step 3: Implement**

In `server/ffmpeg.ts`, add to the `ConcatPart` type:

```ts
  /** Playback rate for this leg; absent means 1. A sped leg keeps its
   *  picture, sped up, and gives up its sound for silence — the speed-up
   *  design mutes a fast range rather than chipmunk it. `/api/window` never
   *  passes this, so its stitch is unchanged. */
  speed?: number;
```

In `concatClips`, replace

```ts
  const anySilent = probed.some((p) => !p.hasAudio);
```

with

```ts
  // A sped leg takes its sound from the silence stand-in too, so it counts
  // as silent here. The stand-in's index does not move either way.
  const silentAt = (i: number) => probed[i]?.hasAudio !== true || (parts[i]?.speed ?? 1) > 1;
  const anySilent = parts.some((_, i) => silentAt(i));
```

and replace the body of `parts.forEach((part, i) => { ... })` with:

```ts
    const speed = part.speed ?? 1;
    // At speed 1 the string is exactly what it always was. `fps` runs after
    // `setpts`, so a fast leg drops its surplus frames rather than encoding
    // sixteen times as many.
    const pts = speed === 1 ? "PTS-STARTPTS" : `(PTS-STARTPTS)/${speed}`;
    legs.push(
      `[${i}:v]trim=${part.start}:${part.end},setpts=${pts},` +
        `scale=${shape.width}:${shape.height},setsar=1,fps=${shape.fps},` +
        `format=yuv420p[v${i}]`,
    );
    // A silent or sped part's leg is cut out of the shared anullsrc input
    // instead, trimmed to this leg's OUTPUT length so the streams stay in step.
    const silent = silentAt(i);
    const audioSrc = silent ? `${silenceIndex}:a` : `${i}:a`;
    const from = silent ? 0 : part.start;
    const to = silent ? (part.end - part.start) / speed : part.end;
    legs.push(
      `[${audioSrc}]atrim=${from}:${to},asetpts=PTS-STARTPTS,` +
        `aresample=${CONCAT_RATE},` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`,
    );
    labels.push(`[v${i}][a${i}]`);
```

(Delete the old `const p = probed[i]; const hasAudio = ...` lines; `silentAt` replaces them.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run server/ffmpeg.test.ts -t "concatClips"`
Expected: all `concatClips` tests PASS, the four existing ones included.

- [ ] **Step 5: Commit**

Proposed message: `feat: concatClips plays a leg at a speed, muted`

---

### Task 3: `exportClip`'s speed stage — VHS, badge, whoosh

**Files:**
- Modify: `src/defaults.ts` (append constants)
- Modify: `server/ffmpeg.ts` (new `SpeedFx` type + `speedFilter` beside `buildFilter`; `ExportOpts`; `exportClip`)
- Test: `server/ffmpeg.test.ts` (new `describe("exportClip speed stage")`)

**Interfaces:**
- Consumes: `Speed` from `src/segments.ts`.
- Produces:
  - In `src/defaults.ts`: `BADGE = { w: 324, h: 130 }`, `BADGE_INSET = 48`, `VHS_ROLL = 0.35`, `VHS_GAP = 0.3`, `VHS_BAND = 0.025`, `VHS_GAIN = 170`.
  - In `server/ffmpeg.ts`:
    - `export type SpeedFx = { windows: { at: number; until: number; speed: Speed }[]; badges: Partial<Record<Speed, string>>; whoosh: string }` (badges: speed → PNG path)
    - `export function speedFilter(fx: SpeedFx, frame: Size, base: number): string` — consumes `[v]`, `[0:a]`, inputs `base..`; produces `[vo]`, `[ao]`.
    - `ExportOpts.speed?: SpeedFx`

- [ ] **Step 1: Add the shared constants**

Append to `src/defaults.ts`:

```ts
/** The speed badge's PNG size and its inset from the frame's top-right
 *  corner. One size for both frames: TALL and WIDE share a 1080px short
 *  side. The client rasterises at exactly this size and the server rejects
 *  anything else, so the overlay can never land off-position. */
export const BADGE = { w: 324, h: 130 };
export const BADGE_INSET = 48;

/** The VHS fast-forward lines over a sped range, shared so the canvas
 *  preview and the export roll the same pattern: bright bands VHS_BAND of
 *  the height tall, one every VHS_GAP of the height, moving down at
 *  VHS_ROLL heights a second, screened on at VHS_GAIN (0-255). */
export const VHS_ROLL = 0.35;
export const VHS_GAP = 0.3;
export const VHS_BAND = 0.025;
export const VHS_GAIN = 170;
```

- [ ] **Step 2: Write the failing tests**

Add `speedFilter` to the test's import from `./ffmpeg.ts`, `BADGE, BADGE_INSET` from `../src/defaults.ts`, and append:

```ts
async function frameAt(path: string, t: number): Promise<Buffer> {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-ss", String(t), "-i", path, "-frames:v", "1",
     "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 64 << 20 },
  );
  return stdout as unknown as Buffer;
}

/** Rows in column `x` between y0 and y1 whose red channel exceeds `over`. */
function litRows(buf: Buffer, width: number, x: number, y0: number, y1: number, over: number): number[] {
  const rows: number[] = [];
  for (let y = y0; y < y1; y++) if ((buf[(y * width + x) * 3] ?? 0) > over) rows.push(y);
  return rows;
}

describe("exportClip speed stage", () => {
  let grey = "";
  let badge = "";
  let whoosh = "";
  let out = "";

  beforeAll(async () => {
    // Flat grey, silent: so the VHS lines are the only bright rows, the
    // badge the only red, and the whoosh the only sound.
    grey = join(dir, "grey.mp4");
    await run("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "color=c=0x808080:s=1920x1080:d=3:r=30",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
      "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
      "-y", grey,
    ]);
    badge = join(dir, "badge.png");
    await run("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", `color=c=red:s=${BADGE.w}x${BADGE.h}`,
      "-frames:v", "1", "-pix_fmt", "rgba", "-y", badge,
    ]);
    whoosh = join(dir, "whoosh.m4a");
    await run("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "sine=frequency=1000:duration=3",
      "-c:a", "aac", "-y", whoosh,
    ]);
    out = join(dir, "out-speed.mp4");
    await exportClip({
      input: grey,
      start: 0,
      duration: 3,
      layout: DEFAULT_LAYOUT,
      boxes: [TOP, BOTTOM],
      source: SOURCE,
      mask: await ensureMask(DEFAULT_LAYOUT, [], dir),
      speed: { windows: [{ at: 1, until: 2, speed: 4 }], badges: { 4: badge }, whoosh },
      out,
    });
  }, 180_000);

  it("draws the badge top-right inside the window only", async () => {
    const x = TALL.w - BADGE_INSET - BADGE.w / 2;
    const y = BADGE_INSET + BADGE.h / 2;
    const inside = await pixelAt(out, 1.5, x, y);
    expect(inside.r).toBeGreaterThan(200);
    expect(inside.g).toBeLessThan(60);
    const before = await pixelAt(out, 0.5, x, y);
    expect(before.r).toBeLessThan(160);
  });

  it("rolls bright lines inside the window and none outside", async () => {
    // Column 540, rows 100-900: inside the top cell's window, clear of the
    // badge and of every white gutter.
    const at = async (t: number) => litRows(await frameAt(out, t), TALL.w, 540, 100, 900, 170);
    expect(await at(0.5)).toEqual([]);
    const early = await at(1.2);
    const late = await at(1.8);
    expect(early.length).toBeGreaterThan(0);
    expect(late.length).toBeGreaterThan(0);
    expect(late).not.toEqual(early);
  });

  it("keeps grey grey — the stage blends in planar RGB", async () => {
    // On YUV, `screen` pushes the chroma planes up and the picture turns
    // purple (the lofi CRT stage's measured bug).
    const p = await pixelAt(out, 1.5, 300, 500);
    expect(Math.abs(p.r - p.g)).toBeLessThan(8);
    expect(Math.abs(p.b - p.g)).toBeLessThan(8);
  });

  it("plays the whoosh from the window's start", async () => {
    expect((await loudness(out, 0.2, 0.6)).max).toBeLessThan(-80);
    expect((await loudness(out, 1.05, 0.5)).max).toBeGreaterThan(-40);
  });

  it("survives a window shorter than the whoosh's fade", async () => {
    // Review focus 3: a 1s range at x16 is 0.0625s of output.
    const tiny = join(dir, "out-speed-tiny.mp4");
    await exportClip({
      input: grey,
      start: 0,
      duration: 2,
      layout: DEFAULT_LAYOUT,
      boxes: [TOP, BOTTOM],
      source: SOURCE,
      mask: await ensureMask(DEFAULT_LAYOUT, [], dir),
      speed: { windows: [{ at: 1, until: 1.0625, speed: 16 }], badges: { 16: badge }, whoosh },
      out: tiny,
    });
    expect((await probeFile(tiny)).seconds).toBeGreaterThan(1.8);
  });

  it("emits no speed stage without windows", () => {
    expect(speedFilter({ windows: [], badges: {}, whoosh }, TALL, 2)).toBe("");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run server/ffmpeg.test.ts -t "speed stage"`
Expected: FAIL — `speedFilter` not exported / `speed` not in `ExportOpts`.

- [ ] **Step 4: Implement**

In `server/ffmpeg.ts`, import `{ VHS_BAND, VHS_GAIN, VHS_GAP, VHS_ROLL, BADGE_INSET }` from `../src/defaults.ts` and `type { Speed }` (plus `SPEEDS`) from `../src/segments.ts`. Add below `buildFilter`:

```ts
/** The speed stage's own inputs and timing. Windows are OUTPUT seconds
 *  (`speedWindows`); badges map each speed used to its PNG; whoosh is the
 *  sound played from each window's start. */
export type SpeedFx = {
  windows: { at: number; until: number; speed: Speed }[];
  badges: Partial<Record<Speed, string>>;
  whoosh: string;
};

/** Red/blue split, px. Export-only: the preview does not draw it. */
const VHS_SHIFT = 6;
/** The whoosh's own level, and how long it fades out at its window's end —
 *  the asset is ~9s and a window can be a twentieth of a second. */
const WHOOSH_GAIN = 1;
const WHOOSH_FADE = 0.3;

/** Graph pieces appended after `buildFilter`'s `[v]`. Inputs: badges at
 *  `base, base+1, …` in `SPEEDS` order for each speed used, then the whoosh.
 *  Produces `[vo]` and `[ao]`; "" when there are no windows.
 *
 *  Every effect is gated with `enable=` over the windows rather than built
 *  per window: one stage, however many windows. The lines depend on row and
 *  time only, so they are computed on a ONE-PIXEL column and stretched —
 *  the lofi CRT lesson — and blended in planar RGB, because `screen` on YUV
 *  pushes the chroma planes and turns the picture purple. */
export function speedFilter(fx: SpeedFx, frame: Size, base: number): string {
  if (fx.windows.length === 0) return "";
  const during = (ws: SpeedFx["windows"]) =>
    ws.map((w) => `between(t,${w.at},${w.until})`).join("+");
  const all = during(fx.windows);
  const used = SPEEDS.filter((sp) => fx.windows.some((w) => w.speed === sp));
  const line = `${VHS_GAIN}*lt(mod(Y/H+1000-T*${VHS_ROLL},${VHS_GAP}),${VHS_BAND})`;

  const parts = [
    `[v]format=gbrp,split=2[fxb][fxc]`,
    `[fxc]scale=1:${frame.h},geq=r='${line}':g='${line}':b='${line}',` +
      `scale=${frame.w}:${frame.h}:flags=neighbor[fxl]`,
    `[fxb]rgbashift=rh=-${VHS_SHIFT}:bh=${VHS_SHIFT}:enable='${all}'[fxs]`,
    `[fxs][fxl]blend=all_mode=screen:enable='${all}',format=yuv420p[fx0]`,
  ];
  used.forEach((sp, k) => {
    const ws = fx.windows.filter((w) => w.speed === sp);
    parts.push(
      `[fx${k}][${base + k}:v]overlay=x=W-w-${BADGE_INSET}:y=${BADGE_INSET}:` +
        `enable='${during(ws)}'[fx${k + 1}]`,
    );
  });
  parts.push(`[fx${used.length}]null[vo]`);

  const whooshIndex = base + used.length;
  const n = fx.windows.length;
  parts.push(`[${whooshIndex}:a]asplit=${n}${fx.windows.map((_, j) => `[w${j}]`).join("")}`);
  fx.windows.forEach((w, j) => {
    const len = w.until - w.at;
    const fade = Math.min(WHOOSH_FADE, len);
    const ms = Math.round(w.at * 1000);
    parts.push(
      `[w${j}]atrim=0:${len},afade=t=out:st=${len - fade}:d=${fade},` +
        `volume=${WHOOSH_GAIN},adelay=delays=${ms}:all=1[wd${j}]`,
    );
  });
  // normalize=0 or the programme halves; duration=first or a whoosh could
  // outrun the clip — the transition swell's two lessons.
  parts.push(
    `[0:a]${fx.windows.map((_, j) => `[wd${j}]`).join("")}` +
      `amix=inputs=${n + 1}:normalize=0:duration=first[ao]`,
  );
  return parts.join(";");
}
```

Add to `ExportOpts`:

```ts
  /** The speed-up stage. Only ever set on a stitched input, which always
   *  carries an audio stream (`concatClips` stands silence in), so `[0:a]`
   *  exists for the whoosh mix. Absent: the graph is exactly as before. */
  speed?: SpeedFx;
```

In `exportClip`, replace the args array's input/filter/map section so it reads:

```ts
  const fx = opts.speed !== undefined && opts.speed.windows.length > 0 ? opts.speed : null;
  const badgeInputs = fx
    ? SPEEDS.filter((sp) => fx.windows.some((w) => w.speed === sp)).flatMap((sp) => {
        const path = fx.badges[sp];
        if (path === undefined) throw new Error(`exportClip: no badge for x${sp}.`);
        return ["-loop", "1", "-i", path];
      })
    : [];
  const graph = buildFilter(opts.layout, opts.boxes, opts.customs ?? []);
```

and in the `run("ffmpeg", [...])` call:

```ts
        "-loop", "1", "-i", opts.mask,
        // Badges and the whoosh after the mask, so input 1 does not move, and
        // before -ss for the mask's own reason.
        ...badgeInputs,
        ...(fx ? ["-i", fx.whoosh] : []),
        "-ss", String(opts.start),
        "-t", String(opts.duration),
        "-filter_complex", fx ? `${graph};${speedFilter(fx, opts.layout.frame, 2)}` : graph,
        "-map", fx ? "[vo]" : "[v]",
        // The ? makes audio optional so a silent source still exports.
        "-map", fx ? "[ao]" : "0:a?",
```

(Keep the existing comments on `-loop`, `-ss` and `-t`.) Note: `-ss` here is an output option applying after the filter graph only for the clip input's timestamps — on a stitched input `start` is 0, so the windows' output times are unaffected.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run server/ffmpeg.test.ts`
Expected: whole file PASS (the existing exportClip tests prove the no-speed path is untouched).

- [ ] **Step 6: Mutation check**

Change `format=gbrp,split=2` to `format=yuv420p,split=2` in `speedFilter`; run `-t "speed stage"`: "keeps grey grey" must FAIL. Revert.

- [ ] **Step 7: Commit**

Proposed message: `feat: exportClip speed stage — VHS lines, badge, whoosh`

---

### Task 4: `/api/export` accepts speeds; whoosh asset boot-checked

**Files:**
- Modify: `server/starter.ts` (add `WHOOSH_PATH`, extend `checkStarter`'s list)
- Modify: `server/index.ts` (`/api/export` handler, ~lines 575-800)

**Interfaces:**
- Consumes: `isValidSpeeds`, `planLegs`, `legsDuration`, `speedWindows`, `type Speed` (Task 1); `SpeedFx`, `exportClip`'s `speed` (Task 3); `BADGE` (Task 3); `png`, `pngSize` (existing).
- Produces: request body fields `speeds?: SpeedRange[]`, `badgePngs?: Record<string, string>`.

- [ ] **Step 1: Asset constant and boot check**

In `server/starter.ts`, after `TITLE_SOUND_PATH`:

```ts
/** The speed-up range's whoosh, played from the start of every sped window
 *  of a framing export. AAC inside a .mp3 name, like the crackle — ffmpeg
 *  sniffs past it. ~8.8s, trimmed to each window by the export. */
export const WHOOSH_PATH = asset("speedup-whoosh.mp3");
```

and change `checkStarter`'s loop to `for (const path of [MUSIC_PATH, CUE_PATH, TITLE_SOUND_PATH, END_PATH, WHOOSH_PATH])`.

- [ ] **Step 2: Validate the new fields**

In `server/index.ts`, import `WHOOSH_PATH` from `./starter.ts`, `isValidSpeeds, planLegs, legsDuration, speedWindows` and `type Speed` from `../src/segments.ts`, `BADGE` from `../src/defaults.ts`. In `/api/export`, replace

```ts
    const keeps = keepRanges(start, end, cuts);
    if (keeps.length === 0) {
      return send(res, 400, { error: "cuts must leave something to export." });
    }
```

with

```ts
    // The violet speed-up ranges, same coordinate system as the cuts.
    // Absent means none, so an older body still exports untouched.
    const speedsRaw = raw.speeds ?? [];
    if (!isValidSpeeds(speedsRaw, start, end)) return send(res, 400, { error: "Bad speeds." });
    // One rule with the client's kept badge: what plays, in order, at what
    // rate. Cut beats speed inside it.
    const legs = planLegs(start, end, cuts, speedsRaw);
    if (legs.length === 0) {
      return send(res, 400, { error: "cuts must leave something to export." });
    }
    const stitched = cuts.length > 0 || speedsRaw.length > 0;

    // One badge PNG per speed that SURVIVES the cuts — a range a cut swallows
    // whole needs none. The client derives the set from the same planLegs,
    // so the two cannot disagree; "exactly" rather than "at least" keeps
    // unused bytes out of the temp dir.
    const used = [...new Set(legs.flatMap((l) => (l.speed === 1 ? [] : [l.speed])))].sort((a, b) => a - b);
    const badgesRaw = raw.badgePngs ?? {};
    if (typeof badgesRaw !== "object" || badgesRaw === null || Array.isArray(badgesRaw)) {
      return send(res, 400, { error: "Bad badgePngs." });
    }
    const badgeKeys = Object.keys(badgesRaw).sort((a, b) => Number(a) - Number(b));
    if (badgeKeys.join(",") !== used.join(",")) {
      return send(res, 400, { error: "badgePngs must cover exactly the speeds used." });
    }
    const badgePngs = used.map((sp) => {
      const buf = png((badgesRaw as Record<string, unknown>)[String(sp)], `badgePngs.${sp}`);
      const sz = pngSize(buf);
      if (sz.w !== BADGE.w || sz.h !== BADGE.h) {
        throw new HttpError(400, `badgePngs.${sp} is ${sz.w}x${sz.h}; needs ${BADGE.w}x${BADGE.h}.`);
      }
      return { speed: sp, buf };
    });
```

Remove `keepRanges` from the `../src/segments.ts` import if it is now unused (tsc will say).

- [ ] **Step 3: Stitch the legs and pass the stage**

In the render block, replace the `composed` expression and the `exportClip` call's `start`/`duration`:

```ts
      const composed = !stitched
        ? input
        : await concatClips(
            legs.map((l) => ({
              path: input,
              start: l.start - windowStart,
              end: l.end - windowStart,
              speed: l.speed,
            })),
            join(dir, "body-cut.mp4"),
          );
      const badges: Partial<Record<Speed, string>> = {};
      for (const b of badgePngs) {
        const path = join(dir, `badge-${b.speed}.png`);
        await writeFile(path, b.buf);
        badges[b.speed] = path;
      }
      const windows = speedWindows(legs);
      await exportClip({
        input: composed,
        start: stitched ? 0 : start - windowStart,
        duration: legsDuration(legs),
        // ... layout, boxes, customs, source, mask unchanged ...
        speed: windows.length > 0 ? { windows, badges, whoosh: WHOOSH_PATH } : undefined,
        out: body,
      });
```

Update the comment above `composed` to say "With drops or speed ranges" instead of "With drops". `legsDuration(legs)` equals the old `totalDuration(keeps)` when there are no speeds (Task 1 identity), so the uncut path is unchanged.

- [ ] **Step 4: Typecheck and full server tests**

Run: `pnpm build && pnpm vitest run server/`
Expected: build clean, all PASS.

- [ ] **Step 5: Manual route check**

Run `pnpm server` in one terminal. Then in another:

```bash
curl -s -X POST localhost:8787/api/export -H 'content-type: application/json' \
  -d '{"videoId":"dQw4w9WgXcQ","windowStart":0,"windowEnd":10,"start":0,"end":10,"starterTitle":"x","titlePng":"","layoutId":"1-1","speeds":[{"start":1,"end":2,"speed":3}]}'
```

Expected: a 400. (The exact message depends on which check runs first — `titlePng` is validated before speeds. To see `Bad speeds.` specifically, use a real cached clip from `/api/clips` and a valid `titlePng` in the browser in Task 7.)

- [ ] **Step 6: Commit**

Proposed message: `feat: /api/export renders speed ranges`

---

### Task 5: Client state, kept length and API type

**Files:**
- Modify: `src/state.ts` (`AppState`, `initial`, `keptLength`)
- Modify: `src/main.ts` (the three `cuts: []` reset sites — lines ~228, ~806, ~910)
- Modify: `src/api.ts` (`exportClip` body type)
- Test: `src/state.test.ts`

**Interfaces:**
- Consumes: `SpeedRange`, `planLegs`, `legsDuration` (Task 1).
- Produces: `AppState.speeds: SpeedRange[]`; `keptLength(s: Pick<AppState, "phase" | "segments" | "clipStart" | "clipEnd" | "cuts" | "speeds">)`.

- [ ] **Step 1: Failing tests**

In `src/state.test.ts`, add `speeds: []` to every existing `keptLength({...})` call inside `describe("keptLength")`, then add:

```ts
  it("counts a sped range at its speed", () => {
    // 12s kept, 4 of them at x4: 8 + 1 = 9.
    expect(
      keptLength({
        phase: "framing",
        segments: [],
        clipStart: 3,
        clipEnd: 15,
        cuts: [],
        speeds: [{ start: 5, end: 9, speed: 4 }],
      }),
    ).toBe(9);
  });
```

and next to "never persists clipStart, clipEnd or clipDigest":

```ts
  it("never persists speeds", () => {
    // Window-scoped, like cuts.
    setState({ videoId: "vid00000009", duration: 600, segments: [{ start: 1, end: 2 }],
      speeds: [{ start: 1, end: 2, speed: 4 }] });
    save();
    expect(readRaw("vid00000009")).not.toHaveProperty("speeds");
  });
```

(If `vid00000009` is already used in that file, pick the next unused id.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/state.test.ts`
Expected: FAIL — `speeds` not in `AppState` (type error surfaces at build; vitest fails the x4 test with 12 ≠ 9).

- [ ] **Step 3: Implement**

`src/state.ts`: import `{ legsDuration, planLegs }` and `type { SpeedRange }` from `./segments.ts`. Add to `AppState` beside `cuts`:

```ts
  /** The framing strip's violet speed-up ranges, clip timeline. Not
   *  persisted, for the reason `cuts` are not. */
  speeds: SpeedRange[];
```

`initial`: `speeds: [],` beside `cuts: [],`. `keptLength`:

```ts
export function keptLength(
  s: Pick<AppState, "phase" | "segments" | "clipStart" | "clipEnd" | "cuts" | "speeds">,
): number {
  return s.phase === "framing"
    ? legsDuration(planLegs(s.clipStart, Math.max(s.clipStart, s.clipEnd), s.cuts, s.speeds))
    : totalDuration(s.segments);
}
```

Drop `keepRanges` from its import if unused.

`src/main.ts`: at each `cuts: [],` (three sites; `grep -n "cuts: \[\]" src/main.ts`) add `speeds: [],` on the next line.

`src/api.ts`, in `exportClip`'s body type after `cuts`:

```ts
  /** Violet speed-up ranges, clip time, normalised. Empty for none. */
  speeds: SpeedRange[];
  /** One badge PNG (BADGE-sized, bare base64) per speed `planLegs` leaves
   *  in use, keyed "2" / "4" / "8" / "16". */
  badgePngs: Record<string, string>;
```

with `import type { SpeedRange } from "./segments.ts";`.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run src/state.test.ts && pnpm exec tsc --noEmit`
Expected: tests PASS. tsc will error in `src/main.ts` `doExport` (missing `speeds`/`badgePngs`) — fixed in Task 7. If it is the ONLY error, this task is done.

- [ ] **Step 5: Commit**

Proposed message: `feat: speeds in app state, counted by keptLength`

---

### Task 6: Badge and VHS drawing, in preview and export

**Files:**
- Create: `src/speed.ts`
- Modify: `src/starter.ts` (extract `pngBase64(canvas)` from `renderTitleArt`'s tail)
- Modify: `src/preview.ts` (`startPreview` gains a `speedNow` parameter)
- Modify: `src/main.ts:1262` (the `startPreview(...)` call)

**Interfaces:**
- Consumes: `BADGE`, `BADGE_INSET`, `VHS_*` (Task 3); `TITLE_FONT` (existing); `Speed`, `SpeedRange` (Task 1).
- Produces:
  - `src/starter.ts`: `export async function pngBase64(canvas: HTMLCanvasElement): Promise<string>`
  - `src/speed.ts`: `drawBadge(ctx, speed, x, y): void`, `renderBadge(speed): Promise<string>`, `drawVhs(ctx, frame, t): void`, `speedAt(speeds, cuts, t): Speed | null`
  - `startPreview(canvas, video, frame, cells, boxes, customs, still, speedNow: () => Speed | null)`

DOM-driven; no unit tests (vitest runs `environment: "node"`), except `speedAt`, which is pure.

- [ ] **Step 1: Extract `pngBase64`**

In `src/starter.ts`, move the body of `renderTitleArt` after `drawTitle(ctx, title, frame);` into:

```ts
/** A canvas as bare base64 PNG — what every client-rendered image this
 *  server takes arrives as. */
export async function pngBase64(canvas: HTMLCanvasElement): Promise<string> {
  // (the existing toBlob → FileReader → strip "data:…;base64," code, moved verbatim)
}
```

and end `renderTitleArt` with `return pngBase64(canvas);`.

- [ ] **Step 2: Write `speedAt`'s test**

Create `src/speed.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { speedAt } from "./speed.ts";

describe("speedAt", () => {
  const speeds = [{ start: 2, end: 5, speed: 4 as const }];
  it("names the speed of the range under t", () => {
    expect(speedAt(speeds, [], 3)).toBe(4);
    expect(speedAt(speeds, [], 5)).toBe(null);
    expect(speedAt(speeds, [], 1.9)).toBe(null);
  });
  it("is null inside a cut, because cut beats speed", () => {
    expect(speedAt(speeds, [{ start: 3, end: 4 }], 3.5)).toBe(null);
  });
});
```

Run: `pnpm vitest run src/speed.test.ts` — Expected: FAIL (no module).

- [ ] **Step 3: Create `src/speed.ts`**

```ts
import { BADGE, VHS_BAND, VHS_GAIN, VHS_GAP, VHS_ROLL } from "./defaults.ts";
import type { Size } from "./geometry.ts";
import type { Segment, Speed, SpeedRange } from "./segments.ts";
import { TITLE_FONT, pngBase64 } from "./starter.ts";

/** The speed playing at clip time `t`, or null. Cut beats speed — the same
 *  rule `planLegs` holds — so a cut inside a speed range reads as no speed. */
export function speedAt(speeds: SpeedRange[], cuts: Segment[], t: number): Speed | null {
  if (cuts.some((c) => t >= c.start && t < c.end)) return null;
  return speeds.find((r) => t >= r.start && t < r.end)?.speed ?? null;
}

/** `▶▶ x4` on a dark pill, BADGE-sized, top-left at (x, y). The SAME draw
 *  the export's PNG is encoded from, so the preview's badge is exact. */
export function drawBadge(ctx: CanvasRenderingContext2D, speed: Speed, x: number, y: number): void {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.beginPath();
  ctx.roundRect(x, y, BADGE.w, BADGE.h, BADGE.h / 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${Math.round(BADGE.h * 0.5)}px ${TITLE_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`▶▶ x${speed}`, x + BADGE.w / 2, y + BADGE.h / 2);
  ctx.restore();
}

/** The badge as the bare base64 PNG `/api/export`'s `badgePngs` takes. */
export async function renderBadge(speed: Speed): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = BADGE.w;
  canvas.height = BADGE.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  drawBadge(ctx, speed, 0, 0);
  return pngBase64(canvas);
}

// ponytail: the lines only — the export's 6px red/blue split is not drawn
// here. Approximate on purpose, like the thumbnail preview's blur; the
// export is the authority.
/** The VHS fast-forward bands at time `t`, screened over the composite: the
 *  canvas spelling of `speedFilter`'s `lt(mod(Y/H+1000-T*ROLL, GAP), BAND)`. */
export function drawVhs(ctx: CanvasRenderingContext2D, frame: Size, t: number): void {
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = `rgb(${VHS_GAIN},${VHS_GAIN},${VHS_GAIN})`;
  const first = (t * VHS_ROLL) % VHS_GAP;
  for (let y = first; y < 1; y += VHS_GAP) {
    ctx.fillRect(0, y * frame.h, frame.w, VHS_BAND * frame.h);
  }
  ctx.restore();
}
```

Run: `pnpm vitest run src/speed.test.ts` — Expected: PASS.

- [ ] **Step 4: Preview integration**

`src/preview.ts`: import `{ drawBadge, drawVhs }` from `./speed.ts`, `{ BADGE, BADGE_INSET }` from `./defaults.ts`, `type { Speed }` from `./segments.ts`. Add the parameter `speedNow: () => Speed | null` after `still`. In `tick`, immediately after the ring fills (`cs.forEach(...)` block) and before `const art = still();`, insert:

```ts
      // The speed-up look, over the finished frame and its gutters — where
      // the export's stage sits. Not on the thumbnail: that frame is the
      // starter screen, which no speed range ever reaches.
      const sp = still() ? null : speedNow();
      if (sp !== null) {
        drawVhs(ctx, frame, video.currentTime);
        drawBadge(ctx, sp, frame.w - BADGE_INSET - BADGE.w, BADGE_INSET);
      }
```

`src/main.ts:1262`: pass an extra argument:

```ts
    () => {
      const cur = getState();
      return speedAt(cur.speeds, cur.cuts, cur.windowStart + videoEl.currentTime);
    },
```

importing `speedAt` from `./speed.ts`. (If `videoEl` may be null at that site, mirror whatever the surrounding code does to narrow it.)

- [ ] **Step 5: Verify**

Run: `pnpm exec tsc --noEmit` — only Task 5's known `doExport` error remains.

- [ ] **Step 6: Commit**

Proposed message: `feat: badge and VHS lines drawn in the framing preview`

---

### Task 7: The strip — `+ Speed`, violet bands, rate select, playback, export wiring

**Files:**
- Modify: `src/main.ts` (framing strip: `MAX_CUTS` constants block ~line 981; `drops` / `place` / `ontimeupdate` / `dragDrop` / `+ Cut` region ~2030-2245; `doExport` ~1425)
- Modify: `src/style.css` (after `.wave-x` ~line 1063)

**Interfaces:**
- Consumes: everything above.
- Produces: the user-facing feature.

- [ ] **Step 1: Constants**

Below `const CUT_S = 2;`:

```ts
/** A fresh speed-up band: four seconds at x4 — long enough to grab both
 *  handles, and the middle of the four rates. */
const SPEED_S = 4;
const DEFAULT_SPEED: Speed = 4;
/** Whether the strip muted the video for a speed range, so leaving the range
 *  unmutes only what this code muted and never a mute the user chose.
 *  Module-scoped because the bar is rebuilt every render. */
let speedMuted = false;
```

Import `MAX_SPEEDS, SPEEDS, isSpeed, legsDuration, normalizeSpeeds, planLegs` and `type Speed` from `./segments.ts`; `renderBadge, speedAt` from `./speed.ts`.

- [ ] **Step 2: Bands**

After the `drops` array:

```ts
  // The violet speed-up ranges: the drop recipe again, plus a rate picker.
  // Same snapshot rule as the drops — the count only changes via setState.
  const fasts = s.speeds.map((r, i) => {
    const band = el("div", { className: "wave-speed", title: `Plays at x${r.speed}` });
    const dl = el("div", { className: "wave-handle is-speed", title: "Drag to move this speed-up's start" });
    const dr = el("div", { className: "wave-handle is-speed", title: "Drag to move this speed-up's end" });
    const kill = el("button", { className: "wave-x is-speed", textContent: "×", title: "Play this part at normal speed" });
    kill.onclick = (e) => {
      e.stopPropagation();
      setState({ speeds: getState().speeds.filter((_, j) => j !== i) });
    };
    const pick = el("select", { className: "wave-speed-pick", title: "Speed" });
    for (const sp of SPEEDS) {
      pick.append(el("option", { value: String(sp), textContent: `x${sp}`, selected: sp === r.speed }));
    }
    pick.onclick = (e) => e.stopPropagation();
    pick.onchange = () => {
      const sp = Number(pick.value);
      if (!isSpeed(sp)) return;
      setState({ speeds: getState().speeds.map((x, j) => (j === i ? { ...x, speed: sp } : x)) });
    };
    wave.append(band, dl, dr, kill, pick);
    return { band, dl, dr, kill, pick };
  });
```

Bands must be appended BEFORE the drops so a cut draws on top: move the `fasts` block above the `drops` block.

In `place()`, after the `drops.forEach(...)`:

```ts
    fasts.forEach((f, i) => {
      const r = cur.speeds[i];
      if (r === undefined) return;
      f.band.style.left = pctOf(r.start);
      f.band.style.width = `${(100 * (r.end - r.start)) / span}%`;
      f.dl.style.left = pctOf(r.start);
      f.dr.style.left = pctOf(r.end);
      f.kill.style.left = pctOf((r.start + r.end) / 2);
      f.pick.style.left = pctOf(r.start);
    });
```

- [ ] **Step 3: Drag**

After `dragDrop`, add `dragSpeed` — `dragDrop` with `speeds` for `cuts`:

```ts
  /** One speed band's edge — `dragDrop` exactly, on `speeds`. Overlaps merge
   *  on pointer-up via `normalizeSpeeds`, earlier range's speed winning. */
  const dragSpeed = (i: number, which: "start" | "end") => (down: PointerEvent) => {
    down.preventDefault();
    down.stopPropagation();
    const box = wave.getBoundingClientRect();
    const target = down.target as HTMLElement;
    target.setPointerCapture(down.pointerId);
    const move = (e: PointerEvent) => {
      const cur = getState();
      const r = cur.speeds[i];
      if (r === undefined) return;
      const raw = s.windowStart + (span * (e.clientX - box.left)) / Math.max(1, box.width);
      const t = Math.min(cur.clipEnd, Math.max(cur.clipStart, raw));
      const moved =
        which === "start"
          ? { ...r, start: Math.min(t, r.end - MIN_CLIP_S) }
          : { ...r, end: Math.max(t, r.start + MIN_CLIP_S) };
      setQuiet({ speeds: cur.speeds.map((x, j) => (j === i ? moved : x)) });
      place();
    };
    const up = () => {
      target.releasePointerCapture(down.pointerId);
      target.onpointermove = null;
      target.onpointerup = null;
      setState({ speeds: normalizeSpeeds(getState().speeds, s.windowStart, s.windowEnd) });
    };
    target.onpointermove = move;
    target.onpointerup = up;
  };
  fasts.forEach((f, i) => {
    f.dl.onpointerdown = dragSpeed(i, "start");
    f.dr.onpointerdown = dragSpeed(i, "end");
    f.dl.onclick = f.dr.onclick = (e) => e.stopPropagation();
  });
```

- [ ] **Step 4: Playback**

In `v.ontimeupdate`, after the `hole` skip:

```ts
      // Play a speed range at its rate, muted — what the export does. Read
      // after the cut skip, and through `speedAt`, so a cut inside a speed
      // range is still skipped rather than sped. ~4Hz means up to a quarter
      // second of real time at the wrong rate either side of a range: at x16
      // that is four seconds of footage. ponytail: a rAF watcher if that
      // ever reads as the export disagreeing.
      const live = getState();
      const sp = speedAt(live.speeds, live.cuts, s.windowStart + v.currentTime);
      v.playbackRate = sp ?? 1;
      if (sp !== null && !v.muted) {
        v.muted = true;
        speedMuted = true;
      } else if (sp === null && speedMuted) {
        v.muted = false;
        speedMuted = false;
      }
```

- [ ] **Step 5: `+ Speed`**

After `addCut`:

```ts
  const addSpeed = el("button", {
    textContent: "+ Speed",
    title: "Speed up the part of the clip under the playhead",
    disabled: Boolean(s.busy) || s.speeds.length >= MAX_SPEEDS,
  });
  addSpeed.onclick = () => {
    // Live state, never `s` — the `+ Cut` trap.
    const cur = getState();
    const at = videoEl === null ? cur.clipStart : cur.windowStart + videoEl.currentTime;
    const start = Math.min(Math.max(cur.clipStart, at), Math.max(cur.clipStart, cur.clipEnd - SPEED_S));
    setState({
      speeds: normalizeSpeeds(
        [...cur.speeds, { start, end: Math.min(start + SPEED_S, cur.clipEnd), speed: DEFAULT_SPEED }],
        cur.windowStart,
        cur.windowEnd,
      ),
    });
  };
```

Append `addSpeed` wherever `addCut` is appended into the bar (`grep -n "addCut" src/main.ts`), directly after it.

- [ ] **Step 6: Export request**

In `doExport`, before `await guard(...)`:

```ts
  // Clamped to the marked clip: the outer handles may have been dragged
  // inward past a band since it was drawn, and the server refuses a range
  // outside start/end.
  const speeds = normalizeSpeeds(s.speeds, s.clipStart, s.clipEnd);
  // Badges for exactly the speeds that survive the cuts — the server derives
  // the same set from the same planLegs and refuses any other.
  const used = [
    ...new Set(planLegs(s.clipStart, s.clipEnd, s.cuts, speeds).flatMap((l) => (l.speed === 1 ? [] : [l.speed]))),
  ];
```

and in the request body after `cuts: s.cuts,`:

```ts
      speeds,
      badgePngs: Object.fromEntries(
        await Promise.all(used.map(async (sp) => [String(sp), await renderBadge(sp)] as const)),
      ),
```

Remove `legsDuration` from the import if unused.

- [ ] **Step 7: CSS**

In `src/style.css`, after the `.wave-x` rule:

```css
/* Speed-up ranges: the drop recipe in violet — red is cut and error, grass
   is keep, blue is the playhead. Drawn under the drops (DOM order), because
   a cut beats a speed-up in the render too. */
.wave-speed {
  position: absolute;
  inset-block: 0;
  background: var(--violet-a5);
  pointer-events: none;
}

.wave-handle.is-speed,
.wave-x.is-speed {
  background: var(--violet-9);
}

/* The rate picker, pinned to the band's top-left over the waveform. Sized off
   the strip like `.wave-x`, not the control recipe. */
.wave-speed-pick {
  position: absolute;
  top: 2px;
  height: 18px;
  padding: 0 2px;
  font-size: 11px;
  border: 0;
  border-radius: var(--radius-1);
  background: var(--violet-9);
  color: #fff;
  cursor: pointer;
}
```

- [ ] **Step 8: Build and full suite**

Run: `pnpm build && pnpm test`
Expected: build clean; all tests PASS (previous count + the new ones).

- [ ] **Step 9: Browser verification**

Use the `run` skill (or `pnpm server` + `pnpm dev`) and open a cached clip from the idle dropdown into framing. Check, in order:
1. `+ Speed` drops a violet band at the playhead with `x4` selected; the kept badge shrinks by 3s.
2. Dragging an edge moves it; dragging it into a second band merges them; the earlier band's speed wins.
3. Playing through the band: the video runs fast and muted, the VHS lines roll, and `▶▶ x4` shows top-right. Leaving the band restores speed and sound. Muting by hand first, then playing through, leaves it muted afterwards.
4. A `+ Cut` placed inside the band is skipped, not sped.
5. Change the picker to x16; Export on a tall layout, then on a wide one (`w-1`): each file shows the badge, lines and colour split only in the range, the whoosh at its start, and is the length the kept badge said.
6. Drag the outer start handle past the band and export: no 400.

- [ ] **Step 10: Commit**

Proposed message: `feat: speed-up bands on the framing strip`

---

### Task 8: Docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/specs/2026-10-03-vstack-speed-ranges-design.md` (as-built amendment)

- [ ] **Step 1: CLAUDE.md**

1. In the opening spec chain, after the horizontal-short sentence, add: "plus `docs/specs/2026-10-03-vstack-speed-ranges-design.md`, which supersedes nothing and adds violet speed-up ranges to the framing strip (x2-x16, muted, whoosh, VHS look, badge) — `speeds` + `badgePngs` on top of `/api/export`'s body."
2. "Needs … all seven bundled assets" → "all eight", and `checkStarter` owns "five" (add the whoosh).
3. Architecture block: add `src/speed.ts` (`speedAt`, `drawBadge`, `renderBadge`, `drawVhs`); add `planLegs`/`normalizeSpeeds`/`isValidSpeeds`/`legsDuration`/`speedWindows` to `src/segments.ts`'s line; add `speedFilter`/`SpeedFx` to `server/ffmpeg.ts`'s line; add `WHOOSH_PATH` to `server/starter.ts`'s line; add `speedup-whoosh.mp3` to `server/assets/`.
4. New invariant after the framing-cut one, "**`planLegs` is the one rule a speed range is spent with, and it reduces to `keepRanges` at no speeds.**" — cut beats speed; earlier speed wins a merge; the client's kept badge, its badge PNG set and the server's legs, badge check and fx windows all come from it; the identity is mutation-tested.
5. New invariant: "**The speed stage blends in planar RGB and is gated, not built per window.**" — `format=gbrp` around `blend=screen` (YUV turns purple, mutation-tested by "keeps grey grey"); one `enable=` sum over all windows; badges are inputs after the mask, before `-ss`; whoosh `amix normalize=0 duration=first`, trimmed and faded to each window.
6. `/api/export`'s body list in the gotcha "takes window bounds plus an optional 8-hex digest": add `speeds` + `badgePngs`, and note `badgePngs` is a third client-rendered image, PNG-signature-checked and exactly `BADGE`-sized.
7. Test count in Commands: update `559` to the number `pnpm test` now reports.

- [ ] **Step 2: Spec amendment**

Append an "As built" section to the spec noting: badge size and VHS constants live in `src/defaults.ts` (shared, not copied); the stage is `ExportOpts.speed: SpeedFx` (windows + badges map + whoosh), not a per-window `Fx` list; the whoosh is trimmed to each window and faded out over `min(0.3s, window)`; the preview draws the lines and badge but not the colour split.

- [ ] **Step 3: Commit**

Proposed message: `docs: speed-up ranges in CLAUDE.md and the spec's as-built notes`
