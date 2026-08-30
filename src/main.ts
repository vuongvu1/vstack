// The same file the exported video plays under its title card — one sound
// for "this step landed", whether that step is a phase advance in the app or
// the title appearing in the short. Imported rather than fetched by path so
// Vite fingerprints it and a build carries it; `vite/client` types make an
// mp3 import a string URL.
import titleSound from "../server/assets/start-title-sound.mp3";
import * as api from "./api.ts";
import { MAX_CUSTOM, defaultCustom, moveOut, outRatio, resizeOut, resnapCrop } from "./custom.ts";
import type { CustomBox } from "./custom.ts";
import { mountEditor } from "./editor.ts";
import type { EditorHandle } from "./editor.ts";
import { GUTTER } from "./frame.ts";
import { OUTPUT, SHORTS_MAX_S, SKIP_TRIM_UNDER, moveBy, resizeFromCorner } from "./geometry.ts";
import type { Rect } from "./geometry.ts";
import {
  DESCRIPTION_TEMPLATE,
  TAGS_DEFAULT,
  YT_TITLE_MAX,
  defaultTitle,
} from "./defaults.ts";
import { clock, parseTimestamp } from "./format.ts";
import {
  DEFAULT_LAYOUT_ID,
  LAYOUTS,
  cellsOf,
  defaultBoxes,
  ratioOf,
  resolveLayout,
} from "./layout.ts";
import { mountPlayer, renderStrip } from "./player.ts";
import type { YtPlayer } from "./player.ts";
import { startPreview } from "./preview.ts";
import { MAX_SEGMENTS, isValidSegments, normalize } from "./segments.ts";
import type { Segment } from "./segments.ts";
import { renderTitleArt } from "./starter.ts";
import type { AppState } from "./state.ts";
import {
  getState,
  keptLength,
  restore,
  save,
  saveVoice,
  savedTitle,
  savedVoice,
  setQuiet,
  setState,
  subscribe,
} from "./state.ts";
import { peaks } from "./waveform.ts";

declare global {
  interface Window {
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  }
}

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

/** Where the trimming player opens: the first mark, so a re-entered phase
 *  starts at the cut rather than at the video. Under
 *  `noUncheckedIndexedAccess` it needs a fallback; an empty `segments` is
 *  unreachable (state starts with one and `− Part` is disabled at one) but
 *  is not worth an assertion.
 *
 *  There is deliberately no `lastMark` beside it any more. It existed for
 *  the framing badge, which now reads the cut instead — see the comment
 *  there — and the trimming bar's own badge describes the *active* segment,
 *  which is neither end of the whole span. */
function firstMark(s: AppState): number {
  return s.segments[0]?.start ?? 0;
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
// The publish phase's metadata panel. Part of the persistent shell like
// everything else here: it takes over the left column in `preview`, where the
// framing <video> has nothing left to say, and is only ever hidden — never
// removed, and never by hiding sourceSlot itself, which would put the YouTube
// iframe's ancestor into display:none.
const publishForm = el("div", { className: "publish-form", hidden: true });
const sourceSlot = el("div", { className: "source" }, sourcePlaceholder, publishForm);
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
      const win = await api.fetchWindow(
        info.videoId,
        [{ start: 0, end: info.duration }],
        info.duration,
      );
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
        segments: [{ start: 0, end: info.duration }],
        clipUrl: win.clipUrl,
        windowStart: win.windowStart,
        windowEnd: win.windowEnd,
        clipStart: win.clipStart,
        clipEnd: win.clipEnd,
        clipDigest: win.digest,
        source,
        layoutId: saved.layoutId ?? DEFAULT_LAYOUT_ID,
        boxes: saved.boxes ?? [],
        customs: saved.customs ?? [],
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
      // Normalised against the real duration: `restore` validates shape and
      // count but has no duration to clamp to (it runs before probe on the
      // cached-clip path), so a record saved against a different video's
      // length would otherwise reach /api/window and 400.
      segments: normalize(saved.segments ?? [{ start: 0, end: info.duration }], info.duration),
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

  void mountPlayer(sourceSlot, videoId, () => syncTransport?.())
    .then((p) => {
      if (playerFor !== videoId) return; // superseded before this resolved
      player = p;
      sourceIframe = sourceSlot.querySelector("iframe");
      const cur = getState();
      if (firstMark(cur) > 0) p.seekTo(firstMark(cur));
      render(); // player just went null -> ready; refresh the disabled state
    })
    .catch((err: unknown) => {
      if (playerFor !== videoId) return;
      playerFor = "";
      playerFailed = videoId; // terminal until Retry is clicked
      setState({ error: err instanceof Error ? err.message : String(err) });
    });
}

// Relabels the Play/Pause button in place. The label has to follow the
// *player*, not this app's clicks: YouTube's own overlay controls start and
// stop playback without going through the wrapper, so the only honest source
// is the API's onStateChange, which ensureSourcePlayer forwards here.
//
// Updated in place rather than through render(): state changes fire several
// times per play (buffering, playing, paused), and a render per event would
// rebuild the whole bar — dropping the cursor out of the timestamp field
// mid-typing, exactly the hazard the quiet oninput handlers avoid. Same
// in-place pattern as the Export button's disabled flag in renderFraming.
//
// renderTrimming reassigns this on every render; a stale closure just writes
// to a detached button, which is harmless.
let syncTransport: (() => void) | null = null;

/** The playhead nudges, in seconds, in the order they appear. Signed rather
 *  than a magnitude plus a direction: the order on screen *is* the list. */
const NUDGES = [-2, -1, 1, 2] as const;

function clampMark(seconds: number, duration: number): number {
  return Math.min(Math.max(0, seconds), duration);
}

/** The index of the segment in `segs` that fully contains `[start, end]`,
 *  falling back to the last index only if genuinely none does (unreachable
 *  in practice — see below).
 *
 *  Shared by every place that has to re-find "the part I was just touching"
 *  after a `normalize` call that may have merged it into a neighbour:
 *  `normalize` can change both a segment's index *and* its exact bounds, so
 *  neither a stale index nor an exact `start`/`end` match survives it.
 *  Matching on containment of the *whole* edited/added range rather than a
 *  single point also survives the one case a point match does not — two
 *  segments touching exactly at the edited bound (which `normalize`
 *  deliberately leaves unmerged), where a point membership test is
 *  ambiguous between them but only one actually contains the whole range.
 *
 *  `normalize` only ever unions overlapping/touching input ranges into
 *  connected components, so the range this is asked to find is always a
 *  subset of exactly one output segment — the fallback exists only to
 *  satisfy `noUncheckedIndexedAccess`, not because it is expected to fire. */
function segmentContaining(segs: Segment[], start: number, end: number): number {
  const i = segs.findIndex((seg) => seg.start <= start && seg.end >= end);
  return i >= 0 ? i : Math.max(0, segs.length - 1);
}

// The pasted-timestamp text. It lives here rather than in AppState because
// nothing about it is persisted, and `barSlot` is rebuilt on every render —
// so the value has to survive that rebuild without ever causing one, the
// same hazard renderIdle's quiet `oninput` avoids for the URL field.
let stampText = "";

// Which segment Set Start / Set End write to. Module-scoped for the reason
// `stampText` is: nothing about it is persisted, and `barSlot` is rebuilt on
// every render — so it has to survive that rebuild without ever causing one.
let activeSegment = 0;

// renderTrimming replaces the strip on every render, and the strip owns a
// rAF loop now. Stopping the old one before building the new one is what
// keeps a loop from reading a detached node for the rest of *this* visit to
// trimming — but renderTrimming only runs while `phase === "trimming"`, so
// leaving the phase (Continue, and every phase after it) needs its own stop.
// render() below does that, the same way it toggles boxesLayer/outBoxesLayer
// by phase, since nothing calls back into renderTrimming to do it itself.
let strip: { el: HTMLElement; stop(): void } | null = null;

/** The paste-a-YouTube-timestamp affordance, shared by both marking phases.
 *  Applying only ever *seeks*: start and end still come from Set Start /
 *  Set End, so a misread paste costs a seek and never a mark. `onApply`
 *  receives absolute source-timeline seconds — each phase maps those onto
 *  its own clock — and returns the message to show, or "" once it has
 *  seeked. The caller also decides what else a seek implies: trimming pauses,
 *  because the next click is usually Set Start.
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

  // Clamped to the active segment's own index, not to the array: a render
  // can arrive after `− Part` shrank it.
  const active = Math.min(activeSegment, s.segments.length - 1);

  /** Rewrites one bound of the active segment and re-normalises the whole
   *  set — dragging a mark past a neighbour is an ordinary editing gesture,
   *  and `normalize` merges rather than rejecting it.
   *
   *  Reads live state via getState(), never `s`: every path that writes
   *  segments goes through setState today, but this is the same hazard
   *  `+ Box` hit, and the cost of getting it wrong is a silently reverted
   *  edit persisted by the save() on the next line.
   *
   *  Also re-aims `activeSegment` at whatever the edited bound landed in
   *  after normalising: dragging a mark into a neighbour merges the two, so
   *  the active *index* can point at an untouched segment afterwards even
   *  though the active segment's own identity (the range containing the
   *  edit) still exists — `segmentContaining` re-finds it instead of
   *  trusting the index to have survived the merge. */
  const setMark = (which: "start" | "end") => {
    if (!player) return;
    const cur = getState();
    const t = clampMark(player.currentTime(), cur.duration);
    const seg = cur.segments[active];
    if (seg === undefined) return;
    const edited = { ...seg, [which]: t };
    // Ignored rather than normalised away: `normalize` DROPS a segment whose
    // end is not after its start, so Set End with the playhead before the
    // part's start would silently delete the part the user was editing —
    // the worst possible answer to an ordinary misclick. Refusing the edit
    // leaves the strip exactly as it was, which reads as "that did nothing".
    if (!(edited.end > edited.start)) return;
    const next = cur.segments.map((s2, i) => (i === active ? edited : s2));
    const normalized = normalize(next, cur.duration);
    activeSegment = segmentContaining(normalized, edited.start, edited.end);
    setState({ segments: normalized });
    save();
  };

  const setStart = el("button", { textContent: "Set Start", disabled: !ready });
  setStart.onclick = () => setMark("start");

  const setEnd = el("button", { textContent: "Set End", disabled: !ready });
  setEnd.onclick = () => setMark("end");

  // Playback transport. The iframe has YouTube's own controls, but they are
  // only reachable by clicking *into* the video — which then swallows the
  // keyboard, and puts the pointer nowhere near the marking buttons. These
  // sit in the bar with everything else the trim needs.
  const transportLabel = () => (player?.playing() === true ? "Pause" : "Play");
  const toggle = el("button", {
    textContent: transportLabel(),
    title: "Play or pause",
    disabled: !ready,
  });
  syncTransport = () => {
    toggle.textContent = transportLabel();
  };
  toggle.onclick = () => {
    if (!player) return;
    // The state is read *once*, before acting, and the label follows the
    // intent rather than a re-read: YouTube reports the new state
    // asynchronously, so a second playing() call here would still describe
    // the old state — and would start lying the day that changes.
    // onStateChange corrects the label anyway if the play never takes.
    const wasPlaying = player.playing();
    if (wasPlaying) player.pause();
    else player.play();
    toggle.textContent = wasPlaying ? "Play" : "Pause";
  };

  // Jump to a mark, to review the cut without hunting for it on the strip.
  // Deliberately no pause(): YouTube's seekTo resumes a playing player and
  // leaves a paused one paused, so a jump preserves whatever the user was
  // doing — unlike the nudges below, where the pause is the point.
  const jump = (label: string, at: number, enabled: boolean) => {
    const b = el("button", {
      className: "btn-gray",
      textContent: label,
      title: `Jump to ${clock(at)}`,
      disabled: !ready || !enabled,
    });
    b.onclick = () => player?.seekTo(at);
    return b;
  };
  // `end` is enabled only once set, which `end > 0` decides exactly: an
  // unset end is 0, and a *set* end of 0 would be an empty trim. Start
  // needs no such gate — an unset start is 0, which is also where the trim
  // genuinely begins, so the button is never wrong, only redundant.
  const activeSeg = s.segments[active] ?? { start: 0, end: 0 };
  const toStart = jump("⇤ Start", activeSeg.start, true);
  const toEnd = jump("End ⇥", activeSeg.end, activeSeg.end > 0);

  // Fine seeking. YouTube's own arrow keys move 5s, which is coarser than a
  // cut needs — and the iframe only hears them when it has focus, which it
  // loses to every button in this bar. These nudge the *playhead*, not the
  // marks: the point is to look at the frame you are about to mark, so the
  // pair is "nudge until the frame is right, then Set Start".
  const nudges = el("div", { className: "nudges", ariaLabel: "Nudge playhead" });
  nudges.setAttribute("role", "group");
  for (const delta of NUDGES) {
    const label = `${delta > 0 ? "+" : "−"}${Math.abs(delta)}s`;
    const step = el("button", {
      className: "btn-gray",
      textContent: label,
      ariaLabel:
        `${delta > 0 ? "Forward" : "Back"} ${Math.abs(delta)} ` +
        `second${Math.abs(delta) === 1 ? "" : "s"}`,
      title: `Seek ${label}`,
      disabled: !ready,
    });
    step.onclick = () => {
      if (!player) return;
      // Paused before the seek, for the reason spelled out on the timestamp
      // field: a rolling player has left the frame by the time you reach
      // Set Start, which would make the nudge pointless.
      player.pause();
      player.seekTo(clampMark(player.currentTime() + delta, s.duration));
    };
    nudges.append(step);
  }

  const marks = el("span", {
    className: "badge",
    textContent:
      s.segments.length === 1
        ? `${clock(activeSeg.start)} → ${clock(activeSeg.end)}`
        : `${s.segments.length} parts · ${clock(keptLength(s))} kept`,
  });

  const long = keptLength(s) > SHORTS_MAX_S;
  const warn = long
    ? el("span", {
        className: "badge badge-warn",
        textContent: "over 3 min — longer than a YouTube Short",
      })
    : el("span");

  const go = el("button", {
    className: "btn-solid",
    textContent: "Continue",
    disabled: !ready || !isValidSegments(s.segments, s.duration),
  });
  go.onclick = () => void openWindow();

  // A five-second default rather than an empty range: every intermediate
  // state stays valid, so Continue never has to explain itself.
  const addPart = el("button", {
    textContent: "+ Part",
    title: "Keep another range, starting at the playhead",
    disabled: !ready || s.segments.length >= MAX_SEGMENTS,
  });
  addPart.onclick = () => {
    if (!player) return;
    const cur = getState();
    const t = clampMark(player.currentTime(), cur.duration);
    const added = { start: t, end: Math.min(t + 5, cur.duration) };
    const next = normalize([...cur.segments, added], cur.duration);
    // Found by containment of the whole added range, not by identity of its
    // bounds: normalize can merge the new five-second span into an
    // overlapping neighbour, which keeps the *neighbour's* start rather than
    // `t` — an exact `seg.start === t` match would then find nothing and
    // silently fall back to segment 0, aiming the marking controls at an
    // unrelated part. `segmentContaining` re-finds whichever segment the
    // added range ended up inside, merged or not.
    activeSegment = segmentContaining(next, added.start, added.end);
    setState({ segments: next });
    save();
  };

  const dropPart = el("button", {
    className: "btn-gray",
    textContent: "− Part",
    title: "Drop the selected range",
    disabled: !ready || s.segments.length <= 1,
  });
  dropPart.onclick = () => {
    const cur = getState();
    if (cur.segments.length <= 1) return;
    const next = cur.segments.filter((_seg, i) => i !== active);
    activeSegment = Math.max(0, Math.min(active, next.length - 1));
    setState({ segments: next });
    save();
  };

  // One chip per part, switching which one the marking controls aim at.
  const chips = el("div", { className: "nudges", ariaLabel: "Select part" });
  chips.setAttribute("role", "group");
  s.segments.forEach((seg, i) => {
    const chip = el("button", {
      className: i === active ? "" : "btn-gray",
      textContent: String(i + 1),
      title: `${clock(seg.start)} → ${clock(seg.end)}`,
      disabled: !ready,
    });
    chip.onclick = () => {
      activeSegment = i;
      // A seek, not just a selection: switching parts is almost always a
      // prelude to looking at that part. Deliberately no pause — the same
      // reasoning as the jump-to-mark buttons.
      player?.seekTo(seg.start);
      setState({});
    };
    chips.append(chip);
  });

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

  const stamp = renderStampInput((t) => {
    if (t > s.duration) {
      return `${clock(t)} is past the end of this video (${clock(s.duration)}).`;
    }
    // Paused, and paused *before* the seek: applying a timestamp is aiming
    // at a mark, and a player that keeps rolling has already moved off the
    // frame you were aiming at by the time you reach Set Start. YouTube's
    // seekTo resumes a playing player but leaves a paused one paused, so
    // this order needs no second call to undo the resume.
    player?.pause();
    player?.seekTo(t);
    return "";
  }, !ready);

  // Four rows, grouped by what each row is *for*, because one row of a dozen
  // controls wrapped wherever it ran out of width — which put Continue, the
  // only phase-advancing action, on a line of its own below everything else.
  //
  // The strip gets the first row to itself (plus the marks it describes): it
  // is `flex: 1 1 240px`, so sharing a row squeezed the one control whose
  // whole job is being clicked precisely. Then everything that moves the
  // playhead — play, jump to a mark, nudge. Then the parts themselves — which
  // chip is active, and adding or dropping one. Last everything that sets a
  // mark, with Continue pushed to the far end where the advancing action sits
  // in every other phase.
  strip?.stop();
  strip = renderStrip({
    duration: s.duration,
    segments: s.segments,
    active,
    head: () => player?.currentTime() ?? 0,
    onSeek: (t) => player?.seekTo(t),
  });

  return [
    el("div", { className: "bar-row" }, strip.el, marks),
    el("div", { className: "bar-row" }, toggle, toStart, toEnd, nudges),
    el("div", { className: "bar-row" }, chips, addPart, dropPart),
    el(
      "div",
      { className: "bar-row" },
      ...controls,
      ...stamp,
      el("div", { className: "bar-end" }, warn, go),
    ),
  ];
}

async function openWindow(): Promise<void> {
  const s = getState();
  await guard("Fetching clip…", async () => {
    const w = await api.fetchWindow(s.videoId, s.segments, s.duration);
    const source = { w: w.width, h: w.height };
    const saved = restore(s.videoId, source);
    setState({
      clipUrl: w.clipUrl,
      windowStart: w.windowStart,
      windowEnd: w.windowEnd,
      clipStart: w.clipStart,
      clipEnd: w.clipEnd,
      clipDigest: w.digest,
      source,
      layoutId: saved.layoutId ?? DEFAULT_LAYOUT_ID,
      boxes: saved.boxes ?? [],
      customs: saved.customs ?? [],
      phase: "framing",
    });
    save();
  });
}

/** The first stored mark that overlaps a reopened clip, clamped to it.
 *
 *  `null` when nothing usable overlaps — the marks belong to a different
 *  window of the same video, or they clip to less than the trim floor — and
 *  the caller then opens on the whole file, which is what a reopen always
 *  did. A stored range is only a starting point either way: the handles
 *  still reach the whole file, pad included.
 *
 *  First match rather than widest, and never `first.start` to `last.end`:
 *  the stored marks can be a multi-part set from an earlier session, and
 *  spanning them end to end would silently put the dropped middle back. */
function markedCut(segments: Segment[], from: number, to: number): Segment | null {
  for (const seg of segments) {
    const start = Math.max(seg.start, from);
    const end = Math.min(seg.end, to);
    if (end - start >= MIN_CLIP_S) return { start, end };
  }
  return null;
}

/** The idle screen's other way in: a clip already in `media/` goes straight
 *  to framing, with no network involved at all. Everything here is
 *  `openWindow`'s tail with the fetch removed — the fields line up because
 *  `/api/clips` answers the same shape `/api/window` does.
 *
 *  Two values a URL load reads off `/api/probe` are unavailable here, and
 *  neither is worth a yt-dlp round trip for a clip that is already on disk:
 *  the badge `title` falls back to the starter title last typed for this
 *  video (then the id), and `duration` becomes wide enough to show whatever
 *  `segments` ends up holding (see below). Both are cosmetic, with one
 *  exception — "Back to trim" then draws a strip that ends at `duration`
 *  rather than at the video — and that path re-fetches the window anyway, so
 *  nothing downstream of it inherits the approximation.
 *
 *  For a PLAIN clip (`c.digest === ""`) the marks cover the whole cached
 *  clip, PAD included: framing has no marking controls, so the alternative is
 *  handing the user a window whose edges they cannot reach, and a plain
 *  clip's window bounds really are source seconds.
 *
 *  A STITCH's window bounds are clip-timeline instead — `0` and the probed
 *  total, per docs/specs/2026-08-28-vstack-segments-design.md — with no
 *  relation to source time. Treating them as a segment the way a plain clip's
 *  bounds truthfully are would silently replace this video's real marks with
 *  clip-timeline garbage the instant it is reopened from the dropdown, and
 *  `save()` below would persist that garbage over marks a whole editing
 *  session made. `restore()`'s own `segments` — already checked against
 *  `isValidSegments` — is the one source-timeline answer available here, so a
 *  stitch prefers it. If nothing is stored either, there is no truthful
 *  answer at all: `segments` still needs *a* value (the invariant is "always
 *  at least one"), so it falls back to the same single-range shape a plain
 *  clip gets — but `persistSegments` keeps that fabrication out of
 *  localStorage rather than clobbering whatever a future save might have
 *  written for this video.
 *
 *  Synchronous, and deliberately not wrapped in `guard`: there is nothing to
 *  await, so there is no window in which a second click could land. */
function openClip(c: api.CachedClip): void {
  const source = { w: c.width, h: c.height };
  const saved = restore(c.videoId, source);
  const isStitch = c.digest !== "";
  // Stored marks are preferred for a PLAIN clip too, not just a stitch. They
  // used to be dropped here on the grounds that framing had no marking
  // controls, so the whole cached file — PAD and all — was the only window
  // whose edges a user could reach. The waveform handles ended that: the pad
  // is one drag away, and fabricating a range instead cost real work. The
  // fabrication went into `save()` a line below, overwriting the video's real
  // marks in localStorage, and into `clipStart`/`clipEnd` below that, so a
  // reopened clip exported PAD seconds wider at BOTH ends than the range that
  // was marked — silently, since every part of the bar agreed with itself.
  const storedSegments = saved.segments;
  const segments = storedSegments ?? [{ start: c.windowStart, end: c.windowEnd }];
  const duration = Math.max(c.windowEnd, ...segments.map((seg) => seg.end));
  // True whenever `segments` above is truthful: a plain clip's own bounds
  // really are source seconds, and stored marks are stored marks. False only
  // for a stitch with nothing stored, where the fallback is clip-timeline
  // garbage that must never reach localStorage.
  const persistSegments = !isStitch || storedSegments !== undefined;
  // Where the cut opens. `c.clipStart`/`c.clipEnd` span the whole cached
  // file; a stored mark that overlaps it is what the user actually chose.
  // Stitch excluded: its clip bounds are its own timeline, and a source-time
  // mark compared against them would be meaningless rather than merely wrong.
  const cut = isStitch ? null : markedCut(segments, c.clipStart, c.clipEnd);
  setState({
    videoId: c.videoId,
    title: savedTitle(c.videoId) || c.videoId,
    duration,
    segments,
    clipUrl: c.clipUrl,
    windowStart: c.windowStart,
    windowEnd: c.windowEnd,
    clipStart: cut?.start ?? c.clipStart,
    clipEnd: cut?.end ?? c.clipEnd,
    clipDigest: c.digest,
    source,
    layoutId: saved.layoutId ?? DEFAULT_LAYOUT_ID,
    boxes: saved.boxes ?? [],
    customs: saved.customs ?? [],
    error: "",
    phase: "framing",
  });
  if (persistSegments) save();
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
// The source overlay (crop rects over the <video>). Held as its whole handle
// rather than just its teardown because the output overlay's drag has to
// call `place()` on it: a resize there rewrites the piece's crop as well as
// its `out`, and this overlay's nodes are DOM — nothing else in that drag
// reaches them, so without the call the tinted crop box keeps its old size
// until the user next touches it and then jumps.
let sourceEditor: EditorHandle | null = null;
// The output overlay, mounted over canvasEl for the floating pieces' `out`
// rects — only present while s.customs.length > 0. Tracked separately from
// sourceEditor because the two overlays have different node counts and
// different geometry (output px vs source px) and are torn down
// independently: the source overlay always exists once framing starts, the
// output overlay only exists while there is at least one piece.
let outEditor: EditorHandle | null = null;

/** How many buckets the clip is reduced to. Fixed rather than matched to the
 *  canvas width so a resize redraws from the same envelope instead of
 *  re-decoding megabytes of audio; 900 is comfortably above any width this
 *  bar reaches, and `drawWave` samples down from it per pixel. */
const WAVE_BUCKETS = 900;

/** The framing trim's floor. `/api/export` rejects a window whose end is not
 *  after its start, so a handle dragged onto its neighbour would produce a
 *  400 rather than a short clip. One second is also the shortest trim worth
 *  making. */
const MIN_CLIP_S = 1;

/** Whether Play covers the marked cut only, rather than the whole fetched
 *  window. Module-scoped like `wavePeaks` below and for the same reason —
 *  this bar is rebuilt on every render, so a local would reset with it.
 *  Deliberately not in `AppState`: it names nothing the export carries, so
 *  `save()` would have nothing to store and `restore` nothing to validate. */
let playCutOnly = false;

/** Play/pause the framing clip. Shared by the bar's own button and the
 *  space-bar shortcut, because `playCutOnly` has to mean the same thing on
 *  both paths — a toggle one control honours and the other ignores reads as
 *  the checkbox being broken rather than as two controls.
 *
 *  Starting playback with the box ticked seeks into the cut whenever the
 *  playhead sits outside it, which covers the ordinary case of pressing Play
 *  again after the previous pass stopped on `clipEnd`. Live state, never a
 *  render's snapshot: every handle drag writes through `setQuiet`. */
function toggleClip(): void {
  const v = videoEl;
  if (v === null) return;
  if (!v.paused) {
    v.pause();
    return;
  }
  if (playCutOnly) {
    const s = getState();
    const from = s.clipStart - s.windowStart;
    if (v.currentTime < from || v.currentTime >= s.clipEnd - s.windowStart) v.currentTime = from;
  }
  void v.play();
}

/** The framing clip's peak envelope, and the clip URL it came from. Cached
 *  module-scoped for the same reason `framingFor` is: this bar is rebuilt on
 *  every render, and decoding per render would re-fetch and re-decode the
 *  same megabytes each time. */
let wavePeaks: Float32Array | null = null;
let waveFor = "";
/** Disconnected and replaced on every render — the bar is rebuilt each time,
 *  so an observer per built canvas would otherwise accumulate one per
 *  render for the life of the phase. */
let waveResize: ResizeObserver | null = null;

/** Decodes the local clip's audio into a peak envelope, then re-renders.
 *
 *  Through an 8 kHz *mono* OfflineAudioContext rather than a live
 *  AudioContext: `decodeAudioData` resamples to its context's own rate, so
 *  this bounds the decode at ~8000 floats per second of clip regardless of
 *  the source's 44.1 kHz stereo. A ten-minute clip costs ~19 MB of
 *  Float32Array instead of the ~230 MB a native-rate stereo decode would.
 *
 *  Every failure is swallowed and leaves the strip flat. A clip with no
 *  audio track is a real case this app already handles at export
 *  (`hasAudio`), and the waveform is a nicety: it must never block trimming,
 *  dragging or Export. */
async function loadWave(clipUrl: string): Promise<void> {
  if (waveFor === clipUrl) return;
  waveFor = clipUrl;
  wavePeaks = null;
  try {
    const res = await fetch(clipUrl);
    if (!res.ok) return;
    const bytes = await res.arrayBuffer();
    const Ctor = window.OfflineAudioContext ?? window.webkitOfflineAudioContext;
    if (!Ctor) return;
    // length 1: this context is never rendered, only used to decode.
    const decoded = await new Ctor(1, 1, 8000).decodeAudioData(bytes);
    // A clip that raced a phase change while decoding must not paint over
    // whatever is on screen now.
    if (waveFor !== clipUrl) return;
    wavePeaks = peaks(decoded.getChannelData(0), WAVE_BUCKETS);
  } catch {
    /* No audio track, an unsupported decode, a failed read: flat strip. */
    return;
  }
  render();
}

/** Paints the envelope as a centred amplitude band.
 *
 *  The accent is read off the element rather than hardcoded, so the strip
 *  follows the CMD+Shift+0 dark theme the way every other surface does —
 *  canvas cannot read a custom property any other way. */
function drawWave(canvas: HTMLCanvasElement): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext("2d");
  if (!g) return;
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const env = wavePeaks;
  if (!env || env.length === 0) return;
  g.fillStyle = getComputedStyle(canvas).getPropertyValue("--blue-8").trim() || "#0090ff";
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const b = Math.min(env.length - 1, Math.floor((x * env.length) / w));
    const amp = (env[b] ?? 0) * mid;
    // At least 1px tall, so silence reads as a centre line rather than a
    // hole in the strip.
    g.fillRect(x, mid - amp, 1, Math.max(1, amp * 2));
  }
}

/** The finished export, played from `/out/<name>`. Like the framing <video>
 *  it lives permanently in outSlot and is only ever hidden — see the
 *  module-level comment on the persistent shell. */
let outVideoEl: HTMLVideoElement | null = null;

/** Idempotent per URL. The URL carries the file's mtime, so a re-export
 *  under the same name is a genuinely different src and reloading is the
 *  point here — the opposite of ensureFraming, where reassigning the same
 *  src is the bug. */
function ensurePreview(url: string): void {
  if (!outVideoEl) {
    outVideoEl = el("video", { controls: true, loop: true, preload: "auto" });
    outSlot.append(outVideoEl);
  }
  const absolute = new URL(url, location.href).href;
  if (outVideoEl.src !== absolute) outVideoEl.src = absolute;
}
// mountEditor appends its own `.boxes` overlay directly into sourceSlot (see
// the comment on its host param) and, like the iframe/video/canvas above, is
// built once and torn down only on a genuine clip change — never on a phase
// change. render() must hide it explicitly when leaving framing, the same
// way it hides videoEl/canvasEl, or the overlay (positioned against a now-
// hidden, zero-size video) is left showing over the trimming view.
let boxesLayer: HTMLDivElement | null = null;
// Mirrors boxesLayer for the output overlay's `.boxes` layer. Reset to null
// (not just hidden) whenever the last piece is removed and outEditor.stop()
// tears the layer down — render() must not try to toggle `hidden` on a node
// that mountEditor's teardown already removed from the DOM.
let outBoxesLayer: HTMLDivElement | null = null;
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
  // The remount key carries the piece count alongside the layout id: both
  // overlays' node counts derive from it (source: cells.length +
  // customs.length, output: customs.length), so adding or removing a piece
  // must rebuild both the same way switching layouts does.
  const sameLayout = editorFor === `${layout.id}:${s.customs.length}`;
  if (sameClip && sameLayout) return;
  framingFor = s.clipUrl;
  editorFor = `${layout.id}:${s.customs.length}`;
  stopPreview?.();

  if (!videoEl) {
    videoEl = el("video", { controls: true, preload: "auto" });
    sourceSlot.append(videoEl);
  }
  // Only on a genuine clip change: assigning the same src reloads the
  // element and restarts playback, which a layout switch must not do.
  if (!sameClip) videoEl.src = s.clipUrl;
  // Fire-and-forget: the waveform is a nicety and must never gate the phase,
  // so this is deliberately not awaited and every failure inside it is
  // swallowed. `loadWave` no-ops when the clip URL has not changed, which is
  // what makes it safe on the layout-switch path — that path reaches here
  // with `sameClip` true and must not re-decode (nor, per the guard above,
  // reassign video.src).
  void loadWave(s.clipUrl);

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

  stopPreview = startPreview(canvasEl, videoEl, cells, currentBoxes, currentCustoms);

  const cellCount = cells.length;
  sourceEditor?.stop();
  sourceEditor = mountEditor({
    host: sourceSlot,
    media: videoEl,
    bounds: () => getState().source,
    count: cellCount + s.customs.length,
    boxes: () => [...currentBoxes(), ...currentCustoms().map((c) => c.crop)],
    move: (rect, dx, dy) => moveBy(rect, dx, dy, getState().source),
    resize: (rect, corner, dx, dy, index) => {
      const source = getState().source;
      // A piece's crop is locked to the piece's own ratio; a cell's to its
      // cell's. Same isValidBox on both sides, different ratio.
      const custom = currentCustoms()[index - cellCount];
      if (custom) {
        return resizeFromCorner(rect, corner, dx, dy, source, outRatio(custom.out));
      }
      const cell = cells[index];
      // pointerdown only sets a drag for an index that has both a node and a
      // box, and nodes are built from `cells`, so this is always present.
      if (!cell) return rect;
      return resizeFromCorner(rect, corner, dx, dy, source, ratioOf(cell));
    },
    // Dragging must not trigger a full re-render — that would rebuild the
    // video element mid-drag. The editor moves its own nodes and the rAF
    // loop reads the new rect; state is written without notifying.
    onChange: (index, rect) => {
      if (index < cellCount) {
        const next = [...currentBoxes()];
        next[index] = rect;
        setQuiet({ boxes: next });
        return;
      }
      const next = [...currentCustoms()];
      const cur = next[index - cellCount];
      if (!cur) return;
      next[index - cellCount] = { ...cur, crop: rect };
      setQuiet({ customs: next });
    },
    onCommit: () => save(),
  });
  boxesLayer = sourceSlot.querySelector<HTMLDivElement>(".boxes");

  outEditor?.stop();
  outEditor = null;
  outBoxesLayer = null;
  if (s.customs.length > 0) {
    outEditor = mountEditor({
      host: outSlot,
      media: canvasEl,
      // Output space: the canvas is 1080x1920 whatever size it renders at.
      bounds: () => OUTPUT,
      count: s.customs.length,
      labelFrom: cellCount,
      boxes: () => currentCustoms().map((c) => c.out),
      // GUTTER as the placement margin: a piece's ring is one gutter wide,
      // so bounding the drag by a gutter parks that ring exactly on the
      // frame's own white margin — one band, not two, and none of it off
      // the frame. A piece dragged into a corner then reads like a cell's
      // window, which is the same 10px inset at the same 24px radius.
      move: (rect, dx, dy) => moveOut(rect, dx, dy, GUTTER),
      resize: (rect, corner, dx, dy) => resizeOut(rect, corner, dx, dy, GUTTER),
      // One patch carrying both halves: the piece's crop is locked to the
      // piece's own ratio, so a resize that changes that ratio has to move
      // the crop in the same frame or the two disagree until the next drag.
      //
      // The rAF canvas picks the new crop up on its own — it re-reads state
      // every frame — but the source overlay is DOM and only moves when its
      // own place() runs, which nothing on this layer would otherwise reach.
      // Hence the explicit re-place: without it the tinted crop box keeps its
      // old width until the user touches it, then jumps.
      onChange: (index, out) => {
        const next = [...currentCustoms()];
        const cur = next[index];
        if (!cur) return;
        next[index] = { out, crop: resnapCrop(cur.crop, getState().source, out) };
        setQuiet({ customs: next });
        sourceEditor?.place();
      },
      onCommit: () => save(),
      onRemove: (index) => {
        // setState, not setQuiet: the node count changes, so both overlays
        // must be rebuilt — the same reason a layout switch notifies.
        setState({ customs: currentCustoms().filter((_, i) => i !== index) });
        save();
      },
    });
    outBoxesLayer = outSlot.querySelector<HTMLDivElement>(".boxes");
  }
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

/** The current floating pieces. Read fresh on every preview frame and every
 *  drag, like currentBoxes. No defaultBoxes-style fallback: an empty array
 *  is a valid steady state, since pieces are user-added rather than
 *  layout-implied — unlike boxes, which must match cells.length or index
 *  mismatches mid-switch. */
function currentCustoms(): CustomBox[] {
  return getState().customs;
}

/** Renders the clip and moves to the preview phase. The file lands in `out/`
 *  server-side, so there is no Blob, no object URL and no <a download> here
 *  any more — and no second copy of the filename either. The client used to
 *  rebuild the same slugify/mmss string purely to label a download, with a
 *  comment noting a mismatch between the two would be invisible; the server
 *  says it once now and this reads it. */
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
    const out = await api.exportClip({
      videoId: s.videoId,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      // Clip time, not the marks: a stitch's clip has its own timeline. For
      // a single segment these ARE the marks, so this request is unchanged.
      start: s.clipStart,
      end: s.clipEnd,
      digest: s.clipDigest,
      starterTitle,
      // Sent raw, blank included: the server resolves blank to `starterTitle`,
      // so the fallback is written once rather than on both sides of the wire.
      // Only the *shown* title is rendered to art and only it names the file.
      voiceTitle: s.voiceTitle.trim(),
      titlePng: await renderTitleArt(starterTitle),
      layoutId: layout.id,
      boxes,
      customs: s.customs,
      voice: currentVoice(s),
    });
    setState({
      phase: "preview",
      outName: out.name,
      outUrl: out.url,
      outSize: out.size,
      // Both defaults are `||`-guarded so a re-export after a crop fix keeps
      // whatever was already typed — retyping the metadata is exactly the
      // work this phase exists to remove.
      ytTitle: getState().ytTitle || defaultTitle(starterTitle),
      ytDescription: getState().ytDescription || DESCRIPTION_TEMPLATE,
      ytTags: getState().ytTags || TAGS_DEFAULT,
      // A fresh file has not been published, whatever the last one did, and
      // its thumbnail state belongs to that upload rather than this file.
      ytVideoId: "",
      ytThumbnail: false,
    });
  });
}

/** Uploads the finished short as a private draft and remembers its id.
 *
 *  The percentage comes from polling rather than from this request, which
 *  reports nothing until it finishes. Each tick is a notifying setState, so
 *  the preview bar is rebuilt twice a second — safe only because every field
 *  in it is disabled while `busy`, so there is no caret to lose. */
async function doPublish(): Promise<void> {
  const s = getState();
  const title = s.ytTitle.trim();
  if (title === "" || s.outName === "") return;
  await guard("Publishing… 0%", async () => {
    const poll = window.setInterval(() => {
      void api
        .publishProgress()
        .then(({ sent, total }) => {
          // A poll already in flight can land after guard's own finally has
          // cleared `busy` — checking it here stops a late tick from
          // resurrecting a bar that has already moved on.
          if (total > 0 && getState().busy !== "") {
            setState({ busy: `Publishing… ${Math.round((sent / total) * 100)}%` });
          }
        })
        // A dropped poll is not worth replacing the upload's own error with.
        .catch(() => undefined);
    }, 500);
    try {
      const { videoId, thumbnail } = await api.publish({
        name: s.outName,
        title,
        description: s.ytDescription,
        tags: s.ytTags,
      });
      setState({ ytVideoId: videoId, ytThumbnail: thumbnail });
      bell();
    } finally {
      // Must run before guard's own finally clears `busy`, or the next tick
      // would set it straight back and strand the bar as busy forever.
      clearInterval(poll);
    }
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
      // Pieces are NOT cleared: a floating box's ratio is its own and its
      // out rect is frame space, so nothing about it is invalidated by the
      // cells changing.
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

  // Playback transport for the fetched clip. The <video> carries `controls`,
  // but the crop overlay is painted over its whole rect and `.boxes > .box`
  // takes pointer events — so a box across the bottom of the frame swallows
  // every hover and click the native control bar needs, and it may as well
  // not be there. Same answer as the trimming phase's transport: the two
  // controls worth having live in the bar, where nothing covers them.
  const ready = videoEl !== null;
  const play = el("button", {
    className: "btn-gray",
    textContent: "Play",
    title: "Play or pause the clip",
    disabled: !ready,
  });
  // Stacked under Play rather than set beside it: the two are one control —
  // play, and how much of it — and a column keeps the waveform on this row
  // instead of pushing it onto a row of its own.
  const cutOnly = el("input", { type: "checkbox", checked: playCutOnly, disabled: !ready });
  cutOnly.onchange = () => {
    playCutOnly = cutOnly.checked;
  };
  const transport = el(
    "div",
    { className: "transport" },
    play,
    el(
      "label",
      { className: "check", title: "Play the marked range only, and stop at its end" },
      cutOnly,
      el("span", { textContent: "Cut only" }),
    ),
  );

  // The clip's own strip: waveform, the kept range's handles, the playhead,
  // and click-to-seek. `s.clipStart`/`s.clipEnd` are in the same coordinate
  // system as `s.windowStart`/`s.windowEnd` — source seconds for a single
  // range, the stitch's own timeline for a stitch — while the <video>'s
  // currentTime is 0-based clip-file time. `span` converts between them.
  const span = Math.max(1e-6, s.windowEnd - s.windowStart);
  const pctOf = (sourceT: number) => `${(100 * (sourceT - s.windowStart)) / span}%`;

  const wave = el("div", { className: "wave" });
  const canvas = el("canvas");
  const cutL = el("div", { className: "wave-cut" });
  const cutR = el("div", { className: "wave-cut" });
  const handleL = el("div", { className: "wave-handle", title: "Drag to move the cut's start" });
  const handleR = el("div", { className: "wave-handle", title: "Drag to move the cut's end" });
  const head = el("div", { className: "strip-head" });
  wave.append(canvas, cutL, cutR, handleL, handleR, head);

  /** Repositions everything the drag moves. Called directly rather than
   *  through a render because the drag writes with `setQuiet`, which by
   *  design reaches no render — the same reason the output overlay has to
   *  call the source overlay's `place()` by hand. */
  const place = () => {
    const cur = getState();
    cutL.style.left = "0";
    cutL.style.width = pctOf(cur.clipStart);
    cutR.style.left = pctOf(cur.clipEnd);
    cutR.style.right = "0";
    handleL.style.left = pctOf(cur.clipStart);
    handleR.style.left = pctOf(cur.clipEnd);
  };
  place();

  if (videoEl) {
    const v = videoEl;
    // Event *properties*, not addEventListener: this bar is rebuilt on every
    // render while the <video> outlives all of them, so listeners would
    // stack one per render.
    v.onplay = v.onpause = () => {
      play.textContent = v.paused ? "Play" : "Pause";
    };
    // ontimeupdate rather than a rAF loop: it fires ~4Hz, which is enough
    // for a playhead on a strip this wide, and it needs no teardown when the
    // phase changes — the trimming strip's rAF loop needs two stop sites
    // precisely because it has no such owner.
    v.ontimeupdate = () => {
      head.style.left = `${(100 * v.currentTime) / span}%`;
      // The stop half of the cut-only toggle. ~4Hz can overshoot `clipEnd`
      // by up to a quarter second before the pause lands, which is cheaper
      // than a rAF loop and its two teardown sites for a difference nobody
      // reviewing a cut can see. Live state: a handle drag moves `clipEnd`
      // through `setQuiet`, so this render's snapshot would go on stopping
      // at the mark the user just dragged away from.
      if (playCutOnly && !v.paused && v.currentTime >= getState().clipEnd - s.windowStart) {
        v.pause();
      }
    };
    // The element may already be playing by the time a re-render builds
    // these: neither event fires again.
    play.textContent = v.paused ? "Play" : "Pause";
    head.style.left = `${(100 * v.currentTime) / span}%`;
    play.onclick = toggleClip;
    // Click-to-seek on the strip body, matching the trimming strip. Handles
    // stop their own clicks below, so a drag never also seeks.
    wave.onclick = (e) => {
      const box = wave.getBoundingClientRect();
      const frac = (e.clientX - box.left) / Math.max(1, box.width);
      v.currentTime = Math.min(span, Math.max(0, frac * span));
    };
  }

  /** One handle's drag. Clamped to the fetched window on the outside and to
   *  its neighbour (less `MIN_CLIP_S`) on the inside — this is what replaces
   *  the "marking is confined to trimming" argument the old comment below
   *  used to make. */
  const dragHandle = (which: "start" | "end") => (down: PointerEvent) => {
    down.preventDefault();
    down.stopPropagation();
    const box = wave.getBoundingClientRect();
    const target = down.target as HTMLElement;
    target.setPointerCapture(down.pointerId);
    const at = (e: PointerEvent) =>
      s.windowStart + (span * (e.clientX - box.left)) / Math.max(1, box.width);
    const move = (e: PointerEvent) => {
      const cur = getState();
      const t = Math.min(s.windowEnd, Math.max(s.windowStart, at(e)));
      if (which === "start") {
        setQuiet({ clipStart: Math.min(t, cur.clipEnd - MIN_CLIP_S) });
      } else {
        setQuiet({ clipEnd: Math.max(t, cur.clipStart + MIN_CLIP_S) });
      }
      place();
    };
    const up = (e: PointerEvent) => {
      target.releasePointerCapture(down.pointerId);
      target.onpointermove = null;
      target.onpointerup = null;
      const cur = getState();
      // A click rather than a drag — measured against where the pointer went
      // down, since a press always emits a pointermove or two of jitter and a
      // `moved` flag set from that would call every click a drag. Aim the
      // playhead at the mark that was clicked: checking a cut means looking
      // at the frame it lands on, and the handle is the thing you point at to
      // say which end. A real drag deliberately does not seek — it ends
      // wherever the pointer stopped, and yanking playback there on every
      // adjustment is the behaviour the stopPropagation below was added for.
      if (videoEl !== null && Math.abs(e.clientX - down.clientX) <= 2) {
        const mark = which === "start" ? cur.clipStart : cur.clipEnd;
        videoEl.currentTime = Math.min(span, Math.max(0, mark - s.windowStart));
      }
      // One notifying update at the end, so the kept-duration badge, the
      // over-length warning and Export's gate all catch up in a single
      // render rather than one per pointermove.
      setState({ clipStart: cur.clipStart, clipEnd: cur.clipEnd });
    };
    target.onpointermove = move;
    target.onpointerup = up;
  };
  handleL.onpointerdown = dragHandle("start");
  handleR.onpointerdown = dragHandle("end");
  // Without this a click that ends on a handle bubbles to the strip and
  // seeks the video to wherever the drag finished.
  handleL.onclick = handleR.onclick = (e) => e.stopPropagation();

  // One observer, replaced per render: the canvas is a new node each time,
  // and an observer per built canvas would accumulate for the life of the
  // phase.
  waveResize?.disconnect();
  waveResize = new ResizeObserver(() => drawWave(canvas));
  waveResize.observe(wave);

  const addBox = el("button", {
    textContent: "+ Box",
    title: "Add a box that floats over the layout",
    disabled: Boolean(s.busy) || s.customs.length >= MAX_CUSTOM,
  });
  addBox.onclick = () => {
    // Live state, never `s`: `s` is this render's snapshot, and every drag
    // writes through setQuiet, which by design reaches no render. Building
    // the new array from `s.customs` would replace the key wholesale with a
    // stale array — reverting the previous piece to its as-added rect, its
    // re-snapped crop with it, and persisting the revert on the next line.
    // Same reason onRemove reads currentCustoms().
    //
    // setState: the node count changes, so ensureFraming must rebuild both
    // overlays on the next render. The button's own `disabled` can still be
    // read off `s` — both `busy` and the MAX_CUSTOM cap only move via
    // setState, which re-renders this bar.
    const cur = getState();
    setState({ customs: [...cur.customs, defaultCustom(cur.source, cur.customs.length)] });
    save();
  };

  // The starter screen's title, and the gate on Export: the screen reads it
  // aloud, so a blank one is a silent screen rather than a missing caption.
  const title = el("input", {
    type: "text",
    placeholder: "Starter screen title (required)",
    title: "Shown on the starter screen, names the file, prefills the upload",
    ariaLabel: "Starter screen title",
    // Grows to fill its row instead of carrying a `size`: it is the thing
    // Export is gated on, so it gets the space. It shares the row with the
    // voice field, which grows from the same basis — an even split.
    className: "field-grow",
    value: s.starterTitle,
    disabled: Boolean(s.busy),
  });

  // What gets *said*, when that should differ from what is shown. Optional and
  // deliberately gates nothing: blank falls back to the title above, resolved
  // server-side. A title written for the eye — numbers, emoji, punctuation —
  // reads badly aloud, and this is the escape hatch for that without changing
  // the screen.
  const voiceTitle = el("input", {
    type: "text",
    placeholder: "Spoken instead (optional)",
    title: "Read aloud in place of the title. Blank reads the title itself.",
    ariaLabel: "Spoken title",
    className: "field-grow",
    value: s.voiceTitle,
    disabled: Boolean(s.busy),
  });
  // Quiet for the same reason the title field is — a notifying update per
  // keystroke rebuilds this input and drops the caret. Nothing is gated on
  // this value, so unlike the title's handler there is no button to flip.
  voiceTitle.oninput = () => setQuiet({ voiceTitle: voiceTitle.value });
  voiceTitle.onblur = () => save();
  // No window check here, but the reason has changed: this phase CAN now
  // move clipStart/clipEnd, so "marking is confined to trimming" no longer
  // holds. What holds instead is that the only thing that moves them is
  // `dragHandle` above, which clamps to [windowStart, windowEnd] on the
  // outside and to its neighbour less MIN_CLIP_S on the inside — so the
  // pair cannot leave the fetched window or invert. `/api/window` reported
  // that window as containing the marks by construction (windowStart =
  // max(0, floor(start − PAD)) for a single range; 0 and the probed
  // duration for a stitch), and the server re-validates the pair regardless.
  const exportable = (text: string) => keptLength(s) > 0 && text.trim() !== "" && !s.busy;

  const long = keptLength(s) > SHORTS_MAX_S;
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
  const tryVoice = renderTryVoice(s, title, voiceTitle);
  title.oninput = () => {
    setQuiet({ starterTitle: title.value });
    download.disabled = !exportable(title.value);
    // Same in-place flip, same reason — Try reads the title aloud too, so a
    // blank one leaves it with nothing to say.
    tryVoice.disabled = title.value.trim() === "";
  };
  // On blur rather than per keystroke: the value is settled by then, and
  // save() notifies nothing, so the caret is safe either way.
  title.onblur = () => save();

  // Three rows, split by what each one is for: pick the shape and read the
  // facts about the clip, drive the clip, then name it and ship it. One row
  // put the required title field between the layout swatches and two
  // read-only badges, which is the least prominent spot on the bar for the
  // control that gates Export.
  return [
    el(
      "div",
      { className: "bar-row" },
      renderLayoutPicker(s.layoutId, Boolean(s.busy)),
      addBox,
      el(
        "div",
        { className: "bar-end" },
        el("span", {
          className: "badge",
          // The CUT, never `firstMark`/`lastMark`. Those are the trimming
          // phase's marks, and a framing trim moves `clipStart`/`clipEnd`
          // without touching them — so this badge went on naming the
          // untrimmed span while `doExport` sent the trimmed one and
          // `outName` put the trimmed one in the filename. The bar claimed
          // one range and the file on disk was another, which is exactly the
          // preview/export divergence this codebase treats as the cardinal
          // failure, showing up in prose instead of in pixels.
          //
          // Single range only: `clipStart`/`clipEnd` are source seconds
          // there, so a clock reading means something. A stitch's are its own
          // timeline, where an absolute time would be a lie — that branch
          // shows a *length* instead, and `keptLength` is already the cut's.
          textContent:
            s.segments.length === 1
              ? `${clock(s.clipStart)} → ${clock(s.clipEnd)}`
              : `${s.segments.length} parts · ${clock(keptLength(s))}`,
        }),
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
      ),
    ),
    el("div", { className: "bar-row" }, transport, wave),
    el(
      "div",
      { className: "bar-row" },
      title,
      voiceTitle,
      renderVoicePicker(s),
      tryVoice,
      // Re-fetch first: it is the odd one out, a utility rather than a step,
      // so it sits furthest from the action that ends the phase.
      el("div", { className: "bar-end" }, refetch, back, download),
    ),
  ];
}

/** The speech presets, fetched once at startup.
 *
 *  The dropdown is built from this, and an empty `state.voice` resolves
 *  against `voiceDefault` — so the default voice's *name* lives on the server
 *  alone and the two sides cannot drift. Fire-and-forget: `framing` is a URL
 *  paste, a trim and a download away, which is many seconds, and a failed
 *  fetch just leaves the dropdown holding whatever was already persisted.
 *
 *  ponytail: no retry and no error surface. A voice list that failed to load
 *  shows one option and Export still works on the server's default. Add a
 *  retry the day the fetch is flaky, which on loopback is never. */
let voiceList: api.Voice[] = [];
let voiceDefault = "";

void api
  .voices()
  .then((r) => {
    voiceList = r.voices;
    voiceDefault = r.default;
    // The dropdown may already be on screen showing a lone fallback option.
    render();
  })
  .catch(() => {
    /* Export falls back to the server's own default. */
  });

/** What `doExport` sends and the dropdown shows as selected. */
const currentVoice = (s: AppState): string => s.voice || voiceDefault;

/** North-to-south, which is also how the engine's own labels read. A region
 *  the table grows later still renders — it lands in the trailing group. */
const REGIONS = ["B\u1eafc", "Trung", "Nam"];

/** "Ph\u1ecfng c\u00e1ch tin t\u1ee9c" -> "tin t\u1ee9c": the prefix is on every
 *  row, so it is pure noise inside a dropdown of nothing but styles. */
const styleOf = (v: api.Voice) =>
  v.style.replace(/^(Phong c\u00e1ch|Gi\u1ecdng \u0111\u1ecdc)\s+/u, "");

/** The voice picker. Grouped by accent because that is the choice a viewer
 *  actually hears first; gender and delivery ride along in each label. */
function renderVoicePicker(s: AppState): HTMLSelectElement {
  const chosen = currentVoice(s);
  const select = el("select", {
    title: "Which voice reads the starter title",
    ariaLabel: "Starter screen voice",
    disabled: Boolean(s.busy),
  });
  // Before the list lands (or if it never does) the select still has to show
  // the voice that will actually be used, or it reads as "no voice picked".
  const groups = voiceList.length > 0 ? voiceList : [];
  if (groups.length === 0 && chosen !== "") {
    select.append(el("option", { value: chosen, textContent: chosen, selected: true }));
  }
  const seen = new Set<string>();
  for (const region of [...REGIONS, ...groups.map((v) => v.region)]) {
    if (seen.has(region)) continue;
    seen.add(region);
    const mine = groups.filter((v) => v.region === region);
    if (mine.length === 0) continue;
    const group = el("optgroup", { label: region });
    for (const v of mine) {
      group.append(
        el("option", {
          value: v.name,
          textContent: `${v.name} \u2014 ${v.gender === "female" ? "N\u1ef1" : "Nam"} \u00b7 ${styleOf(v)}`,
          selected: v.name === chosen,
        }),
      );
    }
    select.append(group);
  }
  // Quiet, like the title field beside it: nothing in this bar is gated on
  // the voice, so a render would only risk disturbing playback. save() on
  // change rather than blur — a <select> commits in one gesture.
  select.onchange = () => {
    setQuiet({ voice: select.value });
    // saveVoice, not save(): the voice is keyed globally, so it survives into
    // the next video rather than into the next visit to this one.
    saveVoice(select.value);
  };
  return select;
}

/** The last sample's object URL, revoked before the next one replaces it.
 *  Module-level rather than per-click because a click that lands while the
 *  previous sample is still playing has to be able to reach it. */
let sampleUrl = "";

/** Plays the real title in the selected voice, without an export.
 *
 *  Its own in-place busy state rather than `guard`'s: a global `busy` would
 *  re-render the bar — rebuilding the very input the user is iterating on —
 *  and disable Export and the transport for the four seconds the model takes
 *  to load. Auditioning a voice is not a phase-advancing action.
 *
 *  ponytail: no client-side cache, so re-trying the same title and voice pays
 *  the ~4.6s again. Add one keyed on `title + voice` the day that grates. */
function renderTryVoice(
  s: AppState,
  titleField: HTMLInputElement,
  voiceField: HTMLInputElement,
): HTMLButtonElement {
  const button = el("button", {
    textContent: "▶ Try",
    title: "Hear the title in this voice",
    // Same gate as Export, minus the marks: with no title there is nothing to
    // read aloud. Flipped in place by the title field's own handler, because
    // a quiet keystroke reaches no render.
    disabled: titleField.value.trim() === "" || Boolean(s.busy),
  });
  button.onclick = () => {
    const title = titleField.value.trim();
    if (title === "") return;
    button.disabled = true;
    button.textContent = "…";
    void api
      .say({
        starterTitle: title,
        // Read off the live field rather than state for the same reason the
        // title is: both are written with setQuiet, so `s` is stale by a
        // keystroke. The server applies the same blank-means-the-title
        // fallback the export does, so Try hears exactly what an export says.
        voiceTitle: voiceField.value.trim(),
        voice: currentVoice(getState()),
      })
      .then((wav) => {
        // The previous sample's URL leaks otherwise: an object URL is held by
        // the document until it is revoked, not until the Audio is collected.
        if (sampleUrl !== "") URL.revokeObjectURL(sampleUrl);
        sampleUrl = URL.createObjectURL(wav);
        return new Audio(sampleUrl).play();
      })
      .catch((err: unknown) => setState({ error: String(err) }))
      .finally(() => {
        button.disabled = titleField.value.trim() === "";
        button.textContent = "▶ Try";
      });
  };
  return button;
}

/** The preview bar: what came out, publishing it, and the ways out of here. */
/** The Publish button is rendered into the bar, but the title that gates it
 *  is rendered into the left panel — two functions, one render pass. A quiet
 *  keystroke reaches no render, so the panel flips the button in place, and
 *  this is how it reaches it. Both are rebuilt in the same render() call, so
 *  this is never stale by the time a keystroke can fire. */
let publishBtn: HTMLButtonElement | null = null;

/** The left column during `preview`: everything about the upload that is
 *  editable. It moved out of the bar because a description is the one field
 *  here worth more than one line, and the source <video> it replaces was
 *  showing a clip the user had already finished with. */
function renderPublishForm(): Node[] {
  const s = getState();
  // Publishing locks the form, and so does a completed publish: the fields
  // stop describing anything editable once the video is on YouTube.
  const locked = Boolean(s.busy) || s.ytVideoId !== "";

  const count = el("span", { className: "field-count" });
  const showCount = (text: string) => {
    count.textContent = `${text.length}/${YT_TITLE_MAX}`;
    // `defaultTitle` already spends 42 of those characters on hashtags, so
    // the ceiling is reachable by typing an ordinary Vietnamese title.
    count.classList.toggle("field-count-full", text.length >= YT_TITLE_MAX);
  };

  const title = el("input", {
    type: "text",
    placeholder: "Required",
    maxLength: YT_TITLE_MAX,
    value: s.ytTitle,
    disabled: locked,
  });
  showCount(s.ytTitle);

  const description = el("textarea", {
    placeholder: "Shown under the video on YouTube",
    rows: 10,
    value: s.ytDescription,
    disabled: locked,
  });

  const tags = el("input", {
    type: "text",
    placeholder: "comma, separated",
    value: s.ytTags,
    disabled: locked,
  });

  // Quiet, like every other text field in this app: a notifying update per
  // keystroke would rebuild the very input being typed into and drop the
  // caret — and during a publish this panel is re-rendered twice a second by
  // the progress poll, which makes that a certainty rather than a risk.
  title.oninput = () => {
    setQuiet({ ytTitle: title.value });
    showCount(title.value);
    if (publishBtn) publishBtn.disabled = title.value.trim() === "" || Boolean(getState().busy);
  };
  description.oninput = () => setQuiet({ ytDescription: description.value });
  tags.oninput = () => setQuiet({ ytTags: tags.value });

  const field = (label: string, control: Node, extra?: Node) =>
    el(
      "label",
      { className: "field" },
      el("span", { className: "field-label" }, label, extra ?? el("span")),
      control,
    );

  return [
    el("h2", { className: "publish-heading", textContent: "Publish details" }),
    field("Title", title, count),
    field("Description", description),
    field("Tags", tags),
  ];
}

function renderPreview(): Node[] {
  const s = getState();
  // Called for its effect: it mounts the output <video> into the persistent
  // outSlot and points it at this export.
  ensurePreview(s.outUrl);

  const finder = el("button", { textContent: "Show in Finder" });
  // Not wrapped in guard(): revealing a file is not a phase-blocking action,
  // and flipping `busy` for it would disable the whole bar for a blink. A
  // failure still surfaces the same way everything else does.
  finder.onclick = () => {
    void api
      .reveal(s.outName)
      // guard() is what normally clears `error`, and this deliberately skips
      // guard (see above) — so a success here has to clear it itself, or a
      // stale callout from an earlier failure sits next to a Finder window
      // that just opened fine.
      .then(() => setState({ error: "" }))
      .catch((err: unknown) => {
        setState({ error: err instanceof Error ? err.message : String(err) });
      });
  };

  const back = el("button", { className: "btn-gray", textContent: "Frame again" });
  // Boxes, layout and marks are all untouched, so this lands back on the
  // same framing the export came from — a bad crop is one click from a
  // re-render.
  back.onclick = () => setState({ phase: "framing" });

  const published = s.ytVideoId !== "";

  const publish = el("button", {
    className: "btn-solid",
    textContent: "Publish (private)",
    disabled: s.ytTitle.trim() === "" || Boolean(s.busy),
  });
  publish.onclick = () => void doPublish();
  // Handed to the panel, which owns the title this is gated on.
  publishBtn = publish;

  // Sits beside Studio rather than inside it: pasting the link into a chat
  // is the next thing after an upload, and the only other way to get it is
  // to open the video and copy the address bar. `/shorts/` and not
  // `youtu.be/` because everything this tool makes is a Short, and that URL
  // is what opens the Shorts player rather than the desktop one.
  const copy = el("button", { textContent: "Copy link" });
  // The label is the whole feedback channel — a clipboard write is invisible
  // otherwise, and a callout for something this small reads as an error.
  const flash = (text: string) => {
    copy.textContent = text;
    setTimeout(() => (copy.textContent = "Copy link"), 1200);
  };
  copy.onclick = () => {
    void navigator.clipboard
      .writeText(`https://www.youtube.com/shorts/${s.ytVideoId}`)
      .then(() => flash("Copied"))
      .catch(() => flash("Copy failed"));
  };

  // Replaces Publish once the upload lands: the next step is on YouTube, and
  // uploading the same file twice is never what was meant.
  const studio = el("a", {
    className: "btn-link",
    href: `https://studio.youtube.com/video/${s.ytVideoId}/edit`,
    target: "_blank",
    rel: "noreferrer",
    textContent: "Open in YouTube Studio →",
  });

  return [
    el(
      "div",
      { className: "bar-row" },
      el("span", { className: "badge badge-title", textContent: s.outName }),
      el("span", {
        className: "badge",
        textContent: `${(s.outSize / 1e6).toFixed(1)} MB`,
      }),
      published
        ? el("span", { className: "badge badge-info", textContent: "uploaded — private" })
        : el("span"),
      // Only worth saying when it did NOT take: a set thumbnail is the
      // expected outcome and needs no badge, but a skipped one is something
      // to fix by hand in Studio, and silence would hide it.
      published && !s.ytThumbnail
        ? el("span", {
            className: "badge badge-warn",
            title: "Custom thumbnails need a phone-verified channel",
            textContent: "thumbnail skipped",
          })
        : el("span"),
      // One row: the fields moved to the left panel, so what is left is the
      // facts about the file and the three things you can do with it. Order
      // mirrors the framing bar — utility, then step back, then the action
      // that ends the phase.
      el(
        "div",
        { className: "bar-end" },
        finder,
        back,
        ...(published ? [copy, studio] : [publish]),
      ),
    ),
  ];
}

/** Everything already in the media cache, for the idle screen's dropdown.
 *  Same shape as `voiceList` above and fetched the same way: once at boot,
 *  then a `render()` so a list that lands after the first paint still shows.
 *
 *  ponytail: never refetched, so a clip downloaded during this session is
 *  absent from the dropdown until a reload. Nothing is lost — by then that
 *  very clip is the one on screen in framing, and `idle` is not reachable
 *  again without one. Refetch the day it is. */
let clipList: api.CachedClip[] = [];

void api
  .clips()
  .then((clips) => {
    clipList = clips;
    render();
  })
  .catch(() => {
    /* The URL field is the way in that always works; a missing dropdown of
       cached clips is not worth an error banner over. */
  });

/** `Bí mật của Linh · 00:12:42–00:13:09 · 1920×1080`. The cache knows only an
 *  id and a pair of bounds, so the name comes from the starter title last
 *  typed for this video — the id is the fallback, not the label. */
const clipLabel = (c: api.CachedClip) =>
  `${savedTitle(c.videoId) || c.videoId} · ${clock(c.windowStart)}\u2013${clock(c.windowEnd)}` +
  ` · ${c.width}\u00d7${c.height}`;

/** The cached-clip picker. Opens on `change` with no confirming button
 *  beside it: unlike the URL field there is nothing to type, so the choice
 *  *is* the action. */
function renderClipPicker(s: AppState): HTMLSelectElement {
  const select = el("select", {
    title: "Open a clip already fetched into media/ — no download, straight to framing",
    ariaLabel: "Open a fetched clip",
    disabled: s.busy !== "",
  });
  // The first row is the label: this control sits next to a URL field, and an
  // unlabelled select showing a clip nobody picked reads as a loaded video.
  select.append(
    el("option", {
      value: "",
      textContent: `Open a fetched clip\u2026 (${clipList.length})`,
      selected: true,
    }),
  );
  // Index-valued rather than name-valued: the value's only consumer is the
  // array it came from, so there is no reason to rebuild a clip's identity
  // out of a DOM string.
  clipList.forEach((c, i) => {
    select.append(el("option", { value: String(i), textContent: clipLabel(c) }));
  });
  select.onchange = () => {
    // Guarded on the string, not the parsed index — `Number("")` is 0, so the
    // placeholder row would otherwise open the first clip.
    if (select.value === "") return;
    const clip = clipList[Number(select.value)];
    if (clip) openClip(clip);
  };
  return select;
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
  // Two ways in, one row each: paste a URL, or reopen something already
  // fetched. The second row is omitted entirely when the cache is empty —
  // which is also what a failed /api/clips looks like.
  const rows: Node[] = [el("div", { className: "bar-row" }, input, go)];
  if (clipList.length > 0) {
    rows.push(el("div", { className: "bar-row" }, renderClipPicker(s)));
  }
  return rows;
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
  // The strip's rAF loop outlives renderTrimming's own return: nothing else
  // calls renderTrimming once the phase moves on (Continue -> framing, and
  // every phase after), so the strip-side `strip?.stop()` before a rebuild
  // never runs again and the loop would otherwise keep polling the still-
  // mounted YouTube iframe's currentTime and writing to a detached node
  // forever. Stopped and cleared here, the same way boxesLayer/outBoxesLayer
  // are handled by phase below, rather than left to whatever the next visit
  // to trimming happens to do.
  if (s.phase !== "trimming" && strip) {
    strip.stop();
    strip = null;
  }
  // Same reasoning as sourceIframe above, but a <video> tolerates
  // detach/reattach fine — it just has no reason to move once it lives in
  // the persistent sourceSlot.
  if (videoEl) {
    videoEl.hidden = s.phase !== "framing";
    // `display:none` doesn't pause anything (see sourceIframe above), so
    // whatever is being hidden is paused explicitly. Preview used to keep
    // this visible for comparison; the left column belongs to publishForm
    // now, and this clip is one the user has already finished with.
    if (s.phase !== "framing") videoEl.pause();
  }
  if (canvasEl) canvasEl.hidden = s.phase !== "framing";
  if (outVideoEl) {
    outVideoEl.hidden = s.phase !== "preview";
    if (s.phase !== "preview") outVideoEl.pause();
  }
  // The crop-box overlay is positioned against videoEl and, like it, is
  // built once and never torn down on a phase change (see the comment by
  // its declaration) — only hidden, so "Back to trim" doesn't leave it
  // showing over the trimming view, and returning to framing gets it back
  // without losing drag state or its ResizeObserver.
  if (boxesLayer) boxesLayer.hidden = s.phase !== "framing";
  // Mirrors boxesLayer above for the output overlay's own `.boxes` layer —
  // hidden, never removed, while it exists. When the last piece is removed
  // ensureFraming tears the layer down itself and resets this to null, so
  // there is nothing here to toggle until a piece exists again.
  if (outBoxesLayer) outBoxesLayer.hidden = s.phase !== "framing";

  publishForm.hidden = s.phase !== "preview";

  if (s.phase === "idle") barSlot.replaceChildren(...renderIdle(s));
  else if (s.phase === "trimming") barSlot.replaceChildren(...renderTrimming());
  else if (s.phase === "framing") barSlot.replaceChildren(...renderFraming());
  else {
    // Bar first: it assigns publishBtn, which the panel's title handler flips
    // in place on a quiet keystroke.
    barSlot.replaceChildren(...renderPreview());
    publishForm.replaceChildren(...renderPublishForm());
  }

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

/** Rings when a step lands, so a phase advance is noticeable while looking
 *  elsewhere — trimming to framing, framing to preview, and the export that
 *  gets you there.
 *
 *  The starter screen's own title sound, deliberately: the app and the video
 *  say the same thing the same way. It is a 3s file with about a second of
 *  audible decay, so it reads as a chime rather than a clip.
 *
 *  A fresh Audio per ring rather than one reused element — replaying a shared
 *  one means resetting currentTime and racing an in-flight play(). Every ring
 *  here follows a click, so autoplay policy is satisfied, but play() still
 *  returns a promise that rejects when it is not, and an unhandled rejection
 *  must not be the cost of a sound effect. */
function bell(): void {
  try {
    const audio = new Audio(titleSound);
    // The file peaks at -6 dB, which is mixed for a video rather than for a
    // UI chime sitting under someone's headphones.
    audio.volume = 0.5;
    // Both guards are needed: play() rejects asynchronously, and the
    // constructor itself can throw where audio is unavailable. A missing
    // bell must never break the phase advance that triggered it.
    void audio.play().catch(() => undefined);
  } catch {
    /* no audio device, or the browser refused it */
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

// Before the first render, so the dropdown opens on the voice you last
// picked rather than flashing the server's fallback. Quiet because `render()`
// is on the next line anyway.
setQuiet({ voice: savedVoice() });

subscribe(render);
render();

// Dark theme. No control in the bar on purpose — a personal tool can afford
// a keystroke instead of a switch. `.dark` on <html> is the class Radix's
// dark scales key on (see `style.css`), and putting it on the root element
// is also what makes `color-scheme: dark` reach the native scrollbars and
// form controls.
//
// ponytail: window keydown only, so the shortcut is deaf while the YouTube
// iframe holds focus — the same capture problem the NUDGES buttons exist to
// work around. Click anywhere in the page first; a real fix means polling
// document.activeElement, which is not worth it for a theme toggle.
const THEME_KEY = "vstack:theme";
document.documentElement.classList.toggle(
  "dark",
  localStorage.getItem(THEME_KEY) === "dark",
);
window.addEventListener("keydown", (e) => {
  // `e.code`, not `e.key`: with Shift held, the 0 key reports ")" on a US
  // layout and something else again elsewhere, while the physical key stays
  // Digit0. CMD+Shift+0 itself is free in Chrome and Safari — CMD+0 alone
  // is "reset zoom", and adding Shift is unbound.
  if (!e.metaKey || !e.shiftKey || e.code !== "Digit0") return;
  e.preventDefault();
  const dark = document.documentElement.classList.toggle("dark");
  localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
});

// Space toggles playback in whichever phase owns a medium — the YouTube
// iframe while trimming, the fetched clip while framing, the finished file
// in preview. Idle owns none, so it is a no-op there.
//
// No label to keep in step: the framing bar's Play/Pause follows `onplay`/
// `onpause` on the live <video>, and the trimming bar's follows YouTube's
// `onStateChange` through `syncTransport`. Both exist because the native
// controls could already change state without going through the bar, and
// this is one more path that does exactly that.
//
// ponytail: a window listener, so — like the theme toggle above — this is
// deaf while the YouTube iframe holds focus. Harmless here specifically:
// YouTube binds space to play/pause inside the iframe, so the key does the
// right thing anyway, which is not true of the theme shortcut.
const SPACE_DEAF = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "VIDEO", "AUDIO"]);

window.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  // Modifier combinations belong to the OS or the browser, never here.
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  // Three reasons to stand down, and each is a control the user would
  // otherwise lose. A field takes the space as text — the URL, the starter
  // title and all three publish fields all hold prose. A focused <button>
  // takes it as a click, so hijacking it would break keyboard operation of
  // every bar in the app. And a focused <video controls> already toggles on
  // space by itself, so handling it here as well would toggle twice and
  // look like the key did nothing.
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    if (SPACE_DEAF.has(active.tagName) || active.isContentEditable) return;
  }

  const phase = getState().phase;
  if (phase === "trimming") {
    if (!player) return;
    // Read once and act on the intent, not on a re-read: YouTube reports the
    // new state asynchronously, the same reason the bar's own toggle does it
    // this way.
    if (player.playing()) player.pause();
    else player.play();
  } else if (phase === "framing") {
    if (!videoEl) return;
    toggleClip();
  } else if (phase === "preview") {
    if (!outVideoEl) return;
    if (outVideoEl.paused) void outVideoEl.play();
    else outVideoEl.pause();
  } else {
    return; // idle owns no medium — leave the page's own scroll alone
  }
  // Only once something was actually toggled: space scrolls the page by
  // default, and suppressing that on a phase with nothing to play would be
  // taking a key away for no benefit.
  e.preventDefault();
});
