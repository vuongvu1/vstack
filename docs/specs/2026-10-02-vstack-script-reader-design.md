# vstack — reading a script aloud into an mp3

2026-10-02

> **Amended 2026-10-02.** Two things below are stale against what shipped
> on `feat/script-reader`. `CLAUDE.md` carries the correct versions; this
> block is so a session reading the spec first does not "fix" the code back
> to it.
>
> 1. **There is NO `prev` and NO sweep.** The body is `{ script, voice,
>    name }`; the `prev` row, step 4 of the flow and the `readOut`-as-`prev`
>    line below are gone. Here a name is the user's handle for a separate
>    voiceover, so sweeping on a rename deleted the previous episode — found
>    in review, reproduced with curl. `isScriptName` gates `/api/reveal`
>    only.
> 2. **Node's `requestTimeout` does not bound the render.** It only limits
>    receiving the request. Measured at the cap instead: 14,833 chars →
>    744.9s of audio in 110.5s wall, 1.78 GB peak RSS, 71.5 MB WAV. The cost
>    of raising `SCRIPT_MAX` is the wait and the memory, not a timeout.

A sixth way out of `idle` and a third dead end: the user pastes a voiceover
script, picks one of the starter screen's VieNeu presets, and gets back one
`.mp3` of the script read aloud — played in the panel and written to
`OUT_DIR`, revealed in Finder on request.

Supersedes nothing and extends nothing. It borrows the speech engine
(`speak`, `knownVoices`, the `vstack:voice` key) from the starter screen and
`MP3_QUALITY` from the cutter, and that is the whole of what it shares.

## Purpose and scope

Voiceover narration, **1–10 minutes**. Not audiobooks: a script long enough
to need progress reporting or crash-resume is out of scope (see "Skipped").

Success: paste a script of up to `SCRIPT_MAX` characters, press Render, hear
it in the panel inside about two minutes, and find `<slug>-voice.mp3` on the
Desktop.

## Measured, and why the design is one request

VieNeu v3 Turbo on this machine: **979 characters → 48.4s of audio in 12.5s
wall** — 4.2s of ONNX session setup, then ~8.3s of synthesis (RTF ≈ 0.17).
Ten minutes of audio is roughly 12,000 characters, so ~105s of synthesis
plus the load: well inside Node's default 300s `server.requestTimeout`.

So the route is a plain request/response. No job, no `-progress` file, no
poll. If the measurement ever stops holding, the request dies at 300s with a
socket error — loud, not silent.

The engine chunks the text itself (`v3turbo.infer`, `max_chars=256`, chunks
joined with a short silence). This feature does **not** chunk: two chunkers
is how pauses come out doubled and how a sentence gets split mid-clause by
the outer one where the inner one would have kept it whole.

## Journey

`idle` → `reading` → `idle`.

- Entered by a `Script →` button in the idle bar, beside `Lofi →` and the
  cutter's button.
- **Claims no `mode`**, the cutter's rule: this phase reaches neither
  `preview` nor `/api/publish`, so there is nothing to classify. The status
  row's probed badges exclude `reading` explicitly, the way they exclude
  `cutting`, because a fresh session's `mode` is still `"short"`.
- `← Back` returns to `idle`.

## Server

### `server/script.ts`

Sits beside `cut.ts`, `lofi.ts`, `longform.ts` and `starter.ts`: every path
is the caller's, so it needs neither `MEDIA_DIR` nor `OUT_DIR`.

```ts
export async function scriptMp3(
  script: string, voice: string, dir: string, out: string,
): Promise<void>
```

1. `speak(script, dir, join(dir, "script.wav"), voice)` — the existing
   one-job path; text travels by file, never argv.
2. ffmpeg `-i script.wav -c:a libmp3lame -q:a MP3_QUALITY -y out`.
Imports `speak` from `starter.ts`, `MP3_QUALITY` from `cut.ts`, `toolError`
from `errors.ts`. `starter.ts`'s file name inside `synthesize` is
`title.txt`; it is a temp file in `dir` and the name does not matter.

### Names

- `scriptName(base)` → `<slugify(base)>-voice.mp3`, beside `cutName` in
  `server/ffmpeg.ts`.
- `SCRIPT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*-voice\.mp3$/`, `isScriptName`
  beside `isCutName`. **Neither `OUT_NAME` nor `CUT_NAME` is widened**: a
  third anchored pattern, each matching exactly what its own producer emits.
  `SCRIPT_NAME` and `CUT_NAME` are disjoint by construction — one ends
  `-voice.mp3`, the other `-<digits>.mp3`.
- Deterministic in the name alone, so re-rendering after a script edit
  overwrites itself; only a *name* edit needs the `prev` sweep.

### `POST /api/read`

Body: `{ script, voice, name, prev? }`.

| Field | Check | Error |
|---|---|---|
| `script` | string, trimmed, non-blank, ≤ `SCRIPT_MAX` (15,000) chars | 400 `script must not be blank.` / `script must be at most 15000 characters.` |
| `voice` | in `knownVoices()` | 400, same message `/api/export` gives |
| `name` | `readTitle(raw.name, "name")` | 400 from `readTitle` |
| `prev` | absent/`null`, or `isScriptName` | 400 `Bad prev.` |

`SCRIPT_MAX` lives in `src/defaults.ts` so the client's counter and the
route's check read one constant.

Flow:

1. `mkdtemp` for the WAV and the text file; removed in `finally`.
2. Partial `<OUT_DIR>/<name>.<uuid>.part.mp3`, added to `inFlight` so a
   SIGTERM from `node --watch` unlinks it; removed from `inFlight` in
   `finally`.
3. `scriptMp3(...)` into the partial, then `rename(partial, outPath(name))`.
4. Sweep: if `prev` is present and `prev !== name`,
   `removeExport`-style `rm(outPath(prev), { force: true })` — **after** the
   rename, **through `outPath`** (a bare name resolves against
   `process.cwd()` and `force` hides the ENOENT), best-effort.
5. Answer `200`, `Content-Type: audio/mpeg`, the mp3 bytes as the body,
   and `X-Vstack-Name: <name>`. No seconds header: `<audio controls>` shows
   its own duration.

Answering bytes rather than JSON is the `/api/say` posture, and it is what
keeps `/out/` untaught about `.mp3` — the cutter's invariant holds
unchanged. A 10-minute mp3 at ~190 kbps is ~14 MB; `readFile` into memory is
fine at that size.

### `/api/reveal`

Accepts `isOutName(name) || isCutName(name) || isScriptName(name)`, still
followed by `existsSync` in `OUT_DIR`. `/api/publish` and `/out/` are not
taught.

## Client

### Panel (`readPanel`, a child of `sourceSlot`)

Persistent node, toggled with `hidden`, under the never-empty rule.

- **Name** field (`.field-grow`), required — it names the file.
- **Voice** dropdown, the same twenty presets, reading and writing the
  global `vstack:voice` key through `saveVoice`/`savedVoice`. Same voice
  the starter screen opens on, by design.
- **Script** `<textarea>`, tall, with a live `n / 15000` counter that turns
  red over the cap.
- **Render** (`.btn-solid`), disabled while blank, over the cap, or `busy`.
  Flipped in place from the inputs' `oninput` (the `setQuiet` rule).
- After a render: `<audio controls>` on a blob URL (its own controls show
  the duration) and `Show in Finder` (`/api/reveal`).

### State

- The script text and its name persist under their own keys
  (`vstack:script`, `vstack:script-name`) — the `vstack:voice` shape, not the
  per-video record. A ten-minute script lost to a reload is data loss, which
  is why this phase persists where the cutter does not.
- `readOut` (the last rendered name, sent as `prev`) and the blob URL are
  module-scoped and unpersisted. A reload between two renders under
  different names strands the older file; accepted, same as `/api/export`.

### Blob URL lifecycle

`releaseReadUrl()` revokes and nulls the URL. Called before assigning a new
one and by `render()` on every render where `phase !== "reading"` — the
cutter's `releaseCutUrl` rule, so a later route out of the phase cannot leak
the blob. Idempotent.

`render()` also pauses the `<audio>` when leaving the phase
(`display: none` does not pause anything).

## Errors

| Case | Surface |
|---|---|
| Validation | 400, message in the status row's callout |
| VieNeu fails | `toolError("vieneu", …)` → 500, stderr tail in the callout |
| ffmpeg fails | `toolError("ffmpeg", …)` → 500 |
| Server down | `BACKEND_DOWN`, existing message |

A failed render leaves the previous mp3 intact (sweep runs only after the
rename).

## Testing

- `server/ffmpeg.test.ts`: `scriptName`/`isScriptName` with the exhaustive
  traversal treatment `isCutName` gets — what `scriptName` emits, traversal,
  everything `slugify` cannot produce, non-strings — plus the disjointness
  pair: a `scriptName` fails `isCutName` and `isOutName`, a `cutName` fails
  `isScriptName`.
- `server/script.test.ts`: real engine, real ffmpeg. A two-paragraph script
  longer than one 256-char engine chunk renders to a file ffprobe reports as
  `mp3` with a duration > 0.
  `beforeAll`/test timeout 180s, the reason `server/starter.test.ts` gives.
- Route, panel, blob lifecycle: untested, like the rest of the HTTP and DOM
  surface. Verified by hand in a browser.

## Skipped

- **Progress / chunk-resume** — add when scripts outgrow ~15 minutes of
  audio or synthesis approaches the 300s request timeout.
- **Pause / emphasis markup** — VieNeu has a gaps variant
  (`normalize_to_chunks_v3_with_gaps`); add when a script needs explicit
  pauses the punctuation does not give.
- **Speed / pitch** — `atempo` is one filter away; add when asked.
- **Feeding the lofi speech folder directly** — the user can Show in Finder
  and move it; add a target-folder option if that becomes routine.
