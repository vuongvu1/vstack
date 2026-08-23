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

/** Appended to the YouTube title. `#shorts` here is separate from the
 *  `#Shorts` `buildSnippet` guarantees in the *description* — the title tag
 *  is what shows under the video, the description tag is the classification
 *  hint. */
export const TITLE_HASHTAGS = "#vtuber #viral #shorts";

/** Pre-fills the description field. Already carries a shorts tag, which is
 *  why `buildSnippet`'s append is a no-op against it — see the test. */
export const DESCRIPTION_TEMPLATE = `#vtuber #vtubervn #vtubervietnam #viral #shorts

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

/** The starter title plus the hashtags, capped for YouTube.
 *
 *  Room for the tags is reserved *first* and the title takes what is left.
 *  The naive order — concatenate, then `slice(0, 100)` — cuts the tail, and
 *  the tail is the tags: a long Vietnamese title would upload ending in
 *  `#vtuber #vir`. A clipped title is recoverable by editing the field; a
 *  clipped hashtag reads as a typo to every viewer. */
export function defaultTitle(starterTitle: string): string {
  const head = starterTitle.slice(0, YT_TITLE_MAX - TITLE_HASHTAGS.length - 1).trim();
  return head === "" ? TITLE_HASHTAGS : `${head} ${TITLE_HASHTAGS}`;
}
