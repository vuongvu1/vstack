import { describe, expect, it } from "vitest";
import { BUCKETS_PER_SEC, FADE, MIN_GAP, SKIP_HEAD, SKIP_TAIL, clampPlacement, fill, orderByPrefix, troughs } from "./lofi.ts";
import type { Placement, Speech } from "./lofi.ts";
import { MAX_DROPS } from "./defaults.ts";

/** An envelope at `loud` everywhere except inside `holes`, which sit at
 *  `quiet`. Built at BUCKETS_PER_SEC so the tests speak in seconds. */
function envOf(
  seconds: number,
  holes: { from: number; to: number }[],
  loud = 0.8,
  quiet = 0.05,
): Float32Array {
  const env = new Float32Array(Math.round(seconds * BUCKETS_PER_SEC)).fill(loud);
  for (const h of holes) {
    for (let b = Math.round(h.from * BUCKETS_PER_SEC); b < Math.round(h.to * BUCKETS_PER_SEC); b++) {
      env[b] = quiet;
    }
  }
  return env;
}

const ok = (r: ReturnType<typeof troughs>) => {
  if ("error" in r) throw new Error(`expected placements, got: ${r.error}`);
  return r.placements;
};

describe("troughs", () => {
  it("places a speech inside the one quiet hole", () => {
    // 120s of music, quiet from 40s to 60s. A 6s speech needs 7s of room.
    const env = envOf(120, [{ from: 40, to: 60 }]);
    const [p] = ok(troughs(env, 120, [{ id: "a", name: "a.mp4", seconds: 6 }]));
    expect(p?.id).toBe("a");
    // `at` is where the speech's own picture starts — FADE past the window.
    expect(p?.at).toBeGreaterThanOrEqual(40);
    expect((p?.at ?? 0) + 6).toBeLessThanOrEqual(60);
  });

  it("returns placements in time order, one per speech", () => {
    const env = envOf(240, [{ from: 40, to: 60 }, { from: 150, to: 175 }]);
    const out = ok(
      troughs(env, 240, [
        { id: "a", name: "a.mp4", seconds: 6 },
        { id: "b", name: "b.mp4", seconds: 6 },
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.at).toBeLessThan(out[1]?.at ?? 0);
    expect(new Set(out.map((p) => p.id))).toEqual(new Set(["a", "b"]));
  });

  it("keeps MIN_GAP between two speeches sharing one long hole", () => {
    const env = envOf(240, [{ from: 40, to: 150 }]);
    const out = ok(
      troughs(env, 240, [
        { id: "a", name: "a.mp4", seconds: 6 },
        { id: "b", name: "b.mp4", seconds: 6 },
      ]),
    );
    const [first, second] = [...out].sort((x, y) => x.at - y.at);
    expect((second?.at ?? 0) - ((first?.at ?? 0) + 6)).toBeGreaterThanOrEqual(MIN_GAP);
  });

  // THE ordering test. Input order would drop the short speech into the big
  // hole (it is the quietest) and strand the long one, which fits nowhere
  // else. Longest-first places the long one there and the short one in the
  // small hole. Mutation: sorting by input order instead fails this.
  it("places the longest speech first", () => {
    const env = new Float32Array(300 * BUCKETS_PER_SEC).fill(0.8);
    const quiet = (from: number, to: number, level: number) => {
      for (let b = from * BUCKETS_PER_SEC; b < to * BUCKETS_PER_SEC; b++) env[b] = level;
    };
    quiet(40, 70, 0.02); // 30s and the quietest — the only hole a 20s speech fits
    quiet(150, 162, 0.05); // 12s, room for the 6s speech only
    const out = ok(
      troughs(env, 300, [
        { id: "short", name: "short.mp4", seconds: 6 },
        { id: "long", name: "long.mp4", seconds: 20 },
      ]),
    );
    expect(out).toHaveLength(2);
    const long = out.find((p) => p.id === "long");
    expect(long?.at).toBeGreaterThanOrEqual(40);
    expect((long?.at ?? 0) + 20).toBeLessThanOrEqual(70);
  });

  it("refuses a speech the track has no room for, naming it", () => {
    // 105s of speech needs 106s of window, and a 120s track has only
    // 120 - SKIP_HEAD - SKIP_TAIL = 95 to offer.
    const env = envOf(120, [{ from: 40, to: 48 }]);
    const r = troughs(env, 120, [{ id: "a", name: "long.mp4", seconds: 105 }]);
    expect("error" in r && r.error).toContain("long.mp4");
  });

  it("will not place a speech in the opening or over the ending", () => {
    // The only quiet stretches are inside SKIP_HEAD and inside SKIP_TAIL.
    const env = envOf(120, [{ from: 0, to: SKIP_HEAD }, { from: 120 - SKIP_TAIL, to: 120 }]);
    const out = ok(troughs(env, 120, [{ id: "a", name: "a.mp4", seconds: 4 }]));
    expect(out[0]?.at).toBeGreaterThanOrEqual(SKIP_HEAD);
    expect((out[0]?.at ?? 0) + 4).toBeLessThanOrEqual(120 - SKIP_TAIL);
  });

  it("is stable across repeated calls", () => {
    const env = envOf(240, [{ from: 40, to: 60 }, { from: 150, to: 175 }]);
    const speeches = [
      { id: "a", name: "a.mp4", seconds: 6 },
      { id: "b", name: "b.mp4", seconds: 8 },
    ];
    expect(troughs(env, 240, speeches)).toEqual(troughs(env, 240, speeches));
  });

  it("reserves 2 * FADE around each speech", () => {
    // The hole is exactly the speech plus its two dips and nothing more, so
    // there is exactly one legal window and its position is arithmetic.
    const env = envOf(120, [{ from: 50, to: 50 + 6 + 2 * FADE }]);
    const out = ok(troughs(env, 120, [{ id: "a", name: "a.mp4", seconds: 6 }]));
    expect(out[0]?.at).toBeCloseTo(50 + FADE, 1);
  });

  it("has no placements to make for no speeches", () => {
    expect(ok(troughs(envOf(60, []), 60, []))).toEqual([]);
  });

  it("returns sorted placements even when processing order diverges from time order", () => {
    // Processing order is longest-first: [long, short]. Chronological order must
    // still be [short, long] in the result.
    const env = new Float32Array(300 * BUCKETS_PER_SEC).fill(0.8);
    const quiet = (from: number, to: number, level: number) => {
      for (let b = from * BUCKETS_PER_SEC; b < to * BUCKETS_PER_SEC; b++) env[b] = level;
    };
    quiet(20, 32, 0.05);   // 12s hole, room for 6s speech only
    quiet(150, 180, 0.02); // 30s hole, the only place a 20s speech fits
    const out = ok(
      troughs(env, 300, [
        { id: "short", name: "short.mp4", seconds: 6 },
        { id: "long", name: "long.mp4", seconds: 20 },
      ]),
    );
    expect(out).toHaveLength(2);
    // Processing was [long, short] but returned order must be chronological [short, long]
    expect(out[0]?.id).toBe("short");
    expect(out[1]?.id).toBe("long");
  });
});

describe("clampPlacement", () => {
  const speeches: Speech[] = [
    { id: "a", name: "a.mp4", seconds: 40 },
    { id: "b", name: "b.mp4", seconds: 40 },
  ];

  it("moves a placement to an ordinary spot with room on both sides", () => {
    const placements: Placement[] = [{ key: "a#0", id: "a", at: 30 }];
    const out = clampPlacement(placements, speeches, "a#0", 100, 300);
    expect(out.find((p) => p.id === "a")?.at).toBe(100);
  });

  it("clamps against the track's own start", () => {
    const placements: Placement[] = [{ key: "a#0", id: "a", at: 30 }];
    const out = clampPlacement(placements, speeches, "a#0", -50, 300);
    expect(out.find((p) => p.id === "a")?.at).toBe(FADE);
  });

  it("clamps against the track's own end", () => {
    const placements: Placement[] = [{ key: "a#0", id: "a", at: 30 }];
    const out = clampPlacement(placements, speeches, "a#0", 1000, 300);
    // 300 - 40 (a's own length) - FADE
    expect(out.find((p) => p.id === "a")?.at).toBe(300 - 40 - FADE);
  });

  it("clamps against a neighbour ahead of the drag", () => {
    // b sits at 200; dragging a rightwards must stop MIN_GAP clear of b's start.
    const placements: Placement[] = [
      { key: "a#0", id: "a", at: 30 },
      { key: "b#0", id: "b", at: 200 },
    ];
    const out = clampPlacement(placements, speeches, "a#0", 190, 300);
    expect(out.find((p) => p.id === "a")?.at).toBe(200 - MIN_GAP - 40);
  });

  it("clamps against a neighbour behind the drag", () => {
    // b sits at 30; dragging a leftwards must stop MIN_GAP clear of b's own end.
    const placements: Placement[] = [
      { key: "a#0", id: "a", at: 200 },
      { key: "b#0", id: "b", at: 30 },
    ];
    const out = clampPlacement(placements, speeches, "a#0", 40, 300);
    expect(out.find((p) => p.id === "a")?.at).toBe(30 + 40 + MIN_GAP);
  });

  // The bug this function exists to fix. A 300s track, two 40s speeches: a
  // at 30, b at 259.5 (the right-hand clamp). Dragging a rightwards past b's
  // own start reclassifies b as "before" (want > b.at), so lo is pushed past
  // b's own end while hi stays capped by the track's end — an empty interval
  // with no legal position left. The old code resolved this to `lo`, landing
  // 19.5s past the end of a 300s track; refusing the move must leave a's
  // placement exactly where it was instead.
  it("refuses a drag that leaves no legal position, keeping the placement where it was", () => {
    const placements: Placement[] = [
      { key: "a#0", id: "a", at: 30 },
      { key: "b#0", id: "b", at: 259.5 },
    ];
    const out = clampPlacement(placements, speeches, "a#0", 280, 300);
    expect(out).toEqual(placements);
  });

  // The two tests below are why a placement carries a `key` at all. With a
  // spacing set, `fill` cycles ONE file into many drops, so `id` stops being
  // unique across the array — and the old id-keyed version both rewrote
  // every sibling's `at` (its `map` matched all of them) and hid those
  // siblings from the MIN_GAP scan (its `others` filter dropped all of
  // them). Both fail against that version.
  it("moves only the dragged drop of a repeated speech", () => {
    const one: Speech[] = [{ id: "a", name: "a.mp3", seconds: 10 }];
    const placements: Placement[] = [
      { key: "a#0", id: "a", at: 20 },
      { key: "a#1", id: "a", at: 120 },
      { key: "a#2", id: "a", at: 220 },
    ];
    const out = clampPlacement(placements, one, "a#1", 140, 600);
    expect(out.map((p) => p.at)).toEqual([20, 140, 220]);
  });

  it("bounds a drag by a sibling drop of the same speech", () => {
    const one: Speech[] = [{ id: "a", name: "a.mp3", seconds: 10 }];
    const placements: Placement[] = [
      { key: "a#0", id: "a", at: 20 },
      { key: "a#1", id: "a", at: 120 },
    ];
    // Dragging the first drop rightwards must stop MIN_GAP clear of its own
    // sibling's start, exactly as it would clear a different speech's.
    const out = clampPlacement(placements, one, "a#0", 110, 600);
    expect(out.find((p) => p.key === "a#0")?.at).toBe(120 - MIN_GAP - 10);
  });

  it("returns the placements unchanged for a key it does not know", () => {
    const placements: Placement[] = [{ key: "a#0", id: "a", at: 30 }];
    expect(clampPlacement(placements, speeches, "ghost#0", 100, 300)).toBe(placements);
  });
});

describe("orderByPrefix", () => {
  const named = (...names: string[]) => names.map((name) => ({ name }));

  it("pins a 1_ file first", () => {
    const out = orderByPrefix(named("b.mp3", "1_intro.mp3", "c.mp3"), () => 0);
    expect(out[0]?.name).toBe("1_intro.mp3");
  });

  it("gives the first of two 1_ files the pin and shuffles the other", () => {
    const out = orderByPrefix(named("1_a.mp3", "1_b.mp3", "c.mp3"), () => 0);
    expect(out[0]?.name).toBe("1_a.mp3");
    expect(out.map((x) => x.name).sort()).toEqual(["1_a.mp3", "1_b.mp3", "c.mp3"]);
  });

  it("shuffles everything when no file is pinned", () => {
    // Fisher-Yates with rand() === 0 swaps each i down to index 0, which
    // rotates [a,b,c] to [b,c,a]. Deterministic, so a shuffle that never
    // moves anything fails here.
    const out = orderByPrefix(named("a", "b", "c"), () => 0);
    expect(out.map((x) => x.name)).toEqual(["b", "c", "a"]);
  });

  it("is always a permutation of its input", () => {
    const input = named("a", "b", "1_c", "d", "e");
    const out = orderByPrefix(input, () => 0.5);
    expect(out.map((x) => x.name).sort()).toEqual(["1_c", "a", "b", "d", "e"]);
    expect(out).toHaveLength(5);
  });

  it("does not mutate the caller's array", () => {
    const input = named("a", "b", "1_c");
    orderByPrefix(input, () => 0);
    expect(input.map((x) => x.name)).toEqual(["a", "b", "1_c"]);
  });

  it("handles empty and single-item lists", () => {
    expect(orderByPrefix([], () => 0)).toEqual([]);
    expect(orderByPrefix(named("1_only"), () => 0).map((x) => x.name)).toEqual(["1_only"]);
  });
});

describe("fill", () => {
  const speech = (id: string, seconds: number): Speech => ({ id, name: `${id}.mp3`, seconds });

  it("reduces exactly to troughs when spacing is 0", () => {
    // THE identity. This is what keeps every troughs test above describing
    // live behaviour rather than an orphaned branch.
    const env = envOf(120, [{ from: 60, to: 80 }]);
    const speeches = [speech("a", 6), speech("b", 4)];
    expect(fill(env, 120, speeches, 0)).toEqual(troughs(env, 120, speeches));
  });

  it("reduces to troughs for a negative spacing too", () => {
    const env = envOf(120, [{ from: 60, to: 80 }]);
    const speeches = [speech("a", 6)];
    expect(fill(env, 120, speeches, -1)).toEqual(troughs(env, 120, speeches));
  });

  it("drops a speech once per slot across the track", () => {
    // 600s, spacing 120 => slots centred at 15, 135, 255, 375, 495, 615. The
    // sixth still fits: hi = min(675, 600 - 10 - 7) = 583, lo = 555, and
    // 555 <= 583. The seventh (centre 735) does not, so the loop stops at 6.
    const env = envOf(600, []);
    const found = fill(env, 600, [speech("a", 6)], 120);
    if ("error" in found) throw new Error(found.error);
    expect(found.placements).toHaveLength(6);
  });

  it("cycles the speech list across slots, in list order", () => {
    const env = envOf(600, []);
    const found = fill(env, 600, [speech("a", 6), speech("b", 6)], 120);
    if ("error" in found) throw new Error(found.error);
    expect(found.placements.map((p) => p.id)).toEqual(["a", "b", "a", "b", "a", "b"]);
  });

  it("returns placements in time order", () => {
    const env = envOf(600, []);
    const found = fill(env, 600, [speech("a", 6)], 120);
    if ("error" in found) throw new Error(found.error);
    const ats = found.placements.map((p) => p.at);
    expect([...ats].sort((x, y) => x - y)).toEqual(ats);
  });

  it("clamps a spacing below MIN_GAP up to MIN_GAP", () => {
    const env = envOf(600, []);
    const tight = fill(env, 600, [speech("a", 2)], 1);
    const floored = fill(env, 600, [speech("a", 2)], MIN_GAP);
    expect(tight).toEqual(floored);
  });

  it("never returns more than MAX_DROPS placements", () => {
    const env = envOf(20000, []);
    const found = fill(env, 20000, [speech("a", 2)], MIN_GAP);
    if ("error" in found) throw new Error(found.error);
    expect(found.placements.length).toBeLessThanOrEqual(MAX_DROPS);
  });

  // The cap is the one way this can stop with track still to go, and it used
  // to do so silently — a 1-minute spacing over three hours is 180 slots
  // against MAX_DROPS' 120, so the last hour came back empty with nothing
  // said. The panel's warning reads this flag.
  it("says so when MAX_DROPS is what stopped it", () => {
    const env = envOf(20000, []);
    const found = fill(env, 20000, [speech("a", 2)], MIN_GAP);
    if ("error" in found) throw new Error(found.error);
    expect(found.capped).toBe(true);
  });

  it("does not claim the cap when the end of the track is what stopped it", () => {
    const env = envOf(600, []);
    const found = fill(env, 600, [speech("a", 6)], 120);
    if ("error" in found) throw new Error(found.error);
    expect(found.capped).toBeUndefined();
  });

  // The boundary between the two above, and the only case the `unreachable`
  // half of the flag decides. Here the walk runs all MAX_DROPS iterations —
  // so the iteration count alone would call it capped — but the slot AFTER
  // the last one is already past the last instant a speech may be heard at,
  // so the track ran out in the same breath and there is nothing the cap
  // took away. Warning here would name a limit that cost the user nothing.
  it("does not claim the cap when the track ends on the same slot the cap does", () => {
    const seconds = SKIP_HEAD + MAX_DROPS * MIN_GAP + SKIP_TAIL;
    const found = fill(envOf(seconds, []), seconds, [speech("a", 2)], MIN_GAP);
    if ("error" in found) throw new Error(found.error);
    expect(found.capped).toBeUndefined();
  });

  // THE skip test. `need` (46) plus MIN_GAP (20) is 66 against a 60s step,
  // so `prevEnd + MIN_GAP` drifts ahead of each slot's own window and every
  // second or third slot comes out unreachable — a band the `need > step`
  // refusal cannot see, since 46 is comfortably inside 60. Ending the walk
  // there gave 5 drops with the last at 284.5s, leaving the final 4.5
  // minutes of a 10-minute render silent and saying nothing about it.
  // Skipping the slot instead carries the drops to the end of the track.
  it("skips an unreachable slot rather than ending the walk there", () => {
    const env = envOf(600, []);
    const found = fill(env, 600, [speech("a", 45)], 60);
    if ("error" in found) throw new Error(found.error);
    const last = found.placements[found.placements.length - 1];
    expect(found.placements.length).toBeGreaterThan(5);
    // Well inside the last third of a 600s track, which is the whole of what
    // the old `break` gave up.
    expect(last?.at).toBeGreaterThan(400);
  });

  it("refuses a speech longer than its slot, by name", () => {
    const env = envOf(600, []);
    const found = fill(env, 600, [speech("a", 200)], 60);
    if (!("error" in found)) throw new Error("expected a refusal");
    expect(found.error).toContain("a.mp3");
  });

  it("puts each drop inside its own slot window", () => {
    const env = envOf(600, []);
    const found = fill(env, 600, [speech("a", 6)], 120);
    if ("error" in found) throw new Error(found.error);
    found.placements.forEach((p, k) => {
      const centre = SKIP_HEAD + k * 120;
      expect(Math.abs(p.at - FADE - centre)).toBeLessThanOrEqual(60);
    });
  });

  it("places into the quietest part of a slot", () => {
    // One hole per slot, offset from the slot's own centre. The drop should
    // land in the hole rather than at the centre.
    const env = envOf(600, [{ from: 150, to: 180 }]);
    const found = fill(env, 600, [speech("a", 6)], 120);
    if ("error" in found) throw new Error(found.error);
    const second = found.placements[1];
    if (second === undefined) throw new Error("expected a second placement");
    expect(second.at).toBeGreaterThanOrEqual(150);
    expect(second.at + 6).toBeLessThanOrEqual(180);
  });

  it("keeps MIN_GAP between consecutive drops when slots abut", () => {
    // `need` (111) is inside `(step - MIN_GAP, step]`, which is the only band
    // where the clamp changes the answer: slot k's window ends exactly where
    // slot k+1's begins, so without it drop 1 would start at 75 while drop 0
    // still runs to 126. `/api/lofi` rejects an overlap outright, so the
    // failure would be a 400 on a real render rather than a bad mix.
    const env = envOf(1200, []);
    const found = fill(env, 1200, [speech("a", 110)], 120);
    if ("error" in found) throw new Error(found.error);
    expect(found.placements.length).toBeGreaterThan(1);
    found.placements.slice(1).forEach((p, i) => {
      const prev = found.placements[i];
      if (prev === undefined) throw new Error("expected a previous placement");
      expect(p.at - (prev.at + 110)).toBeGreaterThanOrEqual(MIN_GAP);
    });
  });
});
