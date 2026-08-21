import * as api from "./api.ts";
import { mountEditor } from "./editor.ts";
import { SHORTS_MAX_S, SKIP_TRIM_UNDER } from "./geometry.ts";
import type { Rect } from "./geometry.ts";
import { clock, mmss, slugify } from "./format.ts";
import { DEFAULT_LAYOUT, DEFAULT_LAYOUT_ID, cellsOf, defaultBoxes, layoutById } from "./layout.ts";
import { mountPlayer, renderStrip } from "./player.ts";
import type { YtPlayer } from "./player.ts";
import { startPreview } from "./preview.ts";
import type { AppState } from "./state.ts";
import { getState, restore, save, setQuiet, setState, subscribe } from "./state.ts";

const appEl = document.querySelector<HTMLDivElement>("#app");
if (!appEl) throw new Error("#app missing");
// Rebound so `app`'s declared type is HTMLDivElement outright: control-flow
// narrowing from the check above doesn't reach into functions declared
// later in this module (render() reads app across a closure boundary).
const app: HTMLDivElement = appEl;

type ElProps<K extends keyof HTMLElementTagNameMap> = Partial<
  Omit<HTMLElementTagNameMap[K], "style">
> & { style?: string };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps<K> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const { style, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (style !== undefined) node.style.cssText = style;
  node.append(...children);
  return node;
}

// Built once. render() never replaces these nodes: removing an <iframe>'s
// ancestor from the document destroys its nested browsing context, so
// re-appending even the identical node reloads the player — the old
// app.replaceChildren()-every-render approach would reset the YouTube
// player on every notifying setState() during the trimming phase. <video>
// has no nested browsing context and tolerates detach/reattach fine, but
// both live in this same persistent shell so Tasks 8-11 don't have to
// reason about mixed ownership between the two.
const sourcePlaceholder = el("p", { textContent: "No video loaded." });
const outPlaceholder = el("p", { textContent: "Output preview." });
// Tasks 8-11 append the real iframe/video/canvas into these slots and
// toggle these placeholders' `hidden` instead of removing anything here.
const sourceSlot = el("div", { className: "source" }, sourcePlaceholder);
const outSlot = el("div", { className: "out" }, outPlaceholder);
const barSlot = el("div", { className: "bar" });
const statusSlot = el("div", { className: "status" });
app.append(el("div", { className: "stage" }, sourceSlot, outSlot), barSlot, statusSlot);

// Defense in depth alongside disabling the controls that start a load:
// refuses a second concurrent call even if two slip through (e.g. a click
// followed by Enter before the first render has disabled anything).
let inFlight = false;

async function guard(label: string, fn: () => Promise<void>): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Inside the try: setState notifies subscribers synchronously, so this
    // is a render() call. If it threw outside the try, finally would never
    // run and inFlight would stay true — wedging every later load with no
    // way back but a page reload.
    setState({ busy: label, error: "" });
    await fn();
  } catch (err) {
    setState({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    inFlight = false; // must stay first, so a throwing setState below can't strand it
    setState({ busy: "" });
  }
}

async function load(url: string): Promise<void> {
  await guard("Reading video info…", async () => {
    const info = await api.probe(url);

    if (info.duration < SKIP_TRIM_UNDER) {
      // A short video skips the trim step entirely, but geometry still
      // must come from the real fetched clip, not probe's informational
      // numbers — probe can report a resolution the actual download never
      // delivers, and crop rects are stored in the delivered clip's pixels.
      setState({ busy: "Fetching clip…" });
      const win = await api.fetchWindow(info.videoId, 0, info.duration, info.duration);
      // Mirrors openWindow() below: boxes are stored in the clip's real
      // fetched pixels, so restoring them requires that resolution, not
      // probe's informational one — and it must happen before entering
      // framing, or ensureFraming rolls fresh defaults and save()'s
      // `framed` gate (now true) writes them straight over the saved pair.
      const source = { w: win.width, h: win.height };
      const saved = restore(info.videoId, source);
      setState({
        videoId: info.videoId,
        title: info.title,
        duration: info.duration,
        start: 0,
        end: info.duration,
        clipUrl: win.clipUrl,
        windowStart: win.windowStart,
        windowEnd: win.windowEnd,
        source,
        layoutId: saved.layoutId ?? DEFAULT_LAYOUT_ID,
        boxes: saved.boxes ?? [],
        phase: "framing",
      });
      save();
      return;
    }

    const saved = restore(info.videoId, null);
    setState({
      videoId: info.videoId,
      title: info.title,
      duration: info.duration,
      source: { w: info.width, h: info.height },
      start: saved.start ?? 0,
      end: saved.end ?? info.duration,
      phase: "trimming",
    });
  });
}

let player: YtPlayer | null = null;
let playerFor = "";
// A failed mount is terminal for this videoId until the user explicitly
// asks to try again (Retry button below) — see ensureSourcePlayer.
let playerFailed = "";
// The actual mounted <iframe>, captured once mountPlayer resolves. render()
// toggles `hidden` on this element directly, not on some wrapper around it
// — an ancestor-level hide would leave the iframe's own `hidden` property
// false, which is observable (and was flagged in review) even though the
// iframe would be invisible either way.
let sourceIframe: HTMLIFrameElement | null = null;

/** Mounts the YouTube iframe once per videoId, directly into the persistent
 *  `sourceSlot` declared above. `renderTrimming()` calls this on every
 *  render — the `playerFor` guard, set synchronously before any async work
 *  starts, is what keeps this a no-op after the first call for a given
 *  video, and what stops a second, different videoId requested before the
 *  first finishes mounting from racing it (its `.then`/`.catch` bail out
 *  once `playerFor` no longer matches what they were mounting). `sourceSlot`
 *  itself must never be emptied or re-parented once the iframe is inside it
 *  (see the comment on the persistent shell above) — but switching to a
 *  genuinely different video is not that bug: `player.destroy()` removes
 *  the old iframe on purpose, the same way loading a second video ever
 *  would.
 *
 *  A failed mount (blocked network, or YouTube refusing to embed the video
 *  — private, deleted, age-restricted, region-locked, or embedding simply
 *  disabled, all ordinary cases) surfaces through `state.error` instead of
 *  leaving Set Start/Set End/Continue clickable while silently doing
 *  nothing forever.
 *
 *  Critically, a failed mount must NOT be retried automatically:
 *  `renderTrimming()` calls this on every render, and `setState({error})`
 *  itself triggers a render — so clearing the gate on failure (instead of
 *  recording it in `playerFailed`) would remount immediately on the very
 *  next render, spinning forever with no user action and no backoff
 *  (a tight, near-synchronous loop for a mount that fails before `onReady`
 *  can even attach, a ~15s-interval loop for the two timeouts — each cycle
 *  appending another throwaway host into `sourceSlot`, since `mountPlayer`
 *  is what owns cleaning up its own DOM node on rejection, not this
 *  function). Recovery is the explicit "Retry" control in `renderTrimming`,
 *  which clears `playerFailed` for exactly one further attempt per click. */
function ensureSourcePlayer(videoId: string): void {
  if (playerFor === videoId || playerFailed === videoId) return;
  playerFailed = "";
  playerFor = videoId;
  player?.destroy();
  player = null;
  sourceIframe = null;

  void mountPlayer(sourceSlot, videoId)
    .then((p) => {
      if (playerFor !== videoId) return; // superseded before this resolved
      player = p;
      sourceIframe = sourceSlot.querySelector("iframe");
      const cur = getState();
      if (cur.start > 0) p.seekTo(cur.start);
      render(); // player just went null -> ready; refresh the disabled state
    })
    .catch((err: unknown) => {
      if (playerFor !== videoId) return;
      playerFor = "";
      playerFailed = videoId; // terminal until Retry is clicked
      setState({ error: err instanceof Error ? err.message : String(err) });
    });
}

function clampMark(seconds: number, duration: number): number {
  return Math.min(Math.max(0, seconds), duration);
}

function renderTrimming(): Node[] {
  const s = getState();
  ensureSourcePlayer(s.videoId);
  const ready = player !== null;
  const failed = playerFailed === s.videoId;

  const setStart = el("button", { textContent: "Set Start", disabled: !ready });
  setStart.onclick = () => {
    if (!player) return;
    setState({ start: clampMark(player.currentTime(), s.duration) });
    save();
  };

  const setEnd = el("button", { textContent: "Set End", disabled: !ready });
  setEnd.onclick = () => {
    if (!player) return;
    setState({ end: clampMark(player.currentTime(), s.duration) });
    save();
  };

  const marks = el("span", {
    className: "badge",
    textContent: `${clock(s.start)} → ${clock(s.end)}`,
  });

  const long = s.end - s.start > SHORTS_MAX_S;
  const warn = long
    ? el("span", {
        className: "badge badge-warn",
        textContent: "over 3 min — longer than a YouTube Short",
      })
    : el("span");

  const go = el("button", {
    className: "btn-solid",
    textContent: "Continue",
    disabled: !ready || !(s.end > s.start),
  });
  go.onclick = () => void openWindow();

  const controls: Node[] = [setStart, setEnd];
  if (failed) {
    // One attempt per click, never automatic — see ensureSourcePlayer.
    const retry = el("button", { className: "btn-gray", textContent: "Retry" });
    retry.onclick = () => {
      playerFailed = "";
      setState({ error: "" });
    };
    controls.push(retry);
  }

  return [
    ...controls,
    renderStrip({
      duration: s.duration,
      start: s.start,
      end: s.end,
      onSeek: (t) => player?.seekTo(t),
    }),
    marks,
    warn,
    go,
  ];
}

async function openWindow(): Promise<void> {
  const s = getState();
  await guard("Fetching clip…", async () => {
    const w = await api.fetchWindow(s.videoId, s.start, s.end, s.duration);
    const source = { w: w.width, h: w.height };
    const saved = restore(s.videoId, source);
    setState({
      clipUrl: w.clipUrl,
      windowStart: w.windowStart,
      windowEnd: w.windowEnd,
      source,
      layoutId: saved.layoutId ?? DEFAULT_LAYOUT_ID,
      boxes: saved.boxes ?? [],
      phase: "framing",
    });
    save();
  });
}

// The <video> and <canvas> for the framing phase, built once and appended
// directly into the persistent sourceSlot/outSlot declared above — never
// into a wrapper of their own (see the module-level comment on the
// persistent shell). A fresh <video> per clipUrl would restart playback on
// every unrelated re-render during framing, so both are created exactly
// once and, on a genuine clip change, only their source is swapped.
let videoEl: HTMLVideoElement | null = null;
let canvasEl: HTMLCanvasElement | null = null;
let stopPreview: (() => void) | null = null;
let stopEditor: (() => void) | null = null;
// mountEditor appends its own `.boxes` overlay directly into sourceSlot (see
// the comment on its host param) and, like the iframe/video/canvas above, is
// built once and torn down only on a genuine clip change — never on a phase
// change. render() must hide it explicitly when leaving framing, the same
// way it hides videoEl/canvasEl, or the overlay (positioned against a now-
// hidden, zero-size video) is left showing over the trimming view.
let boxesLayer: HTMLDivElement | null = null;
let framingFor = "";

/** Idempotent per clipUrl: re-renders during framing (busy toggles, marks
 *  changing, etc.) call this again, and framingFor is what keeps it from
 *  restarting the rAF loop or re-rolling default boxes on every one of
 *  them. */
function ensureFraming(): { video: HTMLVideoElement; canvas: HTMLCanvasElement } {
  const s = getState();
  if (videoEl && canvasEl && framingFor === s.clipUrl) {
    return { video: videoEl, canvas: canvasEl };
  }
  framingFor = s.clipUrl;
  stopPreview?.();

  if (!videoEl) {
    videoEl = el("video", { controls: true, preload: "auto" });
    sourceSlot.append(videoEl);
  }
  videoEl.src = s.clipUrl;

  if (!canvasEl) {
    canvasEl = el("canvas");
    outSlot.append(canvasEl);
  }

  const layout = layoutById(s.layoutId) ?? DEFAULT_LAYOUT;
  const cells = cellsOf(layout);

  if (s.boxes.length !== cells.length) {
    // setQuiet, not setState: this runs during render, and notifying from
    // inside a render is re-entrant. The rAF preview loop below reads state
    // fresh every frame, so a quiet update still reaches the canvas.
    setQuiet({ boxes: defaultBoxes(s.source, layout) });
    save();
  }

  stopPreview = startPreview(canvasEl, videoEl, cells, currentBoxes);

  stopEditor?.();
  stopEditor = mountEditor({
    host: sourceSlot,
    media: videoEl,
    source: () => getState().source,
    cells: () => cells,
    boxes: currentBoxes,
    // Dragging must not trigger a full re-render — that would rebuild the
    // video element mid-drag. The editor moves its own nodes and the rAF
    // loop reads the new rect; state is written without notifying.
    onChange: (index, rect) => {
      const next = [...currentBoxes()];
      next[index] = rect;
      setQuiet({ boxes: next });
    },
    onCommit: () => save(),
  });
  boxesLayer = sourceSlot.querySelector<HTMLDivElement>(".boxes");

  return { video: videoEl, canvas: canvasEl };
}

/** The current boxes, or this layout's defaults if the list isn't built yet.
 *  Read fresh on every preview frame and every drag, so it must not
 *  allocate a fallback unless it actually needs one. */
function currentBoxes(): Rect[] {
  const cur = getState();
  const layout = layoutById(cur.layoutId) ?? DEFAULT_LAYOUT;
  const cells = cellsOf(layout);
  return cur.boxes.length === cells.length ? cur.boxes : defaultBoxes(cur.source, layout);
}

/** Downloads the exported clip. `exportClip` returns a Blob; the object URL
 *  is handed to a real <a download> rather than window.open/location, which
 *  browsers are free to treat as a navigation instead of a save. The anchor
 *  must be attached before `.click()` (Firefox ignores clicks on detached
 *  elements) and the object URL must outlive the click — revoking
 *  synchronously races the browser's own read of it in some browsers, so
 *  revocation is deferred instead of immediate. */
async function doExport(): Promise<void> {
  const s = getState();
  const layout = layoutById(s.layoutId) ?? DEFAULT_LAYOUT;
  const boxes = s.boxes;
  if (boxes.length !== cellsOf(layout).length) return;
  await guard("Rendering… (a 30s clip takes ~5–10s)", async () => {
    const blob = await api.exportClip({
      videoId: s.videoId,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      start: s.start,
      end: s.end,
      title: s.title,
      layoutId: layout.id,
      boxes,
    });
    const url = URL.createObjectURL(blob);
    const a = el("a", {
      href: url,
      download: `${slugify(s.title)}-${mmss(s.start)}-${mmss(s.end)}.mp4`,
    });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
}

/** The framing transport: marks (free within the fetched window's pad),
 *  re-fetch (once they wander outside it), back-to-trim, and export. Returns
 *  bar-slot children only — the <video>/<canvas> themselves are owned by
 *  ensureFraming() and live permanently in the persistent sourceSlot/outSlot
 *  (see the module-level comment on the persistent shell), so this function
 *  builds no wrapper of its own around them. */
function renderFraming(): Node[] {
  const s = getState();
  const { video } = ensureFraming();

  const setStart = el("button", { textContent: "Set Start" });
  setStart.onclick = () => {
    // video.currentTime is clip-relative; marks are in the original video's
    // timeline, and the clip begins at windowStart.
    setState({ start: s.windowStart + video.currentTime });
    save();
  };

  const setEnd = el("button", { textContent: "Set End" });
  setEnd.onclick = () => {
    setState({ end: s.windowStart + video.currentTime });
    save();
  };

  // Nudging a mark within the fetched window is free — PAD already covers
  // it, no refetch needed. Outside it, the server will reject start/end as
  // outside the fetched window regardless; this is just the UI affordance.
  const inWindow = s.start >= s.windowStart && s.end <= s.windowEnd;

  // `inWindow` is deliberately not part of this gate: with windowStart
  // computed as max(0, floor(start - PAD)), `start >= windowStart` holds
  // unconditionally, and framing's only mark input is bounded by the
  // clip's own span — so `inWindow` is true in every state the UI can
  // reach and gating on it would leave this permanently disabled. A forced
  // re-download is still useful on its own (a cached clip can be
  // suspect), so only `busy` guards it.
  const refetch = el("button", {
    textContent: "Re-fetch window",
    disabled: Boolean(s.busy),
    title: "Download this window again",
  });
  refetch.onclick = () => void openWindow();

  const back = el("button", { className: "btn-gray", textContent: "Back to trim" });
  back.onclick = () => setState({ phase: "trimming" });

  const long = s.end - s.start > SHORTS_MAX_S;
  const download = el("button", {
    className: "btn-solid",
    textContent: "Export",
    disabled: !(s.end > s.start) || !inWindow || Boolean(s.busy),
  });
  download.onclick = () => void doExport();

  return [
    setStart,
    setEnd,
    el("span", { className: "badge", textContent: `${clock(s.start)} → ${clock(s.end)}` }),
    el("span", {
      className: "badge",
      textContent: `source ${s.source.w}×${s.source.h}`,
    }),
    long
      ? el("span", {
          className: "badge badge-warn",
          textContent: "over 3 min — longer than a YouTube Short",
        })
      : el("span"),
    refetch,
    back,
    download,
  ];
}

function renderIdle(s: AppState): Node[] {
  const busy = s.busy !== "";
  const input = el("input", {
    type: "url",
    placeholder: "https://www.youtube.com/watch?v=…",
    size: 60,
    value: s.url,
    disabled: busy,
  });
  const go = el("button", { className: "btn-solid", textContent: "Load", disabled: busy });
  go.onclick = () => void load(input.value);
  // Quiet: an input event on every keystroke must not trigger render(),
  // which would rebuild this very input from scratch and drop focus/cursor
  // mid-typing. State still tracks the latest text for the next render.
  input.oninput = () => setQuiet({ url: input.value });
  input.onkeydown = (e) => {
    if (e.key === "Enter") void load(input.value);
  };
  return [input, go];
}

function render(): void {
  const s = getState();

  // Once a phase owns sourceSlot/outSlot (any phase past idle), the "no
  // video yet" placeholders are stale — hide them so Tasks 8-11 inherit
  // clean containers instead of layering real content under leftover text.
  sourcePlaceholder.hidden = s.phase !== "idle";
  outPlaceholder.hidden = s.phase !== "idle";
  // The iframe is hidden, never removed, once framing owns the stage —
  // removing it (or any ancestor) is what discards its nested browsing
  // context and reloads the video (see ensureSourcePlayer above). Neither
  // `display:none` nor the iframe's own `hidden` attribute suspends a
  // nested browsing context or a <video> element, so whichever one is
  // being hidden is paused explicitly here — otherwise the YouTube player
  // keeps playing audibly under framing (and the reverse on "Back to
  // trim"), mixed with the other side's audio.
  if (sourceIframe) sourceIframe.hidden = s.phase !== "trimming";
  if (s.phase !== "trimming") player?.pause();
  // Same reasoning as sourceIframe above, but a <video> tolerates
  // detach/reattach fine — it just has no reason to move once it lives in
  // the persistent sourceSlot.
  if (videoEl) {
    videoEl.hidden = s.phase !== "framing";
    if (s.phase !== "framing") videoEl.pause();
  }
  if (canvasEl) canvasEl.hidden = s.phase !== "framing";
  // The crop-box overlay is positioned against videoEl and, like it, is
  // built once and never torn down on a phase change (see the comment by
  // its declaration) — only hidden, so "Back to trim" doesn't leave it
  // showing over the trimming view, and returning to framing gets it back
  // without losing drag state or its ResizeObserver.
  if (boxesLayer) boxesLayer.hidden = s.phase !== "framing";

  if (s.phase === "idle") barSlot.replaceChildren(...renderIdle(s));
  else if (s.phase === "trimming") barSlot.replaceChildren(...renderTrimming());
  else barSlot.replaceChildren(...renderFraming());

  const status: Node[] = [];
  const meta: Node[] = [];
  if (s.phase !== "idle") {
    meta.push(el("span", { className: "badge badge-title", textContent: s.title }));
    meta.push(el("span", { className: "badge", textContent: clock(s.duration) }));
    meta.push(el("span", { className: "badge", textContent: `${s.source.w}×${s.source.h}` }));
    meta.push(el("span", { className: "badge", textContent: s.phase }));
  }
  if (s.busy) meta.push(el("span", { className: "badge badge-info", textContent: s.busy }));
  if (meta.length > 0) status.push(el("div", { className: "status-row" }, ...meta));
  if (s.error) status.push(el("pre", { className: "callout", textContent: s.error }));
  statusSlot.replaceChildren(...status);
}

subscribe(render);
render();
