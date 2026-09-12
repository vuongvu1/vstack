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

/** A moment worth looking at, at the instant a link should open. */
export type Moment = { t: number; score: number; count: number; sample: string };

/** Bin width in seconds. Ten is short enough to localise a reaction and long
 *  enough that a quiet stream still has countable bins. */
export const BIN = 10;
/** Bins each side of the one being scored that form its baseline — ±5
 *  minutes, long enough to span a bit and short enough to track a stream
 *  waking up. */
export const WIN = 30;
/** How far BEFORE a peak its link points. Chat reacts after the moment, so a
 *  link on the peak opens on the aftermath, and the error is asymmetric:
 *  early costs a scrub forward, late means it already happened.
 *
 *  ponytail: not measured — the spike could not watch the video. Calibrate by
 *  opening three suggested links against a real stream and moving this one
 *  number. */
export const LAG = 15;
export const TOP = 15;
/** Non-maximum suppression radius: two peaks inside 90s are one moment. */
export const MIN_GAP = 90;
/** The opening minute is excluded from the RANKING (never from the
 *  baseline): a stream opens on a greeting flood — 38 emotes over a baseline
 *  of 2, measured — that is not a moment. */
export const SKIP_HEAD = 60;

/** Laugh and reaction tokens, Vietnamese first. Matched case-insensitively
 *  and used as a MULTIPLIER on excess rather than as an additive term, so a
 *  bin that is all laughter and no volume still scores nothing. */
const LAUGH =
  /:\){2,}|=\){2,}|=\]{2,}|\bkk+\b|haha|hehe|😂|🤣|😆|\bvãi\b|\bvcl\b|\bvl\b|\bcl\b|\blmao\b|\bxD\b|ewww|\?{3,}/i;

type Bin = { count: number; laugh: number; paid: number; authors: Set<string>; sample: string[] };

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 0;
}

/** Ranks ten-second bins of chat by how much harder they react than their own
 *  neighbourhood does.
 *
 *  Three properties of the formula are load-bearing and each was measured as
 *  a silent failure on a real 11-hour stream:
 *
 *  - The baseline is a ROLLING MEDIAN, not a global mean. Globally the stream
 *    averaged 3.3 messages a bin against a local 9-16 inside its busy
 *    stretches, so a global baseline ranks the loudest hour rather than the
 *    loudest moments.
 *  - The denominator is `sqrt(base + 4)`, not `base`. A plain ratio is
 *    division by a small number: `count / base` put 9 messages over a
 *    baseline of 1 — dead air at the end of the stream — above 40 messages
 *    and 17 laugh tokens over a baseline of 9.
 *  - Unique authors gate the bin. Forty messages from one person is a spike
 *    with nothing in it. */
export function peaks(msgs: ChatMsg[]): Moment[] {
  if (msgs.length === 0) return [];

  const last = msgs.reduce((m, x) => Math.max(m, x.t), 0);
  const n = Math.floor(last / BIN) + 1;
  const bins: Bin[] = Array.from({ length: n }, () => ({
    count: 0,
    laugh: 0,
    paid: 0,
    authors: new Set<string>(),
    sample: [],
  }));

  for (const m of msgs) {
    const b = bins[Math.floor(m.t / BIN)];
    if (!b) continue;
    b.count++;
    if (LAUGH.test(m.text)) b.laugh++;
    if (m.paid) b.paid++;
    b.authors.add(m.author);
    // Four messages, 30 characters each: the sample's job is to make a
    // pasted Todoist task triageable, and a task name running to three lines
    // is not.
    if (b.sample.length < 4 && m.text !== "") b.sample.push(m.text.slice(0, 30));
  }

  const counts = bins.map((b) => b.count);
  const scored = bins.map((b, i) => {
    // The window is clamped rather than wrapped, and it spans the whole
    // array including bins SKIP_HEAD excludes from the ranking — a head bin
    // is still evidence about its neighbours.
    const base = Math.max(median(counts.slice(Math.max(0, i - WIN), i + WIN + 1)), 1);
    const excess = (b.count - base) / Math.sqrt(base + 4);
    const laughRatio = b.count === 0 ? 0 : b.laugh / b.count;
    const spam = b.count > 0 && b.authors.size / b.count < 0.5 ? -2 : 0;
    return {
      start: i * BIN,
      score: excess * (1 + 1.2 * laughRatio) + 2.5 * b.paid + spam,
      count: b.count,
      sample: b.sample.join(" | ").slice(0, 60),
    };
  });

  const out: Moment[] = [];
  for (const b of [...scored].sort((x, y) => y.score - x.score)) {
    if (b.start < SKIP_HEAD) continue;
    const t = Math.max(0, b.start - LAG);
    if (out.some((m) => Math.abs(m.t - t) < MIN_GAP)) continue;
    out.push({ t, score: b.score, count: b.count, sample: b.sample });
    if (out.length === TOP) break;
  }
  return out.sort((a, b) => a.t - b.t);
}
