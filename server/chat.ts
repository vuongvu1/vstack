/** A message out of a livestream's chat replay, at its offset in the VOD's
 *  own timeline. `text` carries emoji shortcuts verbatim — a channel's
 *  custom emotes are most of the reaction on a Vietnamese stream, and they
 *  only ever arrive as the emoji form. */
export type ChatMsg = { t: number; text: string; author: string; paid: boolean };

/** The two renderer kinds that are not chat. The banner is YouTube's own
 *  "Live chat replay is on." at offset 0 — left in, it lands in the same bin
 *  as the stream-open greeting flood and wins the ranking outright. */
const DROP = /ViewerEngagement|Placeholder/;

/** The four paid kinds, by the substring they share. A table of exact names
 *  would need editing every time YouTube adds a gift variant. */
const PAID = /Paid|Membership|Sponsorships/;

type Run = { text?: string; emoji?: { shortcuts?: string[] } };
type Renderer = {
  message?: { runs?: Run[] };
  headerSubtext?: { runs?: Run[] };
  authorName?: { simpleText?: string };
};
type Line = {
  replayChatItemAction?: {
    videoOffsetTimeMsec?: string;
    actions?: { addChatItemAction?: { item?: Record<string, Renderer> } }[];
  };
};

/** yt-dlp writes JSONL — one object per line, not an array — so this parses
 *  per line and skips anything that does not answer. The file is untrusted
 *  in the ordinary sense (it is whatever YouTube served), so a malformed
 *  line — whether a JSON syntax error or a valid line with wrong-typed
 *  fields — is stepped over rather than thrown on: one bad fragment must not
 *  cost an eleven-hour stream's worth of chat. */
export function parseChat(jsonl: string): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (const raw of jsonl.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const parsed = JSON.parse(raw) as Line;
      const replay = parsed.replayChatItemAction;
      if (!replay) continue;
      const t = Number(replay.videoOffsetTimeMsec ?? Number.NaN) / 1000;
      if (!Number.isFinite(t)) continue;
      for (const action of replay.actions ?? []) {
        const item = action.addChatItemAction?.item;
        if (!item) continue;
        // The renderer kind IS the single key of `item` — there is no type
        // field to read.
        const kind = Object.keys(item)[0];
        if (kind === undefined || DROP.test(kind)) continue;
        const rend = item[kind];
        if (!rend) continue;
        const runs = rend.message?.runs ?? rend.headerSubtext?.runs ?? [];
        out.push({
          t,
          text: runs.map((r) => r.text ?? r.emoji?.shortcuts?.[0] ?? "").join(""),
          author: rend.authorName?.simpleText ?? "",
          paid: PAID.test(kind),
        });
      }
    } catch {
      // A syntactically valid line with wrong-typed fields (e.g. actions not
      // an array, runs not an array) throws during processing and is stepped
      // over. Messages already pushed from an earlier part of this line stay
      // in the output; that is fine.
      continue;
    }
  }
  return out;
}
