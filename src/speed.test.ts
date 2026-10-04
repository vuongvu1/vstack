import { describe, expect, it } from "vitest";
import { speedAt } from "./speed.ts";

describe("speedAt", () => {
  const speeds = [{ start: 2, end: 5, speed: 4 as const }];
  it("names the speed of the range under t", () => {
    expect(speedAt(speeds, [], 3)).toBe(4);
    expect(speedAt(speeds, [], 5)).toBe(null);
    expect(speedAt(speeds, [], 1.9)).toBe(null);
  });
  it("is null inside a cut, because cut beats speed", () => {
    expect(speedAt(speeds, [{ start: 3, end: 4 }], 3.5)).toBe(null);
  });
});
