type YtErrorEvent = { data: number };

type YtPlayerInstance = {
  getCurrentTime(): number;
  getPlayerState(): number;
  seekTo(s: number, allow: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  destroy(): void;
};

/** `getPlayerState`'s codes, per
 *  https://developers.google.com/youtube/iframe_api_reference#Playback_status.
 *  Only the two that mean "rolling, or about to be" are named: BUFFERING
 *  counts as playing because the user's intent while it buffers is to play,
 *  so a Pause button has to be offered (not a Play button that would
 *  re-issue playVideo and do nothing visible). */
const STATE_PLAYING = 1;
const STATE_BUFFERING = 3;

type YtApi = {
  Player: new (
    host: HTMLElement,
    opts: {
      videoId: string;
      playerVars?: Record<string, number | string>;
      events?: {
        onReady?: () => void;
        onError?: (event: YtErrorEvent) => void;
        onStateChange?: () => void;
      };
    },
  ) => YtPlayerInstance;
};

declare global {
  interface Window {
    YT?: YtApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export type YtPlayer = {
  currentTime(): number;
  seekTo(s: number): void;
  /** True while playing or buffering — i.e. whenever the right control to
   *  offer is Pause. Read on demand rather than cached: YouTube's own
   *  overlay controls change the state without going through this wrapper. */
  playing(): boolean;
  play(): void;
  pause(): void;
  destroy(): void;
};

// Generous, but bounded: a blocked network or a silently-refused embed must
// eventually surface as an error instead of leaving the busy state spinning
// (or the controls looking live while doing nothing) forever.
const LOAD_TIMEOUT_MS = 15_000;
const READY_TIMEOUT_MS = 15_000;

let apiReady: Promise<YtApi> | null = null;

/** Maps the IFrame API's numeric error codes to a message that names the
 *  likely cause, since "error 101" means nothing to a user. Codes per
 *  https://developers.google.com/youtube/iframe_api_reference#onError. */
function ytErrorMessage(code: number): string {
  switch (code) {
    case 2:
      return `Invalid YouTube video (error ${code}).`;
    case 5:
      return `This video cannot be played in this browser (error ${code}).`;
    case 100:
      return `This video is unavailable — it may be private or deleted (error ${code}).`;
    case 101:
    case 150:
      return `YouTube will not embed this video (error ${code}). Try another.`;
    default:
      return `YouTube player error ${code}.`;
  }
}

/** The IFrame API signals readiness through a single global callback, so the
 *  script is injected once and the promise is cached. A failed load (script
 *  blocked, or the callback never fires) clears the cache so a later attempt
 *  can retry instead of being stuck replaying a rejected singleton forever. */
function loadApi(): Promise<YtApi> {
  if (apiReady) return apiReady;
  apiReady = new Promise((resolve, reject) => {
    const YT = window.YT;
    if (YT?.Player) {
      resolve(YT);
      return;
    }
    const timer = setTimeout(() => {
      apiReady = null;
      reject(new Error("Timed out loading the YouTube player API."));
    }, LOAD_TIMEOUT_MS);
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      if (window.YT) {
        resolve(window.YT);
      } else {
        apiReady = null;
        reject(new Error("YouTube API ready callback fired without window.YT."));
      }
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.onerror = () => {
      clearTimeout(timer);
      apiReady = null;
      reject(new Error("Could not load the YouTube player API. Check your connection."));
    };
    document.head.append(tag);
  });
  return apiReady;
}

/** Mounts a YouTube IFrame player into `host` and resolves once it is ready
 *  to take `seekTo`/`getCurrentTime` calls, or rejects with a message naming
 *  the failure — left unhandled, the API otherwise fails *silently* (no
 *  `onReady`, no thrown error) for ordinary cases: a private, deleted,
 *  age-restricted, or embedding-disabled video, or a network that never
 *  delivers the API at all. Callers own `host`'s lifetime: this never
 *  removes or replaces `host` itself, only appends into it, so a caller
 *  that keeps `host` attached and never re-parents it gets a player that
 *  survives unrelated re-renders. Re-parenting `host` (or any ancestor)
 *  after this resolves discards the iframe's nested browsing context and
 *  reloads the video — there is no supported way to move a live player.
 *
 *  On rejection (any of the four failure modes above), this cleans up
 *  after itself: the throwaway `slot` div is removed if the constructor
 *  never got to replace it, and the constructed player (if any) is
 *  destroyed so its iframe doesn't linger in `host` as an orphan. A caller
 *  that retries after a rejection must not accumulate dead nodes in
 *  `host` on every attempt. */
export async function mountPlayer(
  host: HTMLElement,
  videoId: string,
  onStateChange?: () => void,
): Promise<YtPlayer> {
  const YT = await loadApi();
  const slot = document.createElement("div");
  host.append(slot);
  return new Promise((resolve, reject) => {
    let settled = false;
    // Hoisted above the try so a synchronously-fired onReady/onError (both
    // reference `timer`) never sees it in the temporal dead zone. Only the
    // assignment stays below, right before the ready-timeout branch —
    // moving that too would leave a synchronous throw from the constructor
    // with no timer to clear, which is a real (different) bug.
    // `clearTimeout(undefined)` is a legal no-op, so this is safe even if
    // onReady/onError fires before the assignment below ever runs.
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Declared (not yet assigned) before the constructor call so the ready
    // timeout below — set up only once construction succeeds — can clean up
    // whatever player it built. If construction itself throws, `p` is never
    // assigned and the catch block below cleans up `slot` instead.
    let p: YtPlayerInstance;
    try {
      p = new YT.Player(slot, {
        videoId,
        playerVars: { rel: 0, modestbranding: 1 },
        events: {
          // Fires for YouTube's *own* controls too — clicking the video
          // itself, or the overlay play button — which is the whole reason
          // a caller cannot just track state through its own play()/pause()
          // calls. Can arrive before onReady, so callers must tolerate being
          // told about a player they have not been handed yet.
          onStateChange,
          onReady: () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
              currentTime: () => p.getCurrentTime(),
              seekTo: (s) => p.seekTo(s, true),
              playing: () => {
                const state = p.getPlayerState();
                return state === STATE_PLAYING || state === STATE_BUFFERING;
              },
              play: () => p.playVideo(),
              pause: () => p.pauseVideo(),
              destroy: () => p.destroy(),
            });
          },
          onError: (event) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            p.destroy(); // remove the iframe this failed attempt created
            reject(new Error(ytErrorMessage(event.data)));
          },
        },
      });
    } catch (err) {
      settled = true;
      // The constructor can throw *after* it has already substituted `slot`
      // for a real (still unconfigured, empty-src) <iframe> — observed for a
      // malformed videoId, which fails the API's own format validation only
      // partway through construction. `slot.remove()` is a no-op once that
      // swap has happened (it is already detached), so the replacement
      // iframe, if one exists, is removed straight from `host` as well.
      slot.remove();
      host.querySelector("iframe")?.remove();
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      p.destroy();
      reject(new Error("Timed out waiting for the YouTube player to become ready."));
    }, READY_TIMEOUT_MS);
  });
}

/** A trim you cannot see is a trim you cannot verify, so the kept ranges are
 *  drawn, not just stored. Clicking the strip seeks.
 *
 *  Returns a handle rather than a bare element because it now owns a rAF
 *  loop for the playhead — the same `{ …, stop }` shape `mountEditor`
 *  returns, and for the same reason. A caller that drops the handle without
 *  calling `stop()` leaves a loop reading a detached node forever. */
export function renderStrip(opts: {
  duration: number;
  segments: { start: number; end: number }[];
  /** Which segment the marking controls are aimed at, drawn brighter. */
  active: number;
  /** The playhead's position in source seconds, read every frame. A
   *  callback rather than a value: this module knows nothing about the
   *  caller's player handle, and a value would be stale by the next frame. */
  head(): number;
  onSeek(s: number): void;
}): { el: HTMLElement; stop(): void } {
  const strip = document.createElement("div");
  strip.className = "strip";

  const pct = (s: number) => `${(100 * s) / Math.max(1, opts.duration)}%`;
  opts.segments.forEach((seg, i) => {
    const range = document.createElement("div");
    range.className = i === opts.active ? "strip-range is-active" : "strip-range";
    range.style.left = pct(seg.start);
    range.style.width = pct(Math.max(0, seg.end - seg.start));
    strip.append(range);
  });

  const head = document.createElement("div");
  head.className = "strip-head";
  strip.append(head);

  let frame = 0;
  let last = -1;
  const tick = () => {
    const t = opts.head();
    // Only touched when it actually moves: a style write per frame on a
    // paused player is pure layout churn.
    if (t !== last) {
      last = t;
      head.style.left = pct(t);
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  strip.onclick = (e) => {
    const box = strip.getBoundingClientRect();
    const frac = (e.clientX - box.left) / Math.max(1, box.width);
    opts.onSeek(frac * opts.duration);
  };
  return {
    el: strip,
    stop: () => cancelAnimationFrame(frame),
  };
}
