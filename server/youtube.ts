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
