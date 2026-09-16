import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeFile } from "./ffmpeg.ts";
import { FADE, renderLofi } from "./lofi.ts";

const run = promisify(execFile);

let dir = "";
/** A flat teal background picture. */
let bg = "";
/** 30s of a 220 Hz sine — the music bed. Long enough to hold a cut-in with
 *  SKIP_HEAD-sized room either side, short enough to encode in seconds. */
let music = "";
/** A 3s vertical "speech": a solid crimson frame over WHITE NOISE. The noise
 *  is what makes the band-limiting measurable — a sine would pass or fail
 *  the 6 kHz check purely on where its one frequency sits. */
let speech = "";
/** The same, silent, for the anullsrc stand-in. */
let mute = "";
let out = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vstack-lofi-"));

  bg = join(dir, "bg.jpg");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=0x108080:s=1920x1080",
    "-frames:v", "1", "-y", bg,
  ]);

  music = join(dir, "music.m4a");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=30",
    "-c:a", "aac", "-y", music,
  ]);

  speech = join(dir, "speech.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=0xC03030:s=1080x1920:d=3:r=30",
    "-f", "lavfi", "-i", "anoisesrc=d=3:c=white:a=0.5",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-shortest", "-y", speech,
  ]);

  mute = join(dir, "mute.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=0x30C030:s=1080x1920:d=2:r=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", mute,
  ]);

  out = join(dir, "out.mp4");
  // One cut-in at t=12, well clear of both ends.
  await renderLofi({ image: bg, music, cuts: [{ path: speech, at: 12 }], out });
  // Explicit, because several real encodes compete for CPU in the full
  // suite — `server/longform.test.ts`'s hook carries one for the same
  // reason.
}, 180_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** One frame at `t`, decoded to raw RGB, sampled at (x, y). Thresholds
 *  rather than equality: libx264 is lossy. */
async function pixelAt(path: string, t: number, x: number, y: number, width = 1920) {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-ss", String(t), "-i", path, "-frames:v", "1",
     "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 64 << 20 },
  );
  const buf = stdout as unknown as Buffer;
  const i = (y * width + x) * 3;
  return { r: buf[i] ?? 0, g: buf[i + 1] ?? 0, b: buf[i + 2] ?? 0 };
}

/** Mean and peak dB over a window, optionally through a filter first. */
async function loudness(path: string, t: number, dur: number, pre = "") {
  const { stderr } = await run("ffmpeg", [
    "-hide_banner", "-ss", String(t), "-t", String(dur), "-i", path,
    "-map", "0:a", "-af", pre === "" ? "volumedetect" : `${pre},volumedetect`,
    "-f", "null", "-",
  ]);
  const mean = /mean_volume: (-?[0-9.]+) dB/.exec(stderr);
  const max = /max_volume: (-?[0-9.]+) dB/.exec(stderr);
  return { mean: mean ? Number(mean[1]) : -91, max: max ? Number(max[1]) : -91 };
}

describe("FADE", () => {
  // The dip samples below are placed from this value.
  it("is the 0.5s the dip samples assume", () => {
    expect(FADE).toBe(0.5);
  });
});

describe("renderLofi", () => {
  it("is 1920x1080 and exactly as long as the music", async () => {
    const probed = await probeFile(out);
    expect(probed.width).toBe(1920);
    expect(probed.height).toBe(1080);
    // THE invariant: the render's duration is the track's, so the name
    // `/api/lofi` builds from it cannot come to describe a different file.
    expect(probed.seconds).toBeGreaterThan(29.5);
    expect(probed.seconds).toBeLessThan(30.5);
  });

  it("shows the background picture outside a cut-in", async () => {
    const p = await pixelAt(out, 4, 960, 540);
    expect(p.g).toBeGreaterThan(90);
    expect(p.b).toBeGreaterThan(90);
    expect(p.r).toBeLessThan(80);
  });

  it("shows the speech inside its cut-in", async () => {
    // Mid-speech, past its fade-in and before its fade-out.
    const p = await pixelAt(out, 13.5, 960, 540);
    expect(p.r).toBeGreaterThan(120);
    expect(p.g).toBeLessThan(90);
  });

  it("dips to black at the edge of a cut-in", async () => {
    // The crossing point: the background has faded out and the speech has
    // not faded in.
    const p = await pixelAt(out, 12, 960, 540);
    expect(p.r + p.g + p.b).toBeLessThan(120);
  });

  it("ducks the music under the speech", async () => {
    // Measured in a narrow band around the music's own 220 Hz, so the
    // speech's own energy cannot be mistaken for the bed's.
    const band = "bandpass=f=220:width_type=h:width=40";
    const before = await loudness(out, 6, 2, band);
    const during = await loudness(out, 13, 2, band);
    expect(during.mean).toBeLessThan(before.mean - 3);
  });

  it("band-limits the speech", async () => {
    // The source is white noise, so it carries real energy above 6 kHz; the
    // lowpass at 3 kHz is what has to remove it.
    const high = "highpass=f=6000";
    const inSpeech = await loudness(out, 13, 2, high);
    const source = await loudness(speech, 0.5, 2, high);
    expect(inSpeech.mean).toBeLessThan(source.mean - 12);
  });

  it("renders a silent speech through the stand-in", async () => {
    const quiet = join(dir, "quiet.mp4");
    await renderLofi({ image: bg, music, cuts: [{ path: mute, at: 12 }], out: quiet });
    const probed = await probeFile(quiet);
    expect(probed.hasAudio).toBe(true);
    expect(probed.seconds).toBeGreaterThan(29.5);
    const p = await pixelAt(quiet, 13, 960, 540);
    expect(p.g).toBeGreaterThan(120);
  }, 120_000);

  it("renders two cut-ins in their own windows", async () => {
    const two = join(dir, "two.mp4");
    await renderLofi({
      image: bg,
      music,
      cuts: [{ path: speech, at: 6 }, { path: mute, at: 20 }],
      out: two,
    });
    const first = await pixelAt(two, 7.5, 960, 540);
    expect(first.r).toBeGreaterThan(120);
    const second = await pixelAt(two, 21, 960, 540);
    expect(second.g).toBeGreaterThan(120);
    const between = await pixelAt(two, 14, 960, 540);
    expect(between.b).toBeGreaterThan(90);
    expect(between.r).toBeLessThan(80);
  }, 180_000);
});
