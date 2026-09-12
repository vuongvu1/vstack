import { describe, expect, it } from "vitest";
import { parseChat } from "./chat.ts";

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
});
