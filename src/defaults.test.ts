import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_TEMPLATE,
  TAGS_DEFAULT,
  TITLE_HASHTAGS,
  YT_TITLE_MAX,
  defaultTitle,
} from "./defaults.ts";

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
    // The interesting lengths are the ones either side of the budget the tags
    // leave, so they are derived rather than written down — editing
    // TITLE_HASHTAGS moves the boundary, and hardcoded numbers would quietly
    // stop testing it.
    const budget = YT_TITLE_MAX - TITLE_HASHTAGS.length - 1;
    for (const n of [0, 1, budget - 1, budget, budget + 1, 99, 100, 101, 200]) {
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

  // The three channel hashtags ride in both fields — the title for search,
  // the description because that is the field people actually read. Pinned
  // here so an edit to one place does not silently drop them from the other.
  it("carries the channel hashtags", () => {
    for (const tag of ["#siini", "#habine", "#sim"]) {
      expect(DESCRIPTION_TEMPLATE).toContain(tag);
      expect(TITLE_HASHTAGS).toContain(tag);
    }
  });

  it("carries the three channel links", () => {
    expect(DESCRIPTION_TEMPLATE).toContain("https://www.youtube.com/@habine03");
    expect(DESCRIPTION_TEMPLATE).toContain("https://www.youtube.com/@SiiniYT");
    expect(DESCRIPTION_TEMPLATE).toContain("https://www.youtube.com/@simchan_hojo");
  });
});

describe("TAGS_DEFAULT", () => {
  // The field is comma-separated, not hashtags: buildSnippet splits on
  // commas. A stray "#" would ship a literal "#vtuber" as a tag.
  it("is comma-separated and carries no hashes", () => {
    expect(TAGS_DEFAULT).toContain(",");
    expect(TAGS_DEFAULT).not.toContain("#");
  });

  it("has no empty entries once split and trimmed", () => {
    const tags = TAGS_DEFAULT.split(",").map((tag) => tag.trim());
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.every((tag) => tag !== "")).toBe(true);
  });

  // YouTube rejects the whole upload when the concatenated tags run past
  // roughly 500 characters, and nothing between this constant and the API
  // truncates — so the default has to be comfortably clear of it by itself.
  it("stays far under YouTube's total tag ceiling", () => {
    expect(TAGS_DEFAULT.length).toBeLessThan(200);
  });
});
