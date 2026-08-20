import type { Rect, Size } from "./geometry.ts";

export type Phase = "idle" | "trimming" | "framing";

export type AppState = {
  phase: Phase;
  error: string;
  busy: string;
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

export function save(): void {
  if (!state.videoId) return;
  const saved: Saved = {
    start: state.start,
    end: state.end,
    boxTop: state.boxTop,
    boxBottom: state.boxBottom,
    sourceW: state.source.w,
    sourceH: state.source.h,
  };
  localStorage.setItem(key(state.videoId), JSON.stringify(saved));
}

/** Restores marks and boxes for a video. Boxes are dropped if the source
 *  resolution changed — rects are stored in source pixels, so they are
 *  meaningless against different dimensions. */
export function restore(videoId: string, source: Size | null): Partial<AppState> {
  const raw = localStorage.getItem(key(videoId));
  if (!raw) return {};
  let saved: Saved;
  try {
    saved = JSON.parse(raw) as Saved;
  } catch {
    return {};
  }
  const sameSource =
    source !== null && saved.sourceW === source.w && saved.sourceH === source.h;
  return {
    start: saved.start,
    end: saved.end,
    boxTop: sameSource ? saved.boxTop : null,
    boxBottom: sameSource ? saved.boxBottom : null,
  };
}
