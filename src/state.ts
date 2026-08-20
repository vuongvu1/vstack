import type { Rect, Size } from "./geometry.ts";

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
  boxTop: Rect | null;
  boxBottom: Rect | null;
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
  boxTop: null,
  boxBottom: null,
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
  boxTop: Rect | null;
  boxBottom: Rect | null;
  sourceW: number;
  sourceH: number;
};

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
  const s = parsed as Partial<Saved>;
  return {
    start: s.start ?? 0,
    end: s.end ?? 0,
    boxTop: s.boxTop ?? null,
    boxBottom: s.boxBottom ?? null,
    sourceW: s.sourceW ?? 0,
    sourceH: s.sourceH ?? 0,
  };
}

export function save(): void {
  if (!state.videoId) return;
  const prev = readSaved(state.videoId);
  // Boxes and dimensions only mean anything once /api/window has reported
  // the clip's real size. Before that, `state.source` still holds probe's
  // informational dimensions and the boxes are null, so writing them here
  // unconditionally would erase a pair framed in an earlier session the
  // moment a mark is touched again during a later trimming visit. Marks,
  // by contrast, always reflect the current session and always persist.
  const framed = state.phase === "framing" && state.boxTop !== null && state.boxBottom !== null;
  const saved: Saved = {
    start: state.start,
    end: state.end,
    boxTop: framed ? state.boxTop : (prev?.boxTop ?? null),
    boxBottom: framed ? state.boxBottom : (prev?.boxBottom ?? null),
    sourceW: framed ? state.source.w : (prev?.sourceW ?? 0),
    sourceH: framed ? state.source.h : (prev?.sourceH ?? 0),
  };
  localStorage.setItem(key(state.videoId), JSON.stringify(saved));
}

/** Restores marks and boxes for a video. Boxes are dropped if the source
 *  resolution changed — rects are stored in source pixels, so they are
 *  meaningless against different dimensions. */
export function restore(videoId: string, source: Size | null): Partial<AppState> {
  const s = readSaved(videoId);
  if (!s) return {};
  const sameSource = source !== null && s.sourceW === source.w && s.sourceH === source.h;
  return {
    start: s.start,
    end: s.end,
    boxTop: sameSource ? s.boxTop : null,
    boxBottom: sameSource ? s.boxBottom : null,
  };
}
