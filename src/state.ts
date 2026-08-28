import { MAX_CUSTOM, isValidCustom } from "./custom.ts";
import type { CustomBox } from "./custom.ts";
import { isValidBox } from "./geometry.ts";
import type { Rect, Size } from "./geometry.ts";
import { DEFAULT_LAYOUT_ID, cellsOf, layoutById, ratioOf, resolveLayout } from "./layout.ts";
import { MAX_SEGMENTS, isValidSegments } from "./segments.ts";
import type { Segment } from "./segments.ts";

export type Phase = "idle" | "trimming" | "framing" | "preview";

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
  /** The starter screen's title, typed in the framing bar. Required to
   *  export — the screen reads it aloud — and unrelated to `title`, which is
   *  YouTube's own and only names the downloaded file. */
  starterTitle: string;
  /** Which speech preset reads the starter title. Empty means "whatever the
   *  server's default is" — the name is not duplicated client-side, it
   *  arrives from /api/voices, so the two sides cannot drift apart.
   *
   *  Persisted by `saveVoice`, NOT by `save()`: it is keyed globally rather
   *  than per video, because the voice of a channel is not a property of one
   *  clip. Putting it in the per-video record meant every new video reverted
   *  to the server's fallback, which is the whole bug this split fixes. */
  voice: string;
  duration: number;
  /** The kept parts of the source timeline, in source seconds. Always at
   *  least one; one segment is exactly the old `start`/`end` pair. These are
   *  what the trimming strip draws and what "Back to trim" restores — they
   *  are NOT what `/api/export` receives, because a stitch's clip has its
   *  own timeline. See `clipStart`/`clipEnd`. */
  segments: Segment[];
  /** The range of the fetched clip file that is the finished cut, reported
   *  by `/api/window`. For one segment these equal the marks; for a stitch
   *  they are `0` and the clip's probed duration. `doExport` sends these. */
  clipStart: number;
  clipEnd: number;
  /** A stitch's segment digest, `""` for an ordinary clip. `/api/export`
   *  needs it to rebuild the cache path. Not persisted — it belongs to a
   *  fetched window, like `clipUrl`. */
  clipDigest: string;
  clipUrl: string;
  windowStart: number;
  windowEnd: number;
  source: Size;
  layoutId: string;
  /** One crop rect per cell of `layoutId`, in `cellsOf` order. Empty means
   *  "not framed yet" — the only other legal length is the layout's cell
   *  count, which is what `save`'s gate and `restore` both check. */
  boxes: Rect[];
  /** Floating pieces over the layout, in z order — last on top. Empty is the
   *  normal case. Unlike `boxes` these survive a layout change: a custom
   *  box's ratio is its own and its `out` is frame space, so nothing about it
   *  is invalidated by the cells changing. */
  customs: CustomBox[];
  /** The finished export. Set by doExport, cleared by nothing — a new
   *  export overwrites them. None of these are persisted: an export belongs
   *  to the session that made it, so save()/restore() do not touch them. */
  outName: string;
  outUrl: string;
  outSize: number;
  /** The upload's metadata. `ytTitle` prefills from `starterTitle` sliced to
   *  YouTube's 100-character cap only while it is still empty (`doExport`
   *  does `getState().ytTitle || starterTitle.slice(0, 100)`) — so, like the
   *  other two, it persists across a re-export within the session, because
   *  retyping a title or description after a crop fix is exactly the work
   *  this phase exists to remove. */
  ytTitle: string;
  ytDescription: string;
  ytTags: string;
  /** Set once the upload lands. Empty means "not published yet", which is
   *  what Publish is gated on. */
  ytVideoId: string;
  /** Whether the thumbnail took. Only meaningful once `ytVideoId` is set —
   *  before that it is just the initial `false`. */
  ytThumbnail: boolean;
};

const initial: AppState = {
  phase: "idle",
  error: "",
  busy: "",
  url: "",
  videoId: "",
  title: "",
  starterTitle: "",
  voice: "",
  duration: 0,
  segments: [{ start: 0, end: 0 }],
  clipStart: 0,
  clipEnd: 0,
  clipDigest: "",
  clipUrl: "",
  windowStart: 0,
  windowEnd: 0,
  source: { w: 0, h: 0 },
  layoutId: DEFAULT_LAYOUT_ID,
  boxes: [],
  customs: [],
  outName: "",
  outUrl: "",
  outSize: 0,
  ytTitle: "",
  ytDescription: "",
  ytTags: "",
  ytVideoId: "",
  ytThumbnail: false,
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
  segments: Segment[];
  starterTitle: string;
  layoutId: string;
  boxes: Rect[];
  customs: CustomBox[];
  sourceW: number;
  sourceH: number;
};

/** The pre-layouts and pre-segments stored shapes. Records in a real user's
 *  localStorage predate both features, and dropping them would silently
 *  un-frame — or un-mark — every video already worked on. */
type Legacy = {
  boxTop?: Rect | null;
  boxBottom?: Rect | null;
  start?: number;
  end?: number;
};

const key = (videoId: string) => `vstack:${videoId}`;

/** The voice, stored once for the whole app rather than per video.
 *
 *  Its own key for the same reason `vstack:theme` has one: it is a preference,
 *  not a property of any one clip. Read through a function instead of baked
 *  into `initial` because `initial` is evaluated at module load, and under
 *  vitest that happens before the localStorage stub exists. */
const VOICE_KEY = "vstack:voice";

export function savedVoice(): string {
  return localStorage.getItem(VOICE_KEY) ?? "";
}

export function saveVoice(name: string): void {
  localStorage.setItem(VOICE_KEY, name);
}

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

  // Migration: a record with no `segments` but with the old pair is a
  // pre-segments save, and that pair is by definition one segment.
  //
  // Tested on `!== undefined`, NOT on truthiness: a record marked from the
  // very start of the video stores `start: 0`, and `s.start ?? s.end` would
  // read that as "nothing here" and drop a real mark. The one case a
  // truthiness check gets wrong is the one a user hits by pressing Set Start
  // without moving the playhead.
  const legacySegments: Segment[] | null =
    s.segments === undefined && (s.start !== undefined || s.end !== undefined)
      ? [{ start: s.start ?? 0, end: s.end ?? 0 }]
      : null;

  return {
    segments: legacySegments ?? (Array.isArray(s.segments) ? s.segments : []),
    starterTitle: typeof s.starterTitle === "string" ? s.starterTitle : "",
    layoutId: s.layoutId ?? DEFAULT_LAYOUT_ID,
    boxes: migrated ?? (Array.isArray(s.boxes) ? s.boxes : []),
    customs: Array.isArray(s.customs) ? s.customs : [],
    sourceW: s.sourceW ?? 0,
    sourceH: s.sourceH ?? 0,
  };
}

/** The starter title stored for a video, or `""` if there is none.
 *
 *  The idle screen's dropdown of cached clips needs a human-readable label,
 *  and the cache itself only knows a videoId and a pair of window bounds. So
 *  a row falls back to whatever title was typed the last time that video was
 *  framed. Unlike `restore` this takes no `Size`: the point is to label a
 *  clip *before* it is opened, which is before any source size is known —
 *  and a title is source-independent anyway, which is why `save` persists it
 *  unconditionally rather than behind the `framed` gate. */
export function savedTitle(videoId: string): string {
  return readSaved(videoId)?.starterTitle ?? "";
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
  //
  // resolveLayout, not layoutById directly: an unknown state.layoutId is
  // unreachable today (restore() and the layout picker only ever produce a
  // known id or DEFAULT_LAYOUT_ID) but is worth resolving on purpose rather
  // than by accident, and the same way the rest of the app already does —
  // main.ts's ensureFraming/currentBoxes/doExport all treat an unknown id as
  // DEFAULT_LAYOUT. Every entry in LAYOUTS (and DEFAULT_LAYOUT itself) has
  // at least two cells, so `cells.length` below can never be 0 any more —
  // this replaces an earlier `cells.length > 0` guard that existed only to
  // stop a *synthesised empty* layout's 0 cells from vacuously matching 0
  // boxes, a case resolveLayout cannot produce. `layout.id`, not the raw
  // `state.layoutId`, is what gets persisted when framed, mirroring why
  // doExport reports `layout.id` rather than the field it read: if an
  // unknown id is ever reached, the app is already behaving as
  // DEFAULT_LAYOUT throughout (its cells, its default boxes), so the saved
  // record should say so — persisting the unknown id instead would write a
  // record that fails its own layout's cell count on the very next restore().
  const layout = resolveLayout(state.layoutId);
  const cells = cellsOf(layout);
  const framed = state.phase === "framing" && state.boxes.length === cells.length;
  const saved: Saved = {
    segments: state.segments,
    // Persisted unconditionally, like the marks and for the same reason: it
    // is typed this session and always reflects it. The framing-only gate
    // below exists for values that are meaningless before /api/window has
    // reported the clip's real size, which a title is not.
    starterTitle: state.starterTitle,
    layoutId: framed ? layout.id : (prev?.layoutId ?? DEFAULT_LAYOUT_ID),
    boxes: framed ? state.boxes : (prev?.boxes ?? []),
    // Same gate as boxes, for the same reason: an `out` is frame space and
    // always meaningful, but a `crop` is source pixels and means nothing
    // before /api/window has reported the clip's real size.
    customs: framed ? state.customs : (prev?.customs ?? []),
    sourceW: framed ? state.source.w : (prev?.sourceW ?? 0),
    sourceH: framed ? state.source.h : (prev?.sourceH ?? 0),
  };
  localStorage.setItem(key(state.videoId), JSON.stringify(saved));
}

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
  // Computed independently of `usable`: a bad piece must not cost the
  // boxes, and a bad box must not cost the pieces.
  //
  // The count is bounded as well as the shapes, the same way the boxes above
  // are checked against their layout's cell count. localStorage is untrusted
  // input: a hand-edited record with three individually legal pieces would
  // otherwise restore into a session that mounts three nodes, previews them,
  // and then 400s at export against `assertCustoms` — which is where this
  // limit is actually enforced.
  const usableCustoms =
    source !== null &&
    sameSource &&
    s.customs.length <= MAX_CUSTOM &&
    s.customs.every((c) => isValidCustom(c, source));
  return {
    // The same validator the server runs on the wire. The count is bounded
    // as well as each element's shape, the way the boxes above are bounded
    // by their layout's cell count: a hand-edited record with twenty legal
    // parts would otherwise mount, preview, and fire twenty downloads
    // before /api/window's own check ever ran. `undefined` — not a
    // fallback — so main.ts's `?? initial` decides what an unusable record
    // means, which is what every other field here already does.
    segments: isValidSegments(s.segments, Number.POSITIVE_INFINITY) ? s.segments : undefined,
    starterTitle: s.starterTitle,
    layoutId: layout ? layout.id : DEFAULT_LAYOUT_ID,
    boxes: usable ? s.boxes : [],
    customs: usableCustoms ? s.customs : [],
  };
}
