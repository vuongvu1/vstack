import { describe, expect, it } from "vitest";
import { clock, mmss, slugify } from "./format.ts";

describe("slugify", () => {
  it("converts a long title to a slug with no trailing dash", () => {
    const longTitle = "word0 word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11";
    const result = slugify(longTitle);
    expect(result).not.toMatch(/^-/);
    expect(result).not.toMatch(/-$/);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it("falls back to 'clip' for all-punctuation title", () => {
    expect(slugify("!!!???...")).toBe("clip");
    expect(slugify("@#$%^&*")).toBe("clip");
    expect(slugify("  \t  ")).toBe("clip");
  });

  it("handles whitespace and special characters", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("foo  bar")).toBe("foo-bar");
    expect(slugify("test-case")).toBe("test-case");
  });
});

describe("mmss", () => {
  it("zero-pads seconds", () => {
    expect(mmss(0)).toBe("0000");
    expect(mmss(5)).toBe("0005");
    expect(mmss(45)).toBe("0045");
    expect(mmss(59)).toBe("0059");
  });

  it("formats minutes and seconds", () => {
    expect(mmss(60)).toBe("0100");
    expect(mmss(125)).toBe("0205");
    expect(mmss(3661)).toBe("6101");
  });

  it("handles values over 59 minutes", () => {
    // 60 minutes = 3600 seconds
    expect(mmss(3600)).toBe("6000");
    expect(mmss(7200)).toBe("12000");
  });

  it("clamps negative input to 0", () => {
    expect(mmss(-5)).toBe("0000");
    expect(mmss(-100)).toBe("0000");
  });

  it("rounds fractional seconds", () => {
    expect(mmss(5.4)).toBe("0005");
    expect(mmss(5.6)).toBe("0006");
  });
});

describe("clock", () => {
  it("formats as hh:mm:ss with every field zero-padded", () => {
    expect(clock(0)).toBe("00:00:00");
    expect(clock(5)).toBe("00:00:05");
    expect(clock(45)).toBe("00:00:45");
    expect(clock(59)).toBe("00:00:59");
  });

  it("formats minutes correctly", () => {
    expect(clock(60)).toBe("00:01:00");
    expect(clock(125)).toBe("00:02:05");
    expect(clock(599)).toBe("00:09:59");
  });

  it("rolls minutes over into hours instead of accumulating them", () => {
    expect(clock(3600)).toBe("01:00:00");
    expect(clock(3661)).toBe("01:01:01");
    expect(clock(5376)).toBe("01:29:36");
    expect(clock(5446)).toBe("01:30:46");
  });

  it("keeps hours past 99 rather than truncating", () => {
    expect(clock(360000)).toBe("100:00:00");
  });

  it("clamps negative input to 0", () => {
    expect(clock(-5)).toBe("00:00:00");
    expect(clock(-100)).toBe("00:00:00");
  });

  it("floors fractional seconds", () => {
    expect(clock(5.9)).toBe("00:00:05");
    expect(clock(59.9)).toBe("00:00:59");
  });
});
