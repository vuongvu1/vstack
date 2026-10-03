# vstack — publishing a short to a Facebook Page as a Reel draft

2026-10-03

A second publish target beside YouTube, for the short journey only: one
button in the `preview` bar that uploads the finished `.mp4` to a Facebook
**Page** as a Reel **draft**, which the user then schedules in Meta Business
Suite.

Supersedes nothing. Extends the publish doc
(`2026-08-23-vstack-publish-design.md`) with a sibling route and a sibling
module; `/api/publish`, `buildSnippet` and everything YouTube-side are
untouched.

Branched from `feat/horizontal-cut`, not `main`: the button's gate reads the
layout's `frame` (`isWide`), which only exists there.

## Purpose and scope

Success: export a tall short, press **Reel (draft)**, and find it under the
Page's drafts in Business Suite with the same caption the YouTube upload
would carry, minus `#Shorts`.

In scope: tall shorts (`mode === "short"` on a `TALL` layout), Page targets,
`DRAFT` state.

## Verified against Meta's Reels publishing doc

- `POST /{page-id}/video_reels` drives three phases: `start` → upload →
  `finish`.
- `video_state` accepts `DRAFT`, `SCHEDULED` and `PUBLISHED`.
- A Reel must be **3–90s**, 9:16, 24–60fps. A vstack short is starter + clip
  + 5.04s outro, so a long cut can exceed 90s.
- 30 API-published Reels per Page per 24h.
- Personal profiles cannot be posted to. A Page is the only target.
- A custom cover is mentioned but the mechanism is not documented.

To verify during implementation (not in the doc page read): the exact
Business Suite drafts URL, and the current Graph API version to pin.

## Credentials — `~/.vstack/`, outside the project root

Same reason `youtube.ts`'s live there: Vite serves the project root
statically, so anything under it is readable by any open page.

| File | Written by | Shape |
|---|---|---|
| `facebook-client.json` | the user, once, by hand | `{ appId, appSecret }` |
| `facebook-token.json` | `pnpm facebook-auth` | `{ pageId, pageName, pageToken }`, mode `0600` |

**`pnpm facebook-auth <short-lived user token>`** (`scripts/facebook-auth.ts`):

1. The user opens Graph API Explorer, picks their Business-type Meta app,
   grants `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`,
   and copies the short-lived user token.
2. The script exchanges it at `/oauth/access_token`
   (`grant_type=fb_exchange_token`) for a long-lived user token.
3. `GET /me/accounts` with that token lists the Pages and their tokens. A
   Page token obtained from a long-lived user token **does not expire**, so
   there is nothing to refresh, ever.
4. One Page → saved. Several → the script lists `id  name` and exits non-zero
   until re-run with `FB_PAGE=<id>`.

No OAuth loopback, no redirect URI, no callback server — the dev-mode app is
enough when the user administers both the app and the Page, so no App Review.

`checkFacebook()` at boot **warns** when either file is missing, exactly as
`checkYouTube()` does. Everything but the Reel button works without them.

## `server/facebook.ts`

Sits beside `youtube.ts`, imports nothing from it. Re-derives `CONFIG_DIR`
itself, for the reason `youtube.ts` and `starter.ts` each re-derive theirs.
No shared "publisher" layer: the two APIs share only "stream a file over
https", and an abstraction with one user per branch is two copies with extra
indirection.

- `GRAPH_VERSION` — one pinned constant.
- `buildCaption(title, description): string` — pure. Joins with a blank line,
  removes every `#Shorts` token case-insensitively (title or description),
  collapses the whitespace that leaves, trims. Blank description → title
  alone. Every other hashtag stays as written.
- `reelLengthError(seconds): string | null` — pure. A sentence naming the
  length and the 3–90s window outside it, `null` inside it (both bounds
  inclusive).
- `uploadReel({ path, size, caption }): Promise<string>` — returns the
  `video_id`:
  1. `POST /{page-id}/video_reels` with `upload_phase=start` → `video_id`.
  2. `POST https://rupload.facebook.com/video-upload/{GRAPH_VERSION}/{video_id}`
     via **`node:https`**, headers `Authorization: OAuth <token>`,
     `offset: 0`, `file_size: <size>`, exact `Content-Length`, file piped in.
     `node:https` for the reason `putVideo` uses it: `Content-Length` is a
     forbidden header under fetch. And it carries every one of `putVideo`'s
     hard-won guards — `res.on("error")` (a destroyed response with no
     listener hangs the promise forever), a 10-minute `req.setTimeout` (a
     stalled socket fires neither handler), and the `seenResponse` rule (after
     headers, a write-side `EPIPE` is not the real error).
  3. `POST /{page-id}/video_reels` with `upload_phase=finish`,
     `video_id`, `video_state=DRAFT`, `description=<caption>`.
- The Page token travels in the POST body or an `Authorization` header,
  **never a URL query** — URLs end up in logs and error messages.
- Graph's own error body (`error.message`) is passed through verbatim,
  rate-limit refusals included.
- `reelProgress(): { sent, total }` — its own counter, not `publishProgress`'s.
  `ponytail:` one global slot, same posture as YouTube's.

## Routes

- **`POST /api/publish-reel`** — body `{ name, title, description }`.
  1. `isOutName(name)` + `existsSync` in `OUT_DIR` — the same gate
     `/api/publish` holds; this route names a file to upload.
  2. `probeFile(path)` → `reelLengthError(seconds)` → **400 before a byte is
     sent**. Meta would otherwise accept the whole upload and refuse at
     `finish`.
  3. `buildCaption(str(title), str(description))`; blank → 400.
  4. `uploadReel`, then `200 { videoId, url }` where `url` is the Page's
     Business Suite drafts view.
- **`POST /api/publish-reel/progress`** — a separate URL, not a query flag:
  routing is exact `req.url` equality.

No `shorts`, no `tags`, no thumbnail. Reels has no tags field, and the tags
the user wants on Facebook are hashtags in the title or description already.

## Client

- **"Reel (draft)"** button in the preview bar beside Publish, built only
  when `mode === "short" && !isWide(resolveLayout(layoutId))`. A wide cut is
  16:9 and Reels refuses it; long and lofi renders are 16:9 and far past 90s.
- Disabled while the title is blank or `busy` — flipped in place by the
  panel's title `oninput`, the `publishBtn` pattern (a quiet keystroke reaches
  no render).
- The over-90s case is the **server's** 400, shown in the status callout,
  not a pre-disabled button. The preview `<video>`'s `duration` would let the
  client gate it, but only after `loadedmetadata` plus a render hook, for an
  answer the route already gives before any upload. `ponytail:` gate on
  `outVideo.duration` if the round trip ever annoys.
- `doPublishReel` mirrors `doPublish`: `guard("Reel… 0%")`, a 500ms progress
  poll cleared before `guard`'s `finally`.
- Reads `ytTitle` / `ytDescription` — no new form field.
- On success: `fbVideoId` set, button replaced by a `reel draft` badge and
  an **"Open in Business Suite →"** link.
- `fbVideoId` is a new `AppState` field handled exactly as `ytVideoId` is:
  never persisted, cleared at every site that clears `ytVideoId` (a fresh
  export, leaving `preview`).
- YouTube and Facebook are independent: either, both, any order.

## Tests

`server/facebook.test.ts`:

- `buildCaption`: `#Shorts` / `#shorts` / `#SHORTS` stripped from title and
  description; `#Shortsy` (a different tag) kept; other hashtags kept; blank
  description → title only; no doubled blank lines left behind.
- `reelLengthError`: 2.9 → error, 3 → `null`, 90 → `null`, 90.1 → error, and
  the error names the length.
- `src/state.test.ts`: `fbVideoId` absent from the persisted record.

The HTTP calls, the auth script and the button get none, like the YouTube
side.

## Skipped

- **`SCHEDULED`** — native (`scheduled_publish_time`), so scheduling from
  vstack is a field and a date picker away. Add when Business Suite
  scheduling gets tedious.
- **Custom cover** — undocumented; the first frame is the starter screen,
  which is the cover anyway.
- **Long-form / lofi to Facebook as a regular Page video** — a different
  endpoint (`/{page-id}/videos`). Add when wanted.
- **Personal profiles** — impossible via the API.
