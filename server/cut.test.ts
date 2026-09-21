import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cutMp3 } from "./cut.ts";

const run = promisify(execFile);

let dir = "";
/** Six seconds of three back-to-back tones, two seconds each: 440 Hz, then
 *  1760 Hz, then 440 Hz again.
 *
 *  Three flat tones rather than anything subtle so a single bandpass says
 *  which part of the input an output came from — a duration assertion alone
 *  passes when a range maps to the wrong audio, and mapping is exactly what
 *  the `-ss`/`-i` ordering decides. The first and third bands repeat 440 Hz
 *  on purpose: the middle range is the only one that reads as 1760 Hz, so an
 *  off-by-one leg lands somewhere measurably wrong in either direction. */
let src = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vstack-cut-"));
  src = join(dir, "src.m4a");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=1760:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]",
    "-map", "[a]", "-y", src,
  ]);
  // 180s, like server/longform.test.ts's and server/lofi.test.ts's hooks:
  // real encodes compete for CPU in the full suite and exceed vitest's
  // default 10s hook budget there while passing in isolation.
}, 180_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Mean dB over a whole file, optionally through a filter first — the same
 *  shape `server/lofi.test.ts`'s `loudness` uses. */
async function meanDb(path: string, pre = ""): Promise<number> {
  const { stderr } = await run("ffmpeg", [
    "-hide_banner", "-i", path,
    "-af", pre === "" ? "volumedetect" : `${pre},volumedetect`,
    "-f", "null", "-",
  ]);
  const mean = /mean_volume: (-?[0-9.]+) dB/.exec(stderr);
  return mean ? Number(mean[1]) : -91;
}

async function seconds(path: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=nk=1:nw=1", path,
  ]);
  return Number(stdout.trim());
}

describe("cutMp3", () => {
  it("writes a range's own audio, at its own length", async () => {
    const out = join(dir, "mid.mp3");
    await cutMp3(src, { start: 2, end: 4 }, out);
    expect(await seconds(out)).toBeGreaterThan(1.8);
    expect(await seconds(out)).toBeLessThan(2.2);
    // THE assertion. A range that maps to the wrong part of the input still
    // has the right duration — only the tone says where it came from, and
    // 1760 Hz lives in the middle two seconds alone.
    const high = await meanDb(out, "bandpass=f=1760:width_type=h:width=200");
    const low = await meanDb(out, "bandpass=f=440:width_type=h:width=100");
    expect(high).toBeGreaterThan(low + 20);
  });

  it("maps the first range to the head of the input", async () => {
    const out = join(dir, "head.mp3");
    await cutMp3(src, { start: 0, end: 2 }, out);
    const high = await meanDb(out, "bandpass=f=1760:width_type=h:width=200");
    const low = await meanDb(out, "bandpass=f=440:width_type=h:width=100");
    expect(low).toBeGreaterThan(high + 20);
  });

  it("does not over-report a range that runs to the very end", async () => {
    const out = join(dir, "tail.mp3");
    await cutMp3(src, { start: 4, end: 6 }, out);
    expect(await seconds(out)).toBeLessThan(2.2);
  });

  it("reports ffmpeg's own stderr when the input is missing", async () => {
    await expect(cutMp3(join(dir, "nope.m4a"), { start: 0, end: 1 }, join(dir, "x.mp3")))
      .rejects.toThrow(/ffmpeg/);
  });
}, 180_000);
