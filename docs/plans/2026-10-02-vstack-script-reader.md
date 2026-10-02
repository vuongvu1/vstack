# Script Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sixth journey, `idle` → `reading` → `idle`: paste a voiceover script, pick a VieNeu voice, get one `<slug>-voice.mp3` in `OUT_DIR`, played back in the panel.

**Architecture:** One request, `POST /api/read`, runs the existing `speak()` over the whole script (VieNeu chunks internally), encodes WAV→mp3 with ffmpeg into a tracked partial in `OUT_DIR`, renames, sweeps `prev`, and answers the mp3 bytes (the `/api/say` posture). The client plays a blob URL and reveals via `/api/reveal`.

**Tech Stack:** Node `node:http` + type stripping, VieNeu-TTS via `server/tts.py`, ffmpeg `libmp3lame`, vanilla TS + Vite, vitest.

**Spec:** `docs/specs/2026-10-02-vstack-script-reader-design.md`

## Global Constraints

- `SCRIPT_MAX = 15_000` characters, counted after `trim()`, on both sides.
- Output name `<slugify(base)>-voice.mp3`; pattern `/^[a-z0-9]+(?:-[a-z0-9]+)*-voice\.mp3$/`. Do NOT widen `OUT_NAME` or `CUT_NAME`.
- The phase claims no `mode`. `/api/publish` and `/out/` are not taught about `.mp3`.
- Voice is validated against `knownVoices()`, never a pattern.
- Erasable TS only (no `enum`, `namespace`, parameter properties); `import type` for types; explicit `.ts` import extensions; no default exports; no `any`; `console.warn`/`.error` only.
- **This environment blocks `git add`/`git commit` and shell `rm`.** The user commits. Each task ends with a *proposed* commit message, not a commit. Delete files with Node's `fs.rm`, never shell `rm`.
- Visual values come from Radix tokens in `src/style.css`; no fresh literals.

## Review Focus

1. **Name edit between renders** — old `<old>-voice.mp3` is removed; same name twice is NOT removed (would unlink the file just written). Verified by curl in Task 3, Step 5.
2. **Blank / whitespace-only / over-cap script** — 400 with a readable message, never an engine crash; Render disabled client-side. Curl in Task 3, Step 4; counter in Task 5 manual check.
3. **Script opening on `-`** — must not be read as a `tts.py` option. Pinned in Task 2's test (script starts with `"- "`).
4. **Engine reading only the first chunk** — a >256-char script must come back longer than one chunk's worth of audio. Pinned in Task 2 (duration > 15s on a ~520-char script; one chunk ≈ 12s).
5. **Reload mid-edit** — script and name survive. Pinned in Task 4's `savedScript` round-trip test; leaving the phase pauses audio and revokes the blob (Task 5 manual check).

---

### Task 1: Output names — `scriptName` / `isScriptName`

**Files:**
- Modify: `server/ffmpeg.ts` (beside `cutName` ~line 126 and `isCutName` ~line 218)
- Test: `server/ffmpeg.test.ts` (beside the `cutName` describes ~line 186)

**Interfaces:**
- Produces: `scriptName(base: string): string`, `isScriptName(name: unknown): name is string` (both exported from `server/ffmpeg.ts`).

- [ ] **Step 1: Write the failing tests** — add `scriptName, isScriptName` to the import list from `./ffmpeg.ts` at the top of `server/ffmpeg.test.ts`, then append:

```ts
describe("scriptName", () => {
  it("slugifies the base and marks it as a voice file", () => {
    expect(scriptName("Hôm nay trời đẹp quá")).toBe("hom-nay-troi-dep-qua-voice.mp3");
    expect(scriptName("Tập 3")).toBe("tap-3-voice.mp3");
  });

  it("always produces a name isScriptName accepts", () => {
    for (const base of ["Hôm nay", "2024", "!!!", "  a  b  ", "Đà Nẵng"]) {
      expect(isScriptName(scriptName(base))).toBe(true);
    }
  });
});

describe("scriptName — the traversal guard", () => {
  it("accepts what scriptName emits", () => {
    expect(isScriptName("an-com-chua-voice.mp3")).toBe(true);
    expect(isScriptName("a-voice.mp3")).toBe(true);
    expect(isScriptName("tap-3-voice.mp3")).toBe(true);
  });

  it("rejects traversal", () => {
    expect(isScriptName("../secret-voice.mp3")).toBe(false);
    expect(isScriptName("a/b-voice.mp3")).toBe(false);
    expect(isScriptName("a\\b-voice.mp3")).toBe(false);
    expect(isScriptName("/etc/passwd")).toBe(false);
    expect(isScriptName("..")).toBe(false);
  });

  it("rejects everything slugify could not have produced", () => {
    expect(isScriptName("An-Com-voice.mp3")).toBe(false); // uppercase
    expect(isScriptName("ăn-cơm-voice.mp3")).toBe(false); // diacritics
    expect(isScriptName("-a-voice.mp3")).toBe(false); // leading dash
    expect(isScriptName("a--b-voice.mp3")).toBe(false); // doubled dash
    expect(isScriptName("a b-voice.mp3")).toBe(false); // space
    expect(isScriptName("-voice.mp3")).toBe(false); // empty slug
    expect(isScriptName("a-voice.mp3.part")).toBe(false);
    expect(isScriptName("a-voice.mp4")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isScriptName(undefined)).toBe(false);
    expect(isScriptName(null)).toBe(false);
    expect(isScriptName(42)).toBe(false);
    expect(isScriptName(["a-voice.mp3"])).toBe(false);
  });

  it("is disjoint from the other two producers", () => {
    expect(isCutName(scriptName("ads"))).toBe(false);
    expect(isOutName(scriptName("ads"))).toBe(false);
    expect(isScriptName(cutName("ads", 1))).toBe(false);
    expect(isScriptName(cutName("ads voice", 2))).toBe(false);
    expect(isScriptName(outName("ads", 0, 60))).toBe(false);
  });
});
```

(`isCutName`, `isOutName`, `cutName`, `outName` are already imported by this file; check the import list and add any that are missing.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run server/ffmpeg.test.ts -t scriptName`
Expected: FAIL — `scriptName is not a function` (or a missing-export error).

- [ ] **Step 3: Implement** — in `server/ffmpeg.ts`, after `cutName`/`cutStem`:

```ts
/** The script reader's one mp3 — the name the user typed, slugified, plus a
 *  fixed `-voice` marker.
 *
 *  Deterministic in the name alone, so re-rendering after a script edit
 *  overwrites itself; only a NAME edit leaves a file behind, which is what
 *  `/api/read`'s `prev` sweep is for. */
export function scriptName(base: string): string {
  return `${slugify(base)}-voice.mp3`;
}
```

and after `isCutName`:

```ts
/** Anchored to exactly what `scriptName` emits — a third producer, a third
 *  pattern, rather than a widened `OUT_NAME` or `CUT_NAME`. Disjoint from
 *  `CUT_NAME` by construction: one ends `-voice.mp3`, the other
 *  `-<digits>.mp3`.
 *
 *  Like `isCutName`, this gates a client string that names a file to
 *  DELETE (`/api/read`'s `prev`). */
const SCRIPT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*-voice\.mp3$/;

export function isScriptName(name: unknown): name is string {
  return typeof name === "string" && SCRIPT_NAME.test(name);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run server/ffmpeg.test.ts`
Expected: PASS, every test in the file.

- [ ] **Step 5: Mutation check** — temporarily change `SCRIPT_NAME` to `/^.*-voice\.mp3$/`, rerun Step 4, confirm the traversal tests FAIL, then revert.

- [ ] **Step 6: Hand off** — proposed commit: `feat(read): scriptName and its traversal guard`

---

### Task 2: `server/script.ts` — script → mp3

**Files:**
- Create: `server/script.ts`
- Test: `server/script.test.ts`

**Interfaces:**
- Consumes: `speak(text, dir, out, voice): Promise<number>` and `VOICE` from `server/starter.ts`; `MP3_QUALITY` from `server/cut.ts`; `toolError` from `server/errors.ts`.
- Produces: `scriptMp3(script: string, voice: string, dir: string, out: string): Promise<void>` — writes `dir/script.wav` (scratch) and `out` (mp3). Caller owns both paths.

- [ ] **Step 1: Write the failing test** — `server/script.test.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scriptMp3 } from "./script.ts";
import { VOICE } from "./starter.ts";

const run = promisify(execFile);
let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vstack-script-test-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scriptMp3", () => {
  // Real engine, so it pays the ~4.2s model load plus synthesis, and the
  // full suite runs it beside other real encodes — the same reason
  // server/starter.test.ts carries an explicit timeout.
  it("reads a multi-chunk script into one mp3", async () => {
    const para =
      "Hôm nay chúng ta sẽ nói về cách làm video ngắn cho kênh của mình. " +
      "Đầu tiên, bạn cần chọn đoạn hay nhất trong buổi phát trực tiếp. ";
    // Opens on "-": the text must travel by file, never argv, or tts.py
    // would read it as an option.
    const script = `- ${para}${para}\n\n${para}${para}`;
    // VieNeu chunks at 256 chars. One chunk is ~12s of audio at the measured
    // ~20 chars/s, so > 15s is what fails if only the first chunk is read.
    expect(script.length).toBeGreaterThan(256);

    const out = join(dir, "out.mp3");
    await scriptMp3(script, VOICE, dir, out);

    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=format_name,duration",
      "-of", "json",
      out,
    ]);
    const format = (JSON.parse(stdout) as { format: { format_name: string; duration: string } })
      .format;
    expect(format.format_name).toBe("mp3");
    expect(Number(format.duration)).toBeGreaterThan(15);
  }, 180_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run server/script.test.ts`
Expected: FAIL — cannot resolve `./script.ts`.

- [ ] **Step 3: Implement** — `server/script.ts`:

```ts
/** The script reader's one job: a whole voiceover script, read aloud into
 *  one mp3.
 *
 *  Sits BESIDE `cut.ts`, `lofi.ts`, `longform.ts` and `starter.ts`: every
 *  path is the caller's, so it needs neither `MEDIA_DIR` nor `OUT_DIR`. It
 *  reaches into two siblings on purpose — `speak` because `starter.ts` stays
 *  the only thing that ever spawns `tts.py`, and `MP3_QUALITY` because two
 *  mp3 producers in one app should not encode at two qualities. */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { MP3_QUALITY } from "./cut.ts";
import { toolError } from "./errors.ts";
import { speak } from "./starter.ts";

const run = promisify(execFile);

/** Speaks `script` in `voice` and encodes it to mp3 at `out`.
 *
 *  The whole script goes to the engine in ONE call. VieNeu v3 Turbo chunks
 *  it itself (256 chars, joined with a short silence); chunking here as well
 *  would double the pauses and could split a sentence the engine would have
 *  kept whole.
 *
 *  ponytail: one blocking run, no progress. Measured at RTF ~0.17, so the
 *  `SCRIPT_MAX` cap synthesises in ~2 minutes, inside Node's 300s
 *  `requestTimeout`. Progress and chunk-resume are the upgrade if scripts
 *  outgrow that. */
export async function scriptMp3(
  script: string,
  voice: string,
  dir: string,
  out: string,
): Promise<void> {
  const wav = join(dir, "script.wav");
  await speak(script, dir, wav, voice);
  try {
    await run("ffmpeg", [
      "-v", "error",
      "-i", wav,
      "-c:a", "libmp3lame",
      "-q:a", MP3_QUALITY,
      "-y", out,
    ]);
  } catch (err) {
    throw toolError("ffmpeg", err);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run server/script.test.ts`
Expected: PASS (takes ~15-30s).

- [ ] **Step 5: Hand off** — proposed commit: `feat(read): scriptMp3, a whole script to one mp3`

---

### Task 3: `POST /api/read` and `/api/reveal`

**Files:**
- Modify: `src/defaults.ts` (append `SCRIPT_MAX`)
- Modify: `server/index.ts` — imports (top), new route before `/api/say` (~line 1388), `/api/reveal` check (~line 1332)

**Interfaces:**
- Consumes: `scriptName`, `isScriptName` (Task 1); `scriptMp3` (Task 2); existing `readTitle`, `str`, `send`, `json`, `knownVoices`, `inFlight`, `outPath`, `OUT_DIR`.
- Produces: `SCRIPT_MAX` in `src/defaults.ts`; `POST /api/read` taking `{ script, voice, name, prev? }`, answering `audio/mpeg` bytes with header `x-vstack-name: <name>`.

- [ ] **Step 1: Add the constant** — append to `src/defaults.ts`:

```ts
/** The script reader's cap, in characters after trimming. Shared so the
 *  panel's counter and `/api/read`'s check cannot disagree.
 *
 *  Measured on VieNeu v3 Turbo here: 979 chars → 48.4s of audio, so ~20
 *  chars/s and 15,000 is ~12 minutes of voiceover. At RTF ~0.17 that
 *  synthesises in ~2 minutes, inside Node's 300s request timeout — raise
 *  this and the request can die there before the engine finishes. */
export const SCRIPT_MAX = 15_000;
```

- [ ] **Step 2: Wire imports in `server/index.ts`** — add `SCRIPT_MAX` to the existing `../src/defaults.ts` import; add `isScriptName, scriptName` to the existing `./ffmpeg.ts` import block; add `import { scriptMp3 } from "./script.ts";` beside the other sibling-module imports.

- [ ] **Step 3: Add the route** — immediately before `if (req.url === "/api/say") {`:

```ts
  // The script reader. Bytes back rather than JSON, the /api/say posture,
  // which is what keeps /out/ untaught about .mp3 — the player plays a blob.
  // Unlike /api/say the file is ALSO kept: it is an artifact the user meant
  // to make, so it lands in OUT_DIR beside the cutter's mp3s.
  if (req.url === "/api/read") {
    const raw = await json<Record<string, unknown>>(req);
    // Trimmed before measuring, the same count the panel shows.
    const script = str(raw.script, "script").trim();
    if (script === "") return send(res, 400, { error: "script must not be blank." });
    if (script.length > SCRIPT_MAX) {
      return send(res, 400, { error: `script must be at most ${SCRIPT_MAX} characters.` });
    }
    // argv of tts.py — a table lookup, as /api/export and /api/say do.
    const voiceName = str(raw.voice, "voice");
    if (!knownVoices().some((v) => v.name === voiceName)) {
      return send(res, 400, { error: `Unknown voice ${voiceName}.` });
    }
    const name = scriptName(readTitle(raw.name, "name"));
    // The one client string here that names a file to DELETE, so it goes
    // through the anchored pattern before anything else touches it.
    let prev: string | null = null;
    if (raw.prev !== undefined && raw.prev !== null) {
      if (!isScriptName(raw.prev)) return send(res, 400, { error: "Bad prev." });
      prev = raw.prev;
    }

    await mkdir(OUT_DIR, { recursive: true });
    const dir = await mkdtemp(join(tmpdir(), "vstack-read-"));
    // A partial in OUT_DIR (same volume, so the rename cannot EXDEV), with a
    // UUID so two concurrent renders under one name cannot share an fd, and
    // tracked so a `node --watch` SIGTERM unlinks it.
    const partial = outPath(name).replace(/\.mp3$/, `.${randomUUID()}.part.mp3`);
    inFlight.add(partial);
    try {
      await scriptMp3(script, voiceName, dir, partial);
      await rename(partial, outPath(name));
      // AFTER the rename, so a failed render leaves the previous file
      // intact; skipped when the name did not move, or it would unlink the
      // file just written; through outPath, because rm on a bare name
      // resolves against process.cwd() and force:true hides the ENOENT.
      if (prev !== null && prev !== name) {
        const stale = prev;
        await rm(outPath(stale), { force: true }).catch((err: unknown) => {
          console.warn(`vstack: could not remove the previous out/${stale}:`, err);
        });
      }
      const mp3 = await readFile(outPath(name));
      res.writeHead(200, {
        "content-type": "audio/mpeg",
        "content-length": mp3.length,
        "x-vstack-name": name,
      });
      return void res.end(mp3);
    } finally {
      inFlight.delete(partial);
      await rm(partial, { force: true }).catch((err: unknown) => {
        console.error("vstack: read partial cleanup failed:", err);
      });
      await rm(dir, { recursive: true, force: true });
    }
  }
```

- [ ] **Step 4: Teach `/api/reveal`** — change

```ts
    if (!isOutName(body.name) && !isCutName(body.name)) {
```

to

```ts
    if (!isOutName(body.name) && !isCutName(body.name) && !isScriptName(body.name)) {
```

and extend the comment above it: "Three producers, three anchored patterns — see isCutName and isScriptName."

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Verify by hand with curl** — start `pnpm server` in the background (if one is already running, `node --watch` has restarted it). Then:

```bash
V="Thùy Dung"
# 400s
curl -s -X POST localhost:8787/api/read -H 'content-type: application/json' -d '{"script":"   \n ","voice":"'"$V"'","name":"t"}'
curl -s -X POST localhost:8787/api/read -H 'content-type: application/json' -d '{"script":"chào","voice":"nope","name":"t"}'
curl -s -X POST localhost:8787/api/read -H 'content-type: application/json' -d '{"script":"chào","voice":"'"$V"'","name":"t","prev":"../x-voice.mp3"}'
node -e 'console.log(JSON.stringify({script:"a".repeat(15001),voice:process.argv[1],name:"t"}))' "$V" | curl -s -X POST localhost:8787/api/read -H 'content-type: application/json' -d @-
```

Expected, in order: `script must not be blank.`, `Unknown voice nope.`, `Bad prev.`, `script must be at most 15000 characters.`

```bash
# render, rename, same-name re-render
curl -s -D - -o /tmp/a.mp3 -X POST localhost:8787/api/read -H 'content-type: application/json' -d '{"script":"Xin chào các bạn.","voice":"'"$V"'","name":"thu a"}' | grep -i x-vstack-name
ls ~/Desktop/vstack/thu-a-voice.mp3
curl -s -o /tmp/b.mp3 -X POST localhost:8787/api/read -H 'content-type: application/json' -d '{"script":"Xin chào các bạn.","voice":"'"$V"'","name":"thu b","prev":"thu-a-voice.mp3"}'
ls ~/Desktop/vstack/thu-a-voice.mp3 ~/Desktop/vstack/thu-b-voice.mp3
curl -s -o /tmp/c.mp3 -X POST localhost:8787/api/read -H 'content-type: application/json' -d '{"script":"Xin chào.","voice":"'"$V"'","name":"thu b","prev":"thu-b-voice.mp3"}'
ls ~/Desktop/vstack/thu-b-voice.mp3 ~/Desktop/vstack/*.part.mp3
curl -s -X POST localhost:8787/api/reveal -H 'content-type: application/json' -d '{"name":"thu-b-voice.mp3"}'
```

Expected: `x-vstack-name: thu-a-voice.mp3`; after the second call `thu-a` is gone ("No such file") and `thu-b` exists; after the third `thu-b` still exists and no `.part.mp3` is left; reveal answers `{"ok":true}` and Finder opens. Clean up the two test files with `node -e 'require("fs").rmSync(...)'`, never shell `rm`.

- [ ] **Step 7: Hand off** — proposed commit: `feat(read): POST /api/read, and /api/reveal accepts a script mp3`

---

### Task 4: Client persistence and the fetch wrapper

**Files:**
- Modify: `src/state.ts` (beside `savedVoice`/`saveVoice` ~line 371)
- Modify: `src/api.ts` (beside `say` ~line 321)
- Test: `src/state.test.ts`

**Interfaces:**
- Produces: `savedScript(): { name: string; text: string }`, `saveScript(name: string, text: string): void` (from `src/state.ts`); `read(body: { script: string; voice: string; name: string; prev?: string }): Promise<{ blob: Blob; name: string }>` (from `src/api.ts`).

- [ ] **Step 1: Write the failing test** — add `saveScript, savedScript` to the `./state.ts` import in `src/state.test.ts`, then append (the file's `beforeEach` already installs a fresh Map-backed `localStorage`; if it does not reset per test, call `globalThis.localStorage = makeStorage()` at the top of each test the way the file already does):

```ts
describe("savedScript / saveScript", () => {
  it("is empty before anything was saved", () => {
    expect(savedScript()).toEqual({ name: "", text: "" });
  });

  it("round-trips the script and its name, newlines and diacritics intact", () => {
    const text = "Đoạn một.\n\nĐoạn hai — có dấu.";
    saveScript("Tập 1", text);
    expect(savedScript()).toEqual({ name: "Tập 1", text });
  });

  it("lives under its own keys, never in a per-video record", () => {
    saveScript("a", "b");
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    expect(keys.sort()).toEqual(["vstack:script", "vstack:script-name"]);
  });
});
```

(If the stub's `makeStorage()` does not implement `length`/`key`, replace the last assertion with `expect(localStorage.getItem("vstack:script")).toBe("b")` and `expect(localStorage.getItem("vstack:script-name")).toBe("a")`.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/state.test.ts -t savedScript`
Expected: FAIL — `savedScript is not a function`.

- [ ] **Step 3: Implement** — `src/state.ts`, after `saveVoice`:

```ts
/** The script reader's text and file name. Global keys of their own, the
 *  `vstack:voice` shape: a script is not a property of any video, and a
 *  ten-minute script lost to a reload is real data loss — which is why this
 *  phase persists where the cutter does not. A function, not a value folded
 *  into `initial`, for `savedVoice`'s reason. */
const SCRIPT_KEY = "vstack:script";
const SCRIPT_NAME_KEY = "vstack:script-name";

export function savedScript(): { name: string; text: string } {
  return {
    name: localStorage.getItem(SCRIPT_NAME_KEY) ?? "",
    text: localStorage.getItem(SCRIPT_KEY) ?? "",
  };
}

export function saveScript(name: string, text: string): void {
  localStorage.setItem(SCRIPT_NAME_KEY, name);
  localStorage.setItem(SCRIPT_KEY, text);
}
```

and `src/api.ts`, after `say`:

```ts
/** The script read aloud, as mp3 bytes, plus the name the server filed it
 *  under in OUT_DIR. Bytes rather than a URL because `/out/` streams only
 *  `.mp4`; the panel plays a blob. `prev` is the last name this session
 *  rendered, so a renamed script does not strand the old file. */
export async function read(body: {
  script: string;
  voice: string;
  name: string;
  prev?: string;
}): Promise<{ blob: Blob; name: string }> {
  const res = await post("/api/read", body);
  return { blob: await res.blob(), name: res.headers.get("x-vstack-name") ?? "" };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/state.test.ts && pnpm exec tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Hand off** — proposed commit: `feat(read): persist the script, and the /api/read wrapper`

---

### Task 5: The `reading` phase UI, plus docs

**Files:**
- Modify: `src/state.ts` (`Phase` union, ~line 11)
- Modify: `src/main.ts` — imports; shell (~line 145); new module block + `renderReadBar`/`renderReadPanel` (place after the cutter's `renderCutting`, before `renderIdle` ~line 4185); `renderIdle` button (~line 4249); `render()` (~line 4259); space-key handler (~line 4550)
- Modify: `src/style.css` (after `.moments-panel`, ~line 409)
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `savedScript`, `saveScript`, `api.read`, `api.reveal` (Task 4); `SCRIPT_MAX` (Task 3); existing `el`, `guard`, `setState`, `getState`, `renderVoicePicker(s)`, `currentVoice(s)`.

- [ ] **Step 1: Phase** — in `src/state.ts` add `| "reading"` to `Phase`, after `| "cutting"`.

- [ ] **Step 2: Imports** — in `src/main.ts` add `SCRIPT_MAX` to the `./defaults.ts` import and `saveScript, savedScript` to the `./state.ts` value import.

- [ ] **Step 3: Shell node** — after the `cutVideo` declaration:

```ts
// The script reader's panel. Persistent and only ever hidden, like every
// other child of sourceSlot — see the module-level comment on the shell.
const readPanel = el("div", { className: "read-panel", hidden: true });
```

and add `readPanel,` to the `sourceSlot` children list after `cutVideo,`.

- [ ] **Step 4: Module state, panel and bar** — insert before `function renderIdle`:

```ts
// The script reader. Text and name are module-scoped rather than AppState:
// every keystroke would otherwise be a setQuiet with nothing to re-render,
// and they persist through their own keys (saveScript) instead of save().
const storedScript = savedScript();
let scriptText = storedScript.text;
let scriptBase = storedScript.name;
/** The last name this session rendered — sent as `prev`. Unpersisted, like
 *  `/api/export`'s: a reload between two renames strands the older file. */
let readOut = "";
/** The blob URL behind readAudio. Released by render() on every render
 *  outside `reading` — the cutter's releaseCutUrl rule. */
let readUrl = "";
/** Assigned by the bar, flipped in place by the panel's inputs — the
 *  publishBtn pattern, since typing reaches no render. */
let readBtn: HTMLButtonElement | null = null;
// Persistent, so a render mid-typing (the voice list landing, say) cannot
// drop the caret or restart playback.
const readText = el("textarea", {
  className: "read-script",
  placeholder: "Dán kịch bản vào đây…",
  ariaLabel: "Script",
  value: scriptText,
});
const readCount = el("span", { className: "field-count" });
const readAudio = el("audio", { controls: true, preload: "auto", hidden: true });

const scriptReady = (): boolean => {
  const n = scriptText.trim().length;
  return n > 0 && n <= SCRIPT_MAX && scriptBase.trim() !== "";
};

/** Counter and Render button, in place. Counts the TRIMMED length, the same
 *  number `/api/read` checks. */
function syncRead(): void {
  const n = scriptText.trim().length;
  readCount.textContent = `${n}/${SCRIPT_MAX}`;
  readCount.classList.toggle("field-count-over", n > SCRIPT_MAX);
  if (readBtn) readBtn.disabled = getState().busy !== "" || !scriptReady();
}

readText.oninput = () => {
  scriptText = readText.value;
  saveScript(scriptBase, scriptText);
  syncRead();
};

/** Idempotent, which is what makes calling it on every other phase's render
 *  free. */
function releaseReadUrl(): void {
  if (readUrl === "") return;
  URL.revokeObjectURL(readUrl);
  readUrl = "";
  readAudio.removeAttribute("src");
  readAudio.load();
}

function renderReadBar(s: AppState): Node[] {
  const busy = s.busy !== "";
  const back = el("button", { className: "btn-gray", textContent: "← Back", disabled: busy });
  back.onclick = () => setState({ phase: "idle", error: "" });

  const go = el("button", {
    className: "btn-solid",
    textContent: "Render mp3",
    disabled: busy || !scriptReady(),
  });
  readBtn = go;
  go.onclick = () =>
    void guard("reading…", async () => {
      if (!scriptReady()) return;
      const { blob, name } = await api.read({
        script: scriptText,
        voice: currentVoice(getState()),
        name: scriptBase,
        ...(readOut !== "" ? { prev: readOut } : {}),
      });
      releaseReadUrl();
      readUrl = URL.createObjectURL(blob);
      readAudio.src = readUrl;
      readOut = name;
    });

  const end: Node[] = [];
  if (readOut !== "") {
    const show = el("button", { className: "btn-gray", textContent: "Show in Finder", disabled: busy });
    // Not guard()ed, the cutter's and preview bar's reason: revealing blocks
    // nothing, so success clears `error` itself and failure (the file
    // deleted from the Desktop since) reaches a callout.
    show.onclick = () => {
      void api
        .reveal(readOut)
        .then(() => setState({ error: "" }))
        .catch((err: unknown) => {
          setState({ error: err instanceof Error ? err.message : String(err) });
        });
    };
    end.push(show);
  }
  end.push(go);
  return [el("div", { className: "bar-row" }, back, el("div", { className: "bar-end" }, ...end))];
}

function renderReadPanel(s: AppState): Node[] {
  const busy = s.busy !== "";
  readText.disabled = busy;
  readAudio.hidden = readUrl === "";
  const name = el("input", {
    type: "text",
    className: "field-grow",
    placeholder: "Tên file",
    ariaLabel: "File name",
    value: scriptBase,
    disabled: busy,
  });
  name.oninput = () => {
    scriptBase = name.value;
    saveScript(scriptBase, scriptText);
    syncRead();
  };
  syncRead();
  const field = (label: string, control: Node, extra?: Node) =>
    el(
      "label",
      { className: "field" },
      el("span", { className: "field-label" }, label, extra ?? el("span")),
      control,
    );
  return [
    field("Name", name),
    field("Voice", renderVoicePicker(s)),
    field("Script", readText, readCount),
    readAudio,
  ];
}
```

- [ ] **Step 5: Idle button** — in `renderIdle`, after the `cutter` button:

```ts
  const reader = el("button", {
    className: "btn-gray",
    textContent: "Script reader →",
    title: "Read a script aloud into an mp3",
    disabled: busy,
  });
  // No `mode` here, for the chat button's reason: this journey reaches
  // neither `preview` nor `/api/publish`.
  reader.onclick = () => setState({ phase: "reading", error: "" });
```

and change the last row to `el("div", { className: "bar-row" }, long, lofi, chat, cutter, reader)`.

- [ ] **Step 6: `render()`** — four edits:

1. `outPlaceholder.hidden = s.phase !== "idle" && s.phase !== "moments" && s.phase !== "cutting" && s.phase !== "reading";`
2. After the `if (s.phase !== "cutting") { … }` departure block:

```ts
  // The reader's departure case, the cutter's rule: driven by the phase,
  // not by ← Back, so a later route out cannot leak the blob or leave the
  // voiceover playing under the next phase (display:none pauses nothing).
  if (s.phase !== "reading") {
    readAudio.pause();
    releaseReadUrl();
  }
```

3. After `momentsPanel.hidden = …`: `readPanel.hidden = s.phase !== "reading";`
4. Before the final `else {` (the preview branch) add:

```ts
  } else if (s.phase === "reading") {
    // Bar first: it assigns readBtn, which the panel's syncRead flips.
    barSlot.replaceChildren(...renderReadBar(s));
    readPanel.replaceChildren(...renderReadPanel(s));
```

and in the badge condition add `s.phase !== "reading" &&` after `s.phase !== "cutting" &&` (and extend its comment: "`reading` is excluded for the same reason").

- [ ] **Step 7: Space key** — in the keydown handler, before the final `else { return; … }`:

```ts
  } else if (phase === "reading") {
    // Nothing to play until a render lands; play() on an empty element rejects.
    if (readUrl === "") return;
    if (readAudio.paused) void readAudio.play();
    else readAudio.pause();
```

(`TEXTAREA` and `AUDIO` are already in `SPACE_DEAF`, so typing a space in the script never reaches this.)

- [ ] **Step 8: CSS** — `src/style.css`, after the `.moments-panel` rule:

```css
/* Mirrors .lofi-panel, for its reason: `.source` clips rather than scrolls,
   and `height: 100%` is what gives the panel a box to fill. The script
   textarea takes the leftover height through the existing
   `.field:has(textarea)` rule. */
.read-panel {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  overflow-y: auto;
  text-align: left;
}
.read-panel audio { width: 100%; }
.field-count-over { color: var(--red-11); }
```

- [ ] **Step 9: Build and full suite**

Run: `pnpm build && pnpm test`
Expected: build clean; all tests pass (previous count + Task 1's 7 + Task 2's 1 + Task 4's 3).

- [ ] **Step 10: Verify in a real browser** — `pnpm server` and `pnpm dev`, open `http://localhost:5173`:
  1. Idle shows `Script reader →`; clicking it shows the panel, the out column keeps its placeholder, the status row shows only the `reading` badge.
  2. Render is disabled with an empty name or script; paste 15,001 chars → counter turns red, Render disabled; trim back → enabled.
  3. Type a name + two paragraphs, reload → both survive.
  4. Render → busy badge, then an audio player appears and plays; Space toggles it when focus is outside the textarea; typing a space in the textarea inserts one.
  5. Show in Finder reveals `<slug>-voice.mp3`.
  6. Rename, render again → the old file is gone from `~/Desktop/vstack`.
  7. Start playback, click `← Back` → audio stops; return → no player (blob released), Show in Finder still present.

- [ ] **Step 11: CLAUDE.md** — update:
  - The spec list paragraph: append `docs/specs/2026-10-02-vstack-script-reader-design.md` — a SIXTH journey and third dead end, `idle` → `reading` → `idle`, script → one `<slug>-voice.mp3` in `OUT_DIR`, claims no `mode`.
  - Commands: test count to the new total from Step 9.
  - Architecture: add `server/script.ts   scriptMp3 (the script reader's one pass — speak + one mp3 encode)`; in `server/ffmpeg.ts`'s line add `scriptName/isScriptName`; `server/index.ts` "18 routes (17 POST …)" → "19 routes (18 POST …)"; `src/api.ts` "16 fetch wrappers" → "17"; `src/main.ts` "all seven phases" → "all nine phases" (the `Phase` union is eight members today, nine with `reading`); and the "Eight phases" sentence under Architecture → "Nine phases … plus three dead ends".
  - Layering paragraph: one sentence — `script.ts` sits beside `cut.ts` and imports `speak` from `starter.ts` and `MP3_QUALITY` from `cut.ts`, so `starter.ts` stays the only thing that spawns `tts.py`.
  - Invariants: one short entry — "`/api/read` answers bytes, `/out/` stays mp4-only; `isScriptName` is the third anchored mp3/mp4 pattern and gates `prev`, which names a file to delete; the sweep runs after the rename and skips `prev === name`."

- [ ] **Step 12: Hand off** — proposed commit: `feat(read): the reading phase — script panel, render, playback`

---

## Skipped (per spec)

Progress / chunk-resume, pause markup, speed control, writing into the lofi speeches folder.
