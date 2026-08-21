import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT_ID } from "./layout.ts";
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
  it("does not clobber a framed box list when a mark is saved back in trimming", () => {
    // The regression case: boxes were framed and saved in an earlier
    // session against the clip's real fetched dimensions (1920x1080).
    const videoId = "regression-trimming";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        start: 5,
        end: 50,
        layoutId: "1-1",
        boxes: [
          { x: 0, y: 0, w: 180, h: 160 },
          { x: 10, y: 10, w: 180, h: 160 },
        ],
        sourceW: 1920,
        sourceH: 1080,
      }),
    );

    // A revisit to trimming starts with boxes back at [] in memory and
    // `source` back at probe's informational (mismatched) dimensions —
    // exactly the state a fresh AppState has before framing runs again.
    setState({
      videoId,
      phase: "trimming",
      start: 12,
      end: 60,
      layoutId: "1-1",
      boxes: [],
      source: { w: 3840, h: 2160 },
    });
    save();

    expect(readRaw(videoId)).toEqual({
      start: 12,
      end: 60,
      layoutId: "1-1",
      boxes: [
        { x: 0, y: 0, w: 180, h: 160 },
        { x: 10, y: 10, w: 180, h: 160 },
      ],
      sourceW: 1920,
      sourceH: 1080,
    });
  });

  it("writes through real boxes and dimensions once framing has them all", () => {
    const videoId = "framed";
    setState({
      videoId,
      phase: "framing",
      start: 1,
      end: 9,
      layoutId: "1-1",
      boxes: [
        { x: 1, y: 1, w: 180, h: 160 },
        { x: 2, y: 2, w: 180, h: 160 },
      ],
      source: { w: 1920, h: 1080 },
    });
    save();

    expect(readRaw(videoId)).toEqual({
      start: 1,
      end: 9,
      layoutId: "1-1",
      boxes: [
        { x: 1, y: 1, w: 180, h: 160 },
        { x: 2, y: 2, w: 180, h: 160 },
      ],
      sourceW: 1920,
      sourceH: 1080,
    });
  });

  it("keeps the previous boxes when framing has fewer than the layout's cells", () => {
    // The subtlest branch of `framed`: phase is "framing" but the list is
    // half-built, which is the state ensureFraming passes through. Writing
    // it would erase a complete list saved earlier.
    const videoId = "half-framed";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        start: 3,
        end: 30,
        layoutId: "2v-1",
        boxes: [
          { x: 5, y: 5, w: 1080, h: 480 },
          { x: 6, y: 6, w: 1080, h: 480 },
          { x: 7, y: 7, w: 180, h: 160 },
        ],
        sourceW: 1920,
        sourceH: 1080,
      }),
    );
    setState({
      videoId,
      phase: "framing",
      start: 4,
      end: 40,
      layoutId: "2v-1",
      boxes: [{ x: 99, y: 99, w: 1080, h: 480 }], // only the first, so far
      source: { w: 1920, h: 1080 },
    });
    save();

    expect(readRaw(videoId)).toMatchObject({
      start: 4,
      end: 40,
      layoutId: "2v-1",
      boxes: [
        { x: 5, y: 5, w: 1080, h: 480 },
        { x: 6, y: 6, w: 1080, h: 480 },
        { x: 7, y: 7, w: 180, h: 160 },
      ],
    });
  });

  it("saves cleanly on a first-ever save with no prior entry", () => {
    const videoId = "first-ever-save";
    setState({
      videoId,
      phase: "trimming",
      start: 3,
      end: 30,
      layoutId: DEFAULT_LAYOUT_ID,
      boxes: [],
      source: { w: 0, h: 0 },
    });

    expect(() => save()).not.toThrow();
    expect(readRaw(videoId)).toEqual({
      start: 3,
      end: 30,
      layoutId: DEFAULT_LAYOUT_ID,
      boxes: [],
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
      layoutId: DEFAULT_LAYOUT_ID,
      boxes: [],
      source: { w: 0, h: 0 },
    });

    expect(() => save()).not.toThrow();
    expect(readRaw(videoId)).toEqual({
      start: 1,
      end: 2,
      layoutId: DEFAULT_LAYOUT_ID,
      boxes: [],
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

  it("migrates a legacy boxTop/boxBottom record onto the 1-1 layout", () => {
    // Records written before layouts existed have no layoutId and no boxes
    // array. Dropping them would silently un-frame every video already in
    // storage.
    const videoId = "legacy";
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

    expect(restore(videoId, { w: 1920, h: 1080 })).toEqual({
      start: 7,
      end: 70,
      layoutId: DEFAULT_LAYOUT_ID,
      boxes: [
        { x: 0, y: 0, w: 180, h: 160 },
        { x: 1, y: 1, w: 180, h: 160 },
      ],
    });
  });

  it("drops boxes when the source dimensions don't match, keeps marks and layout", () => {
    const videoId = "mismatch";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        start: 7,
        end: 70,
        layoutId: "2h-1",
        boxes: [
          { x: 0, y: 0, w: 540, h: 960 },
          { x: 1, y: 1, w: 540, h: 960 },
          { x: 2, y: 2, w: 180, h: 160 },
        ],
        sourceW: 1920,
        sourceH: 1080,
      }),
    );

    // A re-fetch at a different resolution costs the boxes — rects are
    // stored in source pixels — but must not cost the layout choice.
    expect(restore(videoId, { w: 1280, h: 720 })).toEqual({
      start: 7,
      end: 70,
      layoutId: "2h-1",
      boxes: [],
    });
  });

  it("drops boxes whose count does not match the stored layout's cells", () => {
    const videoId = "count-mismatch";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        start: 0,
        end: 5,
        layoutId: "2v-1", // 3 cells
        boxes: [{ x: 0, y: 0, w: 180, h: 160 }], // 1 box
        sourceW: 1920,
        sourceH: 1080,
      }),
    );
    expect(restore(videoId, { w: 1920, h: 1080 })).toMatchObject({
      layoutId: "2v-1",
      boxes: [],
    });
  });

  it("drops boxes that are legal for the wrong cell", () => {
    // 2h-1's first two cells are 540x960 (9:16). A perfect 9:8 rect there
    // would restore and preview cleanly and only die at export.
    const videoId = "wrong-cell";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        start: 0,
        end: 5,
        layoutId: "2h-1",
        boxes: [
          { x: 0, y: 0, w: 180, h: 160 }, // 9:8 — wrong for a 9:16 cell
          { x: 0, y: 0, w: 540, h: 960 },
          { x: 0, y: 0, w: 180, h: 160 },
        ],
        sourceW: 1920,
        sourceH: 1080,
      }),
    );
    expect(restore(videoId, { w: 1920, h: 1080 })).toMatchObject({
      layoutId: "2h-1",
      boxes: [],
    });
  });

  it("falls back to the default layout for an unknown stored id", () => {
    const videoId = "unknown-layout";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        start: 0,
        end: 5,
        layoutId: "not-a-layout",
        boxes: [{ x: 0, y: 0, w: 180, h: 160 }],
        sourceW: 1920,
        sourceH: 1080,
      }),
    );
    expect(restore(videoId, { w: 1920, h: 1080 })).toMatchObject({
      layoutId: DEFAULT_LAYOUT_ID,
      boxes: [],
    });
  });

  it("drops boxes that are not an array at all", () => {
    const videoId = "boxes-not-array";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({ start: 0, end: 5, layoutId: "1-1", boxes: "nope", sourceW: 1920, sourceH: 1080 }),
    );
    expect(restore(videoId, { w: 1920, h: 1080 })).toMatchObject({ boxes: [] });
  });
});
