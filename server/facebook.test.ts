import { describe, expect, it } from "vitest";
import { buildCaption, reelLengthError } from "./facebook.ts";

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
