import { isValidBox } from "./geometry.ts";
import type { Rect, Size } from "./geometry.ts";
import { DEFAULT_LAYOUT_ID, cellsOf, layoutById, ratioOf } from "./layout.ts";

export type Phase = "idle" | "trimming" | "framing";

export type AppState = {
  phase: Phase;
  error: string;
  busy: string;
  // The URL field's live text, kept here (not just in the DOM) so a
  // busy-triggered render that rebuilds the idle bar doesn't lose what the
  // user typed. Never persisted — save()/restore() don't touch it.
  url: string;
  videoId: string;
  title: string;
  duration: number;
  start: number;
  end: number;
  clipUrl: string;
  windowStart: number;
  windowEnd: number;
  source: Size;
  layoutId: string;
  /** One crop rect per cell of `layoutId`, in `cellsOf` order. Empty means
   *  "not framed yet" — the only other legal length is the layout's cell
   *  count, which is what `save`'s gate and `restore` both check. */
  boxes: Rect[];
};

const initial: AppState = {
  phase: "idle",
  error: "",
  busy: "",
  url: "",
  videoId: "",
  title: "",
  duration: 0,
  start: 0,
  end: 0,
  clipUrl: "",
  windowStart: 0,
  windowEnd: 0,
  source: { w: 0, h: 0 },
  layoutId: DEFAULT_LAYOUT_ID,
  boxes: [],
};

let state: AppState = { ...initial };
const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

/** Updates state without notifying. Two callers need this: the box editor
 *  (a re-render mid-drag would rebuild the <video> element and restart
 *  playback) and box defaulting during render (notifying from inside a
 *  render is re-entrant). The rAF preview loop reads state every frame, so
 *  the canvas still follows a quiet update. */
export function setQuiet(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
}

export function subscribe(fn: () => void): void {
  listeners.add(fn);
}

type Saved = {
  start: number;
  end: number;
  layoutId: string;
  boxes: Rect[];
  sourceW: number;
  sourceH: number;
};

/** The pre-layouts stored shape. Records in a real user's localStorage
 *  predate this feature, and dropping them would silently un-frame every
 *  video already framed. */
type Legacy = { boxTop?: Rect | null; boxBottom?: Rect | null };

const key = (videoId: string) => `vstack:${videoId}`;

/** Parses and normalizes whatever is stored under a video's key, or `null`
 *  if there is nothing usable. Shared by `save()` (to preserve fields it
 *  isn't updating this call) and `restore()` (to read them back out). */
function readSaved(videoId: string): Saved | null {
  const raw = localStorage.getItem(key(videoId));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // JSON.parse accepts bare primitives too — the literal string "null"
  // parses successfully to `null` without throwing, as does "42" or a
  // quoted string, so the shape must be checked before reading fields off
  // it, not just the parse call itself.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const s = parsed as Partial<Saved> & Legacy;

  // Migration: a record with no `boxes` but with the old pair is a
  // pre-layouts save, and the pair it holds is by definition a 1-1 framing.
  const migrated: Rect[] | null =
    s.boxes === undefined && s.boxTop && s.boxBottom ? [s.boxTop, s.boxBottom] : null;

  return {
    start: s.start ?? 0,
    end: s.end ?? 0,
    layoutId: s.layoutId ?? DEFAULT_LAYOUT_ID,
    boxes: migrated ?? (Array.isArray(s.boxes) ? s.boxes : []),
    sourceW: s.sourceW ?? 0,
    sourceH: s.sourceH ?? 0,
  };
}

export function save(): void {
  if (!state.videoId) return;
  const prev = readSaved(state.videoId);
  // Boxes and dimensions only mean anything once /api/window has reported
  // the clip's real size. Before that, `state.source` still holds probe's
  // informational dimensions and `boxes` is empty, so writing them here
  // unconditionally would erase a set framed in an earlier session the
  // moment a mark is touched again during a later trimming visit. Marks,
  // by contrast, always reflect the current session and always persist.
  //
  // The count check is what covers the half-built case: ensureFraming
  // passes through states where some cells have boxes and some don't, and
  // writing one of those would truncate a complete stored set.
  const cells = cellsOf(layoutById(state.layoutId) ?? { id: "", label: "", rows: [] });
  const framed =
    state.phase === "framing" && cells.length > 0 && state.boxes.length === cells.length;
  const saved: Saved = {
    start: state.start,
    end: state.end,
    layoutId: framed ? state.layoutId : (prev?.layoutId ?? DEFAULT_LAYOUT_ID),
    boxes: framed ? state.boxes : (prev?.boxes ?? []),
    sourceW: framed ? state.source.w : (prev?.sourceW ?? 0),
    sourceH: framed ? state.source.h : (prev?.sourceH ?? 0),
  };
  localStorage.setItem(key(state.videoId), JSON.stringify(saved));
}

// ponytail: `cellsOf` on a synthesised empty layout is how an unknown
// `state.layoutId` yields `cells.length === 0` and therefore `framed ===
// false`, rather than needing a second branch. If that reads too clever
// later, split it.

/** Restores marks, layout and boxes for a video. Boxes are dropped if the
 *  source resolution changed — rects are stored in source pixels, so they
 *  are meaningless against different dimensions — if their count doesn't
 *  match the layout's cells, or if any fails `isValidBox` against *its own
 *  cell's* ratio, the same check the server runs before ffmpeg. A rect that
 *  matches dimensions but is a legal 9:8 box aimed at a 540x960 cell would
 *  otherwise restore and preview cleanly and die only at export time.
 *
 *  A known layoutId survives all of that: losing the boxes to a re-fetch at
 *  a different resolution should not also cost the layout choice.
 *
 *  localStorage is untrusted input like any other: `Saved`'s field types are
 *  a compile-time claim, not a runtime guarantee, so marks are coerced
 *  through `Number.isFinite` too — a stray string in storage must not
 *  silently make it into a numeric comparison (`"50" > 5` is `true`) and
 *  enable Continue. */
export function restore(videoId: string, source: Size | null): Partial<AppState> {
  const s = readSaved(videoId);
  if (!s) return {};
  const layout = layoutById(s.layoutId);
  const cells = layout ? cellsOf(layout) : [];
  const sameSource = source !== null && s.sourceW === source.w && s.sourceH === source.h;
  const usable =
    source !== null &&
    sameSource &&
    cells.length > 0 &&
    s.boxes.length === cells.length &&
    cells.every((cell, i) => {
      const box = s.boxes[i];
      return box !== undefined && isValidBox(box, source, ratioOf(cell));
    });
  return {
    start: Number.isFinite(s.start) ? s.start : initial.start,
    end: Number.isFinite(s.end) ? s.end : initial.end,
    layoutId: layout ? layout.id : DEFAULT_LAYOUT_ID,
    boxes: usable ? s.boxes : [],
  };
}
