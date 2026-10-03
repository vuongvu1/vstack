import { describe, expect, it } from "vitest";
import { TALL, WIDE } from "./geometry.ts";
import { fitTitle, titleRules } from "./starter.ts";
import type { Measure, TitleRules } from "./starter.ts";

/** Half an em per character: crude, deterministic, and enough to make
 *  widths depend on both the text and the size the way a real font does. */
const measure: Measure = (text, size) => text.length * size * 0.5;

/** Today's loop, copied verbatim from before `fitTitle` existed and spelled
 *  against the same fake measurer — the regression fence for tall sizes. */
function legacySize(title: string): number {
  const maxWidth = TALL.w - 2 * 96;
  const wrap = (size: number) => {
    const lines: string[] = [];
    let line = "";
    for (const word of title.trim().split(/\s+/)) {
      const next = line === "" ? word : `${line} ${word}`;
      if (line !== "" && measure(next, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line !== "") lines.push(line);
    return lines;
  };
  let size = 48;
  for (size = 150; size > 48; size -= 6) {
    const lines = wrap(size);
    const fits = lines.every((l) => measure(l, size) <= maxWidth);
    if (fits && lines.length * size * 1.2 <= TALL.h / 2) break;
  }
  return size;
}

const SHORT = "Ăn cơm chưa";
const MEDIUM = "Hôm nay mình sẽ thử thách ăn hết mười tô phở trong một giờ";
const LONG =
  "Hôm nay mình sẽ thử thách ăn hết mười tô phở trong một giờ đồng hồ cùng với " +
  "những người bạn thân nhất và xem ai là người chiến thắng cuối cùng nhé mọi người";

describe("titleRules", () => {
  it("keeps the tall rules exactly as they were", () => {
    expect(titleRules(TALL)).toEqual({
      maxSize: 150,
      minSize: 48,
      maxLines: Number.POSITIVE_INFINITY,
      maxBlockH: 960,
      maxWidth: 888,
    });
  });

  it("gives the wide frame a 120px floor, three lines and a 756px block", () => {
    expect(titleRules(WIDE)).toEqual({
      maxSize: 220,
      minSize: 120,
      maxLines: 3,
      maxBlockH: 756,
      maxWidth: 1728,
    });
  });
});

describe("fitTitle — tall (the regression fence)", () => {
  it("picks the same size today's loop picked, for every title", () => {
    for (const title of [SHORT, MEDIUM, LONG, `${LONG} ${LONG}`]) {
      expect(fitTitle(measure, title, titleRules(TALL)).size).toBe(legacySize(title));
    }
  });
});

describe("fitTitle — wide", () => {
  const rules: TitleRules = titleRules(WIDE);

  it("gives a short title the maximum size", () => {
    expect(fitTitle(measure, SHORT, rules)).toEqual({ size: 220, lines: [SHORT], fits: true });
  });

  it("never goes below the floor or above three lines", () => {
    for (const title of [SHORT, MEDIUM, LONG, `${LONG} ${LONG}`]) {
      const fit = fitTitle(measure, title, rules);
      expect(fit.size).toBeGreaterThanOrEqual(120);
      expect(fit.size).toBeLessThanOrEqual(220);
      expect(fit.lines.length).toBeLessThanOrEqual(3);
    }
  });

  it("fits a medium title on at most three lines, inside the block", () => {
    const fit = fitTitle(measure, MEDIUM, rules);
    expect(fit.fits).toBe(true);
    expect(fit.lines.length * fit.size * 1.2).toBeLessThanOrEqual(756);
    for (const line of fit.lines) expect(measure(line, fit.size)).toBeLessThanOrEqual(1728);
  });

  it("reports a title that needs a fourth line at the floor, instead of shrinking", () => {
    // MUTATION TEST: drop the wide floor (minSize 48) and this comes back
    // fits: true at a size nobody can read on a sidebar tile.
    const fit = fitTitle(measure, `${LONG} ${LONG}`, rules);
    expect(fit).toMatchObject({ size: 120, fits: false });
    expect(fit.lines).toHaveLength(3);
  });

  it("terminates on one unbreakable word wider than the frame", () => {
    const url = "https://www.youtube.com/watch?v=0vGJ0ywUW-8&t=12345s&list=abcdefghijklmnopqrstuvwxyz";
    const fit = fitTitle(measure, url, rules);
    expect(fit).toEqual({ size: 120, lines: [url], fits: false });
  });
});
