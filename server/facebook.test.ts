import { describe, expect, it } from "vitest";
import { buildCaption, reelLengthError } from "./facebook.ts";
import { DESCRIPTION_TEMPLATE } from "../src/defaults.ts";

describe("buildCaption", () => {
  it("joins title and description with a blank line", () => {
    expect(buildCaption("Title", "Body")).toBe("Title\n\nBody");
  });

  it("strips #Shorts in any case from both fields", () => {
    expect(buildCaption("Clip #Shorts", "Body #shorts\n#SHORTS")).toBe("Clip\n\nBody");
  });

  it("keeps other hashtags, including ones that merely start with Shorts", () => {
    expect(buildCaption("Clip #vtubervn", "#Shortsy #vtuber")).toBe("Clip #vtubervn\n\n#Shortsy #vtuber");
  });

  it("is the title alone when the description is blank", () => {
    expect(buildCaption("  Title  ", "   ")).toBe("Title");
    expect(buildCaption("Title", "#Shorts")).toBe("Title");
  });

  it("leaves no doubled blank lines where a tag line was", () => {
    expect(buildCaption("T", "a\n\n#Shorts\n\nb")).toBe("T\n\na\n\nb");
  });

  it("is empty when there is nothing but the tag", () => {
    expect(buildCaption("#Shorts", "")).toBe("");
  });
  it("drops the Ko-fi line and the rule above it", () => {
    const out = buildCaption("T", DESCRIPTION_TEMPLATE);
    expect(out).not.toMatch(/ko-fi|coffee/i);
    expect(out).not.toMatch(/-{3,}\s*$/);
    expect(out).toContain("https://www.youtube.com/@simchan_hojo");
  });
});

describe("reelLengthError", () => {
  it("accepts both bounds inclusive", () => {
    expect(reelLengthError(3)).toBeNull();
    expect(reelLengthError(90)).toBeNull();
  });

  it("refuses just outside either bound, naming the length", () => {
    expect(reelLengthError(2.9)).toContain("2.9s");
    expect(reelLengthError(90.1)).toContain("90.1s");
  });
});
