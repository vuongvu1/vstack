# vstack

Turn 2–4 regions of a YouTube video into a 1080×1920 vertical short.

Local single-user tool. Not deployed.

Long sources are the point — a 3h stream is 4–8 GB, so vstack never downloads a
whole video:

1. **Trim** against the real embedded YouTube player. Zero download, instant, and
   YouTube's own scrub bar comes free.
2. **Fetch** only `[start − 5s, end + 5s]` via `yt-dlp --download-sections`, cached
   under `media/`.
3. **Frame** 2–4 independently-sized crop boxes, picked from nine layout presets,
   over a real `<video>` of that clip, with a live 9:16 composite — white gutters
   and rounded corners included — showing exactly what the export will produce.
4. **Export** the composite, then prepend a spoken Vietnamese title card in a
   second ffmpeg pass. The finished file lands in `out/`.

Each layout tiles 1080×1920 exactly across its cells; sizing within a cell is
independent, which is what makes both a facecam-over-gameplay crop and a
two-speakers-from-one-wide-shot crop expressible.

## Setup

    brew install yt-dlp        # ffmpeg and ffprobe are also required
    nvm use
    pnpm install

The server checks for `yt-dlp`, `ffmpeg` and `ffprobe` at boot and exits with an
install hint if any is missing.

## Run

Two processes, two terminals:

    pnpm server   # backend on 127.0.0.1:8787
    pnpm dev      # Vite on :5173

Then open http://localhost:5173 and paste a YouTube URL.

Videos under 3 minutes skip the trimming step and open straight into framing.

## Other commands

    pnpm test     # 150 tests
    pnpm build    # tsc && vite build

## How it behaves

- **Marks** are in the original video's timeline. The fetched clip starts at the
  window's start, and the backend converts between the two — the client never sends
  a file path.
- **Nudging a mark** after framing is free while it stays inside the fetched ±5s pad.
- **Boxes and marks persist** to `localStorage` per video id. Boxes are discarded if a
  re-fetch returns different dimensions, since the rects are stored in source pixels.
- **Export** blocks when the range is empty or the marks fall outside the fetched
  window; a selection over 3 minutes warns (YouTube Shorts' own cap) but is allowed.
- **Exports land in `out/`**, not your Downloads folder, next to the `media/` clip
  they were cut from. The finished file plays back in the app before you decide
  whether to publish it.
- **`media/`** and **`out/`** are both caches and both gitignored. Neither evicts;
  `media/`'s size is logged at boot and after each fetch.

## Publishing

A finished short can be uploaded straight to your YouTube channel from the
preview screen. Uploads land **private** — an unaudited YouTube Data API project
cannot upload public video — so making one public is a manual step in YouTube
Studio afterwards.

One-time setup, in [Google Cloud Console](https://console.cloud.google.com):

1. Create a project and enable the **YouTube Data API v3**.
2. OAuth consent screen → External → add yourself as a test user → set
   publishing status to **In production** (needs no verification for this
   scope; left on Testing, Google expires the token after 7 days).
3. Credentials → Create credentials → OAuth client ID → **Desktop app**.
4. Download the JSON to `~/.vstack/youtube-client.json`.

Then run the one-off auth dance:

    pnpm youtube-auth

It opens Google's consent screen and writes `~/.vstack/youtube-token.json`. Run
it again any time publishing fails with an authorisation error. Without either
file, everything except Publish still works.

## Troubleshooting

**"yt-dlp failed: … 403 Forbidden"** — two format selectors are tried in order because
they are complementary (some videos have no working HLS rendition, others no working
progressive one). If both fail the video is likely region-locked or members-only; the
raw yt-dlp message is passed through verbatim.

**The player never appears** — a video YouTube refuses to embed (private, deleted,
age-restricted, region-locked, embedding disabled) surfaces an error and a Retry
button. One attempt per click; there is no automatic retry.

**Black bands in the output** — usually the source's own letterbox or pillarbox
reproduced faithfully. A 4:3 video inside a 16:9 frame has ~238px bars each side, and
the default boxes pin to the frame edges. Drag the boxes inside the picture area.

**Export says "Window … is not cached"** — the clip for that window is gone (cache
cleared, or a stale `localStorage` entry). Press Re-fetch, or go Back to trim and
Continue again.

## Docs

- `CLAUDE.md` — architecture, invariants, and the gotchas that cost time. Read first.
- `docs/specs/2026-08-20-vstack-design.md` — the design, accurate to what shipped.
- `docs/FOLLOWUPS.md` — what was deliberately left undone, and why.
- `docs/plans/2026-08-20-vstack.md` — the historical build plan, with inline "as built"
  corrections. A record, not instructions.

## Note

Fetching YouTube video files conflicts with YouTube's Terms of Service unless
the content is yours or you hold a license. This tool exists for the former.
