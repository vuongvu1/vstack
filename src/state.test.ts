import { beforeEach, describe, expect, it } from "vitest";
import { MAX_CUSTOM, isValidCustom } from "./custom.ts";
import { DEFAULT_LAYOUT_ID } from "./layout.ts";
import { MAX_SEGMENTS } from "./segments.ts";
import { restore, save, saveVoice, savedTitle, savedVoice, setState } from "./state.ts";

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
        segments: [{ start: 5, end: 50 }],
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
      segments: [{ start: 12, end: 60 }],
      layoutId: "1-1",
      boxes: [],
      source: { w: 3840, h: 2160 },
    });
    save();

    expect(readRaw(videoId)).toEqual({
      segments: [{ start: 12, end: 60 }],
      starterTitle: "",
      layoutId: "1-1",
      boxes: [
        { x: 0, y: 0, w: 180, h: 160 },
        { x: 10, y: 10, w: 180, h: 160 },
      ],
      customs: [],
      sourceW: 1920,
      sourceH: 1080,
    });
  });

  it("self-heals a legacy boxTop/boxBottom record to `boxes` on the next save", () => {
    // A record written before layouts existed has no `boxes` field at all —
    // only the old pair. `readSaved`'s migration turns that pair into
    // `boxes` in memory on *every* read, including save()'s own `prev`
    // lookup below, so a plain mark-only save during a later trimming visit
    // writes the migrated shape straight back to storage. There is no
    // dedicated upgrade step; the record self-heals as a side effect of the
    // very first save that touches it.
    const videoId = "self-heal";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        segments: [{ start: 1, end: 10 }],
        boxTop: { x: 0, y: 0, w: 180, h: 160 },
        boxBottom: { x: 5, y: 5, w: 180, h: 160 },
        sourceW: 1920,
        sourceH: 1080,
      }),
    );

    setState({
      videoId,
      phase: "trimming",
      segments: [{ start: 2, end: 20 }],
      layoutId: DEFAULT_LAYOUT_ID,
      boxes: [],
      source: { w: 3840, h: 2160 },
    });
    save();

    // toEqual is exact-shape, so this also proves boxTop/boxBottom are gone
    // from the written record, not merely that `boxes` was added alongside
    // them.
    expect(readRaw(videoId)).toEqual({
      segments: [{ start: 2, end: 20 }],
      starterTitle: "",
      layoutId: DEFAULT_LAYOUT_ID,
      boxes: [
        { x: 0, y: 0, w: 180, h: 160 },
        { x: 5, y: 5, w: 180, h: 160 },
      ],
      customs: [],
      sourceW: 1920,
      sourceH: 1080,
    });
  });

  it("writes through real boxes and dimensions once framing has them all", () => {
    const videoId = "framed";
    setState({
      videoId,
      phase: "framing",
      segments: [{ start: 1, end: 9 }],
      layoutId: "1-1",
      boxes: [
        { x: 1, y: 1, w: 180, h: 160 },
        { x: 2, y: 2, w: 180, h: 160 },
      ],
      source: { w: 1920, h: 1080 },
    });
    save();

    expect(readRaw(videoId)).toEqual({
      segments: [{ start: 1, end: 9 }],
      starterTitle: "",
      layoutId: "1-1",
      boxes: [
        { x: 1, y: 1, w: 180, h: 160 },
        { x: 2, y: 2, w: 180, h: 160 },
      ],
      customs: [],
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
        segments: [{ start: 3, end: 30 }],
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
      segments: [{ start: 4, end: 40 }],
      layoutId: "2v-1",
      boxes: [{ x: 99, y: 99, w: 1080, h: 480 }], // only the first, so far
      source: { w: 1920, h: 1080 },
    });
    save();

    expect(readRaw(videoId)).toMatchObject({
      segments: [{ start: 4, end: 40 }],
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
      segments: [{ start: 3, end: 30 }],
      layoutId: DEFAULT_LAYOUT_ID,
      boxes: [],
      source: { w: 0, h: 0 },
    });

    expect(() => save()).not.toThrow();
    expect(readRaw(videoId)).toEqual({
      segments: [{ start: 3, end: 30 }],
      starterTitle: "",
      layoutId: DEFAULT_LAYOUT_ID,
      boxes: [],
      customs: [],
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
      segments: [{ start: 1, end: 2 }],
      layoutId: DEFAULT_LAYOUT_ID,
      boxes: [],
      source: { w: 0, h: 0 },
    });

    expect(() => save()).not.toThrow();
    expect(readRaw(videoId)).toEqual({
      segments: [{ start: 1, end: 2 }],
      starterTitle: "",
      layoutId: DEFAULT_LAYOUT_ID,
      boxes: [],
      customs: [],
      sourceW: 0,
      sourceH: 0,
    });
  });

  it("keeps the voice out of the per-video record", () => {
    // The regression this split fixes: the voice used to ride along in each
    // video's entry, so every *new* video opened on the server's fallback
    // instead of the voice already chosen. toMatchObject would pass either
    // way — the point is the key's absence, so this reads the raw object.
    const videoId = "voice-not-per-video";
    saveVoice("Mai Anh");
    setState({
      videoId,
      phase: "framing",
      voice: "Mai Anh",
      segments: [{ start: 1, end: 9 }],
      layoutId: "1-1",
      boxes: [
        { x: 1, y: 1, w: 180, h: 160 },
        { x: 2, y: 2, w: 180, h: 160 },
      ],
      source: { w: 1920, h: 1080 },
    });
    save();

    expect(readRaw(videoId)).not.toHaveProperty("voice");
    // …and restoring that video must not hand a voice back either, or it
    // would overwrite the global choice with nothing on every load.
    expect(restore(videoId, { w: 1920, h: 1080 })).not.toHaveProperty("voice");
    // The global key is where it actually lives, untouched by either call.
    expect(savedVoice()).toBe("Mai Anh");
  });

  it("is a no-op without a videoId", () => {
    setState({ videoId: "", phase: "trimming" });
    expect(() => save()).not.toThrow();
  });

  it("persists the starter title from any phase, like a mark and unlike a box", () => {
    // The title is typed in framing but gated like a mark, not like a box:
    // it always reflects the current session, so it must survive a save from
    // trimming — where `framed` is false and boxes/dimensions are carried
    // forward from the previous record instead of written.
    const videoId = "starter-title";
    setState({
      videoId,
      phase: "trimming",
      starterTitle: "Ăn cơm chưa bạn ơi",
      segments: [{ start: 2, end: 20 }],
      layoutId: "1-1",
      boxes: [],
      source: { w: 3840, h: 2160 },
    });
    save();

    expect(readRaw(videoId)).toEqual({
      segments: [{ start: 2, end: 20 }],
      starterTitle: "Ăn cơm chưa bạn ơi",
      layoutId: DEFAULT_LAYOUT_ID,
      boxes: [],
      customs: [],
      sourceW: 0,
      sourceH: 0,
    });
    expect(restore(videoId, null)).toMatchObject({ starterTitle: "Ăn cơm chưa bạn ơi" });
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
        segments: [{ start: 7, end: 70 }],
        boxTop: { x: 0, y: 0, w: 180, h: 160 },
        boxBottom: { x: 1, y: 1, w: 180, h: 160 },
        sourceW: 1920,
        sourceH: 1080,
      }),
    );

    expect(restore(videoId, { w: 1920, h: 1080 })).toEqual({
      segments: [{ start: 7, end: 70 }],
      starterTitle: "",
      layoutId: DEFAULT_LAYOUT_ID,
      boxes: [
        { x: 0, y: 0, w: 180, h: 160 },
        { x: 1, y: 1, w: 180, h: 160 },
      ],
      customs: [],
    });
  });

  it("prefers `boxes` over a stale boxTop/boxBottom pair when a record carries both", () => {
    // readSaved's migration only fires when `boxes === undefined` — a
    // record that somehow still carries a leftover pair alongside a real
    // `boxes` array (e.g. hand-edited storage, or a future bug that stops
    // clearing the old fields) must not let the stale pair win.
    const videoId = "both-present";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        segments: [{ start: 2, end: 20 }],
        layoutId: "1-1",
        boxes: [
          { x: 3, y: 3, w: 180, h: 160 },
          { x: 4, y: 4, w: 180, h: 160 },
        ],
        boxTop: { x: 999, y: 999, w: 180, h: 160 },
        boxBottom: { x: 998, y: 998, w: 180, h: 160 },
        sourceW: 1920,
        sourceH: 1080,
      }),
    );

    expect(restore(videoId, { w: 1920, h: 1080 })).toEqual({
      segments: [{ start: 2, end: 20 }],
      starterTitle: "",
      layoutId: "1-1",
      boxes: [
        { x: 3, y: 3, w: 180, h: 160 },
        { x: 4, y: 4, w: 180, h: 160 },
      ],
      customs: [],
    });
  });

  it("drops boxes when the source dimensions don't match, keeps marks and layout", () => {
    const videoId = "mismatch";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        segments: [{ start: 7, end: 70 }],
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
      segments: [{ start: 7, end: 70 }],
      starterTitle: "",
      layoutId: "2h-1",
      boxes: [],
      customs: [],
    });
  });

  it("drops boxes whose count does not match the stored layout's cells", () => {
    const videoId = "count-mismatch";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        segments: [{ start: 0, end: 5 }],
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
        segments: [{ start: 0, end: 5 }],
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
        segments: [{ start: 0, end: 5 }],
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
      JSON.stringify({
        segments: [{ start: 0, end: 5 }],
        layoutId: "1-1",
        boxes: "nope",
        sourceW: 1920,
        sourceH: 1080,
      }),
    );
    expect(restore(videoId, { w: 1920, h: 1080 })).toMatchObject({ boxes: [] });
  });
});

describe("segments", () => {
  it("round-trips a multi-segment selection", () => {
    setState({ videoId: "vid00000001", duration: 600, segments: [
      { start: 10, end: 20 },
      { start: 40, end: 50 },
    ] });
    save();
    expect(restore("vid00000001", null).segments).toEqual([
      { start: 10, end: 20 },
      { start: 40, end: 50 },
    ]);
  });

  it("migrates a pre-segments {start, end} record into one segment", () => {
    localStorage.setItem(
      "vstack:vid00000002",
      JSON.stringify({ start: 12, end: 34, starterTitle: "x" }),
    );
    expect(restore("vid00000002", null).segments).toEqual([{ start: 12, end: 34 }]);
  });

  it("migrates a record marked at the very start of the video", () => {
    // The case a truthiness check gets wrong: `s.start ?? s.end` reads a
    // stored `start: 0` as "nothing here" and drops a real mark. Pressing
    // Set Start without moving the playhead produces exactly this record.
    localStorage.setItem("vstack:vid00000003", JSON.stringify({ start: 0, end: 34 }));
    expect(restore("vid00000003", null).segments).toEqual([{ start: 0, end: 34 }]);
  });

  it("drops a stored selection that is not valid", () => {
    localStorage.setItem(
      "vstack:vid00000004",
      JSON.stringify({ segments: [{ start: 40, end: 20 }] }),
    );
    expect(restore("vid00000004", null).segments).toBeUndefined();
  });

  it("drops a stored selection with more than MAX_SEGMENTS parts", () => {
    // localStorage is untrusted input. A hand-edited record with twenty
    // individually legal parts would otherwise reach fetchWindow and fire
    // twenty downloads before the server's own check ever ran.
    const many = Array.from({ length: MAX_SEGMENTS + 1 }, (_v, i) => ({
      start: i * 10,
      end: i * 10 + 5,
    }));
    localStorage.setItem("vstack:vid00000005", JSON.stringify({ segments: many }));
    expect(restore("vid00000005", null).segments).toBeUndefined();
  });

  it("never persists clipStart, clipEnd or clipDigest", () => {
    // They belong to a fetched window, not to the video — the same reason
    // clipUrl and windowStart are absent from the record.
    setState({ videoId: "vid00000006", duration: 600, segments: [{ start: 1, end: 2 }],
      clipStart: 0, clipEnd: 1, clipDigest: "a1b2c3d4" });
    save();
    const raw = readRaw("vid00000006") as Record<string, unknown>;
    expect(raw).not.toHaveProperty("clipStart");
    expect(raw).not.toHaveProperty("clipEnd");
    expect(raw).not.toHaveProperty("clipDigest");
  });
});

describe("save / restore — custom boxes", () => {
  const source = { w: 1920, h: 1080 };
  const custom = {
    out: { x: 300, y: 700, w: 480, h: 480 },
    crop: { x: 0, y: 100, w: 480, h: 480 },
  };

  it("round-trips the pieces alongside the boxes", () => {
    const videoId = "customs-round-trip";
    setState({
      videoId,
      phase: "framing",
      layoutId: DEFAULT_LAYOUT_ID,
      source,
      boxes: [
        { x: 0, y: 100, w: 900, h: 800 },
        { x: 1020, y: 100, w: 900, h: 800 },
      ],
      customs: [custom],
    });
    save();
    expect(restore(videoId, source).customs).toEqual([custom]);
  });

  it("does not persist pieces outside framing", () => {
    // MUTATION TEST: drop the phase gate and this record gains a customs
    // array written from a phase where the source size is still probe's
    // informational one.
    const videoId = "customs-gated";
    setState({ videoId, phase: "trimming", source, boxes: [], customs: [custom] });
    save();
    expect(readRaw(videoId)).not.toHaveProperty("customs", [custom]);
  });

  it("drops pieces that are illegal against the restored source", () => {
    const videoId = "customs-illegal";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        segments: [{ start: 0, end: 10 }],
        layoutId: DEFAULT_LAYOUT_ID,
        boxes: [
          { x: 0, y: 100, w: 900, h: 800 },
          { x: 1020, y: 100, w: 900, h: 800 },
        ],
        customs: [{ out: { x: 301, y: 700, w: 480, h: 480 }, crop: custom.crop }],
        sourceW: 1920,
        sourceH: 1080,
      }),
    );
    expect(restore(videoId, source).customs).toEqual([]);
  });

  it("drops a record holding more pieces than MAX_CUSTOM, however legal each is", () => {
    // localStorage is untrusted input. Each of these three passes
    // isValidCustom on its own, so without the count bound the session mounts
    // three nodes, previews them, and only dies at assertCustoms with a 400
    // — the same posture the boxes path takes against the layout's cell count.
    const videoId = "customs-too-many";
    const legal = Array.from({ length: MAX_CUSTOM + 1 }, (_, i) => ({
      out: { x: 300 + i * 2, y: 700, w: 480, h: 480 },
      crop: { x: i * 2, y: 100, w: 480, h: 480 },
    }));
    expect(legal.every((c) => isValidCustom(c, source))).toBe(true);
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        segments: [{ start: 0, end: 10 }],
        layoutId: DEFAULT_LAYOUT_ID,
        boxes: [
          { x: 0, y: 100, w: 900, h: 800 },
          { x: 1020, y: 100, w: 900, h: 800 },
        ],
        customs: legal,
        sourceW: 1920,
        sourceH: 1080,
      }),
    );
    expect(restore(videoId, source).customs).toEqual([]);
    // The boxes are computed independently and must survive the bad pieces.
    expect(restore(videoId, source).boxes).toHaveLength(2);
  });

  it("returns no pieces for a record that predates the feature", () => {
    const videoId = "customs-legacy";
    localStorage.setItem(
      `vstack:${videoId}`,
      JSON.stringify({
        segments: [{ start: 1, end: 2 }],
        layoutId: DEFAULT_LAYOUT_ID,
        sourceW: 0,
        sourceH: 0,
      }),
    );
    expect(restore(videoId, source).customs).toEqual([]);
  });
});

// `savedTitle` is the idle screen's label lookup for a cached clip: the
// media cache stores a videoId and window bounds, nothing a human recognises,
// so the row falls back to the starter title typed the last time that video
// was framed. It reads the same stored record `restore` does, but must answer
// without a source size — the point is to label a clip *before* opening it.
describe("savedTitle", () => {
  it("returns the starter title stored for a video", () => {
    setState({ videoId: "abc12345678", starterTitle: "Bí mật của Linh", phase: "idle" });
    save();
    expect(savedTitle("abc12345678")).toBe("Bí mật của Linh");
  });

  it("returns empty for a video with no stored record", () => {
    expect(savedTitle("zzz98765432")).toBe("");
  });

  it("returns empty for a record that predates starter titles", () => {
    // A pre-starter-screen save has no `starterTitle` key at all. The row
    // falls back to the videoId rather than rendering "undefined".
    localStorage.setItem("vstack:old12345678", JSON.stringify({ segments: [{ start: 1, end: 2 }] }));
    expect(savedTitle("old12345678")).toBe("");
  });

  it("returns empty for a corrupt record instead of throwing", () => {
    localStorage.setItem("vstack:bad12345678", "{not json");
    expect(savedTitle("bad12345678")).toBe("");
  });
});
