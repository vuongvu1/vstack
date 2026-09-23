/** What the publish bar's fields are pre-filled with.
 *
 *  Their own module rather than constants inside `main.ts` because these are
 *  the values most likely to be edited by hand — the channel list changes,
 *  the tag set changes — and hunting for them inside a thousand-line render
 *  file is the wrong ask. Shared client and server, like `format.ts`:
 *  `YT_TITLE_MAX` is the cap `buildSnippet` enforces and the cap
 *  `defaultTitle` builds against, and one definition is what keeps those two
 *  from drifting apart.
 *
 *  Every value here is a *default*. The preview bar's fields are editable and
 *  the server takes whatever they end up holding. */

/** YouTube rejects a longer title outright. `starterTitle` allows 200, so
 *  this is reachable from the UI, not theoretical. */
export const YT_TITLE_MAX = 100;

/** Pre-fills the description field. Already carries a shorts tag, which is
 *  why `buildSnippet`'s append is a no-op against it — see the test. */
export const DESCRIPTION_TEMPLATE = `#vtuber #vtubervn #vtubervietnam #viral #shorts #habine #siini #sim

------

Habi nè: https://www.youtube.com/@habine03
Siini: https://www.youtube.com/@SiiniYT
Sim: https://www.youtube.com/@simchan_hojo`;

/** Pre-fills the tags field, which is comma-separated rather than
 *  hashtagged — `buildSnippet` splits on commas and trims, so a `#` here
 *  would ship a literal "#vtuber" as a tag.
 *
 *  Mirrors the description's tag set. "vtuber vietnam" is two words on
 *  purpose: a hashtag has to be one token, a tag does not, and the spaced
 *  form is what people actually type into search.
 *
 *  YouTube rejects an upload whose concatenated tags run past roughly 500
 *  characters and nothing downstream truncates, so keep additions short. */
export const TAGS_DEFAULT = "vtuber, vtubervn, vtuber vietnam, viral, shorts";

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

/** The starter title, capped for YouTube.
 *
 *  The title carries no hashtags of its own — the tags live in the
 *  description and the tags field, which is where YouTube reads them from
 *  anyway. The whole 100 characters are the title's. */
export function defaultTitle(starterTitle: string): string {
  return starterTitle.trim().slice(0, YT_TITLE_MAX).trim();
}

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

/** The most speech FILES one lofi render will take.
 *
 *  Files, not drops. Those were the same number until a speech could repeat;
 *  now this bounds how many distinct recordings the panel accepts and
 *  `MAX_DROPS` bounds how many times they are heard. The distinction is what
 *  keeps the ffmpeg graph's INPUT count bounded by this while its LEG count
 *  grows with `MAX_DROPS` — one input per file, `asplit` into its drops, the
 *  same shape the crackle leg already has.
 *
 *  Shared client and server, like `MAX_PARTS`: the panel refuses the 101st
 *  file before it is uploaded, and `/api/lofi` refuses it again because the
 *  route is reachable without the panel.
 *
 *  100 rather than the 8 this shipped with, and it is an INPUT count on the
 *  ffmpeg graph — one `-i` each, plus the background, the music, the crackle
 *  and the mark. Raised on request; unmeasured at the top of its range, so
 *  `ponytail:` if a hundred-file render ever fails, the graph's input count
 *  is the first thing to measure. `MAX_DROPS` still bounds the LEGS, which
 *  is the half that grows with every placement. */
export const MAX_SPEECHES = 100;

/** The most speech placements one render will carry.
 *
 *  A sanity bound on the filter graph's size, not a judgement about pacing:
 *  every drop is an `asplit` tap plus an `atrim`, an `adelay` and a crackle
 *  boost leg with two fades.
 *
 *  Sized against what the panel's own defaults can now ask for rather than
 *  against a round number: `MAX_TRACKS` four-minute tracks is about 280
 *  minutes, and the default spacing is one minute, so a full render wants
 *  roughly 280 drops. At the old 120 the cap bound on essentially every
 *  render — two hours in, the rest of the mix silent — which is a limit
 *  doing harm rather than a backstop.
 *
 *  `ponytail:` reasoned from that arithmetic, NOT measured. Nobody has
 *  rendered a 300-drop graph here; what protects a user who reaches it is
 *  `fill`'s `capped` flag, which says so in the panel instead of trimming
 *  the render in silence. Measure it the day someone builds one. */
export const MAX_DROPS = 300;

/** The most music tracks one render will concatenate.
 *
 *  Seventy four-minute tracks is about four and a half hours. The bound is
 *  on the CONCAT PRE-PASS's input count, which is the one place in this
 *  journey that still grows with the music list — the main graph takes the
 *  pre-pass's single output whatever the list's length. */
export const MAX_TRACKS = 70;

/** The short journey's description, with the source video credited on top.
 *
 *  Short-journey only: a stack or a lofi mix has no single source video to
 *  point at, which is why this takes an id rather than `LONG_DESCRIPTION_TEMPLATE`
 *  growing one too. A blank id falls back to the bare template, so the
 *  cached-clip path and any older stored record still read exactly as before.
 *
 *  ponytail: the bare video link, not `?t=<clipStart>` — a credit points at
 *  the video, and a deep link would need the mark carried in here too. Add
 *  the timestamp the day someone wants the exact moment. */
export function defaultDescription(videoId: string): string {
  if (videoId.trim() === "") return DESCRIPTION_TEMPLATE;
  return `Nguồn: https://youtu.be/${videoId}\n\n${DESCRIPTION_TEMPLATE}`;
}

/** How long the bundled `end_video.mp4` outro runs, in seconds.

 *  Measured, not assumed: `ffprobe` reports 5.040000, and the asset is loud
 *  right up to its last sample (final second, -20.9 dB mean / -4.9 peak), so
 *  an amplitude detector finds it as speech every single time.
 *
 *  The cutter's Detect subtracts it from the search window, because the file
 *  it is handed is usually a vstack short and that tail is never what anyone
 *  is cutting for. The head cannot get a constant of its own — the starter
 *  screen is `max(1.6, 0.35 + voiceSeconds + 0.45)` and scales with how long
 *  the title takes to read — so it is excluded by touching t=0 instead.
 *
 *  Client-side only today. It lives here rather than in `waveform.ts`
 *  because it is a fact about a bundled asset rather than about envelopes,
 *  and `server/starter.ts` owns the asset's path the way it always has —
 *  `detectTrim` still MEASURES the outro rather than reading this, which is
 *  the right direction for the server and is why the two do not share it.
 *  Re-measure if the asset is ever replaced. */
export const OUTRO_SECONDS = 5.04;
