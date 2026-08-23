# vstack preview-and-publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exports land in a gitignored `out/` at the project root, and a fourth
phase previews the result and uploads it to YouTube as a private draft.

**Architecture:** `/api/export` stops streaming an mp4 attachment and instead
renames a finished render into `out/`, answering with JSON. A new `preview`
phase plays that file from `/out/<name>` (Vite serves the project root
statically, which is already how `/media/…` reaches the browser) and posts to
three new routes: `/api/reveal`, `/api/publish`, `/api/publish/progress`.
OAuth is a one-off setup script, not a runtime feature, so no route ever needs
`GET` and the phase machine never learns what a token is.

**Tech Stack:** Node 24 running `.ts` directly with type stripping, `node:http`
+ `node:https`, vanilla TS + Vite on the client, vitest. No new dependencies.

**Spec:** `docs/specs/2026-08-23-vstack-publish-design.md`

## Global Constraints

- **No new npm dependencies.** The repo's only dependency is `@radix-ui/colors`.
  `googleapis` is explicitly rejected in the spec.
- **Node runs `server/*.ts` and `scripts/*.ts` with type stripping.** Non-erasable
  TS syntax is a *boot crash*, not a compile error. No `enum`, no `namespace`,
  no constructor parameter properties. `erasableSyntaxOnly: true` catches it in `tsc`.
- **`import type` for type-only imports; explicit `.ts` extensions on relative imports.**
- **No `any`, no default exports, no barrel files.**
- **No `console.log`/`.info`** — `.error`/`.warn` only.
- **`strict` + `noUncheckedIndexedAccess`** — indexing yields `T | undefined`;
  guard with `?? fallback`, never `!`.
- **Uploads are `privacyStatus: "private"`.** An unaudited YouTube Data API
  project has every `videos.insert` locked to private; asking for anything
  else is a request YouTube refuses.
- **`selfDeclaredMadeForKids` is required by the API** and is `false`.
- **YouTube title cap is 100 characters.** `starterTitle` allows 200.
- **Credentials live in `~/.vstack/`, never under the project root** — Vite
  serves the project root statically, so a `secrets/` directory here would be
  readable at `/secrets/youtube-token.json` by any page the browser has open.
- **Layering stays acyclic:** `errors ← {ffmpeg, starter, youtube} ← {ytdlp, mask} ← index`.
  `youtube.ts` imports `errors.ts` only.
- Run the suite with `pnpm test`, the gate with `pnpm build` (`tsc && vite build`).
- `ponytail:` comments mark deliberate simplifications and name the upgrade path.

---

## File Structure

**Created**
- `server/youtube.ts` — OAuth token handling, `buildSnippet`, the resumable
  upload, and the module-level upload progress. Errors-only layer.
- `server/youtube.test.ts` — `buildSnippet` only. No network.
- `scripts/youtube-auth.ts` — `pnpm youtube-auth`. The whole OAuth dance,
  once, outside the server.

**Modified**
- `.gitignore` — `out/`
- `server/ffmpeg.ts` — `OUT_DIR`, `outName`, `outPath`, `isOutName`
- `server/ffmpeg.test.ts` — the out-name tests
- `server/index.ts` — export route writes to `out/`; three new routes; soft boot check
- `src/api.ts` — `exportClip` returns JSON; `reveal`, `publish`, `publishProgress`
- `src/state.ts` — `"preview"` phase, seven new fields
- `src/main.ts` — `doExport` rewrite, `outVideoEl`, `ensurePreview`, `renderPreview`, `doPublish`
- `src/style.css` — `.out > video`, `.bar textarea`
- `package.json` — `youtube-auth` script
- `CLAUDE.md`, `README.md` — docs

---

### Task 1: `out/` names and the traversal guard

Pure functions and their tests. Nothing else changes, so the app still works
exactly as before at the end of this task.

**Files:**
- Modify: `.gitignore`
- Modify: `server/ffmpeg.ts` (add after `clipPath`, around line 26)
- Test: `server/ffmpeg.test.ts` (new `describe` block, after the imports)

**Interfaces:**
- Consumes: `slugify`, `mmss` from `src/format.ts`; `ROOT` (module-private in `ffmpeg.ts`)
- Produces:
  - `OUT_DIR: string`
  - `outName(title: string, start: number, end: number): string`
  - `outPath(name: string): string`
  - `isOutName(name: unknown): name is string`

- [ ] **Step 1: Add `out/` to `.gitignore`**

Insert after the `media/` line:

```
out/
```

- [ ] **Step 2: Write the failing tests**

Add to `server/ffmpeg.test.ts`. Extend the existing import from `./ffmpeg.ts`
to `{ assertBoxes, buildFilter, exportClip, isOutName, outName, probeFile }`.
Put the block immediately before `describe("buildFilter", …)`:

```ts
describe("outName", () => {
  it("slugs a Vietnamese title and pads both marks", () => {
    expect(outName("Ăn cơm chưa", 90, 125)).toBe("an-com-chua-0130-0205.mp4");
  });

  it("falls back to `clip` when a title slugs to nothing", () => {
    expect(outName("!!!???", 0, 30)).toBe("clip-0000-0030.mp4");
  });

  it("produces a name that isOutName accepts", () => {
    expect(isOutName(outName("Hôm nay trời đẹp quá", 3661, 3700))).toBe(true);
  });
});

// The one place this API takes a client-supplied path component. Everything
// else reconstructs paths from window bounds, so this is the check that
// decides which file a subprocess touches — it gets the same exhaustive
// treatment videoIdFrom gets.
describe("outName — the traversal guard", () => {
  it("accepts what outName emits", () => {
    expect(isOutName("an-com-chua-0130-0205.mp4")).toBe(true);
    expect(isOutName("clip-0000-0030.mp4")).toBe(true);
    expect(isOutName("a-0000-0001.mp4")).toBe(true);
  });

  it("rejects traversal", () => {
    expect(isOutName("../secret-0000-0001.mp4")).toBe(false);
    expect(isOutName("a/b-0000-0001.mp4")).toBe(false);
    expect(isOutName("a\\b-0000-0001.mp4")).toBe(false);
    expect(isOutName("/etc/passwd")).toBe(false);
    expect(isOutName("..")).toBe(false);
  });

  it("rejects anything slugify could not have produced", () => {
    expect(isOutName("An-Com-0130-0205.mp4")).toBe(false); // uppercase
    expect(isOutName("ăn-cơm-0130-0205.mp4")).toBe(false); // diacritics
    expect(isOutName("-lead-0000-0001.mp4")).toBe(false); // leading dash
    expect(isOutName("has space-0000-0001.mp4")).toBe(false);
  });

  it("rejects a malformed range or extension", () => {
    expect(isOutName("clip-130-205.mp4")).toBe(false); // mmss is 4 digits
    expect(isOutName("clip-0000-0030.mp4.txt")).toBe(false);
    expect(isOutName("clip-0000-0030.mov")).toBe(false);
    expect(isOutName("clip-0000-0030")).toBe(false);
  });

  it("rejects non-strings without throwing", () => {
    expect(isOutName(null)).toBe(false);
    expect(isOutName(42)).toBe(false);
    expect(isOutName(undefined)).toBe(false);
    expect(isOutName({ toString: () => "clip-0000-0030.mp4" })).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run server/ffmpeg.test.ts -t "outName"`
Expected: FAIL — `isOutName is not a function` / no export named `outName`.

- [ ] **Step 4: Implement**

In `server/ffmpeg.ts`, add to the imports:

```ts
import { mmss, slugify } from "../src/format.ts";
```

and add immediately after `clipPath`:

```ts
/** Finished shorts, beside the `media/` clip cache and gitignored the same
 *  way. Reachable from the browser at `/out/<name>` for exactly the reason
 *  `/media/<id>/<clip>.mp4` is: Vite's dev server serves the project root
 *  statically, so neither needs a route behind it. */
export const OUT_DIR = join(ROOT, "out");

/** The exported short's filename — deterministic in title and range, so
 *  re-exporting the same clip after a crop tweak overwrites rather than
 *  accumulating. `isOutName` below is anchored to exactly what this emits. */
export function outName(title: string, start: number, end: number): string {
  return `${slugify(title)}-${mmss(start)}-${mmss(end)}.mp4`;
}

export function outPath(name: string): string {
  return join(OUT_DIR, name);
}

/** Anchored to what `slugify` (lowercase `[a-z0-9-]`, never leading or
 *  trailing dash, never empty) and `mmss` (four or more digits, but four is
 *  the floor) can produce together. */
const OUT_NAME = /^[a-z0-9][a-z0-9-]*-\d{4,}-\d{4,}\.mp4$/;

/** The one client-supplied path component this API accepts. `/api/export`
 *  deliberately takes window bounds and reconstructs the cache filename
 *  itself, so there is nothing to validate there; preview breaks that,
 *  because publish and reveal both name a file that already exists. So the
 *  name is validated rather than reconstructed. No slash, no dot-dot, no
 *  backslash, no absolute path and no non-ASCII survives the pattern.
 *
 *  Takes `unknown`: it is called on a raw request-body field, and a
 *  `string` annotation there would be a compile-time claim about a value
 *  that arrives from the wire. */
export function isOutName(name: unknown): name is string {
  return typeof name === "string" && OUT_NAME.test(name);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run server/ffmpeg.test.ts -t "outName"`
Expected: PASS (both describes, 8 tests).

- [ ] **Step 6: Run the full suite and the gate**

Run: `pnpm test && pnpm build`
Expected: all tests pass (131 + 8 = 139), `tsc` clean, build clean.

- [ ] **Step 7: Commit**

```bash
git -C . add .gitignore server/ffmpeg.ts server/ffmpeg.test.ts
git -C . commit -m "feat: out/ path helpers and the output-name trust boundary"
```

---

### Task 2: Exports land in `out/`, and a fourth phase plays them

The server stops streaming and the client stops downloading, so both sides
move together — split any smaller and the app is broken between tasks. At the
end of this task Export produces a file in `out/` and drops you into a
`preview` phase that plays it, with a way back to framing. No publish yet.

**Files:**
- Modify: `server/index.ts:1-20` (imports), `server/index.ts:215-270` (export route tail)
- Modify: `src/api.ts:88-97`
- Modify: `src/state.ts:6` (Phase), `:8-40` (AppState), `:42-60` (initial)
- Modify: `src/main.ts:5` (imports), `:470-480` (shell handles), `:569-615` (doExport), `:810-846` (render)
- Modify: `src/style.css:127-129`

**Interfaces:**
- Consumes: `OUT_DIR`, `outName`, `outPath` (Task 1)
- Produces:
  - `/api/export` → `{ name: string; url: string; size: number }`
  - `api.exportClip(...): Promise<ExportResult>` with `export type ExportResult`
  - `AppState.phase` includes `"preview"`; fields `outName`, `outUrl`, `outSize`,
    `ytTitle`, `ytDescription`, `ytTags`, `ytVideoId`
  - `renderPreview(): Node[]` in `src/main.ts`

- [ ] **Step 1: Rewrite the export route's tail**

In `server/index.ts`, change the imports:

```ts
// was: import { createReadStream, existsSync, statSync } from "node:fs";
import { existsSync, statSync } from "node:fs";
// was: import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
// delete entirely: import { pipeline } from "node:stream/promises";
// was: import { mmss, slugify } from "../src/format.ts";   <- delete, unused now
import {
  OUT_DIR,
  assertBoxes,
  clipPath,
  exportClip,
  outName,
  probeFile,
  reportCache,
} from "./ffmpeg.ts";
```

Replace the block from `const dir = await mkdtemp(...)` through the end of the
route (the `try`/`catch`/`finally` and its `return`) with:

```ts
    const dir = await mkdtemp(join(tmpdir(), "vstack-out-"));
    // Named after the starter title, not YouTube's: it is what the screen
    // says and reads aloud, so it is what the file is *about*.
    const name = outName(starterTitle, start, end);
    await mkdir(OUT_DIR, { recursive: true });
    const out = join(OUT_DIR, name);
    // Written under a partial name and renamed on success, the same way
    // fetchWindow does. Two reasons: a half-written file must never be
    // servable under a name the client can request, and the rename has to
    // stay on one volume — $TMPDIR is a different filesystem on macOS, so
    // rendering into the temp dir and renaming into the project risks EXDEV.
    const partial = out.replace(/\.mp4$/, ".part.mp4");
    // The composite lands here first; the starter screen is prepended onto
    // it in a second pass.
    const body = join(dir, "body.mp4");
    const art = join(dir, "title.png");

    try {
      await writeFile(art, titlePng);
      await exportClip({
        input,
        start: start - windowStart,
        duration: end - start,
        layout,
        boxes,
        source: { w: source.width, h: source.height },
        // Rendered on first export of each layout and cached from then on,
        // keyed on the layout id plus GUTTER and CORNER_RADIUS.
        mask: await ensureMask(layout),
        out: body,
      });
      const voice = join(dir, "voice.aiff");
      await prependStarter({
        main: body,
        title: art,
        voice,
        voiceSeconds: await speak(starterTitle, dir, voice),
        out: partial,
      });
      await rename(partial, out);
      const { size, mtimeMs } = statSync(out);
      console.warn(`vstack: exported out/${name} (${Math.round(size / 1e6)} MB)`);
      // Nothing streams any more, so the whole headers-already-sent dance
      // this route used to need is gone with it.
      return send(res, 200, {
        name,
        // The mtime is load-bearing, not decoration. The name is stable
        // across re-exports, so without a cache-buster the <video> would
        // re-show the previous render and a crop fix would look like it did
        // nothing.
        url: `/out/${name}?t=${Math.round(mtimeMs)}`,
        size,
      });
    } finally {
      // force:true only suppresses ENOENT. A throwing finally overrides even
      // a clean completion, escaping this route entirely — so this cleanup
      // must swallow its own errors rather than propagate them. The partial
      // is removed here rather than in a catch: on the success path the
      // rename already took it away, so one cleanup covers both.
      await rm(partial, { force: true }).catch((err: unknown) => {
        console.error("vstack: partial cleanup failed:", err);
      });
      await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
        console.error("vstack: temp dir cleanup failed:", err);
      });
    }
```

- [ ] **Step 2: Verify the route by hand**

Run `pnpm server` in one terminal and `pnpm dev` in another, load a short
video, frame it, type a starter title, press Export.

Expected: `out/<slug>-<mmss>-<mmss>.mp4` exists and plays in QuickTime; the
server logs `vstack: exported out/…`; the browser console shows the POST
answering `200` with a JSON body. The page will throw where `doExport` tries
to read a Blob — that is the next step, not a defect.

- [ ] **Step 3: Change the client's export call**

In `src/api.ts`, replace the `exportClip` return type and body:

```ts
/** What `/api/export` answers with now that it leaves the file on disk
 *  instead of streaming it back. `url` already carries the file's mtime as a
 *  cache-buster — the name is stable across re-exports, so re-showing the
 *  previous render is otherwise exactly what a <video> would do. */
export type ExportResult = { name: string; url: string; size: number };

export async function exportClip(body: {
  // …unchanged fields…
}): Promise<ExportResult> {
  return (await post("/api/export", body)).json() as Promise<ExportResult>;
}
```

- [ ] **Step 4: Add the phase and its state**

In `src/state.ts`:

```ts
export type Phase = "idle" | "trimming" | "framing" | "preview";
```

Add to `AppState`, after `boxes`:

```ts
  /** The finished export. Set by doExport, cleared by nothing — a new
   *  export overwrites them. None of these are persisted: an export belongs
   *  to the session that made it, so save()/restore() do not touch them. */
  outName: string;
  outUrl: string;
  outSize: number;
  /** The upload's metadata. `ytTitle` prefills from `starterTitle` sliced to
   *  YouTube's 100-character cap; the other two persist across a re-export
   *  within the session, because retyping a description after a crop fix is
   *  exactly the work this phase exists to remove. */
  ytTitle: string;
  ytDescription: string;
  ytTags: string;
  /** Set once the upload lands. Empty means "not published yet", which is
   *  what Publish is gated on. */
  ytVideoId: string;
```

and the matching entries in `initial`:

```ts
  outName: "",
  outUrl: "",
  outSize: 0,
  ytTitle: "",
  ytDescription: "",
  ytTags: "",
  ytVideoId: "",
```

- [ ] **Step 5: Rewrite `doExport` and add the preview shell**

In `src/main.ts`, narrow the format import (both `slugify` and `mmss` become
unused here — the server names the file now):

```ts
import { clock, parseTimestamp } from "./format.ts";
```

Replace `doExport`'s doc comment and its download tail:

```ts
/** Renders the clip and moves to the preview phase. The file lands in `out/`
 *  server-side, so there is no Blob, no object URL and no <a download> here
 *  any more — and no second copy of the filename either. The client used to
 *  rebuild the same slugify/mmss string purely to label a download, with a
 *  comment noting a mismatch between the two would be invisible; the server
 *  says it once now and this reads it. */
async function doExport(): Promise<void> {
  const s = getState();
  const layout = resolveLayout(s.layoutId);
  const boxes = s.boxes;
  if (boxes.length !== cellsOf(layout).length) return;
  // Same check the Export button is disabled on, and the same one the server
  // repeats: the title is spoken aloud on the starter screen, so a blank one
  // is a silent screen, not a missing caption.
  const starterTitle = s.starterTitle.trim();
  if (starterTitle === "") return;
  await guard("Rendering… (a 30s clip takes ~5–10s)", async () => {
    const out = await api.exportClip({
      videoId: s.videoId,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      start: s.start,
      end: s.end,
      starterTitle,
      titlePng: await renderTitleArt(starterTitle),
      layoutId: layout.id,
      boxes,
    });
    setState({
      phase: "preview",
      outName: out.name,
      outUrl: out.url,
      outSize: out.size,
      // YouTube caps the title at 100; starterTitle allows 200.
      ytTitle: getState().ytTitle || starterTitle.slice(0, 100),
      // A fresh file has not been published, whatever the last one did.
      ytVideoId: "",
    });
    // Inside the guard, after the await: a failed export throws before this
    // and rings nothing.
    bell();
  });
}
```

Add beside the `videoEl`/`canvasEl` declarations (around line 470):

```ts
/** The finished export, played from `/out/<name>`. Like the framing <video>
 *  it lives permanently in outSlot and is only ever hidden — see the
 *  module-level comment on the persistent shell. */
let outVideoEl: HTMLVideoElement | null = null;

/** Idempotent per URL. The URL carries the file's mtime, so a re-export
 *  under the same name is a genuinely different src and reloading is the
 *  point here — the opposite of ensureFraming, where reassigning the same
 *  src is the bug. */
function ensurePreview(url: string): void {
  if (!outVideoEl) {
    outVideoEl = el("video", { controls: true, loop: true, preload: "auto" });
    outSlot.append(outVideoEl);
  }
  const absolute = new URL(url, location.href).href;
  if (outVideoEl.src !== absolute) outVideoEl.src = absolute;
}
```

- [ ] **Step 6: Add `renderPreview` and wire up `render()`**

Add `renderPreview` just before `renderIdle`:

```ts
/** The preview bar: what came out, and the ways out of here. Publish joins
 *  it in a later task. */
function renderPreview(): Node[] {
  const s = getState();
  // Called for its effect: it mounts the output <video> into the persistent
  // outSlot and points it at this export.
  ensurePreview(s.outUrl);

  const back = el("button", { className: "btn-gray", textContent: "Frame again" });
  // Boxes, layout and marks are all untouched, so this lands back on the
  // same framing the export came from — a bad crop is one click from a
  // re-render.
  back.onclick = () => setState({ phase: "framing" });

  return [
    el(
      "div",
      { className: "bar-row" },
      el("span", { className: "badge badge-title", textContent: s.outName }),
      el("span", {
        className: "badge",
        textContent: `${(s.outSize / 1e6).toFixed(1)} MB`,
      }),
      el("div", { className: "bar-end" }, back),
    ),
  ];
}
```

In `render()`, widen the framing video's rule and add the output video:

```ts
  if (videoEl) {
    // Visible in preview too, paused, so the result can be compared against
    // what it was cut from. boxesLayer's own `!== "framing"` rule below is
    // what keeps the source from reading as still editable.
    videoEl.hidden = s.phase !== "framing" && s.phase !== "preview";
    if (s.phase !== "framing") videoEl.pause();
  }
  if (canvasEl) canvasEl.hidden = s.phase !== "framing";
  if (outVideoEl) {
    outVideoEl.hidden = s.phase !== "preview";
    if (s.phase !== "preview") outVideoEl.pause();
  }
```

and replace the bar dispatch's final `else`:

```ts
  if (s.phase === "idle") barSlot.replaceChildren(...renderIdle(s));
  else if (s.phase === "trimming") barSlot.replaceChildren(...renderTrimming());
  else if (s.phase === "framing") barSlot.replaceChildren(...renderFraming());
  else barSlot.replaceChildren(...renderPreview());
```

- [ ] **Step 7: Style the output video**

In `src/style.css`, extend the rule beside `.out > canvas` (line ~128):

```css
.out > canvas,
.out > video { width: 100%; height: 100%; display: block; }
```

- [ ] **Step 8: Verify by hand**

With `pnpm server` and `pnpm dev` running: load a video, frame it, Export.

Expected: the bar becomes the preview bar with the filename and size; the
right-hand column plays the finished short on loop with the starter screen at
the front; the left column shows the source video paused with **no crop
boxes**; the status row's phase badge reads `preview`; "Frame again" returns to
framing with the boxes exactly where they were; a second Export overwrites the
same file and the player shows the **new** render (this is the `?t=` mtime
doing its job — check by moving a crop box first).

- [ ] **Step 9: Run the suite and the gate**

Run: `pnpm test && pnpm build`
Expected: 139 pass; `tsc` clean. (`state.test.ts` covers `save()` gating, which
is untouched — the new fields are deliberately not persisted.)

- [ ] **Step 10: Commit**

```bash
git -C . add server/index.ts src/api.ts src/state.ts src/main.ts src/style.css
git -C . commit -m "feat: exports land in out/ and a preview phase plays them"
```

---

### Task 3: Show in Finder

**Files:**
- Modify: `server/index.ts` (new route, after `/api/export`)
- Modify: `src/api.ts`
- Modify: `src/main.ts` (`renderPreview`)

**Interfaces:**
- Consumes: `isOutName`, `outPath` (Task 1)
- Produces: `POST /api/reveal {name} → {ok: true}`; `api.reveal(name): Promise<void>`

- [ ] **Step 1: Add the route**

In `server/index.ts`, extend the `./ffmpeg.ts` import with `isOutName, outPath`
and add before the final `return send(res, 404, …)`:

```ts
  if (req.url === "/api/reveal") {
    const body = await json<Record<string, unknown>>(req);
    // The name is validated, not reconstructed — see isOutName. This is the
    // only path component this API takes from a client.
    if (!isOutName(body.name)) return send(res, 400, { error: "Bad output name." });
    const path = outPath(body.name);
    if (!existsSync(path)) return send(res, 404, { error: `${body.name} is not in out/.` });
    // Fire and forget: `open` has done its job by the time it exits, and
    // revealing a file is not worth an error banner. macOS is already a hard
    // dependency here — `say` and the Linh voice.
    execFile("open", ["-R", path], (err) => {
      if (err) console.warn(`vstack: could not reveal ${path}:`, err);
    });
    return send(res, 200, { ok: true });
  }
```

- [ ] **Step 2: Add the client wrapper**

In `src/api.ts`:

```ts
export async function reveal(name: string): Promise<void> {
  await post("/api/reveal", { name });
}
```

- [ ] **Step 3: Add the button**

In `renderPreview`, before the `return`:

```ts
  const finder = el("button", { textContent: "Show in Finder" });
  // Not wrapped in guard(): revealing a file is not a phase-blocking action,
  // and flipping `busy` for it would disable the whole bar for a blink. A
  // failure still surfaces the same way everything else does.
  finder.onclick = () => {
    void api.reveal(s.outName).catch((err: unknown) => {
      setState({ error: err instanceof Error ? err.message : String(err) });
    });
  };
```

and put it in the `bar-end` ahead of `back`:

```ts
      el("div", { className: "bar-end" }, finder, back),
```

- [ ] **Step 4: Verify by hand**

Export a clip, click **Show in Finder**.
Expected: Finder opens with the file selected inside `out/`. Then, in the
browser console, `fetch("/api/reveal", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({name:"../../etc/passwd"})})`
Expected: `400 {"error":"Bad output name."}` and no Finder window.

- [ ] **Step 5: Run the suite and the gate**

Run: `pnpm test && pnpm build`
Expected: 139 pass, clean.

- [ ] **Step 6: Commit**

```bash
git -C . add server/index.ts src/api.ts src/main.ts
git -C . commit -m "feat: reveal an export in Finder"
```

---

### Task 4: `buildSnippet` — the whole upload policy, pure and tested

No network in this task. `buildSnippet` is where every decision that is
awkward to change later lives, so it is the piece that gets tests.

**Files:**
- Create: `server/youtube.ts`
- Test: `server/youtube.test.ts`

**Interfaces:**
- Consumes: nothing (errors-only layer, and it needs nothing from `errors.ts` yet)
- Produces:
  - `export type SnippetInput = { title: string; description: string; tags: string }`
  - `export type VideoResource = { snippet: { title: string; description: string; tags: string[]; categoryId: string }; status: { privacyStatus: string; selfDeclaredMadeForKids: boolean } }`
  - `export function buildSnippet(input: SnippetInput): VideoResource`

- [ ] **Step 1: Write the failing tests**

Create `server/youtube.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildSnippet } from "./youtube.ts";

const base = { title: "Ăn cơm chưa", description: "", tags: "" };

describe("buildSnippet", () => {
  it("trims the title and caps it at YouTube's 100 characters", () => {
    expect(buildSnippet({ ...base, title: "  spaced  " }).snippet.title).toBe("spaced");
    // starterTitle allows 200, so this is reachable from the UI.
    const long = "a".repeat(200);
    expect(buildSnippet({ ...base, title: long }).snippet.title).toHaveLength(100);
  });

  it("appends #Shorts to an empty description", () => {
    expect(buildSnippet(base).snippet.description).toBe("#Shorts");
  });

  it("appends #Shorts below a written description", () => {
    expect(buildSnippet({ ...base, description: "Món ngon" }).snippet.description).toBe(
      "Món ngon\n\n#Shorts",
    );
  });

  it("does not append #Shorts twice when the user typed it", () => {
    const typed = "Món ngon #Shorts";
    expect(buildSnippet({ ...base, description: typed }).snippet.description).toBe(typed);
  });

  it("recognises the user's #shorts regardless of case", () => {
    const typed = "món ngon #shorts";
    expect(buildSnippet({ ...base, description: typed }).snippet.description).toBe(typed);
  });

  it("splits tags on commas and drops the empties", () => {
    expect(buildSnippet({ ...base, tags: "an uong, com ,, nau an " }).snippet.tags).toEqual([
      "an uong",
      "com",
      "nau an",
    ]);
  });

  it("returns no tags for a blank field", () => {
    expect(buildSnippet(base).snippet.tags).toEqual([]);
  });

  // Both of these are defaults whose wrong value is a real-world mistake, not
  // a failing assertion: an unaudited API project has every upload locked to
  // private anyway, and the API rejects an upload with no made-for-kids
  // declaration at all.
  it("uploads private and declares not-made-for-kids", () => {
    expect(buildSnippet(base).status).toEqual({
      privacyStatus: "private",
      selfDeclaredMadeForKids: false,
    });
  });

  it("files under People & Blogs", () => {
    expect(buildSnippet(base).snippet.categoryId).toBe("22");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run server/youtube.test.ts`
Expected: FAIL — cannot resolve `./youtube.ts`.

- [ ] **Step 3: Create `server/youtube.ts` with `buildSnippet`**

```ts
/** YouTube upload. Sits at the errors-only layer beside `ffmpeg.ts` and
 *  `starter.ts` rather than above them — it re-derives its own paths and
 *  never needs MEDIA_DIR or OUT_DIR, which the caller hands it instead.
 *
 *  An unaudited YouTube Data API project has every `videos.insert` upload
 *  locked to private viewing, so "publish" here means "upload a private
 *  draft" and the public flip stays a manual step in YouTube Studio. That is
 *  not a limitation to route around; it is what this module does. */

export type SnippetInput = { title: string; description: string; tags: string };

export type VideoResource = {
  snippet: { title: string; description: string; tags: string[]; categoryId: string };
  status: { privacyStatus: string; selfDeclaredMadeForKids: boolean };
};

/** YouTube rejects a longer title outright, and `starterTitle` — which this
 *  prefills from — allows 200. */
const TITLE_MAX = 100;
const SHORTS = "#Shorts";
/** People & Blogs. A picker would be an AppState field, a categories route
 *  and a save/restore migration for a value this tool never varies.
 *  ponytail: add one the day a second category is wanted. */
const CATEGORY = "22";

/** Everything the upload decides, in one pure function so the decisions can
 *  be tested without a network. */
export function buildSnippet(input: SnippetInput): VideoResource {
  const description = input.description.trim();
  return {
    snippet: {
      title: input.title.trim().slice(0, TITLE_MAX),
      // Case-insensitive, and only when absent: a user who typed the tag
      // themselves must not get it twice.
      description: /#shorts\b/i.test(description)
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

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run server/youtube.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the suite and the gate**

Run: `pnpm test && pnpm build`
Expected: 148 pass, clean.

- [ ] **Step 6: Commit**

```bash
git -C . add server/youtube.ts server/youtube.test.ts
git -C . commit -m "feat: buildSnippet, the upload's whole policy in one pure function"
```

---

### Task 5: `pnpm youtube-auth` and the soft boot check

Auth is setup, not a runtime feature. Keeping it in a script is what spares
`index.ts` a `GET` handler, a callback page and a "has the user finished
authorising yet" poll — `scripts/audition.ts` set this precedent.

**Files:**
- Modify: `server/youtube.ts` (credentials + `checkYouTube` + `exchangeCode`)
- Create: `scripts/youtube-auth.ts`
- Modify: `package.json` (scripts)
- Modify: `server/index.ts` (boot)

**Interfaces:**
- Consumes: nothing new
- Produces:
  - `CONFIG_DIR`, `CLIENT_PATH`, `TOKEN_PATH`, `AUTH_HINT`, `SCOPE: string`
  - `export type Client = { clientId: string; clientSecret: string }`
  - `readClient(): Client | null`
  - `readRefreshToken(): string | null`
  - `exchangeCode(client: Client, code: string, redirectUri: string): Promise<string>`
  - `checkYouTube(): void`

- [ ] **Step 1: Add credentials handling to `server/youtube.ts`**

Add above `buildSnippet`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Outside the project root on purpose. Vite's dev server serves the project
 *  root statically — that is how `/out/<name>` and `/media/…` reach the
 *  browser with no route behind them — so a `secrets/` directory here would
 *  hand a refresh token to any page the browser has open. Nothing under the
 *  project root is private, so nothing private goes under it. */
export const CONFIG_DIR = join(homedir(), ".vstack");
/** The OAuth client JSON downloaded from Google Cloud Console. */
export const CLIENT_PATH = join(CONFIG_DIR, "youtube-client.json");
/** `{ refresh_token }`, written at mode 0600 by `pnpm youtube-auth`. */
export const TOKEN_PATH = join(CONFIG_DIR, "youtube-token.json");

export const SCOPE = "https://www.googleapis.com/auth/youtube.upload";

export const AUTH_HINT =
  "YouTube publishing is not set up (or the token expired). Fix: pnpm youtube-auth";

export type Client = { clientId: string; clientSecret: string };

/** The OAuth client. Env vars win so a second project needs no file move.
 *  Google's downloaded file nests the pair under `installed` for a Desktop
 *  client and `web` for a Web one; both are read, though Desktop is what the
 *  setup instructions ask for — Google ignores the port on a loopback
 *  redirect for that client type, so the script's port needs no
 *  registration. */
export function readClient(): Client | null {
  const id = process.env.VSTACK_YT_CLIENT_ID;
  const secret = process.env.VSTACK_YT_CLIENT_SECRET;
  if (id && secret) return { clientId: id, clientSecret: secret };
  if (!existsSync(CLIENT_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CLIENT_PATH, "utf8")) as {
      installed?: { client_id?: string; client_secret?: string };
      web?: { client_id?: string; client_secret?: string };
    };
    const found = raw.installed ?? raw.web;
    if (!found?.client_id || !found.client_secret) return null;
    return { clientId: found.client_id, clientSecret: found.client_secret };
  } catch {
    // A corrupt or hand-edited file reads the same as no file: the fix is
    // the same command either way.
    return null;
  }
}

export function readRefreshToken(): string | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as { refresh_token?: string };
    return raw.refresh_token ?? null;
  } catch {
    return null;
  }
}

/** Soft, unlike `checkStarter`: missing credentials mean Publish does not
 *  work, not that vstack refuses to boot. Everything else in this app works
 *  without a Google project, and `/api/publish` returns the same hint at the
 *  moment it is actually needed. */
export function checkYouTube(): void {
  if (readClient() !== null && readRefreshToken() !== null) return;
  console.warn(`vstack: ${AUTH_HINT}`);
}

/** Trades an authorisation code for a refresh token. Lives here rather than
 *  in the script so the two token calls sit next to each other and share one
 *  error shape. */
export async function exchangeCode(
  client: Client,
  code: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${text}`);
  const body = JSON.parse(text) as { refresh_token?: string };
  if (!body.refresh_token) {
    throw new Error(
      "Google returned no refresh_token. This happens when the account has " +
        "already granted this client and Google reuses the old grant — the " +
        "auth URL sends prompt=consent to avoid it, so check that the URL " +
        "opened was the one this script printed.",
    );
  }
  return body.refresh_token;
}
```

- [ ] **Step 2: Write the auth script**

Create `scripts/youtube-auth.ts`:

```ts
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import {
  AUTH_HINT,
  CLIENT_PATH,
  CONFIG_DIR,
  SCOPE,
  TOKEN_PATH,
  exchangeCode,
  readClient,
} from "../server/youtube.ts";

/** One-off OAuth setup for publishing.
 *
 *  `pnpm youtube-auth` — opens Google's consent screen, catches the redirect
 *  on a throwaway loopback server, and writes ~/.vstack/youtube-token.json.
 *
 *  ponytail: a script, not a route. Auth happens once, and doing it in the
 *  app would cost index.ts a GET handler, a callback HTML page and a poll
 *  loop asking whether the user has finished in the other tab — all for a
 *  thing you run when you set the tool up. `scripts/audition.ts` made the
 *  same call about choosing a voice.
 *
 *  Setup, first time:
 *    1. console.cloud.google.com → a project → enable "YouTube Data API v3"
 *    2. OAuth consent screen → External → add yourself as a test user
 *       → set publishing status to "In production". Testing status expires
 *       refresh tokens after 7 days; production does not, and this scope
 *       needs no verification either way.
 *    3. Credentials → Create credentials → OAuth client ID → *Desktop app*
 *       (Google ignores the loopback port for that type, so PORT below needs
 *       no registration; a Web client would demand an exact match)
 *    4. Download the JSON to ~/.vstack/youtube-client.json
 *    5. pnpm youtube-auth
 */

const PORT = 8788;
const REDIRECT = `http://127.0.0.1:${PORT}`;

const client = readClient();
if (client === null) {
  console.error(
    `vstack: no OAuth client. Put the JSON Google Cloud Console gives you at\n` +
      `  ${CLIENT_PATH}\n` +
      `or set VSTACK_YT_CLIENT_ID and VSTACK_YT_CLIENT_SECRET.\n` +
      `See the header of scripts/youtube-auth.ts for the console steps.`,
  );
  process.exit(1);
}

// Guards the callback: only a redirect carrying the value this process
// generated is this process's redirect.
const state = randomUUID();
const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth?` +
  new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    // Without this, Google returns an access token and no refresh token, and
    // publishing would need a browser round-trip every hour.
    access_type: "offline",
    // Without this, a re-run after the 7-day Testing-status expiry gets the
    // old grant back with no refresh_token attached.
    prompt: "consent",
    state,
  }).toString();

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", REDIRECT);
    const got = url.searchParams.get("code");
    const failed = url.searchParams.get("error");
    const ok = got !== null && url.searchParams.get("state") === state;
    res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta charset="utf-8"><p style="font:16px system-ui">${
        ok ? "Authorised — close this tab." : `Failed: ${failed ?? "no code"}`
      }</p>`,
    );
    server.close();
    if (ok && got !== null) resolve(got);
    else if (got !== null) reject(new Error("OAuth state mismatch — ignoring this callback."));
    else reject(new Error(failed ?? "No code in the callback."));
  });
  server.on("error", reject);
  // Loopback only, like the main server: nothing on the LAN has any business
  // completing this handshake.
  server.listen(PORT, "127.0.0.1", () => {
    console.warn(`vstack: opening Google's consent screen…\n\n${authUrl}\n`);
    execFile("open", [authUrl], (err) => {
      if (err) console.warn("vstack: could not open a browser — paste the URL above.");
    });
  });
});

const refreshToken = await exchangeCode(client, code, REDIRECT);
// 0700 on the directory as well: the token inside is a bearer credential for
// uploading to the account's YouTube channel.
await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
await writeFile(TOKEN_PATH, `${JSON.stringify({ refresh_token: refreshToken }, null, 2)}\n`, {
  mode: 0o600,
});
// mkdir's `mode` is ignored when the directory already exists, and writeFile's
// is ignored when the file does — so both are set again explicitly.
await chmod(CONFIG_DIR, 0o700);
await chmod(TOKEN_PATH, 0o600);
console.warn(`vstack: wrote ${TOKEN_PATH}. Publishing is ready.`);
console.warn(`vstack: if uploads start failing with "${AUTH_HINT}", run this again.`);
```

- [ ] **Step 3: Add the script to `package.json`**

Beside `"voices"`:

```json
    "youtube-auth": "node scripts/youtube-auth.ts",
```

- [ ] **Step 4: Add the soft boot check**

In `server/index.ts`, extend the imports with `import { checkYouTube } from "./youtube.ts";`
and add after `await checkStarter();`:

```ts
// Soft, unlike the two above: no Google credentials means Publish does not
// work, not that vstack refuses to boot.
checkYouTube();
```

- [ ] **Step 5: Verify the failure path first**

Run: `pnpm server` with no `~/.vstack/` present.
Expected: the server starts normally and warns
`vstack: YouTube publishing is not set up (or the token expired). Fix: pnpm youtube-auth`.

Run: `pnpm youtube-auth` with no client file.
Expected: exits 1 naming `~/.vstack/youtube-client.json`, no browser opens.

- [ ] **Step 6: Verify the real flow**

Follow the console steps in the script's header, drop the JSON at
`~/.vstack/youtube-client.json`, then run `pnpm youtube-auth`.

Expected: a browser tab opens on Google's consent screen; approving it shows
"Authorised — close this tab."; the script writes the token and exits 0.
Check: `ls -l ~/.vstack` shows `drwx------` on the directory and `-rw-------`
on `youtube-token.json`. Restart `pnpm server` — the warning is gone.

- [ ] **Step 7: Run the suite and the gate**

Run: `pnpm test && pnpm build`
Expected: 148 pass, clean. (`erasableSyntaxOnly` is what catches a `.ts`
script that Node's type stripping could not run.)

- [ ] **Step 8: Commit**

```bash
git -C . add server/youtube.ts scripts/youtube-auth.ts package.json server/index.ts
git -C . commit -m "feat: pnpm youtube-auth, and a soft boot check for it"
```

---

### Task 6: Publish

**Files:**
- Modify: `server/youtube.ts` (`accessToken`, `uploadVideo`, `publishProgress`)
- Modify: `server/index.ts` (two routes)
- Modify: `src/api.ts` (`publish`, `publishProgress`)
- Modify: `src/main.ts` (`doPublish`, `renderPreview`)
- Modify: `src/style.css` (`.bar textarea`)

**Interfaces:**
- Consumes: `buildSnippet`, `VideoResource`, `readClient`, `readRefreshToken`,
  `AUTH_HINT` (Tasks 4–5); `isOutName`, `outPath` (Task 1)
- Produces:
  - `uploadVideo(opts: { path: string; size: number; video: VideoResource }): Promise<string>` — the video id
  - `publishProgress(): { sent: number; total: number }`
  - `POST /api/publish {name,title,description,tags} → {videoId, url}`
  - `POST /api/publish/progress {} → {sent, total}`
  - `api.publish(body): Promise<{videoId: string; url: string}>`, `api.publishProgress(): Promise<{sent: number; total: number}>`

- [ ] **Step 1: Add the token refresh**

In `server/youtube.ts`, add after `exchangeCode`:

```ts
/** Access tokens last an hour; a publish takes seconds. Cached with 30s of
 *  slack so a token cannot expire between the check and the upload. */
let cached: { token: string; expires: number } | null = null;

export async function accessToken(): Promise<string> {
  if (cached !== null && cached.expires > Date.now() + 30_000) return cached.token;
  const client = readClient();
  const refresh = readRefreshToken();
  if (client === null || refresh === null) throw new Error(AUTH_HINT);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    // A 400 or 401 here is almost always Google having expired the refresh
    // token, which it does after 7 days for any consent screen still in
    // Testing publishing status. Naming the fix matters more than the raw
    // "invalid_grant" would.
    if (res.status === 400 || res.status === 401) throw new Error(`${AUTH_HINT}\n\n${text}`);
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }
  const body = JSON.parse(text) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}
```

- [ ] **Step 2: Add the upload and its progress**

Add to the imports at the top of `server/youtube.ts`:

```ts
import { createReadStream } from "node:fs";
import { request as httpsRequest } from "node:https";
```

and add after `buildSnippet`:

```ts
// ponytail: one global upload slot — this is a single-user local tool and
// two publishes cannot overlap in the UI. Key it by output name if that ever
// stops being true.
let progress = { sent: 0, total: 0 };

export function publishProgress(): { sent: number; total: number } {
  return { ...progress };
}

/** The resumable protocol's second leg. Deliberately `node:https` and not
 *  `fetch`: this PUT needs an exact `Content-Length`, and `Content-Length` is
 *  a forbidden header name under the fetch spec — a fetch with a stream body
 *  is free to drop it and send chunked, which this endpoint does not accept.
 *  Piping a read stream into an https request also gives byte-level progress
 *  from one `data` listener, with no transform stream in the way. */
function putVideo(session: string, path: string, size: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = httpsRequest(
      session,
      { method: "PUT", headers: { "content-type": "video/mp4", "content-length": size } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 300) {
            // Google's own body, verbatim — the same posture yt-dlp and
            // ffmpeg stderr already get. A 403 here is usually the ~100
            // uploads/day this endpoint has had its own quota for since
            // June 2026.
            reject(new Error(`Upload failed (${res.statusCode ?? 0}): ${text}`));
          } else {
            resolve(text);
          }
        });
      },
    );
    req.on("error", reject);
    const file = createReadStream(path);
    file.on("data", (chunk: Buffer) => {
      progress = { sent: progress.sent + chunk.length, total: size };
    });
    file.on("error", reject);
    file.pipe(req);
  });
}

/** Uploads a finished short and returns its video id. It lands **private**
 *  and there is no option: an unaudited API project has every videos.insert
 *  locked to private viewing, so the public flip is a manual step in Studio. */
export async function uploadVideo(opts: {
  path: string;
  size: number;
  video: VideoResource;
}): Promise<string> {
  const token = await accessToken();
  const init = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(opts.size),
        "x-upload-content-type": "video/mp4",
      },
      body: JSON.stringify(opts.video),
    },
  );
  if (!init.ok) {
    throw new Error(`YouTube refused the upload session (${init.status}): ${await init.text()}`);
  }
  const session = init.headers.get("location");
  if (session === null) {
    throw new Error("YouTube accepted the session but returned no Location header.");
  }

  progress = { sent: 0, total: opts.size };
  try {
    const body = JSON.parse(await putVideo(session, opts.path, opts.size)) as { id?: string };
    if (body.id === undefined) {
      throw new Error("The upload succeeded but YouTube returned no video id.");
    }
    return body.id;
  } finally {
    // Reset on the failure path too — a stale 90% left behind would make the
    // next publish look like it started three-quarters done.
    progress = { sent: 0, total: 0 };
  }
}
```

- [ ] **Step 3: Add the two routes**

In `server/index.ts`, extend the `./youtube.ts` import to
`{ buildSnippet, checkYouTube, publishProgress, uploadVideo }` and add beside
`/api/reveal`:

```ts
  if (req.url === "/api/publish") {
    const body = await json<Record<string, unknown>>(req);
    if (!isOutName(body.name)) return send(res, 400, { error: "Bad output name." });
    const path = outPath(body.name);
    if (!existsSync(path)) return send(res, 404, { error: `${body.name} is not in out/.` });
    const video = buildSnippet({
      title: str(body.title, "title"),
      description: str(body.description, "description"),
      tags: str(body.tags, "tags"),
    });
    // After buildSnippet, not before: it is what trims, so a title of nothing
    // but spaces has to be caught on the other side of it.
    if (video.snippet.title === "") return send(res, 400, { error: "title must not be blank." });
    const videoId = await uploadVideo({ path, size: statSync(path).size, video });
    console.warn(`vstack: uploaded ${body.name} as ${videoId} (private)`);
    return send(res, 200, {
      videoId,
      url: `https://studio.youtube.com/video/${videoId}/edit`,
    });
  }

  // Polled twice a second by the client while an upload runs. Exact string
  // equality above means this never shadows /api/publish and vice versa.
  if (req.url === "/api/publish/progress") return send(res, 200, publishProgress());
```

- [ ] **Step 4: Add the client wrappers**

In `src/api.ts`:

```ts
export async function publish(body: {
  name: string;
  title: string;
  description: string;
  tags: string;
}): Promise<{ videoId: string; url: string }> {
  return (await post("/api/publish", body)).json() as Promise<{
    videoId: string;
    url: string;
  }>;
}

export async function publishProgress(): Promise<{ sent: number; total: number }> {
  return (await post("/api/publish/progress", {})).json() as Promise<{
    sent: number;
    total: number;
  }>;
}
```

- [ ] **Step 5: Add `doPublish`**

In `src/main.ts`, add after `doExport`:

```ts
/** Uploads the finished short as a private draft and remembers its id.
 *
 *  The percentage comes from polling rather than from this request, which
 *  reports nothing until it finishes. Each tick is a notifying setState, so
 *  the preview bar is rebuilt twice a second — safe only because every field
 *  in it is disabled while `busy`, so there is no caret to lose. */
async function doPublish(): Promise<void> {
  const s = getState();
  const title = s.ytTitle.trim();
  if (title === "" || s.outName === "") return;
  await guard("Publishing… 0%", async () => {
    const poll = window.setInterval(() => {
      void api
        .publishProgress()
        .then(({ sent, total }) => {
          if (total > 0) {
            setState({ busy: `Publishing… ${Math.round((sent / total) * 100)}%` });
          }
        })
        // A dropped poll is not worth replacing the upload's own error with.
        .catch(() => undefined);
    }, 500);
    try {
      const { videoId } = await api.publish({
        name: s.outName,
        title,
        description: s.ytDescription,
        tags: s.ytTags,
      });
      setState({ ytVideoId: videoId });
      bell();
    } finally {
      // Must run before guard's own finally clears `busy`, or the next tick
      // would set it straight back and strand the bar as busy forever.
      clearInterval(poll);
    }
  });
}
```

- [ ] **Step 6: Extend `renderPreview` with the publish row**

Replace `renderPreview`'s `return` with the two-row version, adding the fields
above it:

```ts
  const published = s.ytVideoId !== "";

  const title = el("input", {
    type: "text",
    placeholder: "YouTube title (required)",
    ariaLabel: "YouTube title",
    className: "field-grow",
    maxLength: 100,
    value: s.ytTitle,
    disabled: Boolean(s.busy) || published,
  });
  const description = el("textarea", {
    placeholder: "Description",
    ariaLabel: "YouTube description",
    className: "field-grow",
    rows: 2,
    value: s.ytDescription,
    disabled: Boolean(s.busy) || published,
  });
  const tags = el("input", {
    type: "text",
    placeholder: "tags, comma, separated",
    ariaLabel: "YouTube tags",
    size: 24,
    value: s.ytTags,
    disabled: Boolean(s.busy) || published,
  });

  const publish = el("button", {
    className: "btn-solid",
    textContent: "Publish (private)",
    disabled: s.ytTitle.trim() === "" || Boolean(s.busy),
  });
  publish.onclick = () => void doPublish();

  // Quiet, like every other text field in this app: a notifying update per
  // keystroke rebuilds the very input being typed into and drops the caret.
  // But Publish's `disabled` is gated on the title, and a quiet update
  // reaches no render — so it is flipped in place here, exactly as the
  // starter-title field does it in renderFraming.
  title.oninput = () => {
    setQuiet({ ytTitle: title.value });
    publish.disabled = title.value.trim() === "" || Boolean(getState().busy);
  };
  description.oninput = () => setQuiet({ ytDescription: description.value });
  tags.oninput = () => setQuiet({ ytTags: tags.value });

  // Replaces Publish once the upload lands: the next step is on YouTube, and
  // uploading the same file twice is never what was meant.
  const studio = el("a", {
    className: "btn-link",
    href: `https://studio.youtube.com/video/${s.ytVideoId}/edit`,
    target: "_blank",
    rel: "noreferrer",
    textContent: "Open in YouTube Studio →",
  });

  return [
    el(
      "div",
      { className: "bar-row" },
      el("span", { className: "badge badge-title", textContent: s.outName }),
      el("span", {
        className: "badge",
        textContent: `${(s.outSize / 1e6).toFixed(1)} MB`,
      }),
      published
        ? el("span", { className: "badge badge-info", textContent: "uploaded — private" })
        : el("span"),
      el("div", { className: "bar-end" }, finder, back),
    ),
    el(
      "div",
      { className: "bar-row" },
      title,
      description,
      tags,
      el("div", { className: "bar-end" }, published ? studio : publish),
    ),
  ];
```

- [ ] **Step 7: Style the textarea and the link-button**

In `src/style.css`, beside the TextField surface rules:

```css
/* Same surface as the text inputs, just taller. `resize: vertical` only —
   a horizontal drag would fight `.bar-row`'s flex sizing. */
.bar textarea {
  font: inherit;
  padding: 6px 8px;
  border-radius: var(--radius-2);
  border: 1px solid var(--slate-a7);
  background: var(--field);
  color: var(--slate-12);
  resize: vertical;
}

/* An <a> that has to sit in a button row without being a button. */
.btn-link {
  display: inline-flex;
  align-items: center;
  height: var(--control-height);
  padding: 0 12px;
  border-radius: var(--radius-2);
  background: var(--grass-a3);
  color: var(--grass-11);
  text-decoration: none;
  font-weight: 500;
}
```

- [ ] **Step 8: Verify the failure paths first**

With `~/.vstack/youtube-token.json` temporarily renamed, export and press Publish.
Expected: the callout reads `YouTube publishing is not set up (or the token
expired). Fix: pnpm youtube-auth`, and the bar is usable again afterwards.

Restore the token. In the browser console:
`fetch("/api/publish",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"../x-0000-0001.mp4",title:"t",description:"",tags:""})})`
Expected: `400 {"error":"Bad output name."}`.

- [ ] **Step 9: Verify a real upload**

Export a short clip, fill in title/description/tags, press Publish.

Expected: the status badge counts up (`Publishing… 12%` … `100%`), the bell
rings, the bar shows `uploaded — private` and **Open in YouTube Studio →**,
and the server logs `vstack: uploaded <name> as <id> (private)`. Following the
link shows the video in Studio with your title, your description ending in
`#Shorts`, your tags, and visibility **Private**. Publishing a second time is
impossible without exporting again — the button is gone.

- [ ] **Step 10: Run the suite and the gate**

Run: `pnpm test && pnpm build`
Expected: 148 pass, clean.

- [ ] **Step 11: Commit**

```bash
git -C . add server/youtube.ts server/index.ts src/api.ts src/main.ts src/style.css
git -C . commit -m "feat: publish an export to YouTube as a private draft"
```

---

### Task 7: Documentation

CLAUDE.md is the file every future session reads first, so the facts that cost
time go in it — not a feature tour.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Update the spec pointer at the top of CLAUDE.md**

Append to the run-on list of design docs:

```
…plus `docs/specs/2026-08-23-vstack-publish-design.md`, which covers `out/`,
the `preview` phase and publishing, and supersedes the starter-screen doc's
`/api/export` *response* — that route answers with JSON now and leaves the
file on disk rather than streaming an attachment back.
```

- [ ] **Step 2: Update Commands**

```
pnpm test     # vitest, 148 tests
pnpm youtube-auth  # one-off OAuth setup for publishing (see server/youtube.ts)
```

- [ ] **Step 3: Update Architecture**

Add to the module map:

```
server/youtube.ts  CONFIG_DIR/TOKEN_PATH, readClient, checkYouTube,
                   buildSnippet, accessToken, uploadVideo, publishProgress
scripts/youtube-auth.ts  `pnpm youtube-auth` — the one-off OAuth dance
out/               finished shorts (gitignored)
```

Update the layering line to
`errors ← {ffmpeg, starter, youtube} ← {ytdlp, mask} ← index`, note that
`youtube.ts` sits beside `ffmpeg.ts` because it takes paths from the caller
and reads its own credentials out of `~/.vstack/`, and change "Three phases"
to four:

```
… → `framing` (crop boxes, canvas composite, export) → `preview` (the
finished file from `out/`, played back, with publish-to-YouTube). Export no
longer downloads: it writes `out/<slug>-<mmss>-<mmss>.mp4` and advances the
phase.
```

- [ ] **Step 4: Add the invariants**

Under "Invariants — breaking these is silent, not loud":

```
**`isOutName` is the one client-supplied path component this API accepts.**
Everywhere else `/api/export` takes window bounds and reconstructs the cache
filename itself, so there is nothing to validate. Preview breaks that,
because publish and reveal both name a file that already exists — so the name
is validated against exactly what `slugify` + `mmss` can emit, plus an
`existsSync`. Loosen the pattern and `open -R` and an upload both point at
whatever the caller asked for.

**Uploads are private and there is no option.** An unaudited YouTube Data API
project has every `videos.insert` locked to private viewing. `buildSnippet`
hardcodes `privacyStatus: "private"` and `selfDeclaredMadeForKids: false` —
the second is required by the API, and an upload without it is rejected.

**The preview URL carries the file's mtime.** The output name is stable
across re-exports, so `/out/<name>` with no cache-buster re-shows the
*previous* render — a fixed crop looks like it changed nothing.
```

- [ ] **Step 5: Add the gotchas**

Under "Gotchas that each cost real time":

```
**Vite's dev server serves the project root statically.** That is why
`/media/<id>/<clip>.mp4` and `/out/<name>.mp4` reach the browser with no
route behind them — and equally why nothing private may sit under the project
root. Credentials live in `~/.vstack/`; a `secrets/` directory here would be
readable at `/secrets/youtube-token.json` by any page the browser has open.

**The resumable upload's PUT uses `node:https`, not `fetch`.** It needs an
exact `Content-Length`, and `Content-Length` is a forbidden header name under
the fetch spec — a fetch with a stream body may drop it and send chunked,
which the endpoint refuses. `https.request` also gives byte progress from one
`data` listener.

**`prompt=consent`, not just `access_type=offline`.** The first gets a
refresh token at all; the second gets one *again* on a re-run, which is every
time the 7-day expiry Google applies to Testing-status consent screens bites.
Setting the consent screen to "In production" — no verification needed for
`youtube.upload` — stops the expiry.

**The export writes `out/<name>.part.mp4` and renames.** A half-written file
must never be servable under a name the client can request, and the rename
has to stay on one volume: `$TMPDIR` is a different filesystem on macOS, so
rendering into the temp dir and renaming into the project risks `EXDEV`.
```

- [ ] **Step 6: Update Testing posture and Environment notes**

Add to Testing posture:

```
`server/youtube.test.ts` covers `buildSnippet` and nothing else — it is where
every decision that is awkward to change later lives (the 100-char title cap,
`#Shorts` appended once and case-insensitively, private, not-made-for-kids).
The HTTP calls, `open -R`, the preview bar and the auth script have no tests,
like the rest of the network and DOM surface. The out-name tests in
`server/ffmpeg.test.ts` are the traversal guard and get the same exhaustive
treatment `videoIdFrom` does.
```

Add to Environment notes:

```
- `out/` grows without eviction, like `media/`. Nothing prunes it.
- Publishing needs `~/.vstack/youtube-client.json` (a **Desktop app** OAuth
  client from Google Cloud Console, with YouTube Data API v3 enabled) and a
  token from `pnpm youtube-auth`. Missing either is a boot *warning*, not a
  boot failure — everything except Publish works without them.
- Uploads land private and cannot be made public from here; that is Google's
  audit rule for unaudited API projects, not a missing feature. The endpoint
  also has its own ~100 uploads/day quota.
```

- [ ] **Step 7: Update README.md**

Add a short "Publishing" section covering the four console steps and
`pnpm youtube-auth`, and note that exports land in `out/`.

- [ ] **Step 8: Verify**

Run: `pnpm test && pnpm build`
Expected: 148 pass, clean. Re-read CLAUDE.md's Commands block against
`package.json` — the test count and the script list must match reality.

- [ ] **Step 9: Commit**

```bash
git -C . add CLAUDE.md README.md
git -C . commit -m "docs: out/, the preview phase, and publishing"
```

---

## Self-review notes

**Spec coverage** — every section maps to a task: output storage and
`isOutName` → Task 1; the fourth phase, the JSON reply and the shell → Task 2;
reveal → Task 3; `buildSnippet` → Task 4; `~/.vstack/`, the auth script and the
soft boot check → Task 5; the routes, the upload, progress and the bar → Task 6;
docs → Task 7. The spec's "out of scope" list (past-exports list, a Downloads
copy, public/scheduled publishing) has no task, deliberately.

**Type consistency** — `outName`/`outPath`/`isOutName`, `ExportResult`,
`SnippetInput`/`VideoResource`, `Client`, `uploadVideo`/`publishProgress` are
each defined once and used under the same name everywhere after. The client
derives the Studio URL from `ytVideoId` rather than storing the `url` the
route also returns, so there is no second copy of that string to drift.
(as built: there *is* a second copy — `server/index.ts`'s `/api/publish`
returns `url` and `src/main.ts` separately re-derives the same
`https://studio.youtube.com/video/<id>/edit` shape from `ytVideoId`. Caught in
the whole-branch review and left as is: nothing consumes the route's `url`, so
there is nothing wired to drift, and folding the client onto the response
value was judged not worth a task of its own for one string literal.)

**One deviation from the spec, already folded back into it:** the spec first
said the PUT would use `fetch` with `duplex: "half"`. It uses `node:https`
instead, because `Content-Length` is a forbidden header name under the fetch
spec and the resumable endpoint requires it. The spec was amended in commit
`docs: put the resumable PUT on node:https, not fetch`.
