import * as api from "./api.ts";
import { mountEditor } from "./editor.ts";
import { OUTPUT, SHORTS_MAX_S, SKIP_TRIM_UNDER } from "./geometry.ts";
import type { Rect } from "./geometry.ts";
import { clock, mmss, parseTimestamp, slugify } from "./format.ts";
import {
  DEFAULT_LAYOUT_ID,
  LAYOUTS,
  cellsOf,
  defaultBoxes,
  resolveLayout,
} from "./layout.ts";
import { mountPlayer, renderStrip } from "./player.ts";
import type { YtPlayer } from "./player.ts";
import { startPreview } from "./preview.ts";
import { renderTitleArt } from "./starter.ts";
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

// The pasted-timestamp text. It lives here rather than in AppState because
// nothing about it is persisted, and `barSlot` is rebuilt on every render —
// so the value has to survive that rebuild without ever causing one, the
// same hazard renderIdle's quiet `oninput` avoids for the URL field.
let stampText = "";

/** The paste-a-YouTube-timestamp affordance, shared by both marking phases.
 *  Applying only ever *seeks*: start and end still come from Set Start /
 *  Set End, so a misread paste costs a seek and never a mark. `onApply`
 *  receives absolute source-timeline seconds — each phase maps those onto
 *  its own clock — and returns the message to show, or "" once it has
 *  seeked.
 *
 *  ponytail: the video id in a pasted URL is ignored, so a timestamp copied
 *  from a *different* video seeks this one. Checking it needs `videoIdFrom`,
 *  which lives in server/ytdlp.ts where the client cannot import it; hoist
 *  that into a shared module if this ever bites. Both callers reject a
 *  timestamp outside their own range, which catches the usual case. */
function renderStampInput(onApply: (seconds: number) => string, disabled: boolean): Node[] {
  const input = el("input", {
    type: "text",
    placeholder: "https://youtu.be/…?t=327",
    size: 26,
    value: stampText,
    title: "Paste a YouTube link with ?t=, or 1h2m3s, or 5:27",
    disabled,
  });
  // Assigning the module-level `stampText` instead of calling setState: a
  // notifying update per keystroke would rebuild this very input and drop
  // the cursor mid-typing (see renderIdle for the same reasoning).
  input.oninput = () => {
    stampText = input.value;
  };

  const apply = () => {
    const t = parseTimestamp(input.value);
    // A single setState for both outcomes, so a seek that lands also clears
    // whatever message the previous attempt left behind.
    setState({
      error:
        t === null
          ? "Could not read a timestamp there. Paste a YouTube link with ?t=…, or 1h2m3s, or 5:27."
          : onApply(t),
    });
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") apply();
  };
  const go = el("button", { textContent: "Apply timestamp", disabled });
  go.onclick = apply;
  return [input, go];
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
    // Before the strip, not after: `.strip` is `flex: 1 1 240px`, so it eats
    // the row's free space and would push anything behind it to the far edge,
    // away from the Set Start / Set End buttons this input feeds.
    ...renderStampInput((t) => {
      if (t > s.duration) {
        return `${clock(t)} is past the end of this video (${clock(s.duration)}).`;
      }
      player?.seekTo(t);
      return "";
    }, !ready),
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
// The layout the mounted editor and preview loop were built for. Their
// node count and cell list are layout-derived, so a layout change has to
// rebuild them — while leaving videoEl, canvasEl and every other child of
// sourceSlot/outSlot exactly where they are. Emptying either slot is the
// hazard this whole shell exists to avoid.
let editorFor = "";

/** Idempotent per clipUrl *and* per layoutId: re-renders during framing
 *  (busy toggles, marks changing, etc.) call this again, and framingFor /
 *  editorFor are what keep it from restarting the rAF loop, re-rolling
 *  default boxes or reloading the video on every one of them. A layout
 *  change rebuilds the editor and preview (their node count and cell list
 *  are layout-derived) without touching videoEl or canvasEl.
 *
 *  Returns nothing: the nodes it builds are reachable through the module
 *  scoped videoEl/canvasEl that render() already toggles, and the bar has no
 *  reader for them since marking left this phase. */
function ensureFraming(): void {
  const s = getState();
  const layout = resolveLayout(s.layoutId);
  const cells = cellsOf(layout);
  const sameClip = videoEl !== null && canvasEl !== null && framingFor === s.clipUrl;
  const sameLayout = editorFor === layout.id;
  if (sameClip && sameLayout) return;
  framingFor = s.clipUrl;
  editorFor = layout.id;
  stopPreview?.();

  if (!videoEl) {
    videoEl = el("video", { controls: true, preload: "auto" });
    sourceSlot.append(videoEl);
  }
  // Only on a genuine clip change: assigning the same src reloads the
  // element and restarts playback, which a layout switch must not do.
  if (!sameClip) videoEl.src = s.clipUrl;

  if (!canvasEl) {
    canvasEl = el("canvas");
    outSlot.append(canvasEl);
  }

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
    cells,
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
}

/** The current boxes, or this layout's defaults if the list isn't built yet.
 *  Read fresh on every preview frame and every drag, so it must not
 *  allocate a fallback unless it actually needs one. */
function currentBoxes(): Rect[] {
  const cur = getState();
  const layout = resolveLayout(cur.layoutId);
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
  const layout = resolveLayout(s.layoutId);
  const boxes = s.boxes;
  if (boxes.length !== cellsOf(layout).length) return;
  // Same check the Export button is disabled on, and the same one the server
  // repeats: the title is spoken aloud on the starter screen, so a blank one
  // is a silent screen, not a missing caption.
  const starterTitle = s.starterTitle.trim();
  if (starterTitle === "") return;
  await guard("Rendering… (a 30s clip takes ~5–10s)", async () => {
    const blob = await api.exportClip({
      videoId: s.videoId,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      start: s.start,
      end: s.end,
      starterTitle,
      titlePng: await renderTitleArt(starterTitle),
      layoutId: layout.id,
      boxes,
    });
    const url = URL.createObjectURL(blob);
    const a = el("a", {
      href: url,
      // The same name the server puts in Content-Disposition, from the same
      // inputs — a mismatch here would be invisible until someone compared
      // the saved file with the server's log.
      download: `${slugify(starterTitle)}-${mmss(s.start)}-${mmss(s.end)}.mp4`,
    });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    // Inside the guard, after the await: a failed export throws before this
    // and rings nothing. Export doesn't change `phase`, so this is the one
    // step the phase subscriber can't see.
    bell();
  });
}

/** One button per layout, each drawing its own cells. The diagram is
 *  generated from `cellsOf`, so a picker swatch cannot drift from what the
 *  layout actually composes — which a hand-drawn icon set would.
 *
 *  Takes `busy` from the caller rather than reading `getState().busy`
 *  itself: `renderFraming` already holds the render's own snapshot `s`, and
 *  a second independent read here is exactly how a render pass can end up
 *  observing two different moments of state and disagreeing with itself. */
function renderLayoutPicker(currentId: string, busy: boolean): Node {
  const picks = LAYOUTS.map((layout) => {
    const selected = layout.id === currentId;
    const pick = el("button", {
      className: "layout-pick",
      title: layout.label,
      ariaLabel: layout.label,
      disabled: busy,
    });
    pick.setAttribute("aria-pressed", String(selected));
    for (const cell of cellsOf(layout)) {
      // Percentages, plus a 1px inset so neighbouring cells read as
      // separate blocks instead of one filled rectangle.
      pick.append(
        el("span", {
          className: "layout-cell",
          style:
            `left: calc(${(cell.x / OUTPUT.w) * 100}% + 1px);` +
            `top: calc(${(cell.y / OUTPUT.h) * 100}% + 1px);` +
            `width: calc(${(cell.w / OUTPUT.w) * 100}% - 2px);` +
            `height: calc(${(cell.h / OUTPUT.h) * 100}% - 2px);`,
        }),
      );
    }
    pick.onclick = () => {
      if (layout.id === currentId) return;
      // Boxes are cleared, not carried over: cell ratios differ between
      // layouts, so a box from the old one is illegal in the new one.
      // ensureFraming rolls this layout's defaults on the next render.
      //
      // ponytail: a boxesByLayout map would preserve a framing per layout
      // and make flipping between them to compare non-destructive. Add it
      // if that gets annoying.
      setState({ layoutId: layout.id, boxes: [] });
      save();
      // setState() above re-renders synchronously, and render() replaces
      // barSlot's children wholesale — which destroys the very button that
      // was just clicked and drops focus to <body>. The picker's whole
      // point is repeated selection, so losing focus here costs a keyboard
      // user several tabs to get back to the swatch they were just on. The
      // new bar already reflects the selection by this point, so the
      // now-pressed swatch can be found and re-focused directly.
      barSlot.querySelector<HTMLElement>('.layout-pick[aria-pressed="true"]')?.focus();
    };
    return pick;
  });
  const wrap = el("div", { className: "layouts", ariaLabel: "Layout" }, ...picks);
  // role, via setAttribute rather than the ElProps object: `ariaLabel`
  // above and `aria-pressed` on each swatch both rely on ARIAMixin
  // reflection, but plain `role` reflection (Element.role mirroring the
  // `role` content attribute) landed in browsers well after those did.
  // Object.assign-ing a `role` property on a browser that predates it would
  // silently create an inert JS property instead of the attribute assistive
  // tech reads — setAttribute has always worked, reflection or not.
  wrap.setAttribute("role", "group");
  return wrap;
}

/** The framing bar: layout, re-fetch, back-to-trim and export. Marking is
 *  confined to the trimming phase — framing is crop and layout only, and
 *  exports whatever start/end trimming left behind. Returns
 *  bar-slot children only — the <video>/<canvas> themselves are owned by
 *  ensureFraming() and live permanently in the persistent sourceSlot/outSlot
 *  (see the module-level comment on the persistent shell), so this function
 *  builds no wrapper of its own around them. */
function renderFraming(): Node[] {
  const s = getState();
  // Called for its effects: it mounts the <video>, canvas, crop-box overlay
  // and preview loop into the persistent shell. Nothing in this bar reads
  // the video handle it returns any more — marking, the only thing that did,
  // now lives solely in the trimming phase.
  ensureFraming();

  // A forced re-download is useful on its own — a cached clip can be
  // suspect — and `busy` is the only thing worth gating it on: start and end
  // cannot move while this phase is on screen.
  const refetch = el("button", {
    textContent: "Re-fetch window",
    disabled: Boolean(s.busy),
    title: "Download this window again",
  });
  refetch.onclick = () => void openWindow();

  const back = el("button", { className: "btn-gray", textContent: "Back to trim" });
  back.onclick = () => setState({ phase: "trimming" });

  // The starter screen's title, and the gate on Export: the screen reads it
  // aloud, so a blank one is a silent screen rather than a missing caption.
  const title = el("input", {
    type: "text",
    placeholder: "Starter screen title (required)",
    title: "Shown and read aloud before the clip",
    ariaLabel: "Starter screen title",
    size: 28,
    value: s.starterTitle,
    disabled: Boolean(s.busy),
  });
  // No window check: windowStart is max(0, floor(start − PAD)) and windowEnd
  // is min(ceil(end + PAD), duration), so the fetched window contains
  // [start, end] by construction — and with marking confined to trimming,
  // nothing reachable from here can move them out of it. The server
  // re-validates the pair regardless.
  const exportable = (text: string) => s.end > s.start && text.trim() !== "" && !s.busy;

  const long = s.end - s.start > SHORTS_MAX_S;
  const download = el("button", {
    className: "btn-solid",
    textContent: "Export",
    disabled: !exportable(s.starterTitle),
  });
  download.onclick = () => void doExport();

  // Quiet, for the same reason the URL field is: a notifying update per
  // keystroke would rebuild this very input and drop the caret. But Export's
  // disabled state depends on this value, and a quiet update reaches no
  // render — so the button is flipped in place here. Without that it would
  // stay disabled until some unrelated setState happened along, which reads
  // as "Export is broken" rather than "type a title first".
  title.oninput = () => {
    setQuiet({ starterTitle: title.value });
    download.disabled = !exportable(title.value);
  };
  // On blur rather than per keystroke: the value is settled by then, and
  // save() notifies nothing, so the caret is safe either way.
  title.onblur = () => save();

  return [
    renderLayoutPicker(s.layoutId, Boolean(s.busy)),
    title,
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

/** A short beep, so a phase advance is noticeable while looking elsewhere.
 *
 *  ponytail: an oscillator rather than an audio file — nothing to ship, cache
 *  or 404. A fresh AudioContext per ring, closed on ended: a long-lived one
 *  starts suspended until the first gesture and would need resuming, whereas
 *  every ring here follows a click. Swap in an `<audio>` and a real sample if
 *  a nicer sound ever matters. */
function bell(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    // Ramp down rather than a hard stop, which clicks.
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.onended = () => void ctx.close();
    osc.start();
    osc.stop(ctx.currentTime + 0.22);
  } catch {
    // No audio device, or the browser refused to start a context. A missing
    // bell must never break the phase advance that triggered it.
  }
}

// One subscriber for every advance, instead of a bell() at each transition:
// `phase` is set from four places (load's two branches — skip-trim goes
// straight to framing — the trim bar's Continue, and "Back to trim") and a
// per-call-site ring would be missed by the fifth. Comparing here also means
// the many setState calls that don't move the phase (busy on/off, error,
// the layout picker) stay silent for free.
//
// The initial value is read before the first render, and boot is always
// "idle": restore() only ever runs inside a load, never at module scope.
let ranPhase = getState().phase;
subscribe(() => {
  const { phase } = getState();
  if (phase === ranPhase) return;
  ranPhase = phase;
  bell();
});

subscribe(render);
render();
