import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_TEMPLATE,
  LONG_DESCRIPTION_TEMPLATE,
  LONG_TAGS_DEFAULT,
  TAGS_DEFAULT,
  YT_TITLE_MAX,
  defaultTitle,
} from "./defaults.ts";

describe("defaultTitle", () => {
  it("is the starter title, untouched", () => {
    expect(defaultTitle("Ăn cơm chưa")).toBe("Ăn cơm chưa");
  });

  // The title carries no hashtags any more, so there is nothing to reserve
  // room for — but the 100-char cap is still YouTube's and still hard.
  it("never exceeds YouTube's cap, at any input length", () => {
    for (const n of [0, 1, 50, 99, 100, 101, 200]) {
      expect(defaultTitle("a".repeat(n)).length).toBeLessThanOrEqual(YT_TITLE_MAX);
    }
  });

  // slice() can cut mid-word and leave a trailing space, which would upload a
  // title with a dangling space on the end.
  it("leaves no trailing space", () => {
    expect(defaultTitle(`${"a".repeat(99)} bbb`)).toBe("a".repeat(99));
    expect(defaultTitle("spaced   ")).toBe("spaced");
  });

  it("is blank for a blank title", () => {
    expect(defaultTitle("")).toBe("");
    expect(defaultTitle("   ")).toBe("");
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

  // The three channel hashtags live in the description only — the title
  // carries none. Pinned so an edit does not silently drop them here too.
  it("carries the channel hashtags", () => {
    for (const tag of ["#siini", "#habine", "#sim"]) {
      expect(DESCRIPTION_TEMPLATE).toContain(tag);
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

describe("the long-form defaults", () => {
  // buildSnippet with shorts:false does not append, so the template is the
  // whole description — a shorts tag left in here would ship in the upload
  // and misfile a twenty-minute video as a Short.
  it("carries no shorts tag anywhere", () => {
    expect(LONG_DESCRIPTION_TEMPLATE).not.toMatch(/#shorts\b/i);
    expect(LONG_TAGS_DEFAULT).not.toMatch(/\bshorts\b/i);
  });

  it("still carries the channel's own tags and links", () => {
    expect(LONG_DESCRIPTION_TEMPLATE).toMatch(/#vtubervn\b/);
    expect(LONG_DESCRIPTION_TEMPLATE).toContain("youtube.com/@habine03");
  });

  // buildSnippet splits on commas and trims, so a "#" here would ship a
  // literal "#vtuber" as a tag. Same rule the short list already follows.
  it("is comma-separated rather than hashtagged", () => {
    expect(LONG_TAGS_DEFAULT).not.toContain("#");
    expect(LONG_TAGS_DEFAULT.split(",").every((t) => t.trim() !== "")).toBe(true);
  });

  // YouTube rejects an upload whose concatenated tags run past roughly 500
  // characters, and nothing downstream truncates.
  it("stays well inside YouTube's tag budget", () => {
    expect(LONG_TAGS_DEFAULT.length).toBeLessThan(400);
  });

});
