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
export function isValidSegments(segs: unknown, duration: number): segs is Segment[] {
  if (!Array.isArray(segs)) return false;
  if (segs.length === 0 || segs.length > MAX_SEGMENTS) return false;
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
