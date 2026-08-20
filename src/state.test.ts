import { beforeEach, describe, expect, it } from "vitest";
import { restore, save, setState } from "./state.ts";

/** vitest's config runs this file under Node, which has no `localStorage`
 *  global. `state.ts` is pure logic over whatever object sits at
 *  `globalThis.localStorage`, so a tiny Map-backed stub — implementing the
 *  full `Storage` interface, not a partial cast — is all that's needed;
 *  no DOM required. Reset between tests so one test's writes can't leak
 *  into the next. */
function makeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
    clear: () => {
      data.clear();
    },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size;
    },
  };
}

beforeEach(() => {
  globalThis.localStorage = makeStorage();
});

function readRaw(videoId: string): unknown {
  const raw = localStorage.getItem(`vstack:${videoId}`);
  return raw === null ? null : JSON.parse(raw);
}

describe("save", () => {
  it("does not clobber a framed box pair when a mark is saved back in trimming", () => {
    // The regression case: boxes were framed and saved in an earlier
    // session against the clip's real fetched dimensions (1920x1080).
    const videoId = "regression-trimming";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        start: 5,
        end: 50,
        boxTop: { x: 0, y: 0, w: 180, h: 160 },
        boxBottom: { x: 10, y: 10, w: 180, h: 160 },
        sourceW: 1920,
        sourceH: 1080,
      }),
    );

    // A revisit to trimming starts with boxes back at null in memory and
    // `source` back at probe's informational (mismatched) dimensions —
    // exactly the state a fresh AppState has before framing runs again.
    setState({
      videoId,
      phase: "trimming",
      start: 12,
      end: 60,
      boxTop: null,
      boxBottom: null,
      source: { w: 3840, h: 2160 },
    });
    save();

    expect(readRaw(videoId)).toEqual({
      start: 12,
      end: 60,
      boxTop: { x: 0, y: 0, w: 180, h: 160 },
      boxBottom: { x: 10, y: 10, w: 180, h: 160 },
      sourceW: 1920,
      sourceH: 1080,
    });
  });

  it("writes through real boxes and dimensions once framing has both boxes", () => {
    const videoId = "write-through-framing";
    setState({
      videoId,
      phase: "framing",
      start: 1,
      end: 2,
      boxTop: { x: 1, y: 1, w: 180, h: 160 },
      boxBottom: { x: 2, y: 2, w: 180, h: 160 },
      source: { w: 1280, h: 720 },
    });
    save();

    expect(readRaw(videoId)).toEqual({
      start: 1,
      end: 2,
      boxTop: { x: 1, y: 1, w: 180, h: 160 },
      boxBottom: { x: 2, y: 2, w: 180, h: 160 },
      sourceW: 1280,
      sourceH: 720,
    });
  });

  it("keeps the previous box pair intact when only one box is set during framing", () => {
    // The subtlest branch of `framed`: phase is "framing" but the pair is
    // incomplete (e.g. mid box-editing, only the top box touched so far).
    // Persisting a half-complete pair would be worse than persisting
    // nothing — the other box would silently point at last session's rect.
    const videoId = "partial-pair";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        start: 0,
        end: 10,
        boxTop: { x: 5, y: 5, w: 180, h: 160 },
        boxBottom: { x: 6, y: 6, w: 180, h: 160 },
        sourceW: 1920,
        sourceH: 1080,
      }),
    );

    setState({
      videoId,
      phase: "framing",
      start: 0,
      end: 10,
      boxTop: { x: 99, y: 99, w: 180, h: 160 }, // freshly touched
      boxBottom: null, // not set yet
      source: { w: 1920, h: 1080 },
    });
    save();

    expect(readRaw(videoId)).toEqual({
      start: 0,
      end: 10,
      boxTop: { x: 5, y: 5, w: 180, h: 160 }, // previous pair, not the half-set one
      boxBottom: { x: 6, y: 6, w: 180, h: 160 },
      sourceW: 1920,
      sourceH: 1080,
    });
  });

  it("saves cleanly on a first-ever save with no prior entry", () => {
    const videoId = "first-ever-save";
    setState({
      videoId,
      phase: "trimming",
      start: 3,
      end: 30,
      boxTop: null,
      boxBottom: null,
      source: { w: 0, h: 0 },
    });

    expect(() => save()).not.toThrow();
    expect(readRaw(videoId)).toEqual({
      start: 3,
      end: 30,
      boxTop: null,
      boxBottom: null,
      sourceW: 0,
      sourceH: 0,
    });
  });

  it("recovers from a malformed prior entry instead of throwing", () => {
    const videoId = "malformed-prior";
    localStorage.setItem(`vstack:${videoId}`, "{not json");
    setState({
      videoId,
      phase: "trimming",
      start: 1,
      end: 2,
      boxTop: null,
      boxBottom: null,
      source: { w: 0, h: 0 },
    });

    expect(() => save()).not.toThrow();
    expect(readRaw(videoId)).toEqual({
      start: 1,
      end: 2,
      boxTop: null,
      boxBottom: null,
      sourceW: 0,
      sourceH: 0,
    });
  });

  it("is a no-op without a videoId", () => {
    setState({ videoId: "", phase: "trimming" });
    expect(() => save()).not.toThrow();
  });
});

describe("restore", () => {
  it("returns {} when nothing is stored", () => {
    expect(restore("never-saved", null)).toEqual({});
  });

  it("tolerates malformed or unexpected storage contents without throwing", () => {
    const videoId = "malformed-restore";
    const cases = ["{not json", "null", "[1,2,3]", "42", '"a string"'];
    for (const raw of cases) {
      localStorage.setItem(`vstack:${videoId}`, raw);
      expect(() => restore(videoId, null)).not.toThrow();
      expect(restore(videoId, null)).toEqual({});
    }
  });

  it("drops boxes when the source dimensions don't match, keeps marks", () => {
    const videoId = "dimension-mismatch";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        start: 7,
        end: 70,
        boxTop: { x: 0, y: 0, w: 180, h: 160 },
        boxBottom: { x: 1, y: 1, w: 180, h: 160 },
        sourceW: 1920,
        sourceH: 1080,
      }),
    );

    const mismatched = restore(videoId, { w: 3840, h: 2160 });
    expect(mismatched).toEqual({ start: 7, end: 70, boxTop: null, boxBottom: null });

    const matched = restore(videoId, { w: 1920, h: 1080 });
    expect(matched).toEqual({
      start: 7,
      end: 70,
      boxTop: { x: 0, y: 0, w: 180, h: 160 },
      boxBottom: { x: 1, y: 1, w: 180, h: 160 },
    });
  });
});
