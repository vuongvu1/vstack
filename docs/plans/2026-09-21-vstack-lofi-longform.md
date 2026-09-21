# Long lofi mix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the lofi journey from one music track and one-shot speeches to N tracks played back to back with speeches recurring on a user-set spacing, with `1_`-prefixed files pinned first, and report render progress.

**Architecture:** The music is concatenated by a **pre-pass** into one file in the route's existing temp directory, so the main ffmpeg graph keeps exactly one music input and the "duration is the music's, by construction" invariant survives verbatim. A single track skips that pre-pass entirely and is byte-identical to today. Repeated speech drops reuse the crackle leg's `asplit` fan-out, so drop count grows the leg count but never the input count. Placement gains `fill`, which delegates to today's `troughs` when no spacing is given.

**Tech Stack:** Vite + vanilla TS frontend, zero-dependency `node:http` backend, real `ffmpeg`/`ffprobe` subprocesses, vitest (`environment: "node"`).

**Spec:** `docs/specs/2026-09-21-vstack-lofi-longform-design.md` (committed as `fbfe6d9`)

## Global Constraints

Copied from the spec and `CLAUDE.md`; every task's requirements include these.

- Node runs `server/*.ts` with **type stripping**: no `enum`, no `namespace`, no constructor parameter properties. Non-erasable syntax is a boot crash, not a compile error.
- `import type` for type-only imports; **explicit `.ts` extensions** on relative imports.
- No default exports, no barrel files, no `any`, no `console.log`/`.info` (`.error`/`.warn` only).
- `strict` + `noUncheckedIndexedAccess`: indexing yields `T | undefined`; guard with `?? fallback`, never `!`.
- `Bash(git add)`, `Bash(git commit *)` and `Bash(rm *)` are deny-listed. Use `git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add/commit` and Node's `fs.rm`.
- **Cut `feat/lofi-longform` off `main` before the first code commit.** `main` is what the user runs daily.
- `src/lofi.ts` **imports nothing** and must stay that way — it is the bottom of the client layering beside `geometry.ts` and `segments.ts`.
- `server/lofi.ts` imports `probeAudio`/`probeFile` from `ffmpeg.ts` and nothing else. It is a SIBLING of `ffmpeg.ts`, `longform.ts` and `starter.ts`, not a layer above.
- New client state fields are **session-only** — `save()` must not persist them, and `src/state.test.ts` pins that exclusion.
- `OUT_NAME` is already `\d{4,}` and accepts a 5-digit `mmss`. **Do not widen it.**
- Every cap is checked in the panel **and again** in the route: the route is reachable without the panel.
- Run the full suite with `pnpm test` (currently 421 tests) and the type gate with `pnpm build`.

---

## File Structure

| file | responsibility |
|---|---|
| `src/lofi.ts` (modify) | gains `orderByPrefix` (the `1_` rule + shuffle) and `fill` (slot placement, delegating to `troughs`). Still imports nothing. |
| `src/lofi.test.ts` (modify) | exhaustive coverage for both, plus the `fill`→`troughs` identity |
| `src/defaults.ts` (modify) | `MAX_DROPS`, `MAX_TRACKS`; `MAX_SPEECHES`'s comment re-scoped to files |
| `server/lofi.ts` (modify) | gains `TRACK_FADE`, `concatMusic`, `parseProgress`, `renderProgress`; `renderLofi` gains the `asplit` fan-out and `-progress` |
| `server/lofi.test.ts` (modify) | real-ffmpeg coverage for the concat, the seam dip, the fan-out |
| `server/index.ts` (modify) | `/api/lofi` takes `music: string[]`; new `/api/lofi/progress` |
| `src/api.ts` (modify) | `lofi()` body takes `music: string[]` + `spacing`; new `lofiProgress()` |
| `src/state.ts` (modify) | `music` → `tracks: UploadTrack[]`, plus `spacing` |
| `src/state.test.ts` (modify) | the new fields' persistence exclusion |
| `src/main.ts` (modify) | the panel: track list, spacing field, shuffle button, progress readout |
| `CLAUDE.md` (modify) | the invariants this changes and the ones it adds |

---

## Task 1: `orderByPrefix` — the `1_` rule and the shuffle

**Files:**
- Modify: `src/lofi.ts` (append after `clampPlacement`)
- Test: `src/lofi.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `orderByPrefix<T extends { name: string }>(items: T[], rand?: () => number): T[]`

The `rand` parameter is what makes this testable — a shuffle with no injected
source of randomness can only be tested for the permutation property, which
would not catch a shuffle that never moves anything.

- [ ] **Step 1: Write the failing tests**

Append to `src/lofi.test.ts`:

```ts
describe("orderByPrefix", () => {
  const named = (...names: string[]) => names.map((name) => ({ name }));

  it("pins a 1_ file first", () => {
    const out = orderByPrefix(named("b.mp3", "1_intro.mp3", "c.mp3"), () => 0);
    expect(out[0]?.name).toBe("1_intro.mp3");
  });

  it("gives the first of two 1_ files the pin and shuffles the other", () => {
    const out = orderByPrefix(named("1_a.mp3", "1_b.mp3", "c.mp3"), () => 0);
    expect(out[0]?.name).toBe("1_a.mp3");
    expect(out.map((x) => x.name).sort()).toEqual(["1_a.mp3", "1_b.mp3", "c.mp3"]);
  });

  it("shuffles everything when no file is pinned", () => {
    // Fisher-Yates with rand() === 0 swaps each i down to index 0, which
    // rotates [a,b,c] to [b,c,a]. Deterministic, so a shuffle that never
    // moves anything fails here.
    const out = orderByPrefix(named("a", "b", "c"), () => 0);
    expect(out.map((x) => x.name)).toEqual(["b", "c", "a"]);
  });

  it("is always a permutation of its input", () => {
    const input = named("a", "b", "1_c", "d", "e");
    const out = orderByPrefix(input, () => 0.5);
    expect(out.map((x) => x.name).sort()).toEqual(["1_c", "a", "b", "d", "e"]);
    expect(out).toHaveLength(5);
  });

  it("does not mutate the caller's array", () => {
    const input = named("a", "b", "1_c");
    orderByPrefix(input, () => 0);
    expect(input.map((x) => x.name)).toEqual(["a", "b", "1_c"]);
  });

  it("handles empty and single-item lists", () => {
    expect(orderByPrefix([], () => 0)).toEqual([]);
    expect(orderByPrefix(named("1_only"), () => 0).map((x) => x.name)).toEqual(["1_only"]);
  });
});
```

Add `orderByPrefix` to the existing import from `./lofi.ts` at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lofi.test.ts -t orderByPrefix`
Expected: FAIL — `orderByPrefix is not a function` (or a TS resolution error on the import).

- [ ] **Step 3: Write the implementation**

Append to `src/lofi.ts`:

```ts
/** Play order for a list of uploaded files: a name beginning `1_` goes
 *  first, everything else is shuffled.
 *
 *  Generic over `{ name }` because the music list and the speech list take
 *  the identical rule and neither knows about the other.
 *
 *  This reads the FILENAME, which is why it lives on the client: the
 *  original name never crosses the wire — `/api/upload` answers with a UUID
 *  and the panel keeps the name purely for display. So the client resolves
 *  the order and sends the resolved list; the server sees ids and no names,
 *  and its trust boundary stays exactly where it was.
 *
 *  `rand` is injected so the shuffle can be tested for more than the
 *  permutation property — with `Math.random` a shuffle that never moves
 *  anything passes every assertion worth writing.
 *
 *  Two `1_` files is not an error: the first in list order takes the pin and
 *  the other joins the shuffled tail. It is a filename convention rather
 *  than a validated input, and refusing a render over it would be the wrong
 *  severity. */
export function orderByPrefix<T extends { name: string }>(
  items: T[],
  rand: () => number = Math.random,
): T[] {
  const pinnedAt = items.findIndex((x) => /^1_/.test(x.name));
  const rest = items.filter((_, i) => i !== pinnedAt);
  // Fisher-Yates over a copy. The caller's array is the panel's list and
  // reordering it as a side effect would move rows under the user.
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = rest[i];
    const b = rest[j];
    if (a !== undefined && b !== undefined) {
      rest[i] = b;
      rest[j] = a;
    }
  }
  const pinned = pinnedAt === -1 ? undefined : items[pinnedAt];
  return pinned === undefined ? rest : [pinned, ...rest];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lofi.test.ts -t orderByPrefix`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/lofi.ts src/lofi.test.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: order lofi uploads by a 1_ prefix, shuffling the rest"
```

---

## Task 2: `fill` — slot placement that reduces to `troughs`

**Files:**
- Modify: `src/defaults.ts` (after `MAX_SPEECHES`)
- Modify: `src/lofi.ts` (append after `troughs`)
- Test: `src/lofi.test.ts`

**Interfaces:**
- Consumes: `troughs`, `Speech`, `Placement`, `TroughResult`, `FADE`, `MIN_GAP`, `SKIP_HEAD`, `SKIP_TAIL` — all already exported from `src/lofi.ts`.
- Produces:
  - `MAX_DROPS = 120` and `MAX_TRACKS = 60` in `src/defaults.ts`
  - `fill(env: Float32Array, seconds: number, speeches: Speech[], spacing: number): TroughResult`

**Note against the spec:** the spec names the return type `FillResult` and
says it is `TroughResult`'s shape. It returns `TroughResult` directly here —
`fill` delegates to `troughs` and must be able to hand back its answer
unchanged, and an alias for an identical type is a second name for one thing.
If a future divergence gives `fill` its own error cases, introduce the alias
then.

- [ ] **Step 1: Write the failing tests**

Append to `src/lofi.test.ts`:

```ts
describe("fill", () => {
  const speech = (id: string, seconds: number): Speech => ({ id, name: `${id}.mp3`, seconds });

  it("reduces exactly to troughs when spacing is 0", () => {
    // THE identity. This is what keeps every troughs test above describing
    // live behaviour rather than an orphaned branch.
    const env = envOf(120, [{ from: 60, to: 80 }]);
    const speeches = [speech("a", 6), speech("b", 4)];
    expect(fill(env, 120, speeches, 0)).toEqual(troughs(env, 120, speeches));
  });

  it("reduces to troughs for a negative spacing too", () => {
    const env = envOf(120, [{ from: 60, to: 80 }]);
    const speeches = [speech("a", 6)];
    expect(fill(env, 120, speeches, -1)).toEqual(troughs(env, 120, speeches));
  });

  it("drops a speech once per slot across the track", () => {
    // 600s, spacing 120 => slots centred at 15, 135, 255, 375, 495. The last
    // must still fit a 6s speech before 600 - SKIP_TAIL.
    const env = envOf(600, []);
    const found = fill(env, 600, [speech("a", 6)], 120);
    if ("error" in found) throw new Error(found.error);
    expect(found.placements).toHaveLength(5);
  });

  it("cycles the speech list across slots, in list order", () => {
    const env = envOf(600, []);
    const found = fill(env, 600, [speech("a", 6), speech("b", 6)], 120);
    if ("error" in found) throw new Error(found.error);
    expect(found.placements.map((p) => p.id)).toEqual(["a", "b", "a", "b", "a"]);
  });

  it("returns placements in time order", () => {
    const env = envOf(600, []);
    const found = fill(env, 600, [speech("a", 6)], 120);
    if ("error" in found) throw new Error(found.error);
    const ats = found.placements.map((p) => p.at);
    expect([...ats].sort((x, y) => x - y)).toEqual(ats);
  });

  it("clamps a spacing below MIN_GAP up to MIN_GAP", () => {
    const env = envOf(600, []);
    const tight = fill(env, 600, [speech("a", 2)], 1);
    const floored = fill(env, 600, [speech("a", 2)], MIN_GAP);
    expect(tight).toEqual(floored);
  });

  it("never returns more than MAX_DROPS placements", () => {
    const env = envOf(20000, []);
    const found = fill(env, 20000, [speech("a", 2)], MIN_GAP);
    if ("error" in found) throw new Error(found.error);
    expect(found.placements.length).toBeLessThanOrEqual(MAX_DROPS);
  });

  it("refuses a speech longer than its slot, by name", () => {
    const env = envOf(600, []);
    const found = fill(env, 600, [speech("a", 200)], 60);
    if (!("error" in found)) throw new Error("expected a refusal");
    expect(found.error).toContain("a.mp3");
  });

  it("puts each drop inside its own slot window", () => {
    const env = envOf(600, []);
    const found = fill(env, 600, [speech("a", 6)], 120);
    if ("error" in found) throw new Error(found.error);
    found.placements.forEach((p, k) => {
      const centre = SKIP_HEAD + k * 120;
      expect(Math.abs(p.at - FADE - centre)).toBeLessThanOrEqual(60);
    });
  });

  it("places into the quietest part of a slot", () => {
    // One hole per slot, offset from the slot's own centre. The drop should
    // land in the hole rather than at the centre.
    const env = envOf(600, [{ from: 150, to: 180 }]);
    const found = fill(env, 600, [speech("a", 6)], 120);
    if ("error" in found) throw new Error(found.error);
    const second = found.placements[1];
    if (second === undefined) throw new Error("expected a second placement");
    expect(second.at).toBeGreaterThanOrEqual(150);
    expect(second.at + 6).toBeLessThanOrEqual(180);
  });
});
```

Add `fill` to the `./lofi.ts` import and `MAX_DROPS` to a new import from `./defaults.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lofi.test.ts -t fill`
Expected: FAIL — `fill is not a function`.

- [ ] **Step 3: Add the caps**

In `src/defaults.ts`, replace the `MAX_SPEECHES` doc comment and append the two new caps:

```ts
/** The most speech FILES one lofi render will take.
 *
 *  Files, not drops. Those were the same number until a speech could repeat;
 *  now this bounds how many distinct recordings the panel accepts and
 *  `MAX_DROPS` bounds how many times they are heard. The distinction is what
 *  keeps the ffmpeg graph's INPUT count bounded by this while its LEG count
 *  grows with `MAX_DROPS` — one input per file, `asplit` into its drops, the
 *  same shape the crackle leg already has.
 *
 *  Shared client and server, like `MAX_PARTS`: the panel refuses the ninth
 *  file before it is uploaded, and `/api/lofi` refuses it again because the
 *  route is reachable without the panel. */
export const MAX_SPEECHES = 8;

/** The most speech placements one render will carry.
 *
 *  A sanity bound on the filter graph's size, not a judgement about pacing:
 *  every drop is an `asplit` tap plus an `atrim`, an `adelay` and a crackle
 *  boost leg with two fades. Three hours at the default five-minute spacing
 *  is 36, so this leaves room without pretending there is no bound. */
export const MAX_DROPS = 120;

/** The most music tracks one render will concatenate.
 *
 *  Sixty four-minute tracks is four hours, past anything this is for. The
 *  bound is on the CONCAT PRE-PASS's input count, which is the one place in
 *  this journey that still grows with the music list — the main graph takes
 *  the pre-pass's single output whatever the list's length. */
export const MAX_TRACKS = 60;
```

- [ ] **Step 4: Write `fill`**

Append to `src/lofi.ts`:

```ts
/** Where each speech goes when it RECURS through a long track, or the first
 *  reason one of them cannot.
 *
 *  **When `spacing` is 0 or less this is `troughs`, exactly.** That identity
 *  is load-bearing rather than tidy: it is what keeps every `troughs` test
 *  in `src/lofi.test.ts` — the longest-first ordering, MIN_GAP, the
 *  SKIP_HEAD/SKIP_TAIL boundaries, the by-name refusal — describing live
 *  behaviour instead of an orphaned branch. The same shape `bucketAt` holds
 *  against `floor(x * buckets / w)` and `trims` holds against the empty
 *  array. Mutation-tested: breaking the delegation fails the first test
 *  above and nothing else.
 *
 *  With a spacing, the timeline is cut into slots and each slot takes one
 *  drop. Inside a slot the position is still the QUIETEST available, scored
 *  by the same global-median baseline `troughs` uses, so a drop lands on a
 *  breakdown rather than on a downbeat. Speeches cycle in list order, which
 *  is the order `orderByPrefix` has already resolved — so a `1_` speech
 *  opens the render.
 *
 *  Note this does NOT sort longest-first the way `troughs` does. There is
 *  nothing to ration: a slot's occupant is decided by the cycle, not
 *  competed for, so the scarcity argument that forces that ordering does not
 *  arise here. */
export function fill(
  env: Float32Array,
  seconds: number,
  speeches: Speech[],
  spacing: number,
): TroughResult {
  if (!(spacing > 0)) return troughs(env, seconds, speeches);
  if (speeches.length === 0) return { placements: [] };
  if (!(seconds > 0) || env.length === 0) {
    return { error: "That track has no audio to measure." };
  }
  // Below MIN_GAP two drops read as one long interruption regardless of what
  // was typed, so the floor wins over the field.
  const step = Math.max(spacing, MIN_GAP);
  const perSec = env.length / seconds;
  const base = Math.max(median(env), 1e-6);
  const placements: Placement[] = [];

  for (let k = 0; k < MAX_DROPS; k++) {
    const centre = SKIP_HEAD + k * step;
    const speech = speeches[k % speeches.length];
    if (speech === undefined) break;
    const need = speech.seconds + 2 * FADE;
    // The slot's own half-step either side, intersected with the track's
    // bounds. `hi` subtracts `need` because the window has to END inside.
    const lo = Math.max(SKIP_HEAD, centre - step / 2);
    const hi = Math.min(centre + step / 2, seconds - SKIP_TAIL - need);
    if (lo > hi) {
      // Past the end of the track is where the loop stops, not an error —
      // the render simply holds as many slots as it holds. A FIRST slot that
      // does not fit is the real failure, and it is the refusal below.
      if (k > 0) break;
      return {
        error:
          `${speech.name} (${Math.round(speech.seconds)}s) does not fit in a ` +
          `${Math.round(step)}s slot.`,
      };
    }
    let bestAt = -1;
    let bestScore = Infinity;
    // Stepped by BUCKET INDEX, never an accumulated float stride — the same
    // lesson `troughs` and `peaks()` both record.
    for (let b = Math.ceil(lo * perSec); b <= Math.floor(hi * perSec); b++) {
      const from = b / perSec;
      const score = windowMean(env, b, Math.ceil((from + need) * perSec)) / base;
      if (score < bestScore) {
        bestScore = score;
        bestAt = from;
      }
    }
    if (bestAt < 0) {
      if (k > 0) break;
      return {
        error:
          `${speech.name} (${Math.round(speech.seconds)}s) does not fit in a ` +
          `${Math.round(step)}s slot.`,
      };
    }
    placements.push({ id: speech.id, at: bestAt + FADE });
  }

  placements.sort((a, b) => a.at - b.at);
  return { placements };
}
```

Add `import { MAX_DROPS } from "./defaults.ts";` — **check first** whether this breaks the "imports nothing" rule. `src/defaults.ts` itself imports nothing, so `src/lofi.ts` importing it keeps the module at the bottom of the layering and still server-importable. Record that in `src/lofi.ts`'s header comment, replacing "Imports NOTHING" with "Imports only `defaults.ts`, which itself imports nothing".

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/lofi.test.ts`
Expected: PASS — the 17 existing tests plus 6 from Task 1 plus 10 here.

- [ ] **Step 6: Verify the identity by mutation**

Temporarily change the first line of `fill` to `if (false)`. Run
`pnpm vitest run src/lofi.test.ts -t "reduces exactly to troughs"`.
Expected: FAIL. Revert the mutation and re-run to confirm PASS.

- [ ] **Step 7: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/lofi.ts src/lofi.test.ts src/defaults.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: place repeating lofi speeches on a spacing, reducing to troughs"
```

---

## Task 3: `concatMusic` — the pre-pass, with a single track as the identity

**Files:**
- Modify: `server/lofi.ts`
- Test: `server/lofi.test.ts`

**Interfaces:**
- Consumes: `probeAudio` from `./ffmpeg.ts` (already imported), `toolError` from `./errors.ts` (already imported), `RATE` (module-local).
- Produces:
  - `export const TRACK_FADE = 1.5;`
  - `export async function concatMusic(paths: string[], out: string): Promise<string>` — returns the path the caller should use as the music: `paths[0]` for a single track, `out` otherwise.

- [ ] **Step 1: Write the failing tests**

In `server/lofi.test.ts`, add to the `beforeAll` fixture block three 2s tones,
then the tests. The tone choice is the load-bearing part: a mis-ordered leg is
still the right LENGTH, so only the frequency says where the audio came from.
First and third are equal so an off-by-one lands measurably wrong either way.

```ts
// In beforeAll, after the existing fixtures:
tone440a = join(dir, "t440a.m4a");
tone1760 = join(dir, "t1760.m4a");
tone440b = join(dir, "t440b.m4a");
for (const [path, hz] of [[tone440a, 440], [tone1760, 1760], [tone440b, 440]] as const) {
  await run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=2`,
    "-c:a", "aac", path,
  ]);
}
```

```ts
describe("concatMusic", () => {
  it("returns the single input untouched, writing nothing", async () => {
    // THE identity: one track must not pay a pass, a temp file or a new
    // failure mode for a feature it does not use.
    const out = join(dir, "single.flac");
    expect(await concatMusic([tone440a], out)).toBe(tone440a);
    expect(existsSync(out)).toBe(false);
  });

  it("joins three tracks to their summed duration", async () => {
    const out = join(dir, "joined.flac");
    const got = await concatMusic([tone440a, tone1760, tone440b], out);
    expect(got).toBe(out);
    const { seconds } = await probeAudio(out);
    expect(seconds).toBeGreaterThan(5.8);
    expect(seconds).toBeLessThan(6.2);
  });

  it("keeps each track's own tone in its own third", async () => {
    const out = join(dir, "ordered.flac");
    await concatMusic([tone440a, tone1760, tone440b], out);
    // 1760 Hz lives in the middle two seconds alone, so the middle sample is
    // what proves the ORDER rather than merely the length.
    expect(await peakHzAt(out, 1.0)).toBeCloseTo(440, -2);
    expect(await peakHzAt(out, 3.0)).toBeCloseTo(1760, -2);
    expect(await peakHzAt(out, 5.0)).toBeCloseTo(440, -2);
  });

  it("dips at each seam and not at the head or tail", async () => {
    const out = join(dir, "seams.flac");
    await concatMusic([tone440a, tone1760, tone440b], out);
    const seam = (await loudness(out, 1.95, 0.1)).mean;
    const inside = (await loudness(out, 1.0, 0.1)).mean;
    const head = (await loudness(out, 0.0, 0.1)).mean;
    const tail = (await loudness(out, 5.9, 0.1)).mean;
    expect(seam).toBeLessThan(inside - 10);
    // The mix opens and closes deliberately — fading either is fading
    // something that already starts and ends on purpose.
    expect(head).toBeGreaterThan(seam + 10);
    expect(tail).toBeGreaterThan(seam + 10);
  });
});
```

`loudness(path, t, dur, pre)` **already exists** in this file (it wraps
`volumedetect` and returns `{ mean, max }`) — the seam test uses it rather
than adding a second helper that does the same thing. Only the frequency
reader is new:

```ts
/** The dominant frequency at `at` seconds, via a 0.2s window through
 *  `astats`-free means: an `ebur128`-free FFT is not available here, so this
 *  slices the window out and asks `aspectralstats` for its centroid, which
 *  on a pure sine is the sine. */
async function peakHzAt(path: string, at: number): Promise<number> {
  const { stderr } = await run("ffmpeg", [
    "-v", "info", "-ss", String(at), "-t", "0.2", "-i", path,
    "-af", "aspectralstats=measure=centroid,ametadata=mode=print:key=lavfi.aspectralstats.1.centroid",
    "-f", "null", "-",
  ]);
  const hits = [...stderr.matchAll(/centroid=([\d.]+)/g)].map((m) => Number(m[1]));
  if (hits.length === 0) throw new Error(`no centroid read from ${path} at ${at}s`);
  return hits.reduce((a, b) => a + b, 0) / hits.length;
}

```

`aspectralstats` is present in this machine's ffmpeg — verified with
`ffmpeg -filters | grep aspectralstats` before this plan was written. On a
pure sine the spectral centroid IS the sine, which is what makes it a
frequency reader here without an FFT.

Declare `let tone440a = ""; let tone1760 = ""; let tone440b = "";` beside the
existing fixture variables, import `existsSync` from `node:fs` and
`probeAudio` from `./ffmpeg.ts`, and add `concatMusic` to the `./lofi.ts`
import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run server/lofi.test.ts -t concatMusic`
Expected: FAIL — `concatMusic is not a function`.

- [ ] **Step 3: Write `concatMusic`**

Add to `server/lofi.ts`, after the `FADE` declaration:

```ts
/** How long the dip at each seam between two tracks takes.
 *
 *  Longer than this journey's own `FADE` (0.5s), and declared separately
 *  rather than shared with it: `FADE` measures a VOICE's breathing room and
 *  this measures a seam between two pieces of music. One constant for two
 *  jobs means tuning either one moves the other — the same reason
 *  `longform.ts` and `starter.ts` keep separate blur sigmas. */
export const TRACK_FADE = 1.5;
```

And the function, after `checkLofi`:

```ts
/** Joins the music tracks into one file and returns the path to use as the
 *  render's music.
 *
 *  **One track returns its own path and writes nothing.** That identity is
 *  the point: the existing single-track journey must not pay an extra pass,
 *  a ~1 GB temp file or a new failure mode for a feature it does not use.
 *
 *  Why a PRE-PASS rather than N inputs on the main graph. The obvious shape
 *  is `concat` inside `renderLofi`, and it works — but a three-hour render
 *  at four minutes a track is around forty-five tracks, which is forty-five
 *  more ffmpeg inputs on a graph that already carries the background, every
 *  speech, the crackle and the mark. More importantly it would make
 *  `seconds` an arithmetic SUM, and this journey's duration invariant is
 *  that nothing sums: the route probes one file and `outName` commits that
 *  number to the filename. Building the file here keeps the invariant
 *  verbatim — the duration is still the music's, by construction, and the
 *  music is now a file this function built.
 *
 *  flac, so the tracks are not lossily re-encoded twice on their way to the
 *  render's AAC. Roughly 1 GB for three hours, in the caller's temp dir.
 *
 *  The seam is a DIP ON EACH LEG, never `acrossfade`. A crossfade overlaps
 *  the legs, so the output is `(N-1) * d` shorter than the tracks sum to —
 *  and the sum is what the caller has already committed to in the filename.
 *  A dip keeps the total exact by construction. Same decision, same reason,
 *  as `stackWide`'s transition. */
export async function concatMusic(paths: string[], out: string): Promise<string> {
  const first = paths[0];
  if (first === undefined) throw new Error("concatMusic needs at least one track.");
  if (paths.length === 1) return first;

  const probed = await Promise.all(paths.map((p) => probeAudio(p)));
  const fmt = `aformat=sample_fmts=fltp:channel_layouts=stereo`;
  const legs: string[] = [];
  paths.forEach((_, i) => {
    const secs = probed[i]?.seconds ?? 0;
    // Clamped to a third of the track, the same clamp `stackWide` carries
    // and for the same two symptoms of one defect: on a track shorter than
    // `2 * TRACK_FADE` an unclamped fade-in and fade-out overlap and
    // MULTIPLY to roughly quarter level, and once the track is shorter than
    // the fade itself the fade-out's `st` goes negative and ffmpeg refuses
    // the graph outright.
    const d = Math.min(TRACK_FADE, secs / 3);
    // Only BETWEEN tracks: the mix opens on its first track and closes on
    // its last, both deliberately, and fading either is fading something
    // that already begins and ends on purpose.
    const fadeIn = i > 0 ? `afade=t=in:st=0:d=${d},` : "";
    const fadeOut = i < paths.length - 1 ? `afade=t=out:st=${secs - d}:d=${d},` : "";
    legs.push(`[${i}:a]aresample=${RATE},${fmt},${fadeIn}${fadeOut}anull[t${i}]`);
  });
  legs.push(`${paths.map((_, i) => `[t${i}]`).join("")}concat=n=${paths.length}:v=0:a=1[out]`);

  try {
    await run(
      "ffmpeg",
      [
        "-v", "error",
        ...paths.flatMap((p) => ["-i", p]),
        "-filter_complex", legs.join(";"),
        "-map", "[out]",
        "-c:a", "flac",
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run server/lofi.test.ts -t concatMusic`
Expected: PASS, 4 tests. These shell real ffmpeg; the file's `beforeAll`
already carries a 180s timeout, which the three new fixtures fit inside.

- [ ] **Step 5: Verify the seam guards by mutation**

Remove the `i > 0` / `i < paths.length - 1` conditions so every leg fades both
ways. Run the seam test. Expected: FAIL on the head or tail assertion. Revert.

- [ ] **Step 6: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add server/lofi.ts server/lofi.test.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: concatenate lofi music tracks in a pre-pass, dipping each seam"
```

---

## Task 4: the `asplit` fan-out — many drops, one input per file

**Files:**
- Modify: `server/lofi.ts` (the `cuts.forEach` speech-leg block, currently around line 513)
- Test: `server/lofi.test.ts`

**Interfaces:**
- Consumes: `Cut = { path: string; at: number }` — unchanged in shape. What
  changes is that several `Cut`s may now share a `path`.
- Produces: no new exports. `renderLofi`'s signature is unchanged.

- [ ] **Step 1: Write the characterisation test**

**This task has no red state, and pretending otherwise would be dishonest.**
Today each `Cut` opens its own `-i`, so three drops of one file open that file
three times — which *works*. The win here is the INPUT COUNT, which is not
observable from the rendered output. So this test passes before the change as
well as after, and its job is to prove the refactor preserves behaviour.
Write it, watch it pass, refactor, watch it still pass.

```ts
it("plays one speech file at every one of its drops", async () => {
  // Three drops of ONE file. If drops were opened as separate inputs and one
  // were mis-indexed, the tone would be missing from that window while the
  // render still succeeded — the silent failure this asserts against.
  const out = join(dir, "repeat.mp4");
  await renderLofi({
    background: bg,
    music,
    cuts: [
      { path: speechAudio, at: 4 },
      { path: speechAudio, at: 12 },
      { path: speechAudio, at: 20 },
    ],
    out,
  });
  const band = "bandpass=f=1200:width_type=h:width=200";
  for (const at of [4.5, 12.5, 20.5]) {
    expect((await loudness(out, at, 1, band)).mean).toBeGreaterThan(-45);
  }
  // And absent between them, which is what proves the delays are distinct
  // rather than all three landing on one moment.
  for (const at of [8, 16]) {
    expect((await loudness(out, at, 1, band)).mean).toBeLessThan(-55);
  }
}, 120_000);
```

`speechAudio` is the existing 1200 Hz audio-only fixture and `loudness(path,
t, dur, pre)` the existing helper — the same `bandpass` idiom the duck and
crackle tests in this file already use. Reuse both; do not add a helper that
duplicates `loudness`.

- [ ] **Step 2: Run it and confirm it PASSES**

Run: `pnpm vitest run server/lofi.test.ts -t "every one of its drops"`
Expected: PASS, for the reason in Step 1. A failure here means the existing
per-cut input path is broken for repeated paths, which would be worth
understanding before refactoring on top of it.

- [ ] **Step 3: Rewrite the speech-leg block**

Replace the `cuts.forEach((cut, i) => { ... })` block and the `firstCut`
arithmetic in `renderLofi` with a grouped version:

```ts
  // One INPUT per unique speech file, `asplit` into that file's drops — not
  // one input per drop. A three-hour render at five-minute spacing is ~36
  // drops of maybe four files; opening each drop would put 36 inputs on this
  // graph for four recordings.
  //
  // This is the crackle leg's own shape, applied to the speeches: one input,
  // `asplit` into N taps, each `atrim`med and `adelay`ed onto its own
  // moment. Nothing new was invented for it.
  const uniquePaths = [...new Set(cuts.map((c) => c.path))];
  const indexOfPath = new Map(uniquePaths.map((p, i) => [p, firstCut + i]));
  const dropsOfPath = new Map<string, number[]>();
  cuts.forEach((cut, i) => {
    const list = dropsOfPath.get(cut.path) ?? [];
    list.push(i);
    dropsOfPath.set(cut.path, list);
  });

  for (const path of uniquePaths) {
    const drops = dropsOfPath.get(path) ?? [];
    const input = indexOfPath.get(path) ?? firstCut;
    // A single drop takes no `asplit` at all, so a one-shot render's graph
    // is byte-identical to the one it had before repeats existed.
    if (drops.length > 1) {
      const taps = drops.map((i) => `[raw${i}]`).join("");
      legs.push(`[${input}:a]asplit=${drops.length}${taps}`);
    }
    for (const i of drops) {
      const cut = cuts[i];
      if (cut === undefined) continue;
      const dur = probed[i]?.seconds ?? 0;
      const src = drops.length > 1 ? `[raw${i}]` : `[${input}:a]`;
      legs.push(
        `${src}atrim=0:${dur},asetpts=PTS-STARTPTS,` +
          `highpass=f=${SPEECH_HP},` +
          `acrusher=bits=${CRUSH_BITS}:mode=lin:mix=${CRUSH_MIX},` +
          `lowpass=f=${SPEECH_LP},volume=${SPEECH_GAIN},` +
          `adelay=${Math.round(cut.at * 1000)}:all=1,aresample=${RATE},${fmt}[sp${i}]`,
      );
    }
  }
```

Then update the two index derivations below it:

```ts
  const crackleIndex = firstCut + uniquePaths.length;
  const logoIndex = crackleIndex + 1;
```

and the input list, which must push **one** `-i` per unique path rather than
one per cut:

```ts
  for (const path of uniquePaths) inputs.push("-i", path);
```

`probed` stays indexed by CUT, not by path — a drop's `atrim` bound is its own
container duration and two drops of one file legitimately share it.

- [ ] **Step 4: Run the whole server lofi suite**

Run: `pnpm vitest run server/lofi.test.ts`
Expected: PASS — all 20 existing tests plus the concat four plus this one. The
existing tests are the real gate here: they cover the duck, the crackle, the
bars, the mark and the audio-stream duration, all of which read indices this
task moved.

- [ ] **Step 5: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add server/lofi.ts server/lofi.test.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: fan a repeated lofi speech out with asplit, one input per file"
```

---

## Task 5: render progress

**Files:**
- Modify: `server/lofi.ts`
- Test: `server/lofi.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export function parseProgress(text: string): number` — seconds, from a progress file's body
  - `export function renderProgress(): { phase: "music" | "render"; done: number; total: number }`
  - `concatMusic` and `renderLofi` both gain `-progress <out>.progress` and set the module slot.

- [ ] **Step 1: Write the failing test for the parser**

The parser is the only part worth a unit test; the file plumbing is covered by
the route working at all.

```ts
describe("parseProgress", () => {
  it("reads the LAST out_time_us block", () => {
    const text = [
      "frame=30", "out_time_us=1000000", "progress=continue",
      "frame=60", "out_time_us=2500000", "progress=continue",
    ].join("\n");
    expect(parseProgress(text)).toBeCloseTo(2.5, 3);
  });

  it("returns 0 for a file ffmpeg has not written to yet", () => {
    expect(parseProgress("")).toBe(0);
  });

  it("ignores a trailing partial block", () => {
    expect(parseProgress("out_time_us=3000000\nprogress=continue\nframe=9")).toBeCloseTo(3, 3);
  });

  it("survives ffmpeg's N/A before the first frame", () => {
    expect(parseProgress("out_time_us=N/A\nprogress=continue")).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run server/lofi.test.ts -t parseProgress`
Expected: FAIL — `parseProgress is not a function`.

- [ ] **Step 3: Write the parser, the slot and the getter**

Add to `server/lofi.ts`, importing `readFileSync` from `node:fs` alongside the
existing `existsSync`:

```ts
/** Seconds done, from a `-progress` file's body.
 *
 *  ffmpeg APPENDS a key/value block per update rather than rewriting, so the
 *  file is a log and the last `out_time_us` is the position. Before the first
 *  frame it writes `N/A`, which must read as 0 rather than NaN — a NaN here
 *  reaches the panel as a progress bar that renders nothing at all. */
export function parseProgress(text: string): number {
  const hits = [...text.matchAll(/out_time_us=(\d+)/g)];
  const last = hits[hits.length - 1]?.[1];
  return last === undefined ? 0 : Number(last) / 1e6;
}

/** ponytail: one global slot, the same assumption `publishProgress` already
 *  states — two lofi renders cannot overlap in the panel. Unlike publish,
 *  this route IS reachable without the panel, so two concurrent renders give
 *  the second's numbers to both pollers. That is a wrong number rather than
 *  corruption; key it by output name the day it matters. */
let prog: { phase: "music" | "render"; file: string; total: number } | null = null;

/** How far the current render has got. Reads the progress file ON DEMAND,
 *  when the client polls, rather than on a timer — so there is no interval
 *  to leak and no lifecycle to get wrong. */
export function renderProgress(): { phase: "music" | "render"; done: number; total: number } {
  if (prog === null) return { phase: "render", done: 0, total: 0 };
  let done = 0;
  try {
    done = parseProgress(readFileSync(prog.file, "utf8"));
  } catch {
    // The file does not exist until ffmpeg's first block. Not an error.
    done = 0;
  }
  return { phase: prog.phase, done, total: prog.total };
}

/** Clears the slot. The route calls this in the same `finally` that sweeps
 *  the work directory, so a failed render does not leave the panel showing a
 *  frozen bar from a run that is over. */
export function clearProgress(): void {
  prog = null;
}
```

In `concatMusic`, after `probed` is computed and before the `run`:

```ts
  const total = probed.reduce((sum, p) => sum + p.seconds, 0);
  prog = { phase: "music", file: `${out}.progress`, total };
```

and add `"-progress", `${out}.progress`,` to its argument list, immediately
before `"-y"`.

In `renderLofi`, after `seconds` is probed:

```ts
  prog = { phase: "render", file: `${out}.progress`, total: seconds };
```

and add the same two arguments before `"-y"` in its `run` call.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run server/lofi.test.ts -t parseProgress`
Expected: PASS, 4 tests.

- [ ] **Step 5: Confirm a real render writes a readable file**

Run: `pnpm vitest run server/lofi.test.ts`
Expected: PASS. Then verify by hand that a rendered fixture left a
`<out>.progress` beside it during the run — add a temporary
`console.error(renderProgress())` inside one test, observe a non-zero `done`,
and remove it before committing. `console.error` is the allowed channel here.

- [ ] **Step 6: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add server/lofi.ts server/lofi.test.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: report lofi render progress from ffmpeg's own -progress file"
```

---

## Task 6: `/api/lofi` takes a track list, and `/api/lofi/progress`

**Files:**
- Modify: `server/index.ts` (the `/api/lofi` handler, from ~line 923; the route table near line 1236)
- Modify: `src/api.ts`

**Interfaces:**
- Consumes: `concatMusic`, `renderProgress`, `clearProgress` from `./lofi.ts`; `MAX_DROPS`, `MAX_TRACKS`, `MAX_SPEECHES` from `../src/defaults.ts`.
- Produces:
  - `/api/lofi` body: `music` is now `string[]`; `speeches` is now up to `MAX_DROPS` entries over at most `MAX_SPEECHES` distinct ids.
  - `/api/lofi/progress` → `{ phase, done, total }`. The spec calls this
    "a bare GET"; it is reached by a POST from `src/api.ts`, exactly as
    `/api/publish/progress` is. The server routes on `req.url` and never
    checks the method, so the spec's description is a harmless inaccuracy —
    follow the plan, which matches the shipped publish route.
  - `src/api.ts`: `lofi()` body's `music: string[]`; new `export async function lofiProgress(): Promise<{ phase: "music" | "render"; done: number; total: number }>`

- [ ] **Step 1: Replace the music validation**

In `/api/lofi`, replace:

```ts
    if (!isUploadId(raw.music)) return send(res, 400, { error: "Bad music id." });
    const musicPath = uploadPath(raw.music);
    if (!existsSync(musicPath)) {
      return send(res, 404, { error: "That music upload is no longer on disk." });
    }
```

with:

```ts
    // A LIST now, in play order — the client has already resolved the `1_`
    // pin and the shuffle, because the filename never crosses the wire.
    const tracks = raw.music;
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return send(res, 400, { error: "music must be a non-empty array of upload ids." });
    }
    if (tracks.length > MAX_TRACKS) {
      return send(res, 400, { error: `At most ${MAX_TRACKS} tracks.` });
    }
    const trackPaths: string[] = [];
    for (const id of tracks) {
      if (!isUploadId(id)) return send(res, 400, { error: "Bad music id." });
      const path = uploadPath(id);
      if (!existsSync(path)) {
        return send(res, 404, { error: "That music upload is no longer on disk." });
      }
      trackPaths.push(path);
    }
```

- [ ] **Step 2: Re-scope the two speech caps**

Replace:

```ts
    if (speeches.length > MAX_SPEECHES) {
      return send(res, 400, { error: `At most ${MAX_SPEECHES} speeches.` });
    }
```

with:

```ts
    // Two caps now, because a speech repeats: DROPS bound the filter graph's
    // legs and FILES bound its inputs. Checking only the first would let
    // eighty distinct uploads through under a 120-drop limit.
    if (speeches.length > MAX_DROPS) {
      return send(res, 400, { error: `At most ${MAX_DROPS} speech drops.` });
    }
```

and, after the `for (const entry of speeches)` loop that fills `cuts`:

```ts
    const distinct = new Set(cuts.map((c) => c.path));
    if (distinct.size > MAX_SPEECHES) {
      return send(res, 400, { error: `At most ${MAX_SPEECHES} speech files.` });
    }
```

- [ ] **Step 3: Run the concat inside the work dir, before probing**

The work directory is created further down (`const work = await mkdtemp(...)`).
**Move that `mkdtemp` above** the `probeAudio(musicPath)` call, then replace:

```ts
    const { seconds: musicLength } = await probeAudio(musicPath);
```

with:

```ts
    // The pre-pass. One track returns its own path and writes nothing, so
    // the single-track journey is byte-identical to what it was.
    const musicPath = await concatMusic(trackPaths, join(work, "music.flac"));
    // Probed from the file that will actually be rendered — NOT summed from
    // the tracks. That is what keeps "the duration is the music's, by
    // construction" true now that there are several of them.
    const { seconds: musicLength } = await probeAudio(musicPath);
```

- [ ] **Step 4: Clear the progress slot on the way out**

In the handler's existing `finally`, alongside the work-directory sweep, add:

```ts
      clearProgress();
```

- [ ] **Step 5: Add the poll route**

Beside the existing publish poll near line 1236:

```ts
  // A distinct URL rather than a flag: `server/index.ts` routes on exact
  // `req.url` equality, so `/api/lofi?progress=1` would miss the `/api/lofi`
  // branch entirely rather than reaching a flag inside it.
  if (req.url === "/api/lofi/progress") return send(res, 200, renderProgress());
```

- [ ] **Step 6: Update the client wrapper**

In `src/api.ts`, change `lofi()`'s body type — `music: string` becomes:

```ts
  /** The uploaded tracks IN PLAY ORDER. The client has already applied the
   *  `1_` pin and the shuffle, because the original filename never crosses
   *  this wire — the server sees ids and no names. */
  music: string[];
```

and append:

```ts
/** How far the running render has got. Polled while a lofi render is in
 *  flight; `total` of 0 means nothing is running.
 *
 *  A POST to a route that reads like a GET, exactly as `publishProgress` is —
 *  the server routes on `req.url` alone and never checks the method, and
 *  going through the shared `post` helper is what gives this the same
 *  BACKEND_DOWN handling every other call has. */
export async function lofiProgress(): Promise<{
  phase: "music" | "render";
  done: number;
  total: number;
}> {
  return (await post("/api/lofi/progress", {})).json() as Promise<{
    phase: "music" | "render";
    done: number;
    total: number;
  }>;
}
```

This mirrors `publishProgress` in the same file line for line. Do not write a
bare `fetch` here — nothing else in `src/api.ts` does.

- [ ] **Step 7: Verify the type gate and the suite**

Run: `pnpm build`
Expected: PASS — this is where a missed `music: string` call site surfaces.

Run: `pnpm test`
Expected: PASS. `src/main.ts` will still be calling `api.lofi` with a string;
fix that in Task 7 — if `pnpm build` fails here on exactly that, proceed to
Task 7 and re-run the gate at its end.

- [ ] **Step 8: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add server/index.ts src/api.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: take a track list on /api/lofi and expose render progress"
```

---

## Task 7: the panel — a track list, a spacing, a shuffle and a progress readout

**Files:**
- Modify: `src/state.ts`
- Modify: `src/state.test.ts`
- Modify: `src/main.ts` (`doPickMusic` ~1514, `place` ~1519, `doLofi` ~1626, the panel builder ~3135-3190)

**Interfaces:**
- Consumes: `orderByPrefix`, `fill` from `./lofi.ts`; `MAX_TRACKS`, `MAX_DROPS` from `./defaults.ts`; `api.lofiProgress`.
- Produces:
  - `export type UploadTrack = { id: string; name: string; seconds: number };` in
    `src/state.ts` — the same shape the old `music` field had inline, named
    now that it is an array element and two other modules refer to it.
  - state fields `tracks: UploadTrack[]` (replacing `music`) and
    `spacing: number`.

- [ ] **Step 1: Update the existing state test**

`src/state.test.ts` already has `describe("the lofi journey's state") > it("is
not persisted")` at around line 818, and it currently sets `music`. That field
is being removed, so this is an EDIT of that test rather than a new one —
leaving the old one would fail to compile once `music` is gone.

Replace its `music:` line with `tracks:` and add `spacing:`, then add the two
matching assertions:

```ts
  it("is not persisted", () => {
    setState({
      phase: "framing",
      videoId: "abc12345678",
      tracks: [
        { id: "11111111-1111-4111-8111-111111111111", name: "1_track.mp3", seconds: 200 },
      ],
      spacing: 300,
      bg: "/9j/base64",
      bgName: "bg.png",
      speeches: [{ id: "22222222-2222-4222-8222-222222222222", name: "a.mp4", seconds: 6 }],
      placements: [{ id: "22222222-2222-4222-8222-222222222222", at: 40 }],
    });
    save();
    const stored = readRaw("abc12345678") as Record<string, unknown>;
    expect(stored).not.toHaveProperty("tracks");
    expect(stored).not.toHaveProperty("spacing");
    expect(stored).not.toHaveProperty("bg");
    expect(stored).not.toHaveProperty("bgName");
    expect(stored).not.toHaveProperty("speeches");
    expect(stored).not.toHaveProperty("placements");
  });
```

`readRaw` is the helper that file already uses; do not reach into
`localStorage` directly.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/state.test.ts -t "track list"`
Expected: FAIL — `tracks` is not a field on `AppState`.

- [ ] **Step 3: Change the state shape**

In `src/state.ts`, add the element type above `AppState`:

```ts
/** One uploaded lofi music track. The same shape the single `music` field
 *  carried inline, named now that it is an array element. */
export type UploadTrack = { id: string; name: string; seconds: number };
```

then replace the `music` field with:

```ts
  /** The lofi journey's music tracks, IN PLAY ORDER — `orderByPrefix` has
   *  already put any `1_` file first and shuffled the rest. Empty until the
   *  first upload, which is what the panel's Render button is gated on.
   *
   *  NOT persisted, for the reason `parts` is not: each entry names an
   *  upload the user may have swept from `media/uploads/` by hand, and a
   *  restored id pointing at a file that is gone would look like a working
   *  panel right up until Render. */
  tracks: UploadTrack[];
  /** Seconds between speech drops, as the panel's minutes field resolved to
   *  seconds. 0 means the one-shot behaviour every render had before repeats
   *  existed — `fill` delegates straight to `troughs` for it.
   *
   *  NOT persisted, like every other lofi field. */
  spacing: number;
```

Set `tracks: []` and `spacing: 300` in the `initial` object where `music: null`
and the other lofi defaults are. Ensure neither name appears in `save()`'s
persisted record.

- [ ] **Step 4: Rework `doPickMusic` into an appending, ordering picker**

Replace `doPickMusic` in `src/main.ts`:

```ts
/** Uploads tracks and rebuilds the concatenated envelope.
 *
 *  The envelope is built PER TRACK and appended, never by decoding the whole
 *  timeline at once: `decodeTrack` resamples into an 8 kHz mono
 *  OfflineAudioContext and reduces straight to `BUCKETS_PER_SEC`, so one
 *  track at a time is a few MB where three hours in one go is not. Three
 *  hours reduces to about 43k floats.
 *
 *  `orderByPrefix` runs over the whole list on every add, so a `1_` file
 *  dropped in last still takes the front — and the shuffle is re-rolled,
 *  which is what the `↻ Shuffle` button also does. */
async function doPickMusic(files: File[]): Promise<void> {
  await guard("Reading the tracks…", async () => {
    const existing = getState().tracks;
    if (existing.length + files.length > MAX_TRACKS) {
      setState({
        error: `That's ${existing.length + files.length} tracks — the limit is ${MAX_TRACKS}.`,
      });
      return;
    }
    const added: UploadTrack[] = [];
    for (const file of files) {
      const { seconds } = await decodeTrack(file);
      const { id } = await api.upload(file, true);
      // Held so a re-order or a re-shuffle can rebuild the envelope without
      // re-uploading. A `File` handle does not survive a reload, which is
      // consistent with `tracks` itself not persisting.
      trackFiles.set(id, file);
      added.push({ id, name: file.name, seconds });
    }
    const tracks = orderByPrefix([...existing, ...added]);
    await rebuildLofiEnv(tracks);
    setState({ tracks, placements: [] });
    place();
  });
}

/** Decodes every track in play order and concatenates their envelopes into
 *  the module-scoped `lofiEnv`/`lofiSeconds` the placer and the strip read.
 *
 *  Re-decodes from scratch on every change rather than caching per id. The
 *  decode is the cheap part (8 kHz mono) and a cache keyed on a list that
 *  reorders is a second thing to keep in sync; `ponytail:` — key it by id the
 *  day a fifty-track list feels slow. */
async function rebuildLofiEnv(tracks: UploadTrack[]): Promise<void> {
  const parts: Float32Array[] = [];
  let total = 0;
  for (const track of tracks) {
    const file = trackFiles.get(track.id);
    if (file === undefined) continue;
    const { env, seconds } = await decodeTrack(file);
    parts.push(env);
    total += seconds;
  }
  const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    joined.set(p, at);
    at += p.length;
  }
  lofiEnv = joined;
  lofiSeconds = total;
}
```

Add a module-scoped `const trackFiles = new Map<string, File>();` beside
`lofiEnv`, populated in `doPickMusic` (`trackFiles.set(id, file)`) and cleared
where the phase is left. The `File` handles are what make a re-order cheap;
they do not survive a reload, which is consistent with the fields not
persisting.

- [ ] **Step 5: Point `place` at `fill`**

```ts
function place(): void {
  const s = getState();
  if (!lofiEnv || s.tracks.length === 0 || s.speeches.length === 0) {
    setState({ placements: [] });
    return;
  }
  // `fill` with a spacing of 0 IS `troughs`, so this one call covers both
  // the repeating case and the one-shot one.
  const found = fill(lofiEnv, lofiSeconds, orderByPrefix(s.speeches), s.spacing);
  if ("error" in found) {
    setState({ placements: [], error: found.error });
    return;
  }
  setState({ placements: found.placements, error: "" });
}
```

- [ ] **Step 6: Send the list and the spacing from `doLofi`**

In `doLofi`, replace the `music: s.music.id` field of the `api.lofi` body with
`music: s.tracks.map((t) => t.id)`, and relax the guard: `s.music === null`
becomes `s.tracks.length === 0`. Remove the
`s.placements.length !== s.speeches.length` check — with repeats the two
counts legitimately differ; replace it with `s.placements.length === 0`.

- [ ] **Step 7: Add the panel controls**

In the lofi panel builder, beside the existing speech row:

- `doPickMusic` now takes `File[]`, so its call site in the music row's
  `onchange` must pass `[...input.files]` rather than `input.files[0]`. The
  type gate catches this, but it is the one signature change in the task;
- the music row becomes a LIST with `multiple` on its file input, showing each
  track's name in play order and a `(1/N)` index, headed
  `Tracks (${s.tracks.length}/${MAX_TRACKS})`;
- a `↻ Shuffle` button calling
  `setState({ tracks: orderByPrefix(getState().tracks) })` then `place()`;
- a number field labelled `Speech every … min`, writing
  `setQuiet({ spacing: minutes * 60 })` and calling `place()` on `change`
  (not `input` — re-placing on every keystroke re-scores the whole envelope);
- a drops badge reading `${s.placements.length} drops`.

Use the existing `.bar-row` / `.field-grow` / `.btn-gray` recipes and the
Radix custom properties already in `style.css`. Do not introduce literals.

- [ ] **Step 8: Poll progress while rendering**

In `doLofi`, around the `api.lofi` call, start a poll:

```ts
  const poll = window.setInterval(() => {
    void api.lofiProgress().then((p) => {
      if (p.total > 0) {
        const pct = Math.min(100, Math.round((p.done / p.total) * 100));
        const what = p.phase === "music" ? "Joining tracks" : "Rendering";
        setState({ busy: `${what}… ${pct}%` });
      }
    }).catch(() => {
      // A failed poll is not a failed render. Staying quiet is right: the
      // render's own promise is what reports success or failure.
    });
  }, 2000);
```

and clear it with `window.clearInterval(poll)` in a `finally`.

`busy` is already `string` (`src/state.ts:31`, defaulting to `""`), which is
what `guard` writes its label into — so a percentage goes straight into it and
no new field is needed. Note this writes through `setState`, which re-renders
the bar each tick; that is the same cost `guard` already pays on entry and
exit, at one tick every two seconds.

- [ ] **Step 9: Verify**

Run: `pnpm build` — expected PASS (the type gate catches every missed `music`
call site).
Run: `pnpm test` — expected PASS.

- [ ] **Step 10: Verify by hand in a browser**

Start `pnpm server` and `pnpm dev`. Then:
1. Enter the lofi phase, add three short tracks, one named `1_first.mp3`.
2. Confirm the panel lists `1_first.mp3` at position 1 and the other two in
   some order; press `↻ Shuffle` and confirm positions 2 and 3 can swap while
   position 1 does not.
3. Add two speeches, set the spacing to 1 minute, confirm the drops badge
   shows more drops than speeches and that the strip's markers are spread.
4. Render. Confirm the busy text moves through `Joining tracks… n%` and then
   `Rendering… n%`.
5. Play the output in `preview` and confirm the speeches recur and the track
   seams are dips rather than hard cuts.

- [ ] **Step 11: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/state.ts src/state.test.ts src/main.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: a lofi track list, a speech spacing and a render progress readout"
```

---

## Task 8: the documentation this changes

**Files:**
- Modify: `CLAUDE.md`

No tests. This task exists because three of `CLAUDE.md`'s invariants describe
behaviour this plan changes, and a stale invariant is worse than a missing one.

- [ ] **Step 1: Amend the duration invariant**

Find "**The lofi render's duration is the music's, by construction — nothing
sums.**" and extend it: the music may now be several tracks, joined by
`concatMusic` into ONE file in the route's temp directory, and the route
probes that file. Nothing sums, still — state that the sum-the-lengths version
was rejected precisely because it would make `outName` disagree with the file.

- [ ] **Step 2: Amend the `MAX_SPEECHES` description**

In the architecture list and anywhere the cap is described, split files from
drops and name `MAX_DROPS` and `MAX_TRACKS`.

- [ ] **Step 3: Add the new invariants**

Three, in the "Invariants — breaking these is silent, not loud" section:

- **A single track skips the pre-pass, and that identity is load-bearing.**
  `concatMusic` returns `paths[0]` and writes nothing for one track, so the
  original journey pays no pass, no temp file and no new failure mode.
- **One ffmpeg input per unique speech FILE, `asplit` into its drops.** One
  input per drop puts 36 inputs on the graph for four recordings; the crackle
  leg already holds this shape and the speech legs now copy it.
- **`fill` reduces to `troughs` at spacing 0, and that is mutation-tested.**
  It is what keeps `src/lofi.test.ts`'s existing suite describing live
  behaviour.

- [ ] **Step 4: Add the spec to the reading list**

In the opening paragraph that chains the spec documents, add
`docs/specs/2026-09-21-vstack-lofi-longform-design.md`, noting it supersedes
nothing and extends the 2026-09-16 lofi spec.

- [ ] **Step 5: Note the unfixed loudness gap**

Under the lofi notes, record that the music leg carries no gain and every
`amix` is `normalize=0`, so tracks from different sources sit at different
levels — a real defect of the long render and equally of the short one, with
the `loudnorm`-in-the-pre-pass fix named as the upgrade path. `ponytail:`.

- [ ] **Step 6: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add CLAUDE.md
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "docs: record the long lofi journey's invariants"
```

---

## Done when

- `pnpm test` passes with roughly 445 tests (421 today, plus 6 + 10 client and 4 + 1 + 4 server).
- `pnpm build` is clean.
- The browser checks in Task 7 Step 10 all pass.
- A single-track render is byte-identical in behaviour to one made before this
  branch: no pre-pass, no `asplit`, the same graph.
