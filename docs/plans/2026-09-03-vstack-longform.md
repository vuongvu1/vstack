# Long-form output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second journey through vstack in which uploaded vertical
`.mp4` files are letterboxed onto blurred copies of themselves,
concatenated in a user-chosen order into one 1920×1080 video, and published
through the existing preview phase.

**Architecture:** A branch at `idle` that rejoins at `preview`. A new
`stacking` phase collects uploads and their order; `POST /api/upload`
streams each file into `media/uploads/<uuid>.mp4`; `POST /api/stack` runs a
single ffmpeg graph (`server/longform.ts`) that widens and concatenates in
one encode, and renames the result into `OUT_DIR` under a name today's
`OUT_NAME` regex already accepts — which is why `/out/`, `/api/reveal` and
`/api/publish` need no changes. Nothing on the short path changes.

**Tech Stack:** TypeScript run directly by Node's type stripping (no build
step on the server), zero runtime dependencies, `node:http`, ffmpeg/ffprobe
shelled out via `execFile`, vanilla-TS + Vite frontend, vitest.

**Spec:** `docs/specs/2026-09-03-vstack-longform-design.md`

**Branch:** `feat/longform` (already created — do not work on `main`).

## Global Constraints

Copied from `CLAUDE.md` and the spec. Every task's requirements implicitly
include these.

- **Node runs `server/*.ts` with type stripping.** Non-erasable TS syntax is
  a *boot crash*, not a compile error. No constructor parameter properties,
  no `enum`, no `namespace`. `tsconfig.json` sets `erasableSyntaxOnly: true`.
- **No `enum`, `namespace`, `any`, default exports, or barrel files.**
- **`import type` for type-only imports; explicit `.ts` extensions on every
  relative import.**
- **No `console.log` / `console.info`** — `console.error` / `console.warn`
  only.
- **`strict` and `noUncheckedIndexedAccess` are on.** Indexing yields
  `T | undefined`; guard with `?? fallback`, never `!`.
- **Zero runtime dependencies on the server.** Do not add a package for
  anything in this plan.
- **`ponytail:` comments mark deliberate simplifications** and name the
  upgrade path.
- **Visual values come from the `@radix-ui/colors` custom properties** and
  the hand-rolled token layer in `src/style.css` (`--radius-1..4`,
  `--space-1..6`, `--shadow-2/3`, `--control-height`). No fresh literals.
- **Server layering is strict and acyclic:** `errors ← {ffmpeg, starter,
  youtube, longform} ← {ytdlp, mask} ← index`. `longform.ts` sits *beside*
  `ffmpeg.ts` and may import `probeFile` from it, but must never import
  `mask.ts`, `ytdlp.ts` or `index.ts`.
- **`Bash(git add)`, `Bash(git commit *)` and `Bash(rm *)` are deny-listed
  in this environment.** Use `git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add …`
  and `git -C … commit …` (the prefix differs, so it passes), and Node's
  `fs.rm` instead of shell `rm`.
- **Commands:** `pnpm test` (vitest, currently 272 tests, shells real ffmpeg
  *and* real VieNeu-TTS), `pnpm build` (`tsc && vite build`), `pnpm server`,
  `pnpm dev`.
- **Output resolution is exactly 1920×1080.** Not configurable — every input
  is 1080×1920 and a knob with one legal value is not a knob.
- **Uploads land private and there is no option.** `privacyStatus:
  "private"` and `selfDeclaredMadeForKids: false` stay hardcoded.

## File Structure

**Create:**
- `server/longform.ts` — the widen-and-concat ffmpeg graph. One export,
  `stackWide`. Beside `ffmpeg.ts` in the layering.
- `server/longform.test.ts` — real-ffmpeg pixel assertions for that graph.

**Modify:**
- `server/ffmpeg.ts` — add `UPLOADS_DIR`, `uploadPath`, `isUploadId`.
- `server/index.ts` — add `POST /api/upload` and `POST /api/stack`; pass
  `shorts` through `/api/publish`.
- `server/youtube.ts` — `buildSnippet` gains an optional `shorts` flag.
- `server/youtube.test.ts` — cover both flag values.
- `server/ffmpeg.test.ts` — cover `isUploadId`.
- `src/defaults.ts` — add `LONG_DESCRIPTION_TEMPLATE`, `LONG_TAGS_DEFAULT`.
- `src/defaults.test.ts` — cover them.
- `src/state.ts` — add `mode` and `parts`; export `UploadPart`.
- `src/state.test.ts` — cover the new fields' persistence behaviour.
- `src/api.ts` — add `upload` and `stack`; extract a shared `send`; add
  `shorts` to `publish`.
- `src/main.ts` — the idle entry point, the whole `stacking` phase, and the
  `preview` phase's mode branches.
- `src/style.css` — `.stack-panel`, `.stack-row`, and `.out.is-wide`.
- `CLAUDE.md` — document the new spec, routes, module, directory and
  invariants.

**Deliberate deviation from the spec, discovered while planning:** the spec
calls for three new `defaults.ts` constants and a `mode` parameter on
`defaultTitle`. Only **two** constants are needed. `TITLE_HASHTAGS` contains
no shorts tag at all (`#vtubervn #vtubervietnam #habine #siini #sim`), so
the title is already correct for long form and `defaultTitle` needs no
parameter. Only `DESCRIPTION_TEMPLATE` (`#shorts`) and `TAGS_DEFAULT`
(`shorts`) carry one. Adding a third constant duplicating a string that
needs no change would be two knobs where one is correct.

---

### Task 1: `stackWide` — the widen-and-concat graph

**Files:**
- Create: `server/longform.ts`
- Test: `server/longform.test.ts`

**Interfaces:**
- Consumes: `probeFile` and `toolError` from `server/ffmpeg.ts` /
  `server/errors.ts` (both already exported).
- Produces: `stackWide(paths: string[], out: string): Promise<string>` —
  resolves to `out`. Task 3 calls it.

- [ ] **Step 1: Write the failing test**

Create `server/longform.test.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeFile } from "./ffmpeg.ts";
import { stackWide } from "./longform.ts";

const run = promisify(execFile);

let dir = "";
let red = "";
let blue = "";
let wide = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vstack-long-"));

  // Two 1080x1920 vertical parts in different colours, both with audio. The
  // colours are what make the leg ORDER testable: reversing the concat gives
  // blue-then-red and the second sample fails.
  red = join(dir, "red.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=red:s=1080x1920:d=2:r=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-y", red,
  ]);

  // Deliberately silent: the anullsrc stand-in is exercised by the first
  // test rather than by one of its own, because a missing audio leg makes
  // the concat filter's leg count disagree with n= and fail outright.
  blue = join(dir, "blue.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=blue:s=1080x1920:d=2:r=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-y", blue,
  ]);

  // A 16:9 part, to prove an upload that is NOT vertical still lands inside
  // the frame rather than overflowing it.
  wide = join(dir, "wide.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=green:s=1920x1080:d=2:r=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-y", wide,
  ]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** One frame at `t`, decoded to raw RGB, sampled at (x, y). Thresholds
 *  rather than equality everywhere it is used: libx264 is lossy, so a solid
 *  red source frame comes back at r=254 rather than r=255. */
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

describe("stackWide", () => {
  it("widens two vertical parts onto their own blurred backgrounds, in order", async () => {
    const out = join(dir, "stack.mp4");
    await stackWide([red, blue], out);

    const probed = await probeFile(out);
    expect(probed.width).toBe(1920);
    expect(probed.height).toBe(1080);
    expect(probed.seconds).toBeGreaterThan(3.5);
    expect(probed.seconds).toBeLessThan(4.5);
    // The second part is silent, so this is also the anullsrc stand-in's
    // assertion: without it the concat filter's leg count disagrees with n=.
    expect(probed.hasAudio).toBe(true);

    // Centre of the frame is the letterboxed foreground at full saturation.
    const early = await pixelAt(out, 1, 960, 540);
    expect(early.r).toBeGreaterThan(150);
    expect(early.g).toBeLessThan(80);
    expect(early.b).toBeLessThan(80);

    // ORDER. Reversing stackWide's legs gives blue here and fails.
    const late = await pixelAt(out, 3, 960, 540);
    expect(late.b).toBeGreaterThan(150);
    expect(late.r).toBeLessThan(80);
    expect(late.g).toBeLessThan(80);

    // A 1080x1920 part fits 1920x1080 as 608x1080 centred, so x=20 is
    // background. NOT BLACK is the whole point: if the blur leg were
    // dropped the graph would pillarbox and these would all be near zero.
    // Each edge carrying its OWN part's colour is what proves the
    // background tracks the part it belongs to rather than being shared.
    const edgeEarly = await pixelAt(out, 1, 20, 540);
    expect(edgeEarly.r).toBeGreaterThan(80);

    const edgeLate = await pixelAt(out, 3, 20, 540);
    expect(edgeLate.b).toBeGreaterThan(80);
  }, 120_000);

  it("fits a part that is not vertical instead of overflowing the frame", async () => {
    const out = join(dir, "mixed.mp4");
    await stackWide([red, wide], out);

    const probed = await probeFile(out);
    expect(probed.width).toBe(1920);
    expect(probed.height).toBe(1080);

    // A 16:9 part fills the frame edge to edge, so the centre is its colour.
    const mid = await pixelAt(out, 3, 960, 540);
    expect(mid.g).toBeGreaterThan(100);
    expect(mid.r).toBeLessThan(90);
  }, 120_000);

  it("refuses an empty part list", async () => {
    await expect(stackWide([], join(dir, "never.mp4"))).rejects.toThrow(/at least one/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run server/longform.test.ts`
Expected: FAIL — `Failed to load url ./longform.ts` (the module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `server/longform.ts`:

```ts
/** The long-form journey's one ffmpeg pass.
 *
 *  Sits BESIDE `ffmpeg.ts` rather than above it: it takes an output path
 *  from the caller and never needs `MEDIA_DIR` or `OUT_DIR`, the same
 *  posture `starter.ts` and `youtube.ts` already hold. It may read
 *  `probeFile`, and nothing else. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toolError } from "./errors.ts";
import { probeFile } from "./ffmpeg.ts";

const run = promisify(execFile);

/** YouTube's long-form shape, and not configurable: every input this feature
 *  takes is a 1080x1920 short, so a knob here would have one legal value. */
export const WIDE = { w: 1920, h: 1080 };

/** The blur is computed at 480x270 and stretched back up sixteenfold, and
 *  that stretch supplies most of the softening on its own — which is why
 *  this is 12 where `starter.ts`'s own BLUR_SIGMA is 30. Deliberately NOT
 *  imported from there: the two blur different things at different scales,
 *  and one shared constant would make tuning either one move the other.
 *
 *  Do not "improve" this by blurring at full resolution. A 1080x1920 source
 *  scaled to COVER 1920x1080 is 1920x3413, and gblur over that costs roughly
 *  fifty times what it costs here — for a picture whose entire purpose is to
 *  be out of focus. */
const BLUR_SIGMA = 12;
const BG_W = 480;
const BG_H = 270;

const FPS = 30;
const RATE = 44100;
/** The same crf `exportClip` uses. Unlike `concatClips` this is not an
 *  intermediate — it is the product — so there is no later generation to
 *  keep headroom for. */
const CRF = "20";

/** Letterboxes each part onto a blurred copy of itself and concatenates the
 *  lot into one 1920x1080 file, in ONE encode.
 *
 *  Every leg is normalised before `concat` sees it, for the same reason
 *  `concatClips` and `prependStarter` do it: `concat` REFUSES a mismatch
 *  rather than picking a side, and a SAR difference fails with `Nothing was
 *  written into output file`, which names nothing.
 *
 *  Two scale choices are load-bearing:
 *
 *  - The background is `increase` + `crop`, so it fills the frame edge to
 *    edge with no black anywhere.
 *  - The foreground is `decrease` + `force_divisible_by=2`, so a part that
 *    is NOT vertical fits inside the frame instead of overflowing it. An
 *    upload is any file the user picked; only the common case is 9:16.
 *
 *  A part with no audio gets a leg cut from a shared `anullsrc` input,
 *  appended LAST so the real parts' input indices never move — the same
 *  positional rule `concatClips` follows. */
export async function stackWide(paths: string[], out: string): Promise<string> {
  if (paths.length === 0) throw new Error("stackWide needs at least one part.");

  const probed = await Promise.all(paths.map((p) => probeFile(p)));
  const anySilent = probed.some((p) => !p.hasAudio);
  const silenceIndex = paths.length;

  const inputs: string[] = [];
  for (const path of paths) inputs.push("-i", path);
  if (anySilent) {
    inputs.push("-f", "lavfi", "-i", `anullsrc=r=${RATE}:cl=stereo`);
  }

  const legs: string[] = [];
  const labels: string[] = [];
  paths.forEach((_, i) => {
    const p = probed[i];
    const hasAudio = p?.hasAudio === true;
    const seconds = p?.seconds ?? 0;
    legs.push(
      `[${i}:v]split=2[bg${i}][fg${i}]`,
      `[bg${i}]scale=${BG_W}:${BG_H}:force_original_aspect_ratio=increase,` +
        `crop=${BG_W}:${BG_H},gblur=sigma=${BLUR_SIGMA},` +
        `scale=${WIDE.w}:${WIDE.h},setsar=1[bgz${i}]`,
      `[fg${i}]scale=${WIDE.w}:${WIDE.h}:force_original_aspect_ratio=decrease:` +
        `force_divisible_by=2,setsar=1[fgz${i}]`,
      `[bgz${i}][fgz${i}]overlay=(W-w)/2:(H-h)/2,fps=${FPS},` +
        `setpts=PTS-STARTPTS,format=yuv420p[v${i}]`,
    );
    // A silent part's leg is cut out of the shared anullsrc instead, trimmed
    // to this part's own length so the two streams stay in step.
    const audioSrc = hasAudio ? `${i}:a` : `${silenceIndex}:a`;
    legs.push(
      `[${audioSrc}]atrim=0:${seconds},asetpts=PTS-STARTPTS,aresample=${RATE},` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`,
    );
    labels.push(`[v${i}][a${i}]`);
  });
  legs.push(`${labels.join("")}concat=n=${paths.length}:v=1:a=1[v][a]`);

  try {
    await run(
      "ffmpeg",
      [
        "-v", "error",
        ...inputs,
        "-filter_complex", legs.join(";"),
        "-map", "[v]",
        "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", CRF,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run server/longform.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Mutation-test the leg order**

Temporarily reverse the concat order by changing `labels.push(...)` to
`labels.unshift(\`[v${i}][a${i}]\`)`.

Run: `pnpm vitest run server/longform.test.ts`
Expected: FAIL on the `late` blue sample in test 1. Revert the change and
confirm PASS again. Do not commit the mutation.

- [ ] **Step 6: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add server/longform.ts server/longform.test.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: stackWide widens and concatenates parts in one pass

Letterboxes each vertical part onto a blurred copy of itself and
concatenates into one 1920x1080 file. The blur is computed at 480x270 and
stretched back up — blurring the 1920x3413 cover-scaled intermediate costs
~50x more for a picture that is meant to be out of focus.

The foreground scales with decrease + force_divisible_by=2 so a part that
is not vertical fits inside the frame instead of overflowing it; an upload
is any file the user picked.

Leg order is mutation-tested: reversing the concat fails the second half's
colour sample.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Upload storage helpers

**Files:**
- Modify: `server/ffmpeg.ts` (add three exports near `clipPath`)
- Test: `server/ffmpeg.test.ts` (new `describe("isUploadId")`)

**Interfaces:**
- Consumes: `MEDIA_DIR` (already in `server/ffmpeg.ts`).
- Produces: `UPLOADS_DIR: string`, `uploadPath(id: string): string`,
  `isUploadId(id: unknown): id is string`. Task 3 uses all three.

- [ ] **Step 1: Write the failing test**

Add to `server/ffmpeg.test.ts`, after the existing `describe("isOutName")`
block. Also add `UPLOADS_DIR`, `isUploadId` and `uploadPath` to the existing
`import { … } from "./ffmpeg.ts"` list at the top of that file.

```ts
describe("isUploadId", () => {
  // The gate on the /media/uploads side of the API. Given the same
  // exhaustive treatment `isOutName` and `videoIdFrom` get: it decides
  // whether a client-supplied string becomes a path handed to ffmpeg.
  it("accepts what randomUUID emits", () => {
    expect(isUploadId(randomUUID())).toBe(true);
    expect(isUploadId("f81d4fae-7dec-41d0-a765-00a0c91e6bf6")).toBe(true);
  });

  it("rejects traversal, absolute paths and separators", () => {
    expect(isUploadId("../../etc/passwd")).toBe(false);
    expect(isUploadId("/etc/passwd")).toBe(false);
    expect(isUploadId("f81d4fae-7dec-41d0-a765-00a0c91e6bf6/../x")).toBe(false);
    expect(isUploadId("f81d4fae\\7dec\\41d0\\a765\\00a0c91e6bf6")).toBe(false);
  });

  it("rejects the wrong shape, the wrong alphabet and the wrong case", () => {
    expect(isUploadId("")).toBe(false);
    expect(isUploadId("f81d4fae7dec41d0a76500a0c91e6bf6")).toBe(false);
    expect(isUploadId("f81d4fae-7dec-41d0-a765-00a0c91e6bf")).toBe(false);
    expect(isUploadId("f81d4fae-7dec-41d0-a765-00a0c91e6bf67")).toBe(false);
    expect(isUploadId("F81D4FAE-7DEC-41D0-A765-00A0C91E6BF6")).toBe(false);
    expect(isUploadId("g81d4fae-7dec-41d0-a765-00a0c91e6bf6")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isUploadId(undefined)).toBe(false);
    expect(isUploadId(null)).toBe(false);
    expect(isUploadId(42)).toBe(false);
    expect(isUploadId(["f81d4fae-7dec-41d0-a765-00a0c91e6bf6"])).toBe(false);
  });

  it("builds a path inside UPLOADS_DIR", () => {
    const id = randomUUID();
    expect(uploadPath(id)).toBe(join(UPLOADS_DIR, `${id}.mp4`));
  });
});
```

Add `import { randomUUID } from "node:crypto";` to that test file's imports
if it is not already there.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run server/ffmpeg.test.ts -t isUploadId`
Expected: FAIL — `isUploadId is not exported by ./ffmpeg.ts`.

- [ ] **Step 3: Write the implementation**

Add to `server/ffmpeg.ts`, immediately after the `clipPath` function:

```ts
/** Files the user uploaded for a long-form stack.
 *
 *  Under MEDIA_DIR so `reportCache` counts them for free, but at the top
 *  level rather than inside a `<videoId>/` directory — these have no video
 *  id, and `listClips` walks per-video directories and matches CLIP_RE, so
 *  it can never offer one of these as a clip.
 *
 *  Grows without eviction, exactly as `media/` and OUT_DIR already do.
 *  Deliberate: re-rendering a stack after a title fix must not mean
 *  re-uploading a gigabyte.
 *  ponytail: no eviction. Add an LRU here the day it gets annoying. */
export const UPLOADS_DIR = join(MEDIA_DIR, "uploads");

export function uploadPath(id: string): string {
  return join(UPLOADS_DIR, `${id}.mp4`);
}

/** Exactly what `randomUUID` emits, lowercase.
 *
 *  The gate on the `/media/uploads` side of this API — the counterpart to
 *  `isOutName` on the `/out/` side and to `/api/export`'s eight-hex
 *  `digest`. It is the strictest of the three, and can afford to be: the
 *  server minted the id itself, so a client has nothing legitimate to send
 *  here that this does not match. No slash, no dot-dot, no backslash, no
 *  absolute path, no uppercase and no non-hex survives it.
 *
 *  Takes `unknown` for the same reason `isOutName` does: it is called on a
 *  raw request-body field, and a `string` annotation there would be a
 *  compile-time claim about a value that arrives from the wire. */
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUploadId(id: unknown): id is string {
  return typeof id === "string" && UPLOAD_ID.test(id);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run server/ffmpeg.test.ts`
Expected: PASS — the whole file, including the pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add server/ffmpeg.ts server/ffmpeg.test.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: upload storage helpers under media/uploads

UPLOADS_DIR, uploadPath and isUploadId. The id pattern is exactly what
randomUUID emits and nothing else — the strictest of this API's three
client-string gates, because the server minted the id itself and a client
has nothing legitimate to send that this rejects.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `POST /api/upload` and `POST /api/stack`

**Files:**
- Modify: `server/index.ts`
- Modify: `src/defaults.ts` (one shared constant — the size cap)

**Interfaces:**
- Consumes: `stackWide` (Task 1); `UPLOADS_DIR`, `uploadPath`, `isUploadId`
  (Task 2); `probeFile`, `outName`, `outPath`, `OUT_DIR`, `readTitle`,
  `inFlight`, `send`, `json`, `HttpError` (all existing).
- Produces: two HTTP routes.
  - `POST /api/upload` — body is raw `video/mp4` bytes. Answers
    `{ id: string; duration: number; width: number; height: number }`.
  - `POST /api/stack` — body `{ ids: string[]; title: string }`. Answers
    `{ name: string; url: string; size: number; duration: number }`.
  Task 7 wraps both.

**No unit tests.** This matches the existing posture exactly: `/api/export`,
`/api/publish`, `/api/reveal` and `/api/window` have no route-level tests
either — the logic they call is tested, the HTTP plumbing is verified by
hand. Step 6 below is that verification, and it is not optional.

- [ ] **Step 1: Add the shared size cap to `src/defaults.ts`**

Append to `src/defaults.ts`:

```ts
/** The largest file `/api/upload` will take, in bytes.
 *
 *  Lives here rather than in the server because BOTH sides need it: the
 *  client refuses an oversized file before sending a byte (so the user gets
 *  a sentence instead of a dead connection), and the server enforces it
 *  anyway as the actual boundary. `defaults.ts` is already the shared
 *  client/server module — `server/youtube.ts` imports `YT_TITLE_MAX` from
 *  it — and this is exactly the kind of value that gets edited by hand.
 *
 *  512 MB is roughly a 20-minute 1080p short at this app's own bitrate,
 *  which is far past anything this feature is for. */
export const UPLOAD_MAX_BYTES = 512 << 20;

/** How many parts one stack may hold. A cap rather than no cap because
 *  `stackWide` opens every part as a simultaneous ffmpeg input, and the
 *  filter graph grows five legs per part. */
export const MAX_PARTS = 20;
```

- [ ] **Step 2: Add `/api/upload` to `server/index.ts`**

First extend the imports at the top of the file:

```ts
import { createWriteStream, existsSync, statSync, unlinkSync, createReadStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MAX_PARTS, UPLOAD_MAX_BYTES } from "../src/defaults.ts";
import { stackWide } from "./longform.ts";
```

and add `UPLOADS_DIR`, `isUploadId`, `uploadPath` to the existing
`from "./ffmpeg.ts"` import list.

Then insert this route immediately before the `if (req.url === "/api/reveal")`
block:

```ts
  // The first route in this server that takes BYTES rather than JSON, and
  // deliberately raw ones: `multipart/form-data` would mean hand-rolling a
  // boundary parser (a bug farm) or taking a dependency (this server has
  // none), and buys nothing for a single file over loopback.
  //
  // Note what is NOT here: the original filename. The client keeps it for
  // display and the server's handle is the UUID it minted itself, so unlike
  // `isOutName` and `/api/export`'s `digest` there is no client-supplied
  // path component to validate on the way IN at all.
  if (req.url === "/api/upload") {
    await mkdir(UPLOADS_DIR, { recursive: true });
    const id = randomUUID();
    const final = uploadPath(id);
    // The id is already unique, so the partial needs no second UUID the way
    // an export's does — `outName` is deterministic and can collide, this
    // cannot. The `.part` suffix is still the same lesson: a half-written
    // file must never sit under the name a later request can ask for.
    const partial = join(UPLOADS_DIR, `${id}.part.mp4`);
    inFlight.add(partial);
    let tooBig = false;
    try {
      let seen = 0;
      // Counted in a Transform IN the pipeline, never in a `req.on("data")`
      // listener: attaching one of those switches the request into flowing
      // mode before `pipeline` has piped it anywhere, and the first chunks
      // go on the floor. A truncated upload that still probes is the worst
      // possible failure here — it would render, and only the tail would be
      // missing.
      const cap = new Transform({
        transform(chunk: Buffer, _enc, done) {
          seen += chunk.length;
          if (seen > UPLOAD_MAX_BYTES) {
            // Erroring the pipeline destroys the request with it. Failing
            // rather than answering politely is the point: a polite reply
            // means having read the whole body first, which is the cost the
            // cap exists to avoid. The client checks `UPLOAD_MAX_BYTES`
            // before sending, so this is the backstop, not the message.
            tooBig = true;
            done(new Error("upload exceeds UPLOAD_MAX_BYTES"));
            return;
          }
          done(null, chunk);
        },
      });
      await pipeline(req, cap, createWriteStream(partial));
      // THE TRUST BOUNDARY. Nothing else inspects these bytes, and nothing
      // needs to — ffmpeg is their only consumer, so "ffprobe understands
      // it" is exactly the property that matters.
      const probed = await probeFile(partial);
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
    } catch (err) {
      if (tooBig) {
        // The socket is already gone; there is nothing to answer on.
        console.warn(`vstack: refused an upload over ${UPLOAD_MAX_BYTES} bytes`);
        return;
      }
      throw new HttpError(400, `That file is not video ffmpeg can read: ${
        err instanceof Error ? err.message : String(err)
      }`);
    } finally {
      inFlight.delete(partial);
      // force:true suppresses ENOENT, which is the success path — the
      // rename already took the partial away. A throwing finally would
      // escape this route entirely, so it swallows its own errors.
      await rm(partial, { force: true }).catch((err: unknown) => {
        console.error("vstack: upload partial cleanup failed:", err);
      });
    }
  }
```

- [ ] **Step 3: Add `/api/stack` to `server/index.ts`**

Insert immediately after the `/api/upload` block:

```ts
  // The long-form render. Takes ids, never paths: `uploadPath` builds the
  // path from an id `isUploadId` has already reduced to 36 hex-and-dash
  // characters.
  if (req.url === "/api/stack") {
    const raw = await json<Record<string, unknown>>(req);
    const title = readTitle(raw.title, "title");
    const ids = raw.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return send(res, 400, { error: "ids must be a non-empty array." });
    }
    if (ids.length > MAX_PARTS) {
      return send(res, 400, { error: `At most ${MAX_PARTS} parts.` });
    }
    if (!ids.every(isUploadId)) return send(res, 400, { error: "Bad upload id." });
    const paths = ids.map(uploadPath);
    const missing = paths.find((p) => !existsSync(p));
    if (missing !== undefined) {
      return send(res, 404, { error: "One of those uploads is no longer on disk." });
    }

    const probed = await Promise.all(paths.map((p) => probeFile(p)));
    // Ceiled, so the name is stable and integral the way every other name
    // this app writes is. NOT segments.ts's `totalDuration`, which sums
    // source-timeline segments and has nothing to do with this path despite
    // the matching shape.
    const total = Math.ceil(probed.reduce((sum, p) => sum + p.seconds, 0));

    await mkdir(OUT_DIR, { recursive: true });
    // Marks of 0 and the total: `outName` emits `<slug>-0000-<mmss>.mp4`,
    // which today's OUT_NAME regex already accepts. That is the whole
    // reason /out/, /api/reveal and /api/publish need no changes — as far
    // as they can tell this is an ordinary export.
    const name = outName(title, 0, total);
    const out = join(OUT_DIR, name);
    const partial = out.replace(/\.mp4$/, `.${randomUUID()}.part.mp4`);

    inFlight.add(partial);
    try {
      await stackWide(paths, partial);
      await rename(partial, out);
      // No `.jpg` still beside it, unlike an export: that file exists for
      // Studio's *Shorts* thumbnail slot, and a 16:9 video has no such slot.
      //
      // ponytail: no `prev` sweep either. A long-form name varies only in
      // the title and the total, so a re-render after a reorder produces the
      // SAME name and overwrites itself; only a title edit strands a file.
      // Add `prev` (four lines, `isOutName` unchanged) if that gets annoying.
      const { size, mtimeMs } = statSync(out);
      console.warn(`vstack: stacked out/${name} (${Math.round(size / 1e6)} MB)`);
      return send(res, 200, {
        name,
        // The mtime is load-bearing for the same reason it is on /api/export:
        // the name is stable across re-renders, so without a cache-buster the
        // <video> re-shows the previous render and a reorder looks like it
        // did nothing.
        url: `/out/${name}?t=${Math.round(mtimeMs)}`,
        size,
        duration: total,
      });
    } finally {
      inFlight.delete(partial);
      await rm(partial, { force: true }).catch((err: unknown) => {
        console.error("vstack: stack partial cleanup failed:", err);
      });
    }
  }
```

- [ ] **Step 4: Verify the server still boots**

Run: `pnpm build`
Expected: PASS — `tsc` clean. This is the gate that catches non-erasable TS
syntax before the server crashes at boot.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm test`
Expected: PASS, no regressions.

- [ ] **Step 6: Verify both routes by hand**

Start the server in one terminal (`pnpm server`), then:

```bash
# Make a 2-second vertical test clip.
ffmpeg -v error -f lavfi -i color=c=red:s=1080x1920:d=2:r=30 \
  -f lavfi -i sine=frequency=440:duration=2 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -y /tmp/part1.mp4
ffmpeg -v error -f lavfi -i color=c=blue:s=1080x1920:d=2:r=30 \
  -f lavfi -i sine=frequency=660:duration=2 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -y /tmp/part2.mp4

# Upload both. Each prints {"id":"…","duration":2,"width":1080,"height":1920}.
curl -s -X POST --data-binary @/tmp/part1.mp4 \
  -H 'content-type: video/mp4' http://127.0.0.1:8787/api/upload
curl -s -X POST --data-binary @/tmp/part2.mp4 \
  -H 'content-type: video/mp4' http://127.0.0.1:8787/api/upload

# Stack them, substituting the two ids.
curl -s -X POST -H 'content-type: application/json' \
  -d '{"ids":["<ID1>","<ID2>"],"title":"Tổng hợp"}' \
  http://127.0.0.1:8787/api/stack

# Confirm the shape and that it is servable.
ffprobe -v error -show_entries stream=width,height -of json ~/Desktop/vstack/tong-hop-0000-0004.mp4
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8787/out/tong-hop-0000-0004.mp4'

# And that a junk upload is refused rather than stored.
echo 'not a video' | curl -s -X POST --data-binary @- \
  -H 'content-type: video/mp4' http://127.0.0.1:8787/api/upload
```

Expected: 1920×1080 from ffprobe, `200` from the `/out/` request, and a
`400` with a readable message from the junk upload. Confirm
`media/uploads/` holds exactly two `.mp4` files and no `.part.mp4`.

- [ ] **Step 7: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add server/index.ts src/defaults.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: /api/upload and /api/stack

Upload takes raw video/mp4 bytes rather than multipart — a boundary parser
is a bug farm and a dependency is not on the table, and neither buys
anything for one file over loopback. The original filename never reaches
the server, so there is no client-supplied path component to validate on
the way in; ffprobe understanding the bytes is the trust boundary.

Stack names its output with marks of 0 and the ceiled total, which today's
OUT_NAME regex already accepts — so /out/, /api/reveal and /api/publish
need no changes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `buildSnippet` stops forcing `#Shorts`

**Files:**
- Modify: `server/youtube.ts:155-190`
- Modify: `server/index.ts` (the `/api/publish` block)
- Test: `server/youtube.test.ts`

**Interfaces:**
- Produces: `SnippetInput` gains `shorts?: boolean`, defaulting to `true`.
  `/api/publish` reads `body.shorts`, defaulting to `true`. Task 7 sends it.

This is a bug fix as much as a feature: a twenty-minute compilation
carrying `#Shorts` is misfiled by YouTube at the platform level.

- [ ] **Step 1: Write the failing test**

Add to `server/youtube.test.ts`:

```ts
describe("buildSnippet's shorts flag", () => {
  it("leaves the description alone when shorts is false", () => {
    const { snippet } = buildSnippet({
      title: "Tổng hợp",
      description: "Xem thêm ở đây",
      tags: "vtuber",
      shorts: false,
    });
    expect(snippet.description).toBe("Xem thêm ở đây");
    expect(snippet.description).not.toMatch(/#shorts/i);
  });

  it("still appends #Shorts when shorts is true", () => {
    const { snippet } = buildSnippet({
      title: "Ăn cơm chưa",
      description: "Xem thêm ở đây",
      tags: "vtuber",
      shorts: true,
    });
    expect(snippet.description).toBe("Xem thêm ở đây\n\n#Shorts");
  });

  it("defaults to appending, so a body written before this field still works", () => {
    const { snippet } = buildSnippet({
      title: "Ăn cơm chưa",
      description: "Xem thêm ở đây",
      tags: "vtuber",
    });
    expect(snippet.description).toBe("Xem thêm ở đây\n\n#Shorts");
  });

  it("does not append to an empty description when shorts is false", () => {
    // The true branch turns "" into "#Shorts"; the false branch must leave
    // it empty rather than producing a lone newline pair.
    const { snippet } = buildSnippet({
      title: "Tổng hợp",
      description: "",
      tags: "",
      shorts: false,
    });
    expect(snippet.description).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run server/youtube.test.ts`
Expected: FAIL — the first test gets `"Xem thêm ở đây\n\n#Shorts"`, and
`tsc` would reject the `shorts` property (vitest does not typecheck, so the
failure is the assertion).

- [ ] **Step 3: Write the implementation**

In `server/youtube.ts`, change the type and the function:

```ts
export type SnippetInput = {
  title: string;
  description: string;
  tags: string;
  /** Whether to guarantee a `#shorts` tag in the description.
   *
   *  Optional and defaulting to TRUE, so every existing caller, every test
   *  and every request body written before this field existed behaves
   *  exactly as it did.
   *
   *  It is false for exactly one thing: the long-form stack. `#shorts` is
   *  what tells YouTube to classify an upload as a Short, and a
   *  twenty-minute compilation carrying it is misfiled at the platform
   *  level — which is not a cosmetic difference, and not something the
   *  uploader can undo from Studio. */
  shorts?: boolean;
};
```

```ts
export function buildSnippet(input: SnippetInput): VideoResource {
  const description = input.description.trim();
  const shorts = input.shorts ?? true;
  return {
    snippet: {
      title: input.title.trim().slice(0, YT_TITLE_MAX),
      // Case-insensitive, and only when absent: a user who typed the tag
      // themselves must not get it twice. And only when this upload IS a
      // short — see SnippetInput.shorts.
      description:
        !shorts || /#shorts\b/i.test(description)
          ? description
          : `${description === "" ? "" : `${description}\n\n`}${SHORTS}`,
      tags: input.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== ""),
      categoryId: CATEGORY,
    },
    status: {
      privacyStatus: "private",
      // Required by the API — an upload without it is rejected.
      selfDeclaredMadeForKids: false,
    },
  };
}
```

- [ ] **Step 4: Pass the flag through `/api/publish`**

In `server/index.ts`, inside the `/api/publish` block, change the
`buildSnippet` call:

```ts
    const video = buildSnippet({
      title: str(body.title, "title"),
      description: str(body.description, "description"),
      tags: str(body.tags, "tags"),
      // Absent and `true` both mean "this is a short", so a body from a
      // client that predates this field publishes exactly as it used to.
      // Only an explicit `false` turns the tag off.
      shorts: body.shorts !== false,
    });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run server/youtube.test.ts`
Expected: PASS — the four new tests and every pre-existing one, including
the `TAGS_DEFAULT` and `DESCRIPTION_TEMPLATE` cases.

- [ ] **Step 6: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add server/youtube.ts server/youtube.test.ts server/index.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "fix: buildSnippet stops forcing #Shorts onto every upload

#shorts is what tells YouTube to classify an upload as a Short, so a
long-form compilation carrying it is misfiled at the platform level — and
the uploader cannot undo that from Studio.

The flag is optional and defaults to true, so every existing caller, test
and request body behaves exactly as before; only an explicit false turns
the tag off.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Long-form publish defaults

**Files:**
- Modify: `src/defaults.ts`
- Test: `src/defaults.test.ts`

**Interfaces:**
- Produces: `LONG_DESCRIPTION_TEMPLATE: string`, `LONG_TAGS_DEFAULT: string`.
  Task 9 uses both.

`TITLE_HASHTAGS` needs no long-form twin — it carries no shorts tag
(`#vtubervn #vtubervietnam #habine #siini #sim`), so it is already correct
for both journeys, and `defaultTitle` needs no `mode` parameter. Only the
description and the tag list mention shorts.

- [ ] **Step 1: Write the failing test**

Add to `src/defaults.test.ts`:

```ts
describe("the long-form defaults", () => {
  // buildSnippet with shorts:false does not append, so the template is the
  // whole description — a shorts tag left in here would ship in the upload
  // and misfile a twenty-minute video as a Short.
  it("carries no shorts tag anywhere", () => {
    expect(LONG_DESCRIPTION_TEMPLATE).not.toMatch(/#shorts\b/i);
    expect(LONG_TAGS_DEFAULT).not.toMatch(/\bshorts\b/i);
  });

  it("still carries the channel's own tags and links", () => {
    expect(LONG_DESCRIPTION_TEMPLATE).toMatch(/#vtubervn\b/);
    expect(LONG_DESCRIPTION_TEMPLATE).toContain("youtube.com/@habine03");
  });

  // buildSnippet splits on commas and trims, so a "#" here would ship a
  // literal "#vtuber" as a tag. Same rule the short list already follows.
  it("is comma-separated rather than hashtagged", () => {
    expect(LONG_TAGS_DEFAULT).not.toContain("#");
    expect(LONG_TAGS_DEFAULT.split(",").every((t) => t.trim() !== "")).toBe(true);
  });

  // YouTube rejects an upload whose concatenated tags run past roughly 500
  // characters, and nothing downstream truncates.
  it("stays well inside YouTube's tag budget", () => {
    expect(LONG_TAGS_DEFAULT.length).toBeLessThan(400);
  });

  // The title needs no long-form variant, and this is the assertion that
  // fails if someone ever puts a shorts tag into the shared one.
  it("shares TITLE_HASHTAGS, which carries no shorts tag", () => {
    expect(TITLE_HASHTAGS).not.toMatch(/#shorts\b/i);
  });
});
```

Add `LONG_DESCRIPTION_TEMPLATE`, `LONG_TAGS_DEFAULT` and `TITLE_HASHTAGS`
to that file's existing import from `./defaults.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/defaults.test.ts`
Expected: FAIL — `LONG_DESCRIPTION_TEMPLATE is not exported`.

- [ ] **Step 3: Write the implementation**

Add to `src/defaults.ts`, after `TAGS_DEFAULT`:

```ts
/** Pre-fills the description field on the LONG-FORM path.
 *
 *  The same channel links, with every shorts tag removed. Unlike its
 *  short-form twin this is the whole description — `buildSnippet` is called
 *  with `shorts: false` for a stack, so nothing is appended to it and
 *  anything shorts-flavoured left here would ship. */
export const LONG_DESCRIPTION_TEMPLATE = `#vtuber #vtubervn #vtubervietnam #habine #siini #sim

------

Habi nè: https://www.youtube.com/@habine03
Siini: https://www.youtube.com/@SiiniYT
Sim: https://www.youtube.com/@simchan_hojo`;

/** Pre-fills the tags field on the long-form path. Comma-separated, not
 *  hashtagged — `buildSnippet` splits on commas and trims, so a `#` here
 *  would ship a literal "#vtuber" as a tag.
 *
 *  "shorts" is gone and "tổng hợp" takes its place: a compilation is what
 *  someone searching for this would actually type. */
export const LONG_TAGS_DEFAULT = "vtuber, vtubervn, vtuber vietnam, tổng hợp, compilation";
```

Note there is deliberately no `LONG_TITLE_HASHTAGS`: `TITLE_HASHTAGS`
already carries no shorts tag, so both journeys share it, and `defaultTitle`
is unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/defaults.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/defaults.ts src/defaults.test.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: long-form publish defaults

The description and tag list with every shorts tag removed. TITLE_HASHTAGS
needs no twin — it never carried one — so defaultTitle is unchanged and
both journeys share it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `mode` and `parts` in `AppState`

**Files:**
- Modify: `src/state.ts`
- Test: `src/state.test.ts`

**Interfaces:**
- Produces: `AppState.mode: "short" | "long"` (initial `"short"`),
  `AppState.parts: UploadPart[]` (initial `[]`), and
  `export type UploadPart = { id: string; name: string; duration: number }`.
  Tasks 7, 8 and 9 all use them.

- [ ] **Step 1: Write the failing test**

Add to `src/state.test.ts`:

```ts
describe("the long-form fields", () => {
  it("starts on the short journey with no parts", () => {
    expect(getState().mode).toBe("short");
    expect(getState().parts).toEqual([]);
  });

  // Mutation test, mirroring the one that pins `voice`'s exclusion. Neither
  // field belongs in a per-video record: `mode` describes a session's work
  // the way `outName` does, and `parts` would point at files the user may
  // have swept by hand between sessions.
  it("persists neither field", () => {
    setState({
      videoId: "abcdefghijk",
      phase: "trimming",
      mode: "long",
      parts: [{ id: "f81d4fae-7dec-41d0-a765-00a0c91e6bf6", name: "a.mp4", duration: 2 }],
    });
    save();
    const raw = localStorage.getItem("vstack:abcdefghijk");
    expect(raw).not.toBeNull();
    const record = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    expect(record).not.toHaveProperty("mode");
    expect(record).not.toHaveProperty("parts");
  });

  // The long journey has no videoId at all, so save() returns early — the
  // exclusion above is belt AND braces, and this is the braces.
  it("writes nothing at all on the long journey", () => {
    localStorage.clear();
    setState({ videoId: "", mode: "long", phase: "stacking", parts: [] });
    save();
    expect(localStorage.length).toBe(0);
  });
});
```

Match the existing file's setup conventions — check how the surrounding
tests reset `localStorage` and state between cases and follow them exactly
rather than inventing a new pattern.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/state.test.ts`
Expected: FAIL — `expected undefined to be 'short'`.

- [ ] **Step 3: Write the implementation**

In `src/state.ts`, extend `Phase` and `AppState`:

```ts
export type Phase = "idle" | "trimming" | "framing" | "stacking" | "preview";

/** One uploaded long-form part.
 *
 *  `id` is the UUID `/api/upload` minted — the only thing the server will
 *  accept back. `name` is the local filename, kept purely so the panel has
 *  something readable to show, and deliberately never sent anywhere. */
export type UploadPart = { id: string; name: string; duration: number };
```

and add to `AppState`, after `phase`:

```ts
  /** Which journey this session is on. Set once on the way out of `idle`
   *  and never again — the two paths do not meet until `preview`, which is
   *  the only phase that branches on it.
   *
   *  NOT persisted, for the same reason `outName` is not: it describes a
   *  session's work rather than a property of a video. Defaulting to
   *  "short" is also what makes every record written before this field
   *  existed restore onto the journey it was made for. */
  mode: "short" | "long";
  /** Uploaded long-form parts, in render order. Empty on the short path.
   *
   *  NOT persisted: a reload loses the ordering, which is the accepted cost
   *  of not storing a list of paths the user may have swept from
   *  `media/uploads/` by hand. The files themselves survive. */
  parts: UploadPart[];
```

and to `initial`:

```ts
  mode: "short",
  parts: [],
```

`save()` needs no change: it returns early without a `videoId`, and the
long journey never has one. The `Saved` type is untouched, so `restore()` is
untouched too.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm test`
Expected: PASS — the `Phase` union widened, so this catches any exhaustive
switch that needed the new arm.

- [ ] **Step 6: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/state.ts src/state.test.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: mode and parts in AppState

Neither is persisted, and the exclusion is mutation-tested the way voice's
already is: mode describes a session's work rather than a video, and parts
would point at files the user may have swept by hand.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `upload`, `stack` and `publish`'s `shorts` in `src/api.ts`

**Files:**
- Modify: `src/api.ts`

**Interfaces:**
- Consumes: `UPLOAD_MAX_BYTES` from `src/defaults.ts` (Task 3).
- Produces:
  - `upload(file: File): Promise<UploadResult>` where
    `UploadResult = { id: string; duration: number; width: number; height: number }`
  - `stack(body: { ids: string[]; title: string }): Promise<StackResult>` where
    `StackResult = { name: string; url: string; size: number; duration: number }`
  - `publish` gains a required `shorts: boolean` field.
  Task 8 and Task 9 call these.

**No unit tests.** `src/api.ts` is the network surface and has none today,
by design.

- [ ] **Step 1: Extract a shared sender**

`post()` currently owns both the JSON encoding and all the error handling.
`upload` needs the second without the first. Split it, changing nothing
about `post`'s behaviour:

```ts
/** Everything both senders share: the network-down translation and the
 *  server's own error body. Extracted from `post` when `upload` arrived —
 *  it sends raw bytes rather than JSON but wants identical failure
 *  reporting, and duplicating this is how the two would drift. */
async function send(path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    // Nothing answered at all — no dev server, or it refused the connection.
    // fetch() rejects with an opaque "TypeError: Failed to fetch" that means
    // nothing to a user, so this replaces it with something actionable.
    throw new Error(BACKEND_DOWN);
  }
  if (!res.ok) {
    // The server hands back yt-dlp/ffmpeg output verbatim; show it verbatim.
    const text = await res.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* not JSON — use the raw text */
    }
    // Every backend failure answers through send(res, code, { error }), so a
    // failure carrying no body at all did not come from the backend: it is
    // Vite's dev proxy reporting it has nothing to forward to. Naming that
    // matters — "Request failed: 502 Bad Gateway" sends you reading app code
    // when the fix is starting a process. An empty `message` also renders as
    // a falsy state.error, so the busy spinner would vanish showing nothing.
    if (!message) {
      throw new Error(
        res.status >= 502 && res.status <= 504
          ? BACKEND_DOWN
          : `Request failed: ${res.status} ${res.statusText}`,
      );
    }
    throw new Error(message);
  }
  return res;
}

async function post(path: string, body: unknown): Promise<Response> {
  return send(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
```

Move the two comment blocks from `post` into `send` as shown — they describe
the error handling, which is what moved.

- [ ] **Step 2: Add `upload`**

```ts
export type UploadResult = { id: string; duration: number; width: number; height: number };

/** Sends one file's raw bytes to `/api/upload`.
 *
 *  Not `post`: the body is the file itself, not JSON. `multipart/form-data`
 *  would need a parser on the other end that this dependency-free server
 *  does not have, and buys nothing for a single file over loopback — the
 *  platform streams a `File` body for free.
 *
 *  The size check is here as well as on the server, and the split is
 *  deliberate: the server DESTROYS the socket past the cap (answering
 *  politely would mean reading the whole thing first, which is the cost the
 *  cap exists to avoid), and a destroyed socket surfaces as `BACKEND_DOWN`
 *  — "start the backend" for a file that is simply too big. This is what
 *  turns that into a sentence the user can act on. The server's check is
 *  still the actual boundary. */
export async function upload(file: File): Promise<UploadResult> {
  if (file.size > UPLOAD_MAX_BYTES) {
    throw new Error(
      `${file.name} is ${(file.size / 1e6).toFixed(0)} MB — the limit is ` +
        `${Math.round(UPLOAD_MAX_BYTES / 1e6)} MB.`,
    );
  }
  const res = await send("/api/upload", {
    method: "POST",
    headers: { "content-type": "video/mp4" },
    body: file,
  });
  return res.json() as Promise<UploadResult>;
}
```

Add the import at the top of the file:

```ts
import { UPLOAD_MAX_BYTES } from "./defaults.ts";
```

- [ ] **Step 3: Add `stack`**

```ts
/** What `/api/stack` answers with. Same three fields `/api/export` returns,
 *  plus the total duration — the long-form bar has no marks to show, so the
 *  length is the only thing it can say about what came out. `url` already
 *  carries the file's mtime as a cache-buster, for the same reason the
 *  export's does. */
export type StackResult = { name: string; url: string; size: number; duration: number };

/** Renders the uploaded parts, in the order given, into one horizontal
 *  video. `ids` are the UUIDs `upload` returned — never paths, and never
 *  the local filenames, which the server has no idea about. */
export async function stack(body: { ids: string[]; title: string }): Promise<StackResult> {
  return (await post("/api/stack", body)).json() as Promise<StackResult>;
}
```

- [ ] **Step 4: Add `shorts` to `publish`**

```ts
export async function publish(body: {
  name: string;
  title: string;
  description: string;
  tags: string;
  /** Whether this upload is a Short. `#shorts` in the description is what
   *  classifies it, and a long-form compilation carrying that tag is
   *  misfiled at the platform level — so this is `false` for a stack and
   *  `true` for everything the short journey produces. Required here rather
   *  than optional: the caller always knows which journey it is on, and a
   *  default would let a new call site get it wrong silently. */
  shorts: boolean;
}): Promise<{ videoId: string; url: string; thumbnail: boolean }> {
```

The body is unchanged below that.

- [ ] **Step 5: Verify the build**

Run: `pnpm build`
Expected: FAIL — `doPublish` in `src/main.ts` now misses the required
`shorts` field. That failure is expected and is fixed in Task 9; if you want
a green gate here, add `shorts: true` to the existing `api.publish` call in
`src/main.ts` now, which is the correct value for the short journey and is
what Task 9 will make conditional.

Do add it now, so this task commits green:

```ts
      const { videoId, thumbnail } = await api.publish({
        name: s.outName,
        title,
        description: s.ytDescription,
        tags: s.ytTags,
        shorts: true,
      });
```

Re-run `pnpm build`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/api.ts src/main.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: upload and stack API wrappers

post() splits into send() + post() so upload can reuse the error handling
without the JSON encoding. The client-side size check exists because the
server destroys the socket past the cap, which would otherwise surface as
'start the backend' for a file that is simply too big.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The stacking phase

**Files:**
- Modify: `src/main.ts`
- Modify: `src/style.css`

**Interfaces:**
- Consumes: `api.upload`, `api.stack` (Task 7); `AppState.mode`,
  `AppState.parts`, `UploadPart` (Task 6).
- Produces: a working `idle → stacking → preview` path. Task 9 fixes what
  `preview` shows.

**No unit tests.** `src/main.ts` is DOM-driven and has none by design —
vitest runs `environment: "node"` here. Step 7 is the verification and it is
not optional.

- [ ] **Step 1: Add the panel to the persistent shell**

In `src/main.ts`, beside the `publishForm` declaration:

```ts
// The long-form phase's part list. Part of the persistent shell for the same
// reason publishForm is: it takes over the left column during `stacking`,
// and is only ever hidden — never removed, and never by hiding sourceSlot
// itself, which would put the YouTube iframe's ancestor into display:none.
const stackPanel = el("div", { className: "stack-panel", hidden: true });
```

and add it to the `sourceSlot` children:

```ts
const sourceSlot = el("div", { className: "source" }, sourcePlaceholder, publishForm, stackPanel);
```

- [ ] **Step 2: Add the styles**

Append to `src/style.css`, after the `.publish-form` rules:

```css
/* Mirrors .publish-form: it owns the same column in a different phase. */
.stack-panel {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  overflow-y: auto;
  /* `.source` is `place-items: center`, which would otherwise centre every
     row's text as well as the panel itself. */
  text-align: left;
}

.stack-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius-2);
  background: var(--slate-a3);
  font-size: 13px;
}

/* The filename takes the free space so the buttons stay pinned right. */
.stack-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stack-index {
  font-variant-numeric: tabular-nums;
  color: var(--slate-11);
  min-width: 1.5em;
}

.stack-dur { font-variant-numeric: tabular-nums; color: var(--slate-11); }

/* Square-ish, so a row of three reads as controls on the row rather than as
   three separate actions. */
.stack-row button {
  min-width: var(--control-height);
  padding-inline: var(--space-2);
}

.stack-empty {
  margin: 0;
  color: var(--slate-11);
  font-size: 13px;
}
```

- [ ] **Step 3: Add the entry point to the idle bar**

In `renderIdle`, add a third row. Replace the `rows` construction:

```ts
  // Three ways in: paste a URL, reopen something already fetched, or start a
  // long-form stack. The middle row is omitted entirely when the cache is
  // empty — which is also what a failed /api/clips looks like.
  const long = el("button", {
    className: "btn-gray",
    textContent: "Long form →",
    title: "Stack finished vertical videos into one horizontal video",
    disabled: busy,
  });
  long.onclick = () => setState({ mode: "long", phase: "stacking", error: "" });

  const rows: Node[] = [el("div", { className: "bar-row" }, input, go)];
  if (clipList.length > 0) {
    rows.push(el("div", { className: "bar-row" }, renderClipPicker(s)));
  }
  rows.push(el("div", { className: "bar-row" }, long));
  return rows;
```

- [ ] **Step 3b: Claim the mode on the way out of `idle` on the SHORT side too**

`mode` is "set once on the way out of `idle`" — and the button above is only
half of that. The three `setState` calls that leave `idle` on the short
journey must each claim `mode: "short"`, or a session that visits `Long
form →` and steps back reads a stale `"long"` for the rest of its life. That
is invisible today and Critical after Task 9, which gates `doPublish`'s
`shorts` flag and the preview back button on the same field: a short export
would publish without `#Shorts` and offer a "Frame again" that jumps to
`stacking`.

Add `mode: "short",` to each of:

1. the `phase: "framing"` call in `load()`'s skip-trim branch (videos under
   `SKIP_TRIM_UNDER`),
2. the `phase: "trimming"` call at the end of `load()`,
3. the `phase: "framing"` call on the cached-clip picker's open path.

Do **not** add it to the `phase: "framing"` call in the Continue-from-trimming
path. That is not an exit from `idle` — it is already inside the short
journey, and setting it there blurs the rule.

One comment, on whichever of the three reads best, saying why: the two
journeys' only shared phase is `preview`, so whichever way you leave `idle`
has to claim the mode.

- [ ] **Step 4: Add the panel and bar renderers**

Add these to `src/main.ts`, next to `renderPublishForm`:

```ts
/** The Render button lives in the bar and the parts it is gated on live in
 *  the panel — two functions, one render pass. Uploading flips it in place
 *  the way `publishBtn` is flipped by a quiet keystroke, because an upload
 *  finishing calls setState anyway but the *disabled* state has to be right
 *  the moment the list changes. Both are rebuilt in the same render() call,
 *  so this is never stale. */
let stackBtn: HTMLButtonElement | null = null;

/** The left column during `stacking`: the uploaded parts, in render order. */
function renderStackPanel(): Node[] {
  const s = getState();
  const locked = Boolean(s.busy);

  if (s.parts.length === 0) {
    return [
      el("h2", { className: "publish-heading", textContent: "Parts" }),
      el("p", {
        className: "stack-empty",
        textContent: "Add .mp4 files below. They play in this order, top to bottom.",
      }),
    ];
  }

  // Reads live state rather than a snapshot, the same rule `+ Box` follows:
  // every handler here rewrites the array, and two clicks before a render
  // lands would otherwise each build from the same stale copy.
  const reorder = (from: number, to: number) => {
    const parts = [...getState().parts];
    const moved = parts[from];
    if (moved === undefined || to < 0 || to >= parts.length) return;
    parts.splice(from, 1);
    parts.splice(to, 0, moved);
    setState({ parts });
  };

  const rows = s.parts.map((part, i) => {
    // ponytail: reorder is buttons, not drag-and-drop. Two array splices
    // against a pointer-capture state machine with drop targets and
    // autoscroll — and these are keyboard-reachable for free. Upgrade to
    // dragging the day the list routinely runs past a screenful.
    const up = el("button", {
      textContent: "↑",
      title: "Move earlier",
      ariaLabel: `Move ${part.name} earlier`,
      disabled: locked || i === 0,
    });
    up.onclick = () => reorder(i, i - 1);

    const down = el("button", {
      textContent: "↓",
      title: "Move later",
      ariaLabel: `Move ${part.name} later`,
      disabled: locked || i === s.parts.length - 1,
    });
    down.onclick = () => reorder(i, i + 1);

    const remove = el("button", {
      textContent: "✕",
      title: "Remove from this stack",
      ariaLabel: `Remove ${part.name}`,
      disabled: locked,
    });
    // Removes it from the stack, NOT from disk: the upload stays in
    // media/uploads so re-adding it costs nothing.
    remove.onclick = () => setState({ parts: getState().parts.filter((p) => p.id !== part.id) });

    return el(
      "div",
      { className: "stack-row" },
      el("span", { className: "stack-index", textContent: String(i + 1) }),
      el("span", { className: "stack-name", title: part.name, textContent: part.name }),
      el("span", { className: "stack-dur", textContent: clock(part.duration) }),
      up,
      down,
      remove,
    );
  });

  return [el("h2", { className: "publish-heading", textContent: "Parts" }), ...rows];
}

/** The stacking bar: adding files, naming the output, and rendering it. */
function renderStacking(): Node[] {
  const s = getState();
  const busy = s.busy !== "";
  const total = s.parts.reduce((sum, p) => sum + p.duration, 0);

  const picker = el("input", {
    type: "file",
    multiple: true,
    accept: "video/mp4",
    disabled: busy,
  });
  // The choice IS the action, like the cached-clip picker: there is nothing
  // to confirm about having picked files. `value` is cleared afterwards so
  // picking the same file twice in a row still fires a change event.
  picker.onchange = () => {
    const files = [...(picker.files ?? [])];
    picker.value = "";
    if (files.length > 0) void doUpload(files);
  };

  const title = el("input", {
    type: "text",
    placeholder: "Title (names the file)",
    className: "field-grow",
    value: s.starterTitle,
    disabled: busy,
  });

  const back = el("button", { className: "btn-gray", textContent: "← Back", disabled: busy });
  // The uploads stay in state: stepping back to pick a different journey
  // must not throw away files already sent.
  back.onclick = () => setState({ phase: "idle" });

  // `go`, not `render` — a local named `render` would shadow this module's
  // own render() function for the rest of this scope, which is a landmine
  // for whoever next adds a line here that needs it.
  const go = el("button", {
    className: "btn-solid",
    textContent: "Render →",
    disabled: busy || s.parts.length === 0 || s.starterTitle.trim() === "",
  });
  go.onclick = () => void doStack();
  stackBtn = go;

  // Quiet, like every other text field here: a notifying update per
  // keystroke would rebuild the very input being typed into and drop the
  // caret. Which is exactly why Render's `disabled` is flipped in place —
  // without this it would stay disabled until some unrelated setState
  // happened along, which reads as a broken button rather than as "type a
  // title first". `doStack` re-checks the title itself rather than trusting
  // the button.
  title.oninput = () => {
    setQuiet({ starterTitle: title.value });
    if (stackBtn) {
      const live = getState();
      stackBtn.disabled =
        title.value.trim() === "" || live.parts.length === 0 || Boolean(live.busy);
    }
  };

  return [
    el(
      "div",
      { className: "bar-row" },
      picker,
      el("span", {
        className: "badge",
        textContent: `${s.parts.length} part${s.parts.length === 1 ? "" : "s"}`,
      }),
      el("span", { className: "badge", textContent: clock(total) }),
    ),
    el("div", { className: "bar-row" }, title, el("div", { className: "bar-end" }, back, go)),
  ];
}
```

- [ ] **Step 5: Add the two actions**

Add next to `doExport`:

```ts
/** Uploads each picked file and appends it to the stack, in the order the
 *  file dialog handed them over.
 *
 *  Sequential rather than `Promise.all`: these are hundreds of megabytes
 *  each, the order of the resulting list is the order they were picked, and
 *  a parallel upload of four files would race that ordering for no
 *  throughput on a loopback socket. */
async function doUpload(files: File[]): Promise<void> {
  await guard("Uploading…", async () => {
    for (const [i, file] of files.entries()) {
      setState({ busy: `Uploading ${i + 1}/${files.length}…` });
      const { id, duration } = await api.upload(file);
      // Live state, not a snapshot: each iteration appends to what the
      // previous one wrote.
      setState({ parts: [...getState().parts, { id, name: file.name, duration }] });
    }
  });
}

/** Renders the stack and moves to the preview phase. The file lands in
 *  `out/` server-side under a name today's `isOutName` already accepts, so
 *  preview, Reveal and Publish all work on it unchanged. */
async function doStack(): Promise<void> {
  const s = getState();
  // Both checks the Render button is disabled on, repeated here rather than
  // trusting it — the title reaches the button through a quiet update.
  const title = s.starterTitle.trim();
  if (title === "" || s.parts.length === 0) return;
  await guard("Rendering… (a 5-minute stack takes ~1-2 min)", async () => {
    const out = await api.stack({ ids: s.parts.map((p) => p.id), title });
    setState({
      phase: "preview",
      outName: out.name,
      outUrl: out.url,
      outSize: out.size,
      // Both defaults are `||`-guarded for the same reason the export's are:
      // a re-render after a reorder keeps whatever was already typed.
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

Extend the `./defaults.ts` import at the top of `src/main.ts`:

```ts
import {
  DESCRIPTION_TEMPLATE,
  LONG_DESCRIPTION_TEMPLATE,
  LONG_TAGS_DEFAULT,
  TAGS_DEFAULT,
  YT_TITLE_MAX,
  defaultTitle,
} from "./defaults.ts";
```

- [ ] **Step 6: Wire the phase into `render()`**

Three edits inside `render()`:

```ts
  publishForm.hidden = s.phase !== "preview";
  stackPanel.hidden = s.phase !== "stacking";
```

```ts
  if (s.phase === "idle") barSlot.replaceChildren(...renderIdle(s));
  else if (s.phase === "trimming") barSlot.replaceChildren(...renderTrimming());
  else if (s.phase === "framing") barSlot.replaceChildren(...renderFraming());
  else if (s.phase === "stacking") {
    // Bar first: it assigns stackBtn, which the title handler flips in place
    // on a quiet keystroke.
    barSlot.replaceChildren(...renderStacking());
    stackPanel.replaceChildren(...renderStackPanel());
  } else {
    // Bar first: it assigns publishBtn, which the panel's title handler flips
    // in place on a quiet keystroke.
    barSlot.replaceChildren(...renderPreview());
    publishForm.replaceChildren(...renderPublishForm());
  }
```

and the status row, which currently shows a video's title, duration and
source dimensions for every non-idle phase — all three of which are empty or
zero on the long journey:

```ts
  const status: Node[] = [];
  const meta: Node[] = [];
  // The long journey has no probed video behind it: `title`, `duration` and
  // `source` are all still their initial values, and three empty badges read
  // as a broken header rather than as an absence.
  if (s.phase !== "idle" && s.mode === "short") {
    meta.push(el("span", { className: "badge badge-title", textContent: s.title }));
    meta.push(el("span", { className: "badge", textContent: clock(s.duration) }));
    meta.push(el("span", { className: "badge", textContent: `${s.source.w}×${s.source.h}` }));
  }
  if (s.phase !== "idle") meta.push(el("span", { className: "badge", textContent: s.phase }));
```

The rest of the status block is unchanged.

- [ ] **Step 7: Verify by hand**

Run `pnpm build` first. Expected: PASS.

Then start `pnpm server` and `pnpm dev`, open http://localhost:5173 and:

1. Confirm the idle bar shows a third row with `Long form →`.
2. Click it. The left column shows the empty Parts panel; the bar shows a
   file picker, two badges, a title field, Back and Render.
3. Add two `.mp4` files (the `/tmp/part1.mp4` and `/tmp/part2.mp4` from Task
   3 Step 6 work). Both appear as numbered rows with their durations; the
   badges read `2 parts` and the summed length.
4. Click `↓` on row 1. The rows swap and the numbers follow.
5. Click `✕` on a row. It goes; the other renumbers.
6. Re-add it. Type a title — Render enables on the first keystroke, without
   any other interaction.
7. Click Render. The bell rings, the phase advances to `preview`, and the
   output plays.
8. Click Back from stacking, then `Long form →` again — the parts are still
   there.

Note the preview will look wrong at this point: `.out` is `aspect-ratio:
9/16`, so a 16:9 video is squeezed into a vertical box. Task 9 fixes it. Do
not fix it here.

- [ ] **Step 8: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/main.ts src/style.css
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: the stacking phase

Upload, reorder and render, in a panel that joins the persistent shell
beside publishForm — sourceSlot is never emptied, so the YouTube iframe's
browsing context survives a trip through the long journey.

Reorder is up/down buttons rather than drag-and-drop, and every handler
reads live state rather than render()'s snapshot, since a quiet keystroke
reaches no render.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The preview phase learns about `mode`

**Files:**
- Modify: `src/main.ts`
- Modify: `src/style.css`

**Interfaces:**
- Consumes: everything from Tasks 6, 7 and 8.
- Produces: a `preview` phase that shows a 16:9 video at 16:9, steps back to
  the phase the file came from, and publishes without `#Shorts`.

- [ ] **Step 1: Make the output slot follow the output's shape**

Add to `src/style.css`, immediately after the existing `.out` rule:

```css
/* The output slot is 9:16 because that is what every export used to be. A
   long-form stack is 16:9, and squeezing it into the vertical box letterboxes
   it into a thin strip with most of the card empty. Toggled by render() on
   the phase AND the mode, not set once — the same slot holds the framing
   canvas, which is always vertical.

   ONLY `aspect-ratio` is overridden. `.out` keeps `height: 100%`, and `.out`
   sits in `.stage`'s `auto` column — so the width is derived from a definite
   height through the ratio, exactly the way the 9:16 case already works.
   Setting `width: 100%` here instead makes the auto track's size depend on
   the item's size which depends on the track: circular, and it collapses. */
.out.is-wide { aspect-ratio: 16 / 9; }
```

- [ ] **Step 2: Toggle it from `render()`**

In `render()`, beside the other slot toggles:

```ts
  // Only in preview, and only on the long journey: the framing canvas lives
  // in this same slot and is always 1080x1920.
  outSlot.classList.toggle("is-wide", s.phase === "preview" && s.mode === "long");
```

- [ ] **Step 3: Send the right `shorts` flag**

In `doPublish`, replace the hardcoded `shorts: true` added in Task 7:

```ts
      const { videoId, thumbnail } = await api.publish({
        name: s.outName,
        title,
        description: s.ytDescription,
        tags: s.ytTags,
        // `#shorts` in the description is what classifies an upload as a
        // Short. A long-form compilation carrying it is misfiled at the
        // platform level, and the uploader cannot undo that from Studio.
        shorts: s.mode === "short",
      });
```

- [ ] **Step 4: Send the back button somewhere that exists**

In `renderPreview`, replace the `back` button:

```ts
  const long = s.mode === "long";
  const back = el("button", {
    className: "btn-gray",
    textContent: long ? "Edit the stack" : "Frame again",
  });
  // Everything the previous phase held is untouched — boxes and marks on the
  // short path, the part list on the long one — so this lands back on
  // exactly what the render came from. A bad crop or a wrong order is one
  // click from a re-render.
  back.onclick = () => setState({ phase: long ? "stacking" : "framing" });
```

- [ ] **Step 5: Verify by hand**

Run `pnpm build`. Expected: PASS.

Then, with `pnpm server` and `pnpm dev` running:

1. Run a long-form stack through to `preview`. The output video now fills
   the card at 16:9 rather than being squeezed into a vertical strip.
2. Click `Edit the stack`. The parts are still listed in their order.
3. Render again, then use `Show in Finder` — the file is in
   `~/Desktop/vstack/`, and there is deliberately no `.jpg` beside it.
4. Confirm the publish panel prefills with the long-form description (no
   `#shorts` anywhere) and the long-form tags.
5. Run a normal short export end to end. Confirm the output is still 9:16 in
   the card, `Frame again` still says that and still works, and the publish
   panel still prefills with the short-form description.
6. If a YouTube token is configured, publish one long-form video and confirm
   in Studio that the description has no `#Shorts`, that the video is
   private, and that the 16:9 thumbnail took (or that the
   `thumbnail skipped` badge appears, which means an unverified channel and
   is not a failure of this feature).

- [ ] **Step 6: Run the whole suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/main.ts src/style.css
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: preview adapts to the long journey

The output slot follows the output's shape, the back button lands on the
phase the render came from, and publish sends shorts:false so a
compilation is not misfiled as a Short.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Document it in `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

`CLAUDE.md` is the file every future session reads first, and it is
currently the only place the specs' supersession chain is written down. A
feature that is not in it is a feature the next session will break.

- [ ] **Step 1: Add the spec to the reading list**

In the opening paragraph's chain of specs, after the segments doc's entry,
append:

```
plus `docs/specs/2026-09-03-vstack-longform-design.md`, which supersedes
nothing and instead adds a SECOND journey through the app: uploaded
vertical mp4s letterboxed onto blurred copies of themselves, concatenated
into one 1920x1080 video, and published through the same preview phase.
Everything every other spec describes is the *short* journey and is
unchanged by it.
```

- [ ] **Step 2: Update the Architecture map**

Add to the file tree:

```
server/longform.ts WIDE, stackWide (the long journey's one ffmpeg pass)
```

after the `server/mask.ts` line, and:

```
media/uploads/     long-form parts, one <uuid>.mp4 per upload (gitignored)
```

after the `media/` line.

Update the routes line: `server/index.ts` now has **12** routes (11 POST +
GET /out/<name>), not 10.

Update the layering paragraph: `longform.ts` sits beside `ffmpeg.ts` and
`starter.ts` — it takes an output path from the caller and needs neither
`MEDIA_DIR` nor `OUT_DIR`, and it imports `probeFile` and nothing else.

- [ ] **Step 3: Update the phase list**

Replace "Four phases" with five, and describe the branch:

```
Five phases in two journeys that share the last one: `idle` (URL) →
`trimming` → `framing` → `preview` is the short one, and `idle` →
`stacking` → `preview` is the long one. `stackPanel` is a child of
`sourceSlot` beside `publishForm`, under the same rule — `sourceSlot`
itself is never hidden.
```

- [ ] **Step 4: Add the new invariants**

Add to the invariants section:

```
**`#shorts` is what classifies an upload, so `buildSnippet` must not force
it.** The flag is optional and defaults to `true`, which is what keeps every
existing caller and every request body written before it exact — only the
long journey sends `false`. A twenty-minute compilation carrying the tag is
misfiled by YouTube at the platform level, and the uploader cannot undo it
from Studio.

**A long-form output's name passes `isOutName` unchanged, and that is load-
bearing.** `outName(title, 0, total)` emits `<slug>-0000-<mmss>.mp4`, which
today's `OUT_NAME` regex already accepts — which is the entire reason
`/out/`, `/api/reveal` and `/api/publish` needed no edits for this feature.
Do not widen `OUT_NAME` for long form; there is nothing to widen it for.

**`stackWide` blurs at 480x270 and stretches back up, never at full
resolution.** A 1080x1920 source scaled to *cover* 1920x1080 is 1920x3413,
and `gblur` over that costs roughly fifty times what it costs at 480x270 —
for a picture whose entire purpose is to be out of focus. The upscale
supplies most of the softening on its own, which is also why
`longform.ts`'s own `BLUR_SIGMA` is 12 where `starter.ts`'s is 30. The two
are deliberately not shared: one constant for two blurs at two scales means
tuning either one moves the other.

**`stackWide`'s foreground uses `decrease`, not `-2:1080`.** An upload is
whatever file the user picked; only the common case is 9:16. A part wider
than 16:9 scaled to a fixed height overflows the frame, so the foreground
is `scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2`
— fits inside on both axes, even on both, for any input aspect.

**`isUploadId` is the third client-string gate in this API, and the
strictest.** `isOutName` validates a name the client chose; `/api/export`'s
`digest` validates eight hex characters the client computed; this validates
a UUID the *server* minted, so there is nothing legitimate a client can send
that it does not match. The original filename never crosses the wire at all
— the client keeps it purely for display.
```

- [ ] **Step 5: Update the testing posture section**

Add:

```
`server/longform.test.ts` shells out to real ffmpeg and asserts output
pixels, the same posture `server/ffmpeg.test.ts` holds: the output is
1920x1080, a centre sample in each half carries that part's own colour, and
a left-edge sample is NOT black — which is the assertion that fails if the
blur leg is dropped and the graph pillarboxes instead. The two parts are
different colours so the edge sample also proves each background tracks its
own part, and the leg ordering is mutation-tested the way `concatClips`'
already is. A silent second part covers the `anullsrc` stand-in, and a 16:9
part covers an upload that is not vertical. `server/youtube.test.ts` gains
the `shorts` flag's four cases. The upload route, the stacking panel and
the reorder buttons have no tests, like the rest of the network and DOM
surface.
```

- [ ] **Step 6: Add the gotchas**

Add to the gotchas section:

```
**`.out` is `aspect-ratio: 9 / 16` and a long-form video is not.** The slot
holds the framing canvas (always vertical) as well as the preview `<video>`,
so the shape is toggled by `render()` on the phase AND the mode
(`.out.is-wide`), never set once. Without it a 16:9 output is squeezed into
a thin strip with most of the card empty, which reads as a broken render.

**`media/uploads/` grows without eviction and nothing lists it.**
Deliberate: re-rendering a stack after a title fix must not mean
re-uploading a gigabyte. `listClips` cannot reach it — it walks per-video
directories and matches `CLIP_RE`, and a UUID at the top level is neither.
`reportCache` counts it, so the boot log shows it growing.

**`/api/upload` destroys the socket past `UPLOAD_MAX_BYTES` rather than
answering.** Replying politely means having read the whole body first, which
is the cost the cap exists to avoid — but a destroyed socket surfaces
client-side as `BACKEND_DOWN` ("start the backend"), which is the wrong
sentence for a file that is simply too big. That is why the client checks
`file.size` first and the server's check is the backstop. Both read the same
constant from `src/defaults.ts`.
```

- [ ] **Step 7: Add `media/uploads/` to `.gitignore` if `media/` is not already covered**

Run: `grep -n media .gitignore`

If `media/` is already ignored wholesale, change nothing. Otherwise add
`media/uploads/`.

- [ ] **Step 8: Final verification**

```bash
pnpm build
pnpm test
```

Expected: both PASS. Report the test count — it should have grown by roughly
15 from 272.

- [ ] **Step 9: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add CLAUDE.md .gitignore
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "docs: CLAUDE.md covers the long-form journey

The spec chain, the fifth phase, server/longform.ts and media/uploads/ in
the architecture map, and five new invariants — the #shorts flag, the
output name passing isOutName unchanged, the blur's scale, the foreground's
decrease scaling, and isUploadId as the third and strictest client-string
gate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the executor

**Do not touch `concatClips`.** It is mutation-tested for the segments path
and its video leg is a genuinely different chain from `stackWide`'s — it
trims to a range and normalises to part one's own probed shape, where
`stackWide` takes whole files and normalises to a fixed 1920×1080 with a
composite in between. Six duplicated audio lines is the cheaper cost.

**Do not add a `prev` sweep to `/api/stack`, a still beside the output, a
progress bar, or drag-and-drop reordering.** All four are named as out of
scope in the spec, three of them carry `ponytail:` comments naming the
upgrade path, and each is a small addition later if it turns out to matter.

**Do not strip the per-part title cards and outros.** The compilation keeps
them by design — it reads as chapters. Detecting them is impossible for an
arbitrary upload anyway.

**The framing phase must never learn that any of this exists.** No import of
`longform.ts` from the client, no `mode` branch in `renderFraming`,
`ensureFraming`, `buildFilter` or the mask.
