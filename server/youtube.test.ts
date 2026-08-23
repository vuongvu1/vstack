import { describe, expect, it } from "vitest";
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
