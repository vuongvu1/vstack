import { describe, expect, it } from "vitest";
import { videoIdFrom } from "./ytdlp.ts";

// A real, 11-char YouTube id (also used as a fixture elsewhere in this
// repo). Any 11-char [A-Za-z0-9_-] string exercises the same branches.
const ID = "dQw4w9WgXcQ";

// `videoIdFrom` is the only pure, zero-dependency trust boundary in the
// codebase: it alone decides whether a subprocess spawns and with what
// argument, and it has three non-obvious branches — query-param
// extraction, path-tail extraction, and a catch-fallback that accepts any
// 11-char id string while bypassing the host allowlist entirely (intentional,
// since the client posts bare ids, but worth pinning down with a test).
describe("videoIdFrom", () => {
  it("extracts the id from a watch?v= URL", () => {
    expect(videoIdFrom(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID);
  });

  it("extracts the id from a youtu.be/ URL", () => {
    expect(videoIdFrom(`https://youtu.be/${ID}`)).toBe(ID);
  });

  it("extracts the id from a /shorts/ URL", () => {
    expect(videoIdFrom(`https://www.youtube.com/shorts/${ID}`)).toBe(ID);
  });

  it("extracts the id from an /embed/ URL", () => {
    expect(videoIdFrom(`https://www.youtube.com/embed/${ID}`)).toBe(ID);
  });

  it("extracts the id from a /live/ URL", () => {
    expect(videoIdFrom(`https://www.youtube.com/live/${ID}`)).toBe(ID);
  });

  it("accepts a bare 11-char id with no URL structure at all", () => {
    // `new URL(...)` throws on a non-absolute string, so this exercises
    // the catch-fallback branch specifically — the one that accepts any
    // 11-char [A-Za-z0-9_-] string with no host check whatsoever, because
    // the client posts bare ids straight from earlier in the flow.
    expect(videoIdFrom(ID)).toBe(ID);
  });

  it("rejects an 11-char path tail on a non-YouTube host", () => {
    // The case that proves the fallback above is not a general escape
    // hatch: once the input parses as an absolute URL, an 11-char
    // candidate is not sufficient on its own — the host must also be on
    // the allowlist. Same candidate as the bare-id case, different result.
    expect(videoIdFrom(`https://evil.example.com/${ID}`)).toBeNull();
  });

  it("rejects a ?v= value shorter than 11 characters", () => {
    expect(videoIdFrom("https://www.youtube.com/watch?v=short")).toBeNull();
  });

  it("rejects a playlist URL with no video id", () => {
    expect(
      videoIdFrom("https://www.youtube.com/playlist?list=PLabcdefghijklmnop"),
    ).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(videoIdFrom("")).toBeNull();
  });

  it("throws on undefined input rather than silently spawning", () => {
    // The signature claims `string`, but nothing at this trust boundary
    // enforces that at runtime for a caller that violates it (the one
    // production caller, the /api/probe route, already guards this via
    // `str()` before videoIdFrom ever sees the value). Pinning down the
    // actual behaviour here — an uncaught TypeError, not a null or a
    // silently-accepted candidate — rather than asserting what it should
    // be, so a future refactor cannot loosen this without a test noticing.
    expect(() => videoIdFrom(undefined as unknown as string)).toThrow(TypeError);
  });
});
