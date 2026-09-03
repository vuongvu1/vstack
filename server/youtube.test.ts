import { describe, expect, it } from "vitest";
import { TAGS_DEFAULT } from "../src/defaults.ts";
import { buildSnippet } from "./youtube.ts";

const base = { title: "Ăn cơm chưa", description: "", tags: "" };

describe("buildSnippet", () => {
  it("trims the title and caps it at YouTube's 100 characters", () => {
    expect(buildSnippet({ ...base, title: "  spaced  " }).snippet.title).toBe("spaced");
    // starterTitle allows 200, so this is reachable from the UI.
    const long = "a".repeat(200);
    expect(buildSnippet({ ...base, title: long }).snippet.title).toHaveLength(100);
  });

  it("appends #Shorts to an empty description", () => {
    expect(buildSnippet(base).snippet.description).toBe("#Shorts");
  });

  it("appends #Shorts below a written description", () => {
    expect(buildSnippet({ ...base, description: "Món ngon" }).snippet.description).toBe(
      "Món ngon\n\n#Shorts",
    );
  });

  it("does not append #Shorts twice when the user typed it", () => {
    const typed = "Món ngon #Shorts";
    expect(buildSnippet({ ...base, description: typed }).snippet.description).toBe(typed);
  });

  it("recognises the user's #shorts regardless of case", () => {
    const typed = "món ngon #shorts";
    expect(buildSnippet({ ...base, description: typed }).snippet.description).toBe(typed);
  });

  // The `\b` in /#shorts\b/i is what makes this "a different word", not the
  // tag. Without the boundary the regex matches here, no tag is appended,
  // and the upload silently loses its #Shorts — every other test in this
  // file passes with the boundary removed, so this is the one guarding it.
  it("does not mistake a longer word starting with shorts for the tag", () => {
    expect(buildSnippet({ ...base, description: "#shortsomething" }).snippet.description).toBe(
      "#shortsomething\n\n#Shorts",
    );
  });

  it("splits tags on commas and drops the empties", () => {
    expect(buildSnippet({ ...base, tags: "an uong, com ,, nau an " }).snippet.tags).toEqual([
      "an uong",
      "com",
      "nau an",
    ]);
  });

  it("returns no tags for a blank field", () => {
    expect(buildSnippet(base).snippet.tags).toEqual([]);
  });

  // Both of these are defaults whose wrong value is a real-world mistake, not
  // a failing assertion: an unaudited API project has every upload locked to
  // private anyway, and the API rejects an upload with no made-for-kids
  // declaration at all.
  it("uploads private and declares not-made-for-kids", () => {
    expect(buildSnippet(base).status).toEqual({
      privacyStatus: "private",
      selfDeclaredMadeForKids: false,
    });
  });

  it("files under People & Blogs", () => {
    expect(buildSnippet(base).snippet.categoryId).toBe("22");
  });
});

describe("buildSnippet with the shipped defaults", () => {
  // The constant and the parser have to agree, and they live on opposite
  // sides of the client/server line — this is the assertion that fails if
  // someone edits TAGS_DEFAULT into a space-separated or hashtagged list.
  it("turns TAGS_DEFAULT into the tags YouTube receives", () => {
    expect(buildSnippet({ ...base, tags: TAGS_DEFAULT }).snippet.tags).toEqual([
      "vtuber",
      "vtubervn",
      "vtuber vietnam",
      "viral",
      "shorts",
    ]);
  });
});

describe("buildSnippet's shorts flag", () => {
  it("leaves the description alone when shorts is false", () => {
    const { snippet } = buildSnippet({
      title: "Tổng hợp",
      description: "Xem thêm ở đây",
      tags: "vtuber",
      shorts: false,
    });
    expect(snippet.description).toBe("Xem thêm ở đây");
    expect(snippet.description).not.toMatch(/#shorts/i);
  });

  it("still appends #Shorts when shorts is true", () => {
    const { snippet } = buildSnippet({
      title: "Ăn cơm chưa",
      description: "Xem thêm ở đây",
      tags: "vtuber",
      shorts: true,
    });
    expect(snippet.description).toBe("Xem thêm ở đây\n\n#Shorts");
  });

  it("defaults to appending, so a body written before this field still works", () => {
    const { snippet } = buildSnippet({
      title: "Ăn cơm chưa",
      description: "Xem thêm ở đây",
      tags: "vtuber",
    });
    expect(snippet.description).toBe("Xem thêm ở đây\n\n#Shorts");
  });

  it("does not append to an empty description when shorts is false", () => {
    // The true branch turns "" into "#Shorts"; the false branch must leave
    // it empty rather than producing a lone newline pair.
    const { snippet } = buildSnippet({
      title: "Tổng hợp",
      description: "",
      tags: "",
      shorts: false,
    });
    expect(snippet.description).toBe("");
  });
});
