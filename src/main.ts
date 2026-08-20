import * as api from "./api.ts";
import { SKIP_TRIM_UNDER } from "./geometry.ts";
import { clock } from "./format.ts";
import { mountPlayer, renderStrip } from "./player.ts";
import type { YtPlayer } from "./player.ts";
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
 *  nothing forever. */
function ensureSourcePlayer(videoId: string): void {
  if (playerFor === videoId) return;
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
      // Clear the gate so a future attempt for this same video (e.g. a
      // retry control, or just calling load() again) is not wedged forever
      // by one failed mount.
      playerFor = "";
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

  return [
    setStart,
    setEnd,
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

  if (s.phase === "idle") barSlot.replaceChildren(...renderIdle(s));
  else if (s.phase === "trimming") barSlot.replaceChildren(...renderTrimming());
  else barSlot.replaceChildren(); // Filled in by Task 9.

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
