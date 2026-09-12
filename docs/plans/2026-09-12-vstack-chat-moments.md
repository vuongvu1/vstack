# Chat Moments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given a finished YouTube livestream URL, list the 15 moments its chat replay reacted hardest to, as `youtu.be/<id>?t=` links copyable one-per-line into Todoist.

**Architecture:** A dead-end flow beside the two journeys — `idle` → `moments` → `idle`. One new server module (`server/chat.ts`: yt-dlp fetch + a pure parser + a pure scorer), one new route (`/api/moments`), one new client phase with a panel in `sourceSlot`. Nothing downstream of `idle` learns it exists: no `segments`, no video fetch, no export.

**Tech Stack:** Node 24 type-stripping TS (no build for `server/`), vitest, vanilla-TS client, `yt-dlp` on PATH.

**Spec:** `docs/specs/2026-09-12-vstack-chat-moments-design.md`

## Global Constraints

Copied from `CLAUDE.md` — every task's requirements implicitly include these.

- **Node runs `server/*.ts` with type stripping.** No `enum`, no `namespace`, no constructor parameter properties. Non-erasable syntax is a *boot crash*, not a compile error.
- `import type` for type-only imports. Explicit `.ts` extensions on every relative import.
- No default exports, no barrel files, no `any`.
- No `console.log` / `console.info` — `.error` / `.warn` only.
- `strict` and `noUncheckedIndexedAccess` are on: indexing yields `T | undefined`. Guard with `?? fallback`, never `!`.
- Visual values come from the `@radix-ui/colors` custom properties and the hand-rolled token layer in `src/style.css` (`--radius-1..4`, `--space-1..6`, `--shadow-2/3`, `--control-height`). No fresh literals.
- Button variants are classes: bare `<button>` is soft accent, `.btn-solid` is the one phase-advancing action, `.btn-gray` steps back.
- `ponytail:` comments mark deliberate simplifications and name the upgrade path.
- **`Bash(git add)`, `Bash(git commit *)` and `Bash(rm *)` are deny-listed.** Use `git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add/commit` and Node's `fs.rm`.
- Branch is `feat/chat-moments`, already cut. The spec is already committed on it.
- Test command is `pnpm test` (vitest). Single file: `pnpm vitest run server/chat.test.ts`.

**Constants, exact values, used across Tasks 1-4:**

```
BIN = 10    WIN = 30    LAG = 15    TOP = 15    MIN_GAP = 90    SKIP_HEAD = 60
```

---

### Task 1: `parseChat` — chat replay JSONL to messages

**Files:**
- Create: `server/chat.ts`
- Create: `server/chat.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type ChatMsg = { t: number; text: string; author: string; paid: boolean }` and `export function parseChat(jsonl: string): ChatMsg[]`. Task 2 consumes `ChatMsg`; Task 3 calls `parseChat`.

**Background the implementer needs:**

`yt-dlp --write-subs --sub-langs live_chat` writes JSONL — one JSON object per line, not a JSON array. Each line that matters looks like:

```json
{"replayChatItemAction":{"actions":[{"addChatItemAction":{"item":{"liveChatTextMessageRenderer":{"message":{"runs":[{"text":"hello"}]},"authorName":{"simpleText":"Someone"}}}}}],"videoOffsetTimeMsec":"4120000"}}
```

`videoOffsetTimeMsec` is milliseconds from the start of the VOD — already the timeline the `?t=` link uses, so no clock alignment is needed anywhere.

The renderer kind is the *single key* of `item`. Eight kinds were observed on a real stream. Two must be dropped:

- `liveChatViewerEngagementMessageRenderer` — YouTube's own "Live chat replay is on" banner at offset 0. Left in, it **won the feasibility spike's first ranking outright**.
- `liveChatPlaceholderItemRenderer` — an empty placeholder, 625 of them on the spike stream.

Four count as paid (`liveChatPaidMessageRenderer`, `liveChatPaidStickerRenderer`, `liveChatMembershipItemRenderer`, `liveChatSponsorships*Renderer`), matched by the substrings `Paid`, `Membership`, `Sponsorships`.

A `runs` entry is either `{text}` or `{emoji: {shortcuts: [":face-blue-smiling:"]}}`. Custom channel emotes only ever arrive as the emoji form, and they are a real signal, so the shortcut is kept as text rather than dropped.

- [ ] **Step 1: Write the failing test**

Create `server/chat.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run server/chat.test.ts
```

Expected: FAIL — `Failed to resolve import "./chat.ts"`.

- [ ] **Step 3: Write the minimal implementation**

Create `server/chat.ts`:

```ts
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
 *  line is stepped over rather than thrown on: one bad fragment must not
 *  cost an eleven-hour stream's worth of chat. */
export function parseChat(jsonl: string): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (const raw of jsonl.split("\n")) {
    if (raw.trim() === "") continue;
    let parsed: Line;
    try {
      parsed = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
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
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run server/chat.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add server/chat.ts server/chat.test.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: parse a livestream's chat replay JSONL

The two dropped renderer kinds are not tidiness: YouTube's own \"Live chat
replay is on.\" banner sits at offset 0 and, left in, lands in the same bin
as the stream-open greeting flood and wins the ranking outright.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `peaks` — scoring the bins

**Files:**
- Modify: `server/chat.ts` (append)
- Modify: `server/chat.test.ts` (append)

**Interfaces:**
- Consumes: `ChatMsg` from Task 1.
- Produces: `type Moment = { t: number; score: number; count: number; sample: string }`, `export function peaks(msgs: ChatMsg[]): Moment[]`, and the exported constants `BIN`, `WIN`, `LAG`, `TOP`, `MIN_GAP`, `SKIP_HEAD`. Task 3 calls `peaks`; Task 4 mirrors `Moment` client-side.

**Background the implementer needs — read this before writing code:**

The scorer's shape is dictated by three **wrong** scorers a feasibility spike built first on a real 11h19m stream. Each is a silent failure, not an error, and each is mutation-tested below. Do not "simplify" any of the three back.

1. **The baseline is a rolling median over ±`WIN` bins, never a global mean.** An 11-hour stream has hours of dead air. Global mean measured 3.3 messages/bin against a local baseline of 9-16 inside the busy stretches — so scored globally, ordinary bins from the busiest *hour* crowd out genuine spikes from quieter ones.

2. **The denominator is `sqrt(base + 4)`, never `base`.** A plain `count / base` ratio is division by a small number: measured, it promoted a bin with **9 messages over a baseline of 1** from the stream's dead tail above a bin with 40 messages and 17 laugh tokens over a baseline of 9. The `+ 4` is the smoothing that stops a baseline of 1 mattering at all.

3. **Every emitted `t` is `binStart - LAG`.** Chat reacts *after* the moment. A link on the peak itself opens on the aftermath.

Plus two exclusions:

- `SKIP_HEAD` drops the opening minute from the *ranking* (not from the baseline — head bins still inform their neighbours' medians). Even with the banner gone, t=0 carried 38 greeting emotes over a baseline of 2.
- `uniqueAuthors / count < 0.5` is a **spam gate**: one person typing forty messages is a spike with nothing in it.

Laugh tokens are a *multiplier* on excess, never an additive term — a bin with a high laugh ratio and no volume must still score nothing.

- [ ] **Step 1: Write the failing test**

Append to `server/chat.test.ts`:

Merge the value import into the one Task 1 already added — a second
`import ... from "./chat.ts"` in the same file is legal and untidy:

```ts
import { LAG, MIN_GAP, SKIP_HEAD, TOP, parseChat, peaks } from "./chat.ts";
import type { ChatMsg } from "./chat.ts";

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

const at = (ms: { t: number }[], binStart: number) =>
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run server/chat.test.ts
```

Expected: FAIL — `"peaks" is not exported by "server/chat.ts"`.

- [ ] **Step 3: Write the minimal implementation**

Append to `server/chat.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run server/chat.test.ts
```

Expected: PASS, 14 tests.

- [ ] **Step 5: Verify the three mutations actually fail**

This is the point of the tests — run each mutation, confirm the named test goes red, then revert it. Do all three.

```bash
# 1. Plain ratio instead of the Poisson-shaped denominator.
#    Edit: const excess = b.count / base;
pnpm vitest run server/chat.test.ts
# Expected: FAIL on "ranks a real spike above a dead-tail bin with a tiny baseline"
# Revert.

# 2. Global mean instead of the rolling median.
#    Edit: const base = Math.max(counts.reduce((a, c) => a + c, 0) / counts.length, 1);
pnpm vitest run server/chat.test.ts
# Expected: FAIL on "finds a spike in a quiet stretch of a stream whose mean is high"
# Revert.

# 3. No lag offset.
#    Edit: const t = b.start;
pnpm vitest run server/chat.test.ts
# Expected: FAIL on "points the timestamp LAG seconds before the peak, not at it"
# Revert.
```

If any mutation does **not** fail its named test, the test is not pinning what it claims — fix the test, not the implementation, before moving on.

- [ ] **Step 6: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add server/chat.ts server/chat.test.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: rank chat bins by how hard they react against their own neighbourhood

Three properties are load-bearing and all three were measured as silent
failures on a real 11-hour stream, so all three are mutation-tested: a
global mean ranks the loudest hour instead of the loudest moments, a plain
count/base ratio puts 9 messages over a baseline of 1 above 40 messages over
a baseline of 9, and a link on the peak itself opens on the aftermath.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `fetchChat`, `/api/moments` and the client wrapper

**Files:**
- Modify: `server/chat.ts` (append `fetchChat` and its imports)
- Modify: `server/index.ts` (one route, one constant, two imports)
- Modify: `src/api.ts` (one type, one wrapper)

**Interfaces:**
- Consumes: `parseChat` (Task 1), `peaks` / `Moment` (Task 2).
- Produces: `POST /api/moments` answering `{ videoId: string; moments: Moment[] }`, and `api.moments(url)` returning that. Task 4 calls `api.moments` and renders `Moment[]`.

**Background the implementer needs:**

`server/chat.ts` sits **above** `ffmpeg.ts` in the layering (it needs `MEDIA_DIR`), beside `mask.ts` and `ytdlp.ts`. It must **not** import `ytdlp.ts` — the route does its own probing and hands this module a bare video id, which keeps `videoIdFrom` the single trust boundary that decides whether a subprocess spawns.

`--sub-langs live_chat` names the file after the `-o` template's base with the sub language appended: `-o "chat.<uuid>.%(ext)s"` produces `chat.<uuid>.live_chat.json`. The UUID plus a rename is the same lesson the download partial and the export partial both carry — a fetch killed halfway must never leave a truncated file under the name the cache checks for, because a truncated cache entry is permanent.

**The live-status guard is load-bearing, not politeness.** On a stream that is still live, `--sub-langs live_chat` follows the chat in real time and **never returns** — the request hangs until the stream ends. `probe()` already reports `liveStatus`, so no new detection is needed.

`server/index.ts` already has a `NOT_FETCHABLE` table, but its `is_live` message ("a section of it is not well-defined") is about cutting video and is wrong here. This route gets its own three-entry table.

- [ ] **Step 1: Append `fetchChat` to `server/chat.ts`**

Add these imports at the top of the file, above the existing code:

```ts
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { HttpError, toolError } from "./errors.ts";
import { MEDIA_DIR } from "./ffmpeg.ts";

const run = promisify(execFile);
const BIG = 64 << 20; // an 11-hour stream's chat is ~20 MB
```

And append at the end:

```ts
/** Downloads a finished stream's chat replay to `media/<id>/chat.json` and
 *  returns that path, or returns it immediately when it is already there.
 *
 *  A finished stream's replay is immutable, so there is no staleness to
 *  reason about — and the cache is not for the user's sake so much as for
 *  the scorer's: retuning any constant in this file means re-running it over
 *  the same stream, and 45 seconds a run is the difference between tuning
 *  and not bothering.
 *
 *  `chat.json` cannot collide with the clip cache: `CLIP_RE` in `ytdlp.ts` is
 *  anchored on `<digits>-<digits>[-<8 hex>].mp4`, so `listClips` can never
 *  offer this file as a clip, while `reportCache` counts it for free.
 *
 *  The download goes to a UUID-suffixed name and is renamed into place — the
 *  same lesson the download partial and the export partial carry. A fetch
 *  killed halfway must not leave a truncated file under the name the cache
 *  checks for, because nothing would ever re-fetch it.
 *
 *  CALLER MUST have rejected a live stream first: `--sub-langs live_chat`
 *  follows an ongoing chat in real time and never returns. */
export async function fetchChat(videoId: string): Promise<string> {
  const dir = join(MEDIA_DIR, videoId);
  const path = join(dir, "chat.json");
  if (existsSync(path)) return path;

  await mkdir(dir, { recursive: true });
  const stem = join(dir, `chat.${randomUUID()}`);
  try {
    await run(
      "yt-dlp",
      [
        "--skip-download",
        "--write-subs",
        "--sub-langs",
        "live_chat",
        "--no-warnings",
        "--no-playlist",
        "-o",
        `${stem}.%(ext)s`,
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { maxBuffer: BIG },
    );
  } catch (err) {
    throw toolError("yt-dlp", err);
  }

  // yt-dlp exits 0 and writes nothing when a video has no chat replay —
  // never a stream, or the uploader turned replay off after the fact.
  const written = `${stem}.live_chat.json`;
  if (!existsSync(written)) {
    throw new HttpError(400, "No chat replay for this video.");
  }
  await rename(written, path);
  return path;
}
```

- [ ] **Step 2: Add the route to `server/index.ts`**

Add to the import block (alongside the existing `./ytdlp.ts` and `./ffmpeg.ts` imports):

```ts
import { fetchChat, parseChat, peaks } from "./chat.ts";
```

`readFile` (line 10) and `reportCache` (line 40) are **already imported** in
this file — do not add them again.

Add beside the existing `NOT_FETCHABLE` table (around `server/index.ts:399`):

```ts
/** Why a video has no chat replay to read yet. Separate from NOT_FETCHABLE
 *  above, whose `is_live` message is about a section of video being
 *  ill-defined — the reason a live stream fails HERE is different and
 *  sharper: yt-dlp would follow the ongoing chat and never return. */
const CHAT_NOT_READY: Record<string, string> = {
  is_live: "Stream still live — chat replay exists only after it ends.",
  is_upcoming: "This stream has not started yet.",
  post_live:
    "This stream just ended and YouTube is still processing the replay. " +
    "Try again in an hour.",
};
```

Add the route immediately after the `/api/clips` line:

```ts
  // The idle screen's third way in, and a dead end — it fetches no video,
  // writes no segments and reaches no other phase. Answers where a
  // livestream's chat reacted hardest, as timestamps the user copies out.
  if (req.url === "/api/moments") {
    const body = await json<Record<string, unknown>>(req);
    const videoId = videoIdFrom(str(body.url, "url"));
    if (!videoId) return send(res, 400, { error: "Not a YouTube video URL." });
    const info = await probe(videoId);
    // Load-bearing, not politeness: on a live stream `--sub-langs live_chat`
    // follows the chat in real time and the request never returns.
    const why = CHAT_NOT_READY[info.liveStatus];
    if (why) return send(res, 400, { error: why });
    const moments = peaks(parseChat(await readFile(await fetchChat(videoId), "utf8")));
    reportCache();
    // No title in the answer, deliberately: the client has nowhere to put it
    // that would not mean either a third state field or writing `state.title`,
    // which belongs to a probed video on the short journey. The user pasted
    // the URL; they know which stream this is.
    return send(res, 200, { videoId, moments });
  }
```

- [ ] **Step 3: Add the client wrapper to `src/api.ts`**

Append beside the other wrappers:

```ts
/** One moment the chat reacted to. `t` already carries the lag offset — it
 *  is the instant a link should open, not the instant chat peaked. */
export type Moment = { t: number; score: number; count: number; sample: string };

export type MomentsResult = { videoId: string; moments: Moment[] };

export async function moments(url: string): Promise<MomentsResult> {
  return (await post("/api/moments", { url })).json() as Promise<MomentsResult>;
}
```

- [ ] **Step 4: Verify it type-checks and the suite still passes**

```bash
pnpm build && pnpm test
```

Expected: build clean, all existing tests plus Task 1-2's still pass.

- [ ] **Step 5: Verify the route end to end against the real stream**

Start the backend in a second terminal (`pnpm server`), then:

```bash
curl -s -X POST http://127.0.0.1:8787/api/moments \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=smf3SB2fgQY"}' | head -c 2000
```

Expected on the first run: ~60s (45s fetch + probe + parse), then JSON with `videoId` and 15 moments. Confirm by eye that no moment has `t < 60`, that the list is time-ordered, and that `sample` strings are non-empty.

Run it a **second** time: expected under 5s, because `media/smf3SB2fgQY/chat.json` now exists. Confirm that file is there and is ~20 MB, and that no `chat.<uuid>.live_chat.json` was left beside it.

Then check the two error paths:

```bash
# Not a YouTube URL
curl -s -X POST http://127.0.0.1:8787/api/moments \
  -H 'content-type: application/json' -d '{"url":"https://example.com"}'
# Expected: {"error":"Not a YouTube video URL."}

# An ordinary upload with no chat replay (any non-stream video)
curl -s -X POST http://127.0.0.1:8787/api/moments \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
# Expected: {"error":"No chat replay for this video."}
```

- [ ] **Step 6: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add server/chat.ts server/index.ts src/api.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: /api/moments, the chat replay fetch and its cache

The live-status guard is load-bearing rather than polite: on an ongoing
stream --sub-langs live_chat follows the chat in real time and the request
never returns. probe() already reports it, so this needs no new detection.

The fetch lands on a UUID name and is renamed into place, the same lesson
the download and export partials carry — a truncated chat.json would be
cached permanently.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The `moments` phase — state, panel, bar, styles

**Files:**
- Modify: `src/state.ts:9` (`Phase` union), `src/state.ts:17-140` (`AppState`), `src/state.ts:142-177` (`initial`)
- Modify: `src/main.ts` (panel node, two render functions, `render()` gates, one comment)
- Modify: `src/style.css` (append)

**Interfaces:**
- Consumes: `api.moments`, `api.Moment` (Task 3); `mmss` from `src/format.ts`; `el`, `guard`, `setState`, `setQuiet`, `getState` already in `src/main.ts`.
- Produces: nothing — this is the top of the stack.

**Background the implementer needs:**

- **Never empty `sourceSlot`.** It holds the trimming iframe; removing an `<iframe>`'s *ancestor* discards its nested browsing context and reloads the YouTube player. `momentsPanel` is built once into `sourceSlot` at module scope and only ever toggled with `hidden`, exactly like `publishForm` and `stackPanel`.
- **`hidden` alone is not enough** — `style.css` already carries `.source > [hidden] { display: none; }`, and `momentsPanel` is a direct child of `.source`, so it is covered with no CSS change.
- **`mode` is deliberately NOT claimed on this exit from `idle`.** The invariant that every exit claims it exists because the short and long journeys meet at `preview`; this flow reaches neither, so there is nothing to claim. Comment it at the call site.
- **`setQuiet`, not `setState`, for the URL field's `oninput`** — a notifying update rebuilds the bar mid-typing and drops the cursor. The `moments` bar reads and writes `state.url`, the same unpersisted field the idle bar already uses, so a URL typed on one screen survives the move to the other.
- `save()` builds an explicit record rather than spreading state (this is what `src/state.test.ts`'s `not.toHaveProperty("voice")` pins), so adding fields to `AppState` needs no change to `save`/`restore`.

- [ ] **Step 1: Add the phase and the two state fields**

In `src/state.ts`, extend the union at line 9:

```ts
export type Phase = "idle" | "trimming" | "framing" | "stacking" | "moments" | "preview";
```

Add to `AppState`, beside `parts` / `thumb` (the other journey-scoped fields):

```ts
  /** The chat-moments lookup's result, and the video it belongs to.
   *
   *  NOT persisted, and `momentsFor` is a field of its own rather than a
   *  reuse of `videoId`: this flow never enters a journey, so it must not
   *  leave a video id behind that `load()` or the clip picker would then be
   *  overwriting. Two unpersisted strings are cheaper than that coupling. */
  moments: Moment[];
  momentsFor: string;
```

with the import at the top of the file:

```ts
import type { Moment } from "./api.ts";
```

`import type`, and it introduces no cycle: `api.ts` imports `geometry`,
`custom`, `segments` and `defaults`, never `state.ts`. The annotation is
erased at build, so this costs nothing at runtime — and `Moment` is a wire
shape, which is where the rest of the wire types already live.

And in `initial`:

```ts
  moments: [],
  momentsFor: "",
```

- [ ] **Step 2: Build the panel node and wire `render()`**

In `src/main.ts`, beside the `stackPanel` declaration (around line 120):

```ts
// The chat-moments lookup's result list. Part of the persistent shell for the
// same reason publishForm and stackPanel are: it takes over the left column
// during `moments`, and is only ever hidden — never removed, and never by
// hiding sourceSlot itself, which would put the YouTube iframe's ancestor
// into display:none.
const momentsPanel = el("div", { className: "moments-panel", hidden: true });
```

and add it to the `sourceSlot` children:

```ts
const sourceSlot = el(
  "div",
  { className: "source" },
  sourcePlaceholder,
  publishForm,
  stackPanel,
  momentsPanel,
);
```

In `render()`, make these four edits:

```ts
// 1. The out column has nothing to show in `moments` either, so its
//    placeholder stays rather than leaving an empty card.
outPlaceholder.hidden = s.phase !== "idle" && s.phase !== "moments";

// 2. Beside the existing publishForm/stackPanel toggles:
momentsPanel.hidden = s.phase !== "moments";

// 3. In the bar dispatch, before the `stacking` branch:
else if (s.phase === "moments") {
  barSlot.replaceChildren(...renderMoments());
  momentsPanel.replaceChildren(...renderMomentsPanel());
}

// 4. The badge gate. `moments` has no probed video behind it — `title`,
//    `duration` and `source` are whatever a previous journey left — so it
//    is excluded explicitly rather than inheriting the `mode` test, which
//    is true here for a reason that has nothing to do with this phase.
if (s.phase !== "idle" && s.phase !== "moments" && s.mode === "short") {
```

Also update the space-handler's final comment at the bottom of the file, which currently names only two phases:

```ts
    return; // idle, stacking and moments own no medium — leave the page's own scroll alone
```

- [ ] **Step 3: Add the idle button**

In `renderIdle`, beside the existing `long` button:

```ts
  const chat = el("button", {
    className: "btn-gray",
    textContent: "Chat moments →",
    title: "Find where a finished livestream's chat reacted hardest",
    disabled: busy,
  });
  // No `mode` here, deliberately. Every exit from `idle` on the two journeys
  // claims it because they meet at `preview` and a stale value misclassifies
  // an upload — this flow reaches neither phase, so there is nothing to
  // claim and nothing downstream that could read it.
  chat.onclick = () => setState({ phase: "moments", error: "" });
```

and put it in the same row as `long`:

```ts
  rows.push(el("div", { className: "bar-row" }, long, chat));
```

- [ ] **Step 4: Write the two render functions**

Add above `renderIdle` in `src/main.ts`:

```ts
/** One copyable line per moment — Todoist turns a multi-line paste into one
 *  task per line, so the line format IS the deliverable. `mm:ss` leads so
 *  the tasks sort and read as positions; the sample is what makes a task
 *  triageable without opening it. */
function momentLine(s: AppState, m: Moment): string {
  return `${mmss(m.t)}  ${m.sample}  https://youtu.be/${s.momentsFor}?t=${m.t}`;
}

async function findMoments(url: string): Promise<void> {
  await guard("Reading chat replay… (up to a minute)", async () => {
    const res = await api.moments(url);
    // Never `title`: that field belongs to a probed video on the short
    // journey, and this flow has not probed one for that purpose.
    setState({ moments: res.moments, momentsFor: res.videoId });
  });
}

function renderMoments(): Node[] {
  const s = getState();
  const busy = s.busy !== "";
  const input = el("input", {
    type: "url",
    placeholder: "https://www.youtube.com/watch?v=… (a finished livestream)",
    size: 60,
    value: s.url,
    disabled: busy,
    className: "field-grow",
  });
  // Quiet for the same reason the idle bar's field is: a notifying update
  // rebuilds this very input and drops the cursor mid-typing.
  input.oninput = () => setQuiet({ url: input.value });
  input.onkeydown = (e) => {
    if (e.key === "Enter") void findMoments(input.value);
  };

  const find = el("button", { className: "btn-solid", textContent: "Find", disabled: busy });
  find.onclick = () => void findMoments(input.value);

  const back = el("button", { className: "btn-gray", textContent: "← Back", disabled: busy });
  back.onclick = () => setState({ phase: "idle", error: "" });

  const copy = el("button", {
    textContent: "Copy all",
    title: "One line per moment — pastes into Todoist as one task each",
    disabled: busy || s.moments.length === 0,
  });
  copy.onclick = () => {
    const live = getState();
    void navigator.clipboard
      .writeText(live.moments.map((m) => momentLine(live, m)).join("\n"))
      .then(
        () => {
          copy.textContent = "Copied";
          setTimeout(() => {
            copy.textContent = "Copy all";
          }, 1200);
        },
        // A clipboard write can be refused (no user gesture, no permission),
        // and a button that silently did nothing reads as a broken feature.
        (err: unknown) => setState({ error: String(err) }),
      );
  };

  return [
    el("div", { className: "bar-row" }, back, input, find),
    el(
      "div",
      { className: "bar-row" },
      el("span", { className: "badge", textContent: `${s.moments.length} moments` }),
      el("div", { className: "bar-end" }, copy),
    ),
  ];
}

function renderMomentsPanel(): Node[] {
  const s = getState();
  if (s.moments.length === 0) {
    return [
      el("p", {
        textContent:
          "Paste a finished livestream URL. The first look at a stream downloads " +
          "its chat replay, which takes about a minute; after that it is cached.",
      }),
    ];
  }
  // An <a> per row rather than a click handler: middle-click, cmd-click and
  // "copy link address" all come free, and checking a peak before copying the
  // list is the whole reason the rows are here rather than only in the
  // clipboard.
  return s.moments.map((m) =>
    el(
      "a",
      {
        className: "moment-row",
        href: `https://youtu.be/${s.momentsFor}?t=${m.t}`,
        target: "_blank",
        rel: "noreferrer",
      },
      el("span", { className: "moment-time", textContent: mmss(m.t) }),
      el("span", { className: "moment-sample", textContent: m.sample }),
      el("span", { className: "badge", textContent: `${m.count}` }),
    ),
  );
}
```

Check the existing import block at the top of `src/main.ts` and extend it — `mmss` comes from `./format.ts` (`clock` is already imported from there), and `Moment` from `./api.ts`:

```ts
import type { Moment } from "./api.ts";
// The existing line is `import { clock, parseTimestamp } from "./format.ts";`
import { clock, mmss, parseTimestamp } from "./format.ts";
```

- [ ] **Step 5: Add the styles**

Append to `src/style.css`, after the `.stack-panel` block:

```css
/* Mirrors .stack-panel — same column, same overrides of `.source`'s
   place-items: center. */
.moments-panel {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  overflow-y: auto;
  text-align: left;
}

.moment-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius-2);
  text-decoration: none;
  color: var(--slate-12);
}

.moment-row:hover {
  background: var(--blue-a3);
}

.moment-time {
  font-variant-numeric: tabular-nums;
  color: var(--blue-11);
  flex: none;
}

.moment-sample {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--slate-11);
}
```

- [ ] **Step 6: Verify it builds and the suite still passes**

```bash
pnpm build && pnpm test
```

Expected: build clean, all tests pass.

- [ ] **Step 7: Verify in a real browser**

With both `pnpm server` and `pnpm dev` running, open `http://localhost:5173` and check each of these:

1. `Chat moments →` is on the idle bar beside `Long form →`.
2. Clicking it shows the panel's empty-state text, and the status row shows the `moments` badge and **no** title/duration/size badges.
3. Pasting `https://www.youtube.com/watch?v=smf3SB2fgQY` and pressing Find shows the busy badge, then 15 rows.
4. Clicking a row opens a new tab at that timestamp in the video.
5. `Copy all` flips to `Copied`; pasting into a text editor gives 15 lines, each `mm:ss  sample  https://youtu.be/smf3SB2fgQY?t=N`.
6. `← Back` returns to idle with the URL field still holding what was typed.
7. From idle, loading an ordinary video still reaches trimming/framing normally — the moments lookup left nothing behind.

- [ ] **Step 8: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add src/state.ts src/main.ts src/style.css
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "feat: the moments phase — a dead-end lookup off the idle screen

idle -> moments -> idle, claiming no mode: the invariant that every exit
from idle claims one exists because the two journeys meet at preview, and
this flow reaches neither. momentsFor is its own field rather than a reuse
of videoId for the same reason — nothing here may leave an id behind that
load() would then be overwriting.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Calibrate `LAG`, then document

**Files:**
- Modify: `server/chat.ts` (only if the offset reads wrong)
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

**Background:** `LAG = 15` is the one constant in this feature that was **not** measured — the spike could not watch the video. This task is where it gets calibrated against a real stream, which is the `ponytail:` comment's own instruction.

- [ ] **Step 1: Check three links against the real video**

Run the lookup on `smf3SB2fgQY`, open three moments from different parts of the stream, and watch from where each link lands.

- If the interesting thing happens **a few seconds after** the link lands: correct, leave `LAG` alone.
- If it has **already happened** when the link lands: increase `LAG`.
- If there is a long dead stretch before it: decrease `LAG`.

Change only the constant. Its three consumers (`peaks`, the tests' `at()` helper, the client's link) all read it, and `server/chat.test.ts` asserts on `LAG` symbolically rather than on a literal, so a retune must not require a test edit. If it does, the test is wrong.

- [ ] **Step 2: Re-run the suite if the constant moved**

```bash
pnpm test
```

Expected: PASS. If a test hardcoded 15, fix the test to read `LAG`.

- [ ] **Step 3: Update `CLAUDE.md`**

Three edits, matching the file's existing voice:

1. **The spec pointer** at the top — append to the chain of design docs:

> plus `docs/specs/2026-09-12-vstack-chat-moments-design.md`, which supersedes nothing and adds a dead-end lookup beside the two journeys: a finished livestream's chat replay, scored into the fifteen moments it reacted hardest to. It writes no `segments`, fetches no video and reaches no other phase — the result is a list of `youtu.be/<id>?t=` links the user copies out.

2. **The architecture block** — add the module and the route count:

```
server/chat.ts     ChatMsg/Moment, BIN/WIN/LAG/TOP/MIN_GAP/SKIP_HEAD,
                   fetchChat (chat replay -> media/<id>/chat.json),
                   parseChat, peaks (the scorer)
```

and change `server/index.ts`'s line from `12 routes (11 POST + GET /out/<name>)` to `13 routes (12 POST + GET /out/<name>)`.

Extend the layering sentence: `chat.ts` sits above `ffmpeg.ts` beside `mask.ts` — it needs `MEDIA_DIR` for its cache and imports nothing else, deliberately not `ytdlp.ts`, so `videoIdFrom` stays the one trust boundary that decides whether a subprocess spawns.

Extend the phase sentence: `idle` → `moments` → `idle` is a third way out of `idle` and a dead end, sharing no phase with either journey.

3. **Two invariants**, in the "breaking these is silent, not loud" section:

> **The chat scorer's baseline is a rolling median and its denominator is
> `sqrt(base + 4)`, and both were measured as silent failures.** A global
> mean over an eleven-hour stream is 3.3 messages a bin against a local 9-16
> inside its busy stretches, so it ranks the loudest *hour* rather than the
> loudest *moments*. A plain `count / base` ratio is division by a small
> number: it promoted nine messages over a baseline of one — dead air at the
> end of the stream — above forty messages and seventeen laugh tokens over a
> baseline of nine. Both are mutation-tested in `server/chat.test.ts`, along
> with the lag offset, because all three produce a plausible-looking list
> rather than an error. YouTube's own "Live chat replay is on." banner is
> dropped at parse for the same reason: left in, it won the ranking outright.

> **`/api/moments` must reject a live stream before it spawns yt-dlp.**
> `--sub-langs live_chat` on an ongoing stream *follows the chat in real
> time* and never returns, so the request hangs until the stream ends rather
> than failing. `probe()` already reports `liveStatus`, which is why the
> guard needs no new detection — but it is a separate table from
> `NOT_FETCHABLE`, whose `is_live` message is about a section of video being
> ill-defined and says nothing about why this route cannot run.

Also add to the environment notes: `media/<id>/chat.json` is ~20 MB for an eleven-hour stream, counted by `reportCache`, swept by hand like the rest of `media/`. It is cached so that retuning the scorer's constants does not cost 45 seconds a run.

- [ ] **Step 4: Final verification**

```bash
pnpm build && pnpm test
```

Expected: build clean, full suite green.

- [ ] **Step 5: Commit**

```bash
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack add CLAUDE.md server/chat.ts server/chat.test.ts
git -C /Users/vuhoangvuong/WORKSPACE/personal/vstack commit -m "docs: chat moments in CLAUDE.md, and LAG calibrated against a real stream

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
