# vstack — finding a livestream's moments in its chat replay

2026-09-12

Supersedes nothing and extends nothing. It adds a **dead-end lookup** beside
the two journeys: a way in from `idle` that answers "where are the
interesting moments in this 11-hour stream" and hands back a list of
timestamped links. It never writes `segments`, never fetches video, never
reaches `framing`, `preview` or `/api/export`. Every other spec in this
directory is unaffected, and that isolation is the design rather than a
happy accident.

## What the user asked for

A stream is hours long and the clippable moments are minutes of it. Chat
knows where they are: the audience reacts. Given a finished livestream URL,
produce a list of peak moments as `youtu.be/<id>?t=<seconds>` links with
enough context to triage, and a copy button — pasted into Todoist, a
multi-line block becomes one task per line.

Explicitly **not** asked for: picking a moment inside the app, auto-marking
a trim, or exporting anything. This is a lookup that ends in the clipboard.

## The feasibility spike

Run before this document existed, on a real 11h19m Vietnamese stream
(`smf3SB2fgQY`). Every constant below comes from it.

| fact | measured |
|---|---|
| chat replay retrievable | yes — `yt-dlp --skip-download --write-subs --sub-langs live_chat` |
| timestamp field | `replayChatItemAction.videoOffsetTimeMsec`, relative to VOD start |
| fetch cost | 45s, 20 MB JSONL, 13,267 lines |
| parse cost | ~1s, no dependencies |
| density | 12,626 usable messages, 19.5 msg/min, 2171/4072 ten-second bins non-empty |

`videoOffsetTimeMsec` is already in the VOD's own timeline, so no clock
alignment is needed anywhere in this feature.

The spike also produced three **wrong** scorers before a right one, and each
wrong one is a silent failure rather than an error. They are the reason
section "Scoring" reads the way it does, and they are what
`server/chat.test.ts` mutation-tests.

## Scoring

Ten-second bins over the whole stream. For bin `i`:

```
base   = max(median(count over bins i-30 … i+30), 1)     // ±5 minutes
excess = (count - base) / sqrt(base + 4)
score  = excess * (1 + 1.2 * laughRatio)
       + 2.5 * paidCount
       + (uniqueAuthors / count < 0.5 ? -2 : 0)
```

Peaks are taken highest-first with non-maximum suppression at `MIN_GAP`
(90s), capped at `TOP` (15).

**The baseline must be a rolling median, never a global mean.** An 11-hour
stream has hours of dead air; the global mean was 3.3 messages per bin,
against a local baseline of 9-16 inside the busy stretches. Scored globally,
every mildly busy bin in a live stretch outranks a genuine spike, and the
ranking fills with the loudest *hour* rather than the loudest *moments*.

**The denominator must be `sqrt(base + 4)`, never `base`.** A plain ratio is
division by a small number: measured, `count / base` promoted a bin at
604:20 with **9 messages over a baseline of 1** to the top of the list —
noise from the stream's dead tail, ranked above a bin with 40 messages and
17 laugh tokens over a baseline of 9. The Poisson-shaped denominator
requires absolute volume *and* a relative jump; the `+ 4` is the smoothing
that stops a baseline of 1 from mattering at all.

**`uniqueAuthors / count` is a spam gate, not a refinement.** One person
typing forty messages is a bin with a spike in it and nothing worth
clipping.

Laugh tokens are Vietnamese-first and matched case-insensitively:

```
:))+   =))+   =]]+   kk+   haha   hehe   😂 🤣 😆
vãi    vcl    cl     lmao   xD    ewww   ???+
```

They are a *multiplier* on excess rather than an additive term, so a bin
with a high laugh ratio and no volume still scores nothing.

## Two artifacts that must be removed, not tuned

**The engagement banner.** YouTube's own "Live chat replay is on" message is
a `liveChatViewerEngagementMessageRenderer` at offset 0. Left in, it lands
in a bin with the stream-open greeting flood and **won the spike's first
ranking outright**. Dropped at parse, alongside
`liveChatPlaceholderItemRenderer`.

**The stream-open flood.** Even with the banner gone, t=0 carried 38
greeting emotes over a baseline of 2. `SKIP_HEAD` (60s) excludes the opening
minute from the ranking. It is the one place in the scorer where a bin is
discarded rather than scored.

## The lag offset

Chat reacts *after* the moment. Every emitted timestamp is therefore
`max(0, binStart - LAG)` with `LAG = 15`, which covers the reaction delay
plus a lead-in so the link opens before the setup rather than on the
punchline.

**`LAG` is not measured.** The spike could not watch the video. 15s is
chosen because the error is asymmetric — too early costs a scrub forward,
too late means the moment already happened — and it carries a `ponytail:`
comment naming the calibration: open three suggested links against the real
video and adjust the one constant.

## Architecture

### `server/chat.ts`

New module, sitting beside `ytdlp.ts` and `mask.ts` — **above** `ffmpeg.ts`
because it needs `MEDIA_DIR` for the cache, and importing nothing else. It
does not import `ytdlp.ts`: the route does its own probing and hands this
module a video id.

```ts
export type ChatMsg = { t: number; text: string; author: string; paid: boolean };
export type Moment  = { t: number; score: number; count: number; sample: string };

export const BIN = 10, WIN = 30, LAG = 15, TOP = 15, MIN_GAP = 90, SKIP_HEAD = 60;

export function fetchChat(videoId: string): Promise<string>;  // → path to chat.json
export function parseChat(jsonl: string): ChatMsg[];          // pure
export function peaks(msgs: ChatMsg[]): Moment[];             // pure
```

`sample` is up to four messages from the peak's own bin, each truncated to
30 characters, joined with `" | "` and the whole capped at 60 — it is what
makes a pasted Todoist task triageable without opening the link, and a
Todoist task name that runs to three lines is not.

### The cache

`fetchChat` writes `media/<videoId>/chat.json` and returns early when it
already exists. A finished stream's chat replay is immutable, so there is no
staleness to reason about.

The path cannot collide with the clip cache: `CLIP_RE` is anchored
(`^(\d+)-(\d+)(?:-([0-9a-f]{8}))?\.mp4$`), so `listClips` can never offer
`chat.json` as a clip, and `reportCache` counts it at boot for free. 20 MB
per stream, swept by hand like the rest of `media/`.

Caching is not an optimisation for the user's sake — it is what makes
*tuning the constants* possible, since every retune means re-running the
scorer over the same stream.

### `/api/moments`

Body `{ url }`. Response `{ videoId, title, moments }`.

The route calls the existing `probe()` first, for two reasons:

1. It resolves the id and title with the same validator every other route
   uses — `videoIdFrom` stays the one trust boundary that decides whether a
   subprocess spawns, and this feature adds no second one.
2. It reports `liveStatus`, which is **load-bearing**: on a stream that is
   still live, `--sub-langs live_chat` follows the chat in real time and
   never returns. `is_live` and `post_live` are refused with *"Stream still
   live — chat replay exists only after it ends."* rather than hanging the
   request.

A run that writes no file — uploader disabled replay, or the video was never
a stream — answers *"No chat replay for this video."* A yt-dlp failure goes
through `toolError` like every other spawn in this codebase.

### Client

- `src/api.ts` gains one wrapper, `moments(url)`.
- `Phase` gains `"moments"`. `AppState` gains `moments: Moment[]`, **not
  persisted** — it belongs to a lookup, the same rule `cuts` follows.
- `mode` is deliberately **not** claimed on this exit from `idle`. The
  invariant that every exit claims it exists because the short and long
  journeys meet at `preview` and misclassify an upload otherwise; this flow
  reaches neither, so there is nothing to claim and a stale value cannot
  reach anything that reads it. Documented at the call site rather than left
  to be rediscovered.
- `momentsPanel` is a child of `sourceSlot`, built once and toggled with
  `hidden`, under the same rule as `publishForm` and `stackPanel` —
  `sourceSlot` itself is never hidden or emptied.
- The `moments` bar is a URL field, `Find`, and `← Back` to `idle`. The idle
  bar gains `Chat moments →` beside `Long form →`. The field reads and
  writes `state.url` — the same unpersisted field the idle bar already
  quiet-updates on every keystroke, so a URL typed on one screen survives
  the move to the other and neither screen loses the cursor to a render.
- Each row is `mm:ss` + sample, opening `https://youtu.be/<id>?t=<t>` in a
  new tab, so a peak can be checked before the list is copied. `mmss`
  already lives in `src/format.ts`.
- `Copy all` writes `lines.join("\n")` via `navigator.clipboard`, one line
  per peak:

```
68:40  =)))))) | :))) | :_anhnhacem:  https://youtu.be/smf3SB2fgQY?t=4105
```

The line is built client-side from `t` and `sample` as a template literal.
There is no new client module, and no formatting logic on the server.

### One trap in `render()`

`render()` gates the title/duration/size badges on
`s.phase !== "idle" && s.mode === "short"`. In `moments` that predicate is
true with whatever `mode` was left at, so it would paint three badges
describing a video this flow never probed. The gate becomes an explicit
phase check.

## Testing

`server/chat.test.ts`, pure only — no network, no yt-dlp, no fixtures on
disk.

`parseChat` against a hand-built JSONL string: an ordinary text message, the
engagement banner, a placeholder item, a superchat, and a run of emoji
shortcuts. Asserts the two dropped renderer kinds are gone, that `paid` is
set for the superchat, and that emoji runs survive as their shortcuts.

`peaks` against synthetic bins, mutation-testing the three scorers the spike
actually built and rejected:

| mutation | must fail on |
|---|---|
| `count / base` instead of `(count - base) / sqrt(base + 4)` | a 9-message bin over a baseline of 1 outranking a 40-message bin over a baseline of 9 |
| global mean instead of rolling median | a genuine spike inside a busy stretch dropping out of the top 15 |
| `LAG` dropped | an emitted `t` landing on the peak instead of 15s before it |

Plus `SKIP_HEAD` (a large bin at t=0 is not in the output) and `MIN_GAP` (two
adjacent high bins yield one moment, not two).

`fetchChat`, the route, and the panel have no tests, like the rest of the
network and DOM surface in this codebase.

## Out of scope

- **Audio loudness.** Measures the streamer; chat measures the audience. One
  ffmpeg filter away if chat ever proves too quiet to bin — not needed while
  chat alone finds 15 candidates in 11 hours for 45 seconds of compute.
- **ASR.** Answers "what was said", when the question is "where to cut".
- **A trained classifier.** There are no labels. This heuristic is what
  would produce them.
- **Any tuning UI.** Bin size, weights, count and lag are source constants.
  There is no feedback loop that would tell a slider it was set better.
- **Writing `segments`.** A picked moment does not auto-mark a trim. The
  flow ends in the clipboard.
