import { describe, expect, it } from "vitest";
import { LAG, MIN_GAP, SKIP_HEAD, TOP, parseChat, peaks } from "./chat.ts";
import type { ChatMsg, Moment } from "./chat.ts";

/** One line of the JSONL yt-dlp writes. `kind` is the renderer key, which is
 *  the single key of `item` and the thing parseChat filters on. */
function line(
  seconds: number,
  kind: string,
  runs: unknown[],
  author = "Someone",
): string {
  return JSON.stringify({
    replayChatItemAction: {
      actions: [{ addChatItemAction: { item: { [kind]: { message: { runs }, authorName: { simpleText: author } } } } }],
      videoOffsetTimeMsec: String(seconds * 1000),
    },
  });
}

describe("parseChat", () => {
  it("reads text, author and offset from a plain message", () => {
    const msgs = parseChat(line(412, "liveChatTextMessageRenderer", [{ text: "hello" }], "Ann"));
    expect(msgs).toEqual([{ t: 412, text: "hello", author: "Ann", paid: false }]);
  });

  it("keeps emoji shortcuts as text, joined with any text runs", () => {
    const msgs = parseChat(
      line(10, "liveChatTextMessageRenderer", [
        { text: "ha " },
        { emoji: { shortcuts: [":face-blue-smiling:", ":alt:"] } },
      ]),
    );
    expect(msgs[0]?.text).toBe("ha :face-blue-smiling:");
  });

  it("drops the engagement banner and placeholder items", () => {
    const jsonl = [
      line(0, "liveChatViewerEngagementMessageRenderer", [{ text: "Live chat replay is on." }]),
      line(1, "liveChatPlaceholderItemRenderer", []),
      line(2, "liveChatTextMessageRenderer", [{ text: "real" }]),
    ].join("\n");
    expect(parseChat(jsonl).map((m) => m.text)).toEqual(["real"]);
  });

  it("flags superchats, memberships and gifts as paid", () => {
    const jsonl = [
      line(1, "liveChatPaidMessageRenderer", [{ text: "$5" }]),
      line(2, "liveChatMembershipItemRenderer", [{ text: "member" }]),
      line(3, "liveChatSponsorshipsGiftPurchaseAnnouncementRenderer", [{ text: "gift" }]),
      line(4, "liveChatTextMessageRenderer", [{ text: "free" }]),
    ].join("\n");
    expect(parseChat(jsonl).map((m) => m.paid)).toEqual([true, true, true, false]);
  });

  it("survives blank lines, malformed JSON and lines that are not chat items", () => {
    const jsonl = [
      "",
      "{not json",
      JSON.stringify({ somethingElse: true }),
      line(5, "liveChatTextMessageRenderer", [{ text: "ok" }]),
      "   ",
    ].join("\n");
    expect(parseChat(jsonl).map((m) => m.text)).toEqual(["ok"]);
  });

  it("skips lines with wrong-typed fields and continues processing", () => {
    const jsonl = [
      JSON.stringify({
        replayChatItemAction: {
          videoOffsetTimeMsec: "1000",
          actions: 5, // Should be an array, but it's a number
        },
      }),
      line(2, "liveChatTextMessageRenderer", [{ text: "ok" }]),
    ].join("\n");
    expect(parseChat(jsonl).map((m) => m.text)).toEqual(["ok"]);
  });
});

/** `n` messages inside the ten-second bin starting at `start`, each from a
 *  distinct author so the spam gate never fires unless a test asks for it. */
function burst(
  start: number,
  n: number,
  opts: { text?: string; author?: string } = {},
): ChatMsg[] {
  return Array.from({ length: n }, (_, i) => ({
    t: start + (i % 10),
    text: opts.text ?? "ok",
    author: opts.author ?? `a${start}-${i}`,
    paid: false,
  }));
}

/** A flat stretch of `perBin` messages in every bin of `[from, to)`. */
function flat(from: number, to: number, perBin: number): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (let s = from; s < to; s += 10) out.push(...burst(s, perBin));
  return out;
}

const at = (ms: Moment[], binStart: number) =>
  ms.find((m) => m.t === binStart - LAG);

describe("peaks", () => {
  it("returns nothing for no messages", () => {
    expect(peaks([])).toEqual([]);
  });

  it("points the timestamp LAG seconds before the peak, not at it", () => {
    const msgs = [...flat(0, 2000, 2), ...burst(600, 40)];
    const top = peaks(msgs);
    expect(top.some((m) => m.t === 600 - LAG)).toBe(true);
    expect(top.some((m) => m.t === 600)).toBe(false);
  });

  it("ignores the stream-open flood", () => {
    // A huge bin at t=0 and a real one at 600s. Only the second may appear.
    // Asserted on the BIN the moment came from (`m.t + LAG`), not on `m.t`:
    // the first legal bin starts at SKIP_HEAD and emits SKIP_HEAD - LAG, so
    // a bare `m.t < SKIP_HEAD` check fails on a perfectly legal moment.
    const msgs = [...flat(0, 2000, 2), ...burst(0, 80), ...burst(600, 40)];
    const top = peaks(msgs);
    expect(top.every((m) => m.t + LAG >= SKIP_HEAD)).toBe(true);
    expect(at(top, 600)).toBeDefined();
  });

  it("emits one moment for two adjacent hot bins, not two", () => {
    const msgs = [...flat(0, 2000, 2), ...burst(600, 40), ...burst(610, 40)];
    const near = peaks(msgs).filter((m) => Math.abs(m.t - (600 - LAG)) < MIN_GAP);
    expect(near).toHaveLength(1);
  });

  it("ranks a real spike above a dead-tail bin with a tiny baseline", () => {
    // Busy stretch (baseline 9) with a 40-message spike, and a dead stretch
    // (baseline 1) with a 9-message bin. `count / base` scores the dead one
    // 9.0 and the real one 4.4 — the exact inversion measured on the spike.
    const msgs = [
      ...flat(0, 1200, 1),
      ...burst(600, 9),
      ...flat(1200, 2400, 9),
      // No laugh tokens on the hot burst, deliberately: the multiplier would
      // roughly double its score and let `count / base` survive the mutation
      // (10.0 dead against 10.8 hot). Plain, it is 10.0 against 5.4 and the
      // mutation fails, which is the whole point of this test.
      ...burst(1800, 40),
    ];
    const top = peaks(msgs);
    const hot = at(top, 1800);
    const dead = at(top, 600);
    expect(hot).toBeDefined();
    expect(dead === undefined || dead.score < (hot?.score ?? 0)).toBe(true);
  });

  it("finds a spike in a quiet stretch of a stream whose mean is high", () => {
    // A dense stretch (30/bin) drags the GLOBAL mean to ~16, which buries a
    // 20-message spike sitting over a local baseline of 2 under the dense
    // stretch's own ordinary bins. A rolling median scores it 7.3.
    const msgs = [
      ...flat(0, 2400, 30),
      ...flat(2400, 4800, 2),
      ...burst(3600, 20, { text: ":))))" }),
    ];
    expect(at(peaks(msgs), 3600)).toBeDefined();
  });

  it("scores one author's flood below the same volume from many", () => {
    const many = [...flat(0, 2000, 2), ...burst(600, 40)];
    const one = [...flat(0, 2000, 2), ...burst(600, 40, { author: "spammer" })];
    const manyScore = at(peaks(many), 600)?.score ?? 0;
    const oneScore = at(peaks(one), 600)?.score ?? 0;
    expect(oneScore).toBeLessThan(manyScore);
  });

  it("carries a sample of the bin's own messages", () => {
    const msgs = [...flat(0, 2000, 2), ...burst(600, 40, { text: "=))))" })];
    expect(at(peaks(msgs), 600)?.sample).toContain("=))))");
  });

  it("returns at most TOP moments, in time order", () => {
    const msgs = [...flat(0, 30000, 2)];
    for (let s = 600; s < 20000; s += 300) msgs.push(...burst(s, 30));
    const top = peaks(msgs);
    expect(top.length).toBeLessThanOrEqual(TOP);
    expect(top.map((m) => m.t)).toEqual([...top.map((m) => m.t)].sort((a, b) => a - b));
  });
});
