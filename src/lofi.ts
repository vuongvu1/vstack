/** Where a speech goes in a music track, found from the track's own
 *  loudness envelope.
 *
 *  Imports NOTHING, and sits at the bottom of the client layering beside
 *  `geometry.ts` and `segments.ts`. That is what lets vitest's `node`
 *  environment test it at all — the caller owns the decode — and what would
 *  let the server import it directly the day detection has to move, the way
 *  `ytdlp.ts` already reaches across for `geometry.ts`'s `PAD`. */

/** One uploaded speech, as the panel knows it. `seconds` is what
 *  `/api/upload-audio` probed; `name` is the local filename, for the error
 *  message and the list row only.
 *
 *  A speech may be an audio file or a video one, and the distinction never
 *  reaches this module: only its audio is ever rendered, so all a placement
 *  needs is how long it runs. */
export type Speech = { id: string; name: string; seconds: number };

/** Where one speech's voice enters the music's timeline. */
export type Placement = { id: string; at: number };

export type TroughResult = { placements: Placement[] } | { error: string };

/** How much room a speech is given at each of its own edges.
 *
 *  The same 0.5s `longform.ts` uses, and declared here rather than shared
 *  for the same reason its BLUR_SIGMA is not shared with `starter.ts`: these
 *  sit on opposite sides of the client/server line, and one constant for two
 *  transitions means tuning either one moves the other. `server/lofi.ts`
 *  declares its own copy; `server/lofi.test.ts` pins the value.
 *
 *  It used to be the dip to black on either side of a cut-in, which is why
 *  it is reserved rather than merely respected. There is no cut-in any more
 *  — a speech is mixed in as audio and the picture never moves — so what it
 *  buys now is breathing room at each edge of the voice and the length of
 *  the crackle boost's own fades. Kept because a placement flush against
 *  the track's own start or end still reads as an accident. */
export const FADE = 0.5;

/** The envelope's resolution. Four buckets a second is fine enough to find
 *  the edge of a breakdown and coarse enough that one quiet beat inside a
 *  loud bar does not read as a hole. */
export const BUCKETS_PER_SEC = 4;

/** The least music between two speeches. Without it two speeches drop into
 *  the two halves of one long breakdown and read as one long interruption. */
export const MIN_GAP = 20;

/** No speech in the opening: the track needs to establish itself before it
 *  is interrupted. */
export const SKIP_HEAD = 15;

/** Nor over the ending, which is the track's own resolution. */
export const SKIP_TAIL = 10;

/** The envelope's midpoint, which is what "quiet for this track" is measured
 *  against.
 *
 *  GLOBAL, deliberately — where `server/chat.ts`'s scorer needs a rolling
 *  median because an eleven-hour stream's density drifts by an order of
 *  magnitude across it, a music track is stationary: its loud passages and
 *  its quiet ones interleave on a scale of bars, not hours.
 *
 *  ponytail: global. A track that is loud for its first half and quiet for
 *  its second would put every speech in the second half; go rolling (a
 *  +/- 60s window, `chat.ts`'s shape) the day one does. */
function median(env: Float32Array): number {
  const sorted = Array.from(env).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/** Mean of the envelope over the bucket range [from, to). */
function windowMean(env: Float32Array, from: number, to: number): number {
  let sum = 0;
  let n = 0;
  for (let b = from; b < to && b < env.length; b++) {
    sum += env[b] ?? 0;
    n++;
  }
  return n === 0 ? Infinity : sum / n;
}

/** Where each speech goes, or the first reason one of them cannot go
 *  anywhere.
 *
 *  Placement is greedy and **longest first**. A long speech has strictly
 *  fewer legal windows than a short one, so placing the short ones first can
 *  take the only window the long one had — and the failure is not an error,
 *  it is a render with a speech missing from it.
 *
 *  Each window is chosen for being the QUIETEST AVAILABLE given the geometry
 *  constraints (SKIP_HEAD, SKIP_TAIL, MIN_GAP between speeches, no overlap
 *  with other placements), not for clearing any quietness threshold. The
 *  render ducks the music under every speech anyway.
 *
 *  It does NOT fall back to a least-bad position for a speech that fits
 *  nowhere. A silently misplaced speech is indistinguishable from a working
 *  render until someone watches the output, which is the failure class this
 *  codebase exists to keep out of its own exports. */
export function troughs(
  env: Float32Array,
  seconds: number,
  speeches: Speech[],
): TroughResult {
  if (speeches.length === 0) return { placements: [] };
  if (!(seconds > 0) || env.length === 0) {
    return { error: "That track has no audio to measure." };
  }
  // Derived from the envelope rather than assumed to be BUCKETS_PER_SEC: the
  // caller builds it, and a caller that used a different resolution should
  // still get the right answer rather than a subtly shifted one.
  const perSec = env.length / seconds;
  // Floored away from zero: a track of pure digital silence would otherwise
  // divide every window by 0 and score them all NaN.
  const base = Math.max(median(env), 1e-6);

  const taken: { from: number; to: number }[] = [];
  const placements: Placement[] = [];

  // A stable sort on a copy: `speeches` is the caller's array, and the
  // longest-first pass must not reorder the panel's list as a side effect.
  const order = speeches
    .map((speech, i) => ({ speech, i }))
    .sort((a, b) => b.speech.seconds - a.speech.seconds || a.i - b.i);

  for (const { speech } of order) {
    // The breathing room at both edges is part of what this speech needs,
    // not extra on top of it.
    const need = speech.seconds + 2 * FADE;
    const lo = SKIP_HEAD;
    const hi = seconds - SKIP_TAIL - need;
    let bestAt = -1;
    let bestScore = Infinity;
    // Stepped by BUCKET INDEX, never by an accumulated float stride: a
    // stride added a few thousand times drifts off the end of the envelope.
    // Same lesson `peaks()` in `waveform.ts` states for its bucket edges.
    for (let b = Math.ceil(lo * perSec); b <= Math.floor(hi * perSec); b++) {
      const from = b / perSec;
      const to = from + need;
      const clash = taken.some((r) => from < r.to + MIN_GAP && to > r.from - MIN_GAP);
      if (clash) continue;
      const score = windowMean(env, b, Math.ceil(to * perSec)) / base;
      if (score < bestScore) {
        bestScore = score;
        bestAt = from;
      }
    }
    if (bestAt < 0) {
      return {
        error:
          `${speech.name} (${Math.round(speech.seconds)}s) does not fit anywhere ` +
          `left in the track.`,
      };
    }
    taken.push({ from: bestAt, to: bestAt + need });
    placements.push({ id: speech.id, at: bestAt + FADE });
  }

  placements.sort((a, b) => a.at - b.at);
  return { placements };
}

/** Moves one placement, keeping it inside the track and MIN_GAP clear of its
 *  neighbours. The drag path's bound, not a legality rule — `/api/lofi`
 *  checks only that speeches fit and do not overlap, so an older body still
 *  renders. Same asymmetry `moveOut`'s `margin` has against `isValidOut`.
 *
 *  Refuses the move — returns `placements` unchanged — when the feasible
 *  interval is empty (`hi < lo`), rather than clamping into one of the two
 *  bounds. `hi < lo` is reachable by an ordinary drag: a neighbour is
 *  classified "before" or "after" by the raw `want`, not by where the
 *  dragged marker currently sits, so dragging far enough past a neighbour
 *  can ask for a window past the end of the track (or, dragging the other
 *  way, before its start) with no legal position left at all. Resolving
 *  that to either bound anyway would emit an `at` the route rejects — the
 *  one place a constructor produced something its own validator refuses,
 *  backwards from every other pair in this codebase. Leaving the placement
 *  where it was is the same answer `editMark` gives a doomed range: refuse
 *  rather than invent an illegal one. */
export function clampPlacement(
  placements: Placement[],
  speeches: Speech[],
  id: string,
  want: number,
  seconds: number,
): Placement[] {
  const others = placements.filter((p) => p.id !== id);
  const mine = speeches.find((x) => x.id === id);
  if (!mine) return placements;
  let lo = FADE;
  let hi = seconds - mine.seconds - FADE;
  for (const other of others) {
    const otherSeconds = speeches.find((x) => x.id === other.id)?.seconds ?? 0;
    if (other.at < want) lo = Math.max(lo, other.at + otherSeconds + MIN_GAP);
    else hi = Math.min(hi, other.at - MIN_GAP - mine.seconds);
  }
  if (hi < lo) return placements;
  const at = Math.min(Math.max(want, lo), hi);
  return placements.map((p) => (p.id === id ? { ...p, at } : p));
}

/** Play order for a list of uploaded files: a name beginning `1_` goes
 *  first, everything else is shuffled.
 *
 *  Generic over `{ name }` because the music list and the speech list take
 *  the identical rule and neither knows about the other.
 *
 *  This reads the FILENAME, which is why it lives on the client: the
 *  original name never crosses the wire — `/api/upload` answers with a UUID
 *  and the panel keeps the name purely for display. So the client resolves
 *  the order and sends the resolved list; the server sees ids and no names,
 *  and its trust boundary stays exactly where it was.
 *
 *  `rand` is injected so the shuffle can be tested for more than the
 *  permutation property — with `Math.random` a shuffle that never moves
 *  anything passes every assertion worth writing.
 *
 *  Two `1_` files is not an error: the first in list order takes the pin and
 *  the other joins the shuffled tail. It is a filename convention rather
 *  than a validated input, and refusing a render over it would be the wrong
 *  severity. */
export function orderByPrefix<T extends { name: string }>(
  items: T[],
  rand: () => number = Math.random,
): T[] {
  const pinnedAt = items.findIndex((x) => /^1_/.test(x.name));
  const rest = items.filter((_, i) => i !== pinnedAt);
  // Fisher-Yates over a copy. The caller's array is the panel's list and
  // reordering it as a side effect would move rows under the user.
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = rest[i];
    const b = rest[j];
    if (a !== undefined && b !== undefined) {
      rest[i] = b;
      rest[j] = a;
    }
  }
  const pinned = pinnedAt === -1 ? undefined : items[pinnedAt];
  return pinned === undefined ? rest : [pinned, ...rest];
}
