# vstack — preview and publish

Date: 2026-08-23
Status: designed
Extends: `docs/specs/2026-08-22-vstack-starter-screen-design.md` (supersedes
its `/api/export` *response* — the route now answers with JSON and leaves the
file on disk, instead of streaming the mp4 back as an attachment) and
`docs/specs/2026-08-20-vstack-design.md` (adds a fourth phase to its three)

## Problem

Export ends by handing the browser a Blob, which lands in `~/Downloads` under
a name the app already knows. From there the user opens Finder, finds the
file, opens YouTube Studio, drags it in, and retypes the title.

Two things are wrong with that. The output of a project-local tool should
live in the project, next to the `media/` cache it was cut from. And the app
already holds every piece of metadata the upload wants.

So: exports land in `out/`, and a fourth phase previews the result and
uploads it.

## The constraint that shapes the publish half

**A YouTube Data API project that has not passed Google's compliance audit
can only upload private videos.** Every video inserted through
`videos.insert` from an unaudited project (created after 2020-07-28) is
locked to private viewing. Since June 2026 uploads also draw on their own
quota rather than the shared pool — roughly 100 per day.

This is not a bug to route around; it is what the feature is. "Publish to
YouTube" means **upload as a private draft**. Flipping it public stays a
manual step in Studio.

**Rejected — pass the audit.** A form, a review measured in weeks, and a
rejection risk, to remove one click from a single-user tool.

**Rejected — skip the API, open Studio's upload page.** Cheapest by far, and
it can publish public immediately. But it cannot carry the title,
description or tags across, which is most of the typing the feature exists to
remove.

**Chosen — upload private, edit in Studio.** The clip, its title, its
description and its tags all arrive in one click. The user visits Studio once
per video, to press Publish.

A second consequence, worth writing down because it will look like a bug:
an OAuth consent screen left in **Testing** publishing status has its refresh
tokens expired by Google after 7 days. Setting the screen to **In
production** — which needs no verification for this scope — makes the token
persist. Uploads land private either way.

## Where things live

```
out/                            gitignored, served by Vite at /out/<name>
~/.vstack/youtube-client.json   the OAuth client from Cloud Console
~/.vstack/youtube-token.json    { refresh_token }, mode 0600
```

`out/` sits at the project root, alongside `media/`, and is reachable from
the browser for exactly the reason `media/` is: **Vite's dev server serves
the project root statically.** That is why `/media/<id>/<clip>.mp4` works
today with no route behind it, and why `/out/<name>.mp4` will too.

The same fact is why credentials live in `~/.vstack/` and not in the repo.
A `secrets/` directory at the project root would be served at
`/secrets/youtube-token.json`, and any page the browser has open could read
a refresh token out of it. Nothing under the project root is private, so
nothing private goes under the project root. `.gitignore` gains `out/` and
nothing else.

## Output files

`OUT_DIR` joins `ffmpeg.ts`'s existing `MEDIA_DIR`, and two pure helpers join
`clipName`/`clipPath`:

```ts
outName(title, start, end)  // `${slugify(title)}-${mmss(start)}-${mmss(end)}.mp4`
isOutName(name): boolean    // the trust boundary — see below
```

The name is unchanged from what `/api/export` already puts in
`Content-Disposition`, so re-exporting the same title over the same range
overwrites. That is the wanted behaviour: adjust a crop, re-render, one file.

`prependStarter` writes `out/<base>.part.mp4` and the route renames it to
`out/<base>.mp4` on success. Two reasons, both learned elsewhere in this
codebase: a half-written file must never be visible under a name the client
can request, and the rename has to stay on one volume — writing to the temp
dir and renaming into the project risks `EXDEV` on macOS, where `$TMPDIR` is
a different filesystem. `fetchWindow` already does exactly this. A failed
render removes its own `.part.mp4`.

The route's reply becomes:

```json
{ "name": "an-com-chua-0130-0205.mp4",
  "url":  "/out/an-com-chua-0130-0205.mp4?t=1755950400000",
  "size": 4_812_003 }
```

The `?t=` is the file's mtime, and it is load-bearing. The name is stable
across re-exports, so without a cache-buster the `<video>` would re-show the
*previous* render and the crop fix would look like it did nothing.

`api.exportClip` therefore returns this object rather than a `Blob`, and
`src/api.ts` gains `publish`, `reveal` and `publishProgress` beside it. The
client stops composing the filename entirely — it was building the same
`slugify`/`mmss` string as the server purely to label a download, with a
comment noting that a mismatch between the two would be invisible. The
server now says the name once and the client reads it.

### `isOutName` is a trust boundary

Everywhere else, this API takes window bounds and reconstructs paths itself —
there is deliberately no client-supplied path to validate. Preview breaks
that, because publishing and revealing both name a file that already exists.

So the name is validated rather than reconstructed, anchored to precisely
what `slugify` and `mmss` can emit:

```
/^[a-z0-9][a-z0-9-]*-\d{4}-\d{4}\.mp4$/
```

plus an `existsSync` in `OUT_DIR`. No slash, no dot-dot, no backslash, no
absolute path and no non-ASCII survives that pattern. It gets the same
exhaustive test treatment `videoIdFrom` gets, for the same reason: it is the
check that decides which path a subprocess touches.

## The fourth phase

`Phase` becomes `"idle" | "trimming" | "framing" | "preview"`.

New `AppState` fields, none of them persisted — an export belongs to the
session that made it, and `save`/`restore` are untouched:

```ts
outName: string; outUrl: string; outSize: number;
ytTitle: string; ytDescription: string; ytTags: string;
ytVideoId: string;   // "" until published
```

`doExport` stops building an `<a download>`. It sets `phase: "preview"` from
the route's JSON, with `ytTitle` prefilled from `starterTitle` sliced to
YouTube's 100-character cap (`starterTitle` allows 200). `bell()` stays where
it is, and the comment claiming export is the one step the phase subscriber
cannot see gets deleted — it can now.

### The shell

One more long-lived element: `outVideoEl` (`controls`, `loop`), appended into
`outSlot` once, hidden outside `preview`. The persistent-shell rules apply
unchanged — it is never removed, only toggled, and `.out > [hidden]` in
`style.css` already covers it.

In `preview` the canvas hides and the output video shows. The framing
`<video>` stays **visible and paused** in the source column, so the result can
be compared against what it was cut from; `videoEl.hidden` widens to
`phase !== "framing" && phase !== "preview"`. The crop overlay needs no new
rule — `boxesLayer`'s existing `phase !== "framing"` already hides it, which
is what keeps the source from reading as still editable.

### The bar

Two `.bar-row`s, split the way the framing bar is — what this is, then what
to do with it:

1. Badges: filename, size in MB. `.bar-end`: **Show in Finder**,
   **Frame again** (`.btn-gray`, back to `framing` with boxes intact).
2. YouTube title (`.field-grow`), description (`<textarea rows=2>`), tags.
   `.bar-end`: **Publish** (`.btn-solid`).

Publish is disabled while `busy`, while the title is blank, and once
`ytVideoId` is set — at which point it is replaced by a link to the video in
Studio.

The title field takes the same `setQuiet` + flip-`disabled`-in-place
treatment the starter-title field already has, and for the same reason: a
notifying update per keystroke rebuilds the input and drops the caret, but
Publish's `disabled` is gated on that very value.

## Server

Three routes, all `POST`. `route()`'s `POST only` guard stays exactly as it
is — the OAuth callback lives in a setup script, not in the server, so
nothing here ever needs `GET`.

| Route | Body | Reply |
|---|---|---|
| `/api/reveal` | `{ name }` | `{ ok: true }` |
| `/api/publish` | `{ name, title, description, tags }` | `{ videoId, url }` |
| `/api/publish/progress` | `{}` | `{ sent, total }` |

`/api/reveal` validates the name and spawns `open -R <path>`. macOS is
already a hard dependency here (`say`, and the `Linh` voice). A failure
warns and never 500s — revealing a file is not worth an error banner.

### `server/youtube.ts`

Sits at the errors-only layer, beside `ffmpeg.ts` and `starter.ts` rather
than above them. It re-derives its own `ROOT` in one line instead of
importing `ffmpeg.ts` for it, keeping the layering flat: `errors ← {ffmpeg,
starter, youtube} ← {ytdlp, mask} ← index`.

```ts
buildSnippet({ title, description, tags })  // pure
accessToken(): Promise<string>
uploadVideo({ path, size, snippet }): Promise<{ videoId: string }>
publishProgress(): { sent: number; total: number }
checkYouTube(): void
```

`buildSnippet` is the whole of the policy, and it is pure so it can be
tested:

```jsonc
{ "snippet": { "title":       "<=100 chars",
               "description": "<description>\n\n#Shorts",  // only if absent
               "tags":        ["split", "on", "commas"],
               "categoryId":  "22" },                      // People & Blogs
  "status":  { "privacyStatus":          "private",
               "selfDeclaredMadeForKids": false } }
```

`selfDeclaredMadeForKids` is required by the API, and both it and
`privacyStatus` are the kind of default that is a real-world mistake when
wrong, so both are asserted in tests.

### The upload itself

Two calls, native `fetch`, no `googleapis` dependency — that package is tens
of megabytes of surface for one endpoint, in a repo whose only dependency is
a colour palette.

```
POST https://www.googleapis.com/upload/youtube/v3/videos
       ?uploadType=resumable&part=snippet,status
     Authorization: Bearer <token>
     X-Upload-Content-Length: <size>
     X-Upload-Content-Type: video/mp4
     <the snippet JSON>
  → 200, Location: <session url>

PUT <session url>
     Content-Type: video/mp4, Content-Length: <size>
     <the bytes>
  → 200 { "id": "<videoId>", … }
```

**The two JSON calls use `fetch`; the PUT uses `node:https`.** The resumable
protocol requires an exact `Content-Length` on the upload, and `Content-Length`
is a forbidden header name under the fetch spec — a `fetch` with a stream body
is free to drop it and send chunked instead, which this endpoint does not
accept. `https.request` sets the header verbatim, and piping a
`createReadStream` into it gives byte-level progress from a `data` listener
with no transform stream and no `duplex: "half"` to remember. Stdlib, and no
part of it is ambiguous.

Progress is a module-level `{ sent, total }` that the poll route reads.
`ponytail: one global upload slot; key it by name if concurrent publishing
ever matters.` The client polls every 500 ms and writes the percentage into
`busy`. That re-renders the preview bar twice a second, which is safe here
only because every field is disabled during the upload — there is no caret to
lose.

### `pnpm youtube-auth`

`scripts/audition.ts` has the precedent: a one-off script for a setup
concern, kept out of the server. Auth is setup, not a runtime feature, and
putting it here is what keeps OAuth out of `index.ts` and out of the phase
machine entirely — no callback route, no `GET` handler, no polling for
"has the user finished authorising yet".

The script starts a throwaway server on 127.0.0.1:8788, `open`s the consent
URL, catches `?code=`, exchanges it, and writes `~/.vstack/youtube-token.json`
at mode 0600.

```
https://accounts.google.com/o/oauth2/v2/auth
  ?client_id=…&redirect_uri=http://127.0.0.1:8788
  &response_type=code&scope=https://www.googleapis.com/auth/youtube.upload
  &access_type=offline&prompt=consent
```

`access_type=offline` is what returns a refresh token at all;
`prompt=consent` is what returns one *again* on a re-run, which matters every
time the 7-day Testing-status expiry bites.

**Create the OAuth client as a Desktop app.** Google ignores the port on a
loopback redirect for that client type, so port 8788 needs no registration —
a Web client would demand an exact match and break the moment the port moved.

## Errors

`checkYouTube()` is **soft**, unlike `checkStarter()`: no token means Publish
does not work, not that vstack refuses to boot. It warns once at boot, and
`/api/publish` returns 400 carrying the same hint.

There is deliberately no status route and no pre-disabled Publish button.
This app's posture is that a failure carries its own fix — `BACKEND_DOWN`
says which command to run — and Publish is a once-per-session click, so
finding out at the click is cheap and the message is the same either way.

| Failure | Becomes |
|---|---|
| No token file | 400 "Run `pnpm youtube-auth`." |
| Google 401 on refresh | the same message — this is the 7-day expiry |
| Google 403 (quota) | Google's own message, verbatim |
| Render fails | `.part.mp4` removed, existing error path unchanged |
| `open -R` fails | `console.warn`, no error banner |

Verbatim pass-through matches how yt-dlp and ffmpeg stderr are already
surfaced: the tool knows what went wrong better than a rewrite of it would.

## Testing

Same posture as the rest of the project — the modules whose bugs are silent
get exhaustive coverage, and DOM and network get none.

- **`isOutName` / `outName`** — rejects `../`, absolute paths, backslashes,
  a trailing-slash name, a name that is not `slugify` output; accepts real
  Vietnamese-titled exports. This is the traversal guard.
- **`buildSnippet`** — 100-character truncation, `#Shorts` appended exactly
  once (and not twice when the user typed it), tag splitting and empty-tag
  dropping, `privacyStatus: "private"`, `selfDeclaredMadeForKids: false`.
- **Not tested:** the HTTP calls, `open -R`, the preview bar, the auth
  script. No route tests exist today and none are added.

`exportClip`'s signature does not change, so `server/ffmpeg.test.ts` and
`server/starter.test.ts` are untouched. The suite goes from 131 to roughly
143.

## Out of scope

- A list of past exports. `out/` stays a dump, and grows without eviction,
  exactly like `media/`.
- Any second copy of the export in `~/Downloads`.
- Publishing public, scheduling, thumbnails, playlists — all of them are
  blocked by the audit, on the far side of a manual Studio visit anyway.
