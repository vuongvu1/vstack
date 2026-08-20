type YtApi = {
  Player: new (
    host: HTMLElement,
    opts: {
      videoId: string;
      playerVars?: Record<string, number | string>;
      events?: { onReady?: () => void };
    },
  ) => { getCurrentTime(): number; seekTo(s: number, allow: boolean): void; destroy(): void };
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
  destroy(): void;
};

let apiReady: Promise<YtApi> | null = null;

/** The IFrame API signals readiness through a single global callback, so the
 *  script is injected once and the promise is cached. */
function loadApi(): Promise<YtApi> {
  if (apiReady) return apiReady;
  apiReady = new Promise((resolve) => {
    const YT = window.YT;
    if (YT?.Player) {
      resolve(YT);
      return;
    }
    window.onYouTubeIframeAPIReady = () => {
      if (window.YT) resolve(window.YT);
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.append(tag);
  });
  return apiReady;
}

/** Mounts a YouTube IFrame player into `host` and resolves once it is ready
 *  to take `seekTo`/`getCurrentTime` calls. Callers own `host`'s lifetime:
 *  this never removes or replaces `host` itself, only appends into it, so a
 *  caller that keeps `host` attached and never re-parents it gets a player
 *  that survives unrelated re-renders. Re-parenting `host` (or any ancestor)
 *  after this resolves discards the iframe's nested browsing context and
 *  reloads the video — there is no supported way to move a live player. */
export async function mountPlayer(host: HTMLElement, videoId: string): Promise<YtPlayer> {
  const YT = await loadApi();
  const slot = document.createElement("div");
  host.append(slot);
  return new Promise((resolve) => {
    const p = new YT.Player(slot, {
      videoId,
      playerVars: { rel: 0, modestbranding: 1 },
      events: {
        onReady: () =>
          resolve({
            currentTime: () => p.getCurrentTime(),
            seekTo: (s) => p.seekTo(s, true),
            destroy: () => p.destroy(),
          }),
      },
    });
  });
}

/** A trim you cannot see is a trim you cannot verify, so the marked range is
 *  drawn, not just stored. Clicking the strip seeks. */
export function renderStrip(opts: {
  duration: number;
  start: number;
  end: number;
  onSeek(s: number): void;
}): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "strip";

  const pct = (s: number) => `${(100 * s) / Math.max(1, opts.duration)}%`;
  const range = document.createElement("div");
  range.className = "strip-range";
  range.style.left = pct(opts.start);
  range.style.width = pct(Math.max(0, opts.end - opts.start));
  strip.append(range);

  strip.onclick = (e) => {
    const box = strip.getBoundingClientRect();
    opts.onSeek(((e.clientX - box.left) / box.width) * opts.duration);
  };
  return strip;
}
