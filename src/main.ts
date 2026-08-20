import * as api from "./api.ts";
import { defaultBoxes, SKIP_TRIM_UNDER } from "./geometry.ts";
import { clock } from "./format.ts";
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
const statusSlot = el("div");
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
    const saved = restore(info.videoId, null);

    if (info.duration < SKIP_TRIM_UNDER) {
      // A short video skips the trim step entirely, but geometry still
      // must come from the real fetched clip, not probe's informational
      // numbers — probe can report a resolution the actual download never
      // delivers, and crop rects are stored in the delivered clip's pixels.
      setState({ busy: "Fetching clip…" });
      const win = await api.fetchWindow(info.videoId, 0, info.duration, info.duration);
      setState({
        videoId: info.videoId,
        title: info.title,
        duration: info.duration,
        start: 0,
        end: info.duration,
        clipUrl: win.clipUrl,
        windowStart: win.windowStart,
        windowEnd: win.windowEnd,
        source: { w: win.width, h: win.height },
        phase: "framing",
      });
      return;
    }

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

  const marks = el("span", { textContent: `${clock(s.start)} → ${clock(s.end)}` });

  const long = s.end - s.start > 180;
  const warn = long
    ? el("span", {
        textContent: "over 3 min — longer than a YouTube Short",
        style: "color:var(--amber-11)",
      })
    : el("span");

  const go = el("button", {
    textContent: "Continue",
    disabled: !ready || !(s.end > s.start),
  });
  go.onclick = () => void openWindow();

  const controls: Node[] = [setStart, setEnd];
  if (failed) {
    // One attempt per click, never automatic — see ensureSourcePlayer.
    const retry = el("button", { textContent: "Retry" });
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
      boxTop: saved.boxTop ?? null,
      boxBottom: saved.boxBottom ?? null,
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

  if (!s.boxTop || !s.boxBottom) {
    const { top, bottom } = defaultBoxes(s.source);
    // setQuiet, not setState: this runs during render, and notifying from
    // inside a render is re-entrant. The rAF preview loop below reads state
    // fresh every frame, so a quiet update still reaches the canvas.
    setQuiet({ boxTop: top, boxBottom: bottom });
    save();
  }

  stopPreview = startPreview(canvasEl, videoEl, () => {
    const cur = getState();
    return {
      top: cur.boxTop ?? defaultBoxes(cur.source).top,
      bottom: cur.boxBottom ?? defaultBoxes(cur.source).bottom,
    };
  });

  return { video: videoEl, canvas: canvasEl };
}

function renderFraming(): Node[] {
  const s = getState();
  ensureFraming();
  return [
    el("span", { textContent: `${clock(s.start)} → ${clock(s.end)}` }),
    el("span", { textContent: `source ${s.source.w}x${s.source.h}` }),
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
  const go = el("button", { textContent: "Load", disabled: busy });
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
  // context and reloads the video (see ensureSourcePlayer above).
  if (sourceIframe) sourceIframe.hidden = s.phase !== "trimming";
  // Same reasoning as sourceIframe above, but a <video> tolerates
  // detach/reattach fine — it just has no reason to move once it lives in
  // the persistent sourceSlot.
  if (videoEl) videoEl.hidden = s.phase !== "framing";
  if (canvasEl) canvasEl.hidden = s.phase !== "framing";

  if (s.phase === "idle") barSlot.replaceChildren(...renderIdle(s));
  else if (s.phase === "trimming") barSlot.replaceChildren(...renderTrimming());
  else barSlot.replaceChildren(...renderFraming());

  const status: Node[] = [];
  if (s.phase !== "idle") {
    status.push(
      el("p", {
        textContent: `${s.title} — ${clock(s.duration)} — ${s.source.w}x${s.source.h}`,
      }),
    );
    status.push(el("p", { textContent: `phase: ${s.phase}` }));
  }
  if (s.busy) status.push(el("p", { textContent: s.busy }));
  if (s.error) status.push(el("pre", { textContent: s.error, style: "color:var(--amber-11)" }));
  statusSlot.replaceChildren(...status);
}

subscribe(render);
render();
