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
