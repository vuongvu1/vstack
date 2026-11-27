/** The kept parts of a video's timeline, in source seconds.
 *
 *  This module sits at the bottom of the client layering beside
 *  `geometry.ts` and imports nothing, which is what lets the server import
 *  it too — `server/ytdlp.ts` already reaches across for `PAD` the same way.
 *
 *  A single segment is not a special case anywhere: it is the general case
 *  at N = 1, and every path below `/api/window` still sees one continuous
 *  clip either way. */
export type Segment = { start: number; end: number };

/** Bounds the ffmpeg concat graph and the untrusted-input surface, the way
 *  `MAX_CUSTOM` bounds the floating pieces. Not a measured limit. */
export const MAX_SEGMENTS = 6;

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Clamps to `[0, duration]`, drops anything empty or non-finite, sorts by
 *  start, and merges overlaps.
 *
 *  Merging rather than rejecting is a UI decision: dragging one part's end
 *  past the next part's start is an ordinary editing gesture, and merging is
 *  what a cut tool does with it. Touching bounds (`a.end === b.start`) are
 *  left as two segments — the user may have marked the same instant twice on
 *  purpose, and merging would silently remove a chip from the strip.
 *
 *  Idempotent, which the drag path relies on: this runs on every mark. */
export function normalize(segs: Segment[], duration: number): Segment[] {
  const clean: Segment[] = [];
  for (const seg of segs) {
    if (!finite(seg?.start) || !finite(seg?.end)) continue;
    const start = Math.min(Math.max(0, seg.start), duration);
    const end = Math.min(Math.max(0, seg.end), duration);
    if (end > start) clean.push({ start, end });
  }
  clean.sort((a, b) => a.start - b.start);

  const merged: Segment[] = [];
  for (const seg of clean) {
    const last = merged[merged.length - 1];
    if (last !== undefined && seg.start < last.end) {
      last.end = Math.max(last.end, seg.end);
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/** The validator both sides run — `restore` on the client, `/api/window` on
 *  the server — the same split posture `isValidBox`/`assertBoxes` has for
 *  crop rects. Either side alone would let a bad selection through one door
 *  and die at the other.
 *
 *  Takes `unknown` for the reason `isOutName` does: it is called on a raw
 *  request-body field and on a `JSON.parse` result, and a `Segment[]`
 *  annotation at either site would be a compile-time claim about a value
 *  that arrives from outside the program. */
export function isValidSegments(
  segs: unknown,
  duration: number,
  max: number = MAX_SEGMENTS,
): segs is Segment[] {
  if (!Array.isArray(segs)) return false;
  if (segs.length === 0 || segs.length > max) return false;
  let prevEnd = Number.NEGATIVE_INFINITY;
  for (const seg of segs) {
    if (seg === null || typeof seg !== "object" || Array.isArray(seg)) return false;
    const { start, end } = seg as Segment;
    if (!finite(start) || !finite(end)) return false;
    if (start < 0 || end > duration) return false;
    if (!(end > start)) return false;
    // Sorted AND non-overlapping in one comparison: a later segment must
    // begin at or after the previous one ends.
    if (start < prevEnd) return false;
    prevEnd = end;
  }
  return true;
}

export function totalDuration(segs: Segment[]): number {
  return segs.reduce((sum, s) => sum + (s.end - s.start), 0);
}

/** What is left of `[start, end]` after the cuts are taken out of it.
 *
 *  The one rule both sides of a framing cut compute from: the client sizes
 *  the kept badge with it, the server builds the export's concat legs with
 *  it. Two copies of this subtraction is how a badge comes to disagree with
 *  the file it names.
 *
 *  Assumes `cuts` is sorted and disjoint, which is what `normalize` emits
 *  and what `isValidSegments` accepts — the same pairing `/api/window`
 *  already relies on. Cuts outside the range are ignored, a cut overhanging
 *  a bound is clipped to it, and a gap of zero length is dropped rather
 *  than returned: an empty leg is an ffmpeg error, not a no-op. */
export function keepRanges(start: number, end: number, cuts: Segment[]): Segment[] {
  const keeps: Segment[] = [];
  let at = start;
  for (const cut of cuts) {
    if (cut.end <= at) continue;
    if (cut.start >= end) break;
    if (cut.start > at) keeps.push({ start: at, end: Math.min(cut.start, end) });
    at = Math.max(at, cut.end);
    if (at >= end) return keeps;
  }
  if (end > at) keeps.push({ start: at, end });
  return keeps;
}

/** One bound of `seg` moved to `t`, or `null` if the edit has to be refused.
 *
 *  Two rules, and both of them were user-visible bugs:
 *
 *  - `+ Part` hands a new range a SYNTHETIC five-second end, so the ordinary
 *    flow — add a part, roll forward, aim Set Start — lands the start past
 *    that end. Refusing there read as "Set Start is broken" (no tick, no
 *    change), and the Set End that followed then stretched the part from the
 *    `+ Part` playhead rather than from the start the user had aimed. So an
 *    end the user never aimed at (`endAimed`) is carried along, keeping the
 *    part's own length; an end they DID aim is theirs, and is refused rather
 *    than silently overwritten.
 *  - Anything still leaving `end <= start` is refused rather than handed to
 *    `normalize`, which DROPS such a segment — a misclicked Set End would
 *    otherwise delete the very part being edited.
 *
 *  Pure and here rather than in `main.ts` beside `segmentContaining` because
 *  both failures are silent: neither throws, and both produce a plausible
 *  strip. */
export function editMark(
  seg: Segment,
  which: "start" | "end",
  t: number,
  duration: number,
  endAimed: boolean,
): Segment | null {
  const edited: Segment =
    which === "start" ? { start: t, end: seg.end } : { start: seg.start, end: t };
  if (which === "start" && edited.end <= t && !endAimed) {
    edited.end = Math.min(t + (seg.end - seg.start), duration);
  }
  return edited.end > edited.start ? edited : null;
}

/** The framing strip's playback rates. A closed set rather than a number,
 *  because each one is a badge PNG the client renders and a branch the
 *  server's validator has to know — and Chrome's `playbackRate` stops at 16. */
export const SPEEDS = [2, 4, 8, 16] as const;
export type Speed = (typeof SPEEDS)[number];

/** A sped-up range on the framing strip, in the clip timeline — the same
 *  coordinate system as `cuts`. */
export type SpeedRange = { start: number; end: number; speed: Speed };

/** One piece of the export, in order: a kept range and the rate it plays at. */
export type Leg = { start: number; end: number; speed: 1 | Speed };

/** How many holes and speed-up bands the framing strip takes. Each adds a
 *  leg or two to the export's stitch graph, which grows linearly, so these
 *  only bound untrusted input on `/api/export` — not a measured limit. */
export const MAX_CUTS = 20;
export const MAX_SPEEDS = 20;

/** How loud a leg's own sound plays at `speed`. Up to x4 speech is still
 *  words; at x8 and x16 it is a warble, so it drops to a bed under the
 *  picture rather than going silent. One rule for the export's stitch and
 *  the framing `<video>`'s `volume`. ~-10.5 dB. */
export const FAST_GAIN = 0.3;
export function speedGain(speed: number): number {
  return speed >= 8 ? FAST_GAIN : 1;
}

export function isSpeed(n: unknown): n is Speed {
  return SPEEDS.includes(n as Speed);
}

/** Sorted, clamped into `[lo, hi]`, empties and illegal speeds dropped, and
 *  overlaps merged. A merged range keeps the EARLIER range's speed — the
 *  same "earlier start survives" rule `normalize` holds for segments.
 *  Touching ranges are not merged: they may carry different speeds. */
export function normalizeSpeeds(ranges: SpeedRange[], lo: number, hi: number): SpeedRange[] {
  const clean: SpeedRange[] = [];
  for (const r of ranges) {
    if (!finite(r?.start) || !finite(r?.end) || !isSpeed(r.speed)) continue;
    const start = Math.min(Math.max(lo, r.start), hi);
    const end = Math.min(Math.max(lo, r.end), hi);
    if (end > start) clean.push({ start, end, speed: r.speed });
  }
  clean.sort((a, b) => a.start - b.start);
  const merged: SpeedRange[] = [];
  for (const r of clean) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r.start < last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** The server's gate on `/api/export`'s `speeds`. Empty is legal (no speed
 *  ranges); otherwise sorted, non-overlapping, inside `[start, end]`, legal
 *  speeds only — a superset of nothing `normalizeSpeeds` cannot emit. */
export function isValidSpeeds(v: unknown, start: number, end: number): v is SpeedRange[] {
  if (!Array.isArray(v) || v.length > MAX_SPEEDS) return false;
  let prevEnd = Number.NEGATIVE_INFINITY;
  for (const r of v) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) return false;
    const { start: a, end: b, speed } = r as SpeedRange;
    if (!finite(a) || !finite(b) || !isSpeed(speed)) return false;
    if (a < start || b > end || !(b > a) || a < prevEnd) return false;
    prevEnd = b;
  }
  return true;
}

/** The export, as ordered legs: `keepRanges` with each kept range split at
 *  every speed range's bounds. Cut beats speed, because only kept footage is
 *  ever split. `speeds` must be normalised. With no speeds this is exactly
 *  `keepRanges` at speed 1 — the identity the cut tests rely on. */
export function planLegs(start: number, end: number, cuts: Segment[], speeds: SpeedRange[]): Leg[] {
  const legs: Leg[] = [];
  const push = (a: number, b: number, speed: 1 | Speed) => {
    if (!(b > a)) return;
    const last = legs[legs.length - 1];
    // Only ever true inside one keep: two keeps are separated by a cut of
    // positive length, so one's end never equals the next one's start.
    if (last !== undefined && last.end === a && last.speed === speed) last.end = b;
    else legs.push({ start: a, end: b, speed });
  };
  for (const keep of keepRanges(start, end, cuts)) {
    let at = keep.start;
    for (const r of speeds) {
      if (r.end <= at) continue;
      if (r.start >= keep.end) break;
      push(at, r.start, 1);
      const to = Math.min(r.end, keep.end);
      push(Math.max(at, r.start), to, r.speed);
      at = to;
      if (at >= keep.end) break;
    }
    push(at, keep.end, 1);
  }
  return legs;
}

/** How long the export is: each leg's length over its rate. */
export function legsDuration(legs: Leg[]): number {
  return legs.reduce((sum, l) => sum + (l.end - l.start) / l.speed, 0);
}

/** Where clip-timeline instant `t` lands in the OUTPUT — the starter
 *  screen's picked frame. A `t` inside a cut snaps to the next kept leg's
 *  first frame; before every leg is 0, after every leg the output's end. */
export function outputAt(legs: Leg[], t: number): number {
  let out = 0;
  for (const l of legs) {
    if (t < l.end) return out + Math.max(0, t - l.start) / l.speed;
    out += (l.end - l.start) / l.speed;
  }
  return out;
}

/** Where each sped leg lands in the OUTPUT — what the export's effects are
 *  gated on. One window per sped leg; `planLegs` has already joined equal
 *  neighbours, so two windows that touch differ in speed. */
export function speedWindows(legs: Leg[]): { at: number; until: number; speed: Speed }[] {
  const out: { at: number; until: number; speed: Speed }[] = [];
  let t = 0;
  for (const l of legs) {
    const len = (l.end - l.start) / l.speed;
    if (l.speed !== 1) out.push({ at: t, until: t + len, speed: l.speed });
    t += len;
  }
  return out;
}

/** Clip time [clipStart, clipEnd] lives in file `file` from fileStart; the file is fileLength s long. */
export type LegSource = { file: number; clipStart: number; clipEnd: number; fileStart: number; fileLength: number };
/** File-relative range in source `file`. */
export type ShiftedLeg = { file: number; start: number; end: number; speed: 1 | Speed };

/** Maps clip-timeline legs onto the source files, `offset` seconds later in
 *  each file (negative = earlier). A leg crossing a seam between two sources
 *  is split there. A piece that would run off a file's start or end slides
 *  back inside instead of shrinking, so every piece keeps its length and the
 *  total duration never changes. */
export function shiftLegs(legs: Leg[], sources: LegSource[], offset: number): ShiftedLeg[] {
  const out: ShiftedLeg[] = [];
  for (const leg of legs) {
    for (const src of sources) {
      const a = Math.max(leg.start, src.clipStart);
      const b = Math.min(leg.end, src.clipEnd);
      if (b <= a) continue;
      let start = src.fileStart + (a - src.clipStart) + offset;
      let end = src.fileStart + (b - src.clipStart) + offset;
      const lo = Math.max(0, -start);
      start += lo;
      end += lo;
      const hi = Math.max(0, end - src.fileLength);
      start -= hi;
      end -= hi;
      out.push({ file: src.file, start, end, speed: leg.speed });
    }
  }
  return out;
}

/** How far a box may be time-shifted, `{ min <= 0 <= max }` in whole
 *  seconds, given the footage the server actually has around the marks.
 *
 *  The server slides a shift that overruns its source file back inside it
 *  as a whole block, so asking for more than this exports as LESS — a `+3`
 *  that renders as 0 while the badge still says `+3s`. Bounding the control
 *  by the real headroom is what keeps the label honest.
 *
 *  A single range (`digest === ""`) lives in the fetched window itself. A
 *  stitch's shifted copies are rebuilt from its part files, each fetched
 *  over `[floor(start - pad), ceil(end + pad)]` clamped to the video — the
 *  arithmetic `fetchOne` and `partPath` in `server/ytdlp.ts` use, ended at
 *  the video's real `duration` rather than its ceil — and the
 *  tightest part bounds the whole clip, since one offset shifts every leg.
 *  A `duration` shorter than the parts is the dropdown reopen's stand-in
 *  (the clip's own windowEnd) and is treated as unknown, as `fetchOne`
 *  does with a 0; a part a cached wider window serves can only have MORE
 *  room than this, so the answer errs short. A stitch with fewer than two
 *  stored parts cannot be described at all: `{ 0, 0 }`.
 *
 *  `pad` and `cap` are parameters because this module imports nothing. */
export function offsetBounds(o: {
  digest: string;
  segments: Segment[];
  clipStart: number;
  clipEnd: number;
  windowStart: number;
  windowEnd: number;
  duration: number;
  pad: number;
  cap: number;
}): { min: number; max: number } {
  let head: number;
  let tail: number;
  if (o.digest === "") {
    head = o.clipStart - o.windowStart;
    // The window is ceil'd but the file ends at the video's real end. A
    // duration short of the marks is a stand-in (or unknown) and ignored.
    const fileEnd = o.duration >= o.clipEnd ? Math.min(o.windowEnd, o.duration) : o.windowEnd;
    tail = fileEnd - o.clipEnd;
  } else {
    if (o.segments.length < 2) return { min: 0, max: 0 };
    const last = Math.max(...o.segments.map((s) => s.end));
    // The real end, not `fetchOne`'s ceil: the file stops at `duration`.
    const videoEnd = o.duration >= last ? o.duration : Number.POSITIVE_INFINITY;
    head = Math.min(...o.segments.map((s) => s.start - Math.max(0, Math.floor(s.start - o.pad))));
    tail = Math.min(...o.segments.map((s) => Math.min(Math.ceil(s.end + o.pad), videoEnd) - s.end));
  }
  // `0 -`, not unary minus: no -0 for a caller to compare against.
  return {
    min: 0 - Math.min(o.cap, Math.max(0, Math.floor(head))),
    max: Math.min(o.cap, Math.max(0, Math.floor(tail))),
  };
}
