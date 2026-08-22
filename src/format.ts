export function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}${String(s % 60).padStart(2, "0")}`;
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  // Hours are always shown, even when zero: the trim badge reads
  // `start → end`, and a conditional hour field makes it jump width the
  // moment a mark crosses 1:00:00.
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\da-z]+/g, "-")
      .slice(0, 60)
      // Trim AFTER slicing: trimming first lets the cut land on a collapsed
      // separator and reintroduce the dash we just removed.
      .replace(/^-+|-+$/g, "") || "clip"
  );
}

/** Reads an absolute source-timeline second count out of whatever was
 *  pasted: a YouTube share URL's `t=`/`start=` value, the bare `1h2m3s` form
 *  YouTube also emits, a plain second count, or the `hh:mm:ss` form the trim
 *  badges display. Returns null rather than a best guess — the caller seeks
 *  with this, and a silently wrong seek reads as a broken player.
 *
 *  Both patterns deliberately capture hours/minutes/seconds in groups 1/2/3
 *  so one summation serves both. Order matters only in that a colon form
 *  cannot match the h/m/s pattern, so the `??` chain never mis-reads one as
 *  the other. */
export function parseTimestamp(text: string): number | null {
  const raw = text.trim();
  // A pasted URL carries the value in a query parameter; anything else *is*
  // the value. A URL with no `t=`/`start=` falls through to the token
  // patterns below, neither of which can match a URL, and so yields null.
  const token = /[?&](?:t|start)=([^&#]+)/.exec(raw)?.[1] ?? raw;
  // Every group in the h/m/s pattern is optional, so it matches the empty
  // string — which would turn blank input into a seek to 0.
  if (token === "") return null;

  const parts =
    /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(token) ??
    /^(?:(\d+):)?(\d+):(\d+)$/.exec(token);
  if (!parts) return null;
  const [, h, m, s] = parts;
  return 3600 * Number(h ?? 0) + 60 * Number(m ?? 0) + Number(s ?? 0);
}
