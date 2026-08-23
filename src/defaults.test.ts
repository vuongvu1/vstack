import { describe, expect, it } from "vitest";
import { DESCRIPTION_TEMPLATE, TITLE_HASHTAGS, YT_TITLE_MAX, defaultTitle } from "./defaults.ts";

describe("defaultTitle", () => {
  it("appends the hashtags to a short title", () => {
    expect(defaultTitle("Ăn cơm chưa")).toBe(`Ăn cơm chưa ${TITLE_HASHTAGS}`);
  });

  // The hashtags are the point of the default — a title long enough to push
  // them past YouTube's cap must lose its own tail, not the tags. Without
  // reserving room first, `.slice(0, 100)` would land mid-tag and upload
  // something like "#vtuber #vir".
  it("keeps the hashtags whole when the starter title is too long", () => {
    const result = defaultTitle("a".repeat(200));
    expect(result.endsWith(TITLE_HASHTAGS)).toBe(true);
    expect(result.length).toBeLessThanOrEqual(YT_TITLE_MAX);
  });

  it("never exceeds YouTube's cap, at any input length", () => {
    for (const n of [0, 1, 50, 76, 77, 78, 99, 100, 101, 200]) {
      expect(defaultTitle("a".repeat(n)).length).toBeLessThanOrEqual(YT_TITLE_MAX);
    }
  });

  // slice() can cut mid-word and leave a trailing space, which would then sit
  // as a double space in front of the tags.
  it("leaves exactly one space before the hashtags", () => {
    expect(defaultTitle("a".repeat(200))).not.toContain("  ");
    expect(defaultTitle("spaced   ")).toBe(`spaced ${TITLE_HASHTAGS}`);
  });

  it("falls back to the bare hashtags for a blank title", () => {
    expect(defaultTitle("")).toBe(TITLE_HASHTAGS);
    expect(defaultTitle("   ")).toBe(TITLE_HASHTAGS);
  });
});

describe("DESCRIPTION_TEMPLATE", () => {
  // buildSnippet appends #Shorts only when absent, case-insensitively. The
  // template already carries `#shorts`, so that append must stay a no-op —
  // this is the assertion that fails if the template is ever edited in a way
  // that drops the tag and silently gets a second one bolted on.
  it("already carries the shorts tag, so buildSnippet will not add another", () => {
    expect(/#shorts\b/i.test(DESCRIPTION_TEMPLATE)).toBe(true);
  });

  it("carries the three channel links", () => {
    expect(DESCRIPTION_TEMPLATE).toContain("https://www.youtube.com/@habine03");
    expect(DESCRIPTION_TEMPLATE).toContain("https://www.youtube.com/@SiiniYT");
    expect(DESCRIPTION_TEMPLATE).toContain("https://www.youtube.com/@simchan_hojo");
  });
});
