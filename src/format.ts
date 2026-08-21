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
