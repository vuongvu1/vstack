import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUCKETS_PER_SEC } from "../src/lofi.ts";
import { probeAudio, probeFile } from "./ffmpeg.ts";
import {
  FADE,
  glitchAt,
  hitsAt,
  LOGO_FILTER,
  LOGO_PATH,
  LOGO_RECT,
  markScaleAt,
  VINYL_RIM,
  SPIN_EXPR,
  logoAt,
  SPIN_SECONDS,
  spinAt,
  VIZ_BAR,
  VIZ_RECT,
  concatMusic,
  parseProgress,
  progressLine,
  renderLofi,
  renderProgress,
  scanFolder,
  trackEnvelope,
} from "./lofi.ts";

const run = promisify(execFile);

/** The render's own shape, for the corner assertions below. Not imported
 *  from `WIDE` because this file already hardcodes 1920 in `pixelAt`. */
const WIDE_W = 1920;
const WIDE_H = 1080;
/** The render's frame rate, which is the grid `overlay` evaluates the
 *  bounce on. Written down rather than imported for the reason WIDE_W is. */
const RENDER_FPS = 30;

let dir = "";
/** A flat teal background picture — the render's ONLY picture. */
let bg = "";
/** 30s of a 220 Hz sine — the music bed. Long enough to hold a speech with
 *  SKIP_HEAD-sized room either side, short enough to encode in seconds. */
let music = "";
/** A 3s VIDEO speech: a solid crimson frame over WHITE NOISE. Its picture is
 *  what the "never shows a speech" assertions watch for, and must be a
 *  colour nothing else in the render could produce. The noise is what makes
 *  the band-limiting measurable — a sine would pass or fail the 6 kHz check
 *  purely on where its one frequency sits. */
let speech = "";
/** A 2s AUDIO-ONLY speech: a 1200 Hz sine in an .m4a with no video stream at
 *  all. Inside the voice's own 300-3000 Hz band, so it survives the vinyl
 *  chain, and narrow enough to find again in a bandpass. */
let voice = "";
/** A 2s speech whose audio stream is DIGITAL SILENCE. Legal input — it has
 *  an audio stream — and the fixture that keeps `acrusher`'s `mode=lin`
 *  honest, since log-mode quantisation of a zero sample is what used to kill
 *  the encoder. Also what makes the crackle measurable: a real speech is
 *  broadband and would drown it. */
let silent = "";
/** A video with no audio stream at all. Refused, not rendered. */
let noaudio = "";
/** A 1.5s ANIMATED background: red, then green, then blue, half a second
 *  each. Three flat colours rather than anything subtle so a single sampled
 *  pixel says which frame of the loop is on screen, and a period that
 *  divides into the 30s track so "it looped" is checkable by arithmetic. */
let gif = "";
let out = "";
/** A directory `scanFolder` walks: two media files, a non-media file it must
 *  ignore outright, and a media-EXTENSION file with no audio stream, which
 *  it must report as skipped rather than fail the whole scan over. */
let scanDir = "";
/** 4s built as 2s of a loud sine then 2s of digital silence — the fixture
 *  that makes an envelope's SHAPE checkable rather than just its length. */
let loudThenQuiet = "";
/** Three 2s tones for `concatMusic`'s own fixtures — see the tests below for
 *  why the frequencies rather than the lengths are what prove the order. */
let tone440a = "";
let tone1760 = "";
let tone440b = "";
/** A SHORT 1760 Hz tone — 1.8s, which is between `TRACK_FADE` and
 *  `2 * TRACK_FADE`. That band is the only one where the `min(TRACK_FADE,
 *  secs / 3)` clamp changes the answer without also making ffmpeg refuse
 *  the graph: unclamped, this track's fade-in and fade-out overlap and
 *  MULTIPLY across its own middle, where at 1.5s or less the fade-out's
 *  `st` would simply go negative and fail loudly. Asserting on the level
 *  rather than on either failure mode is `server/longform.test.ts`'s own
 *  lesson for the identical clamp. */
let toneShort = "";
/** The CRT fixture: flat mid-grey — so any colour cast from the screen
 *  stage reads as a number — with one white vertical stripe near the centre
 *  to give the colour fringing a hard edge to pull apart — and for the glitch
 *  to tear sideways. Rendered over EIGHT seconds of tone with the screen ON,
 *  the one render in this file that is: eight because no glitch may fall in
 *  the first six seconds, so a shorter fixture would hold none. */
let crtBg = "";
let crtOut = "";

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

  voice = join(dir, "voice.m4a");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "sine=frequency=1200:duration=2",
    "-c:a", "aac", "-y", voice,
  ]);

  silent = join(dir, "silent.m4a");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", "2", "-c:a", "aac", "-y", silent,
  ]);

  noaudio = join(dir, "noaudio.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=0x30C030:s=1080x1920:d=2:r=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", noaudio,
  ]);

  gif = join(dir, "cycle.gif");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=red:s=320x180:d=0.5:r=10",
    "-f", "lavfi", "-i", "color=c=green:s=320x180:d=0.5:r=10",
    "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=0.5:r=10",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map", "[v]", "-y", gif,
  ]);

  tone440a = join(dir, "t440a.m4a");
  tone1760 = join(dir, "t1760.m4a");
  tone440b = join(dir, "t440b.m4a");
  for (const [path, hz] of [[tone440a, 440], [tone1760, 1760], [tone440b, 440]] as const) {
    await run("ffmpeg", [
      "-y", "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=2`,
      "-c:a", "aac", path,
    ]);
  }

  toneShort = join(dir, "tshort.m4a");
  await run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "sine=frequency=1760:duration=1.8",
    "-c:a", "aac", toneShort,
  ]);

  scanDir = join(dir, "scan");
  await mkdir(scanDir, { recursive: true });
  // Named so that plain name order is NOT the order they were created in —
  // the scan sorts, and a fixture that is already sorted cannot show it.
  await run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:a", "aac", join(scanDir, "b-second.m4a"),
  ]);
  await run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=2",
    "-c:a", "aac", join(scanDir, "a-first.m4a"),
  ]);
  await writeFile(join(scanDir, "notes.txt"), "not media");
  await run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", join(scanDir, "silentfilm.mp4"),
  ]);

  loudThenQuiet = join(dir, "loudquiet.m4a");
  await run("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=2",
    "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[a]",
    "-map", "[a]", "-c:a", "aac", loudThenQuiet,
  ]);

  crtBg = join(dir, "crt-bg.png");
  await run("ffmpeg", [
    "-v", "error", "-f", "lavfi",
    "-i", "color=c=0x808080:s=1920x1080,drawbox=x=900:y=0:w=120:h=1080:color=white:t=fill",
    "-frames:v", "1", "-y", crtBg,
  ]);
  const crtMusic = join(dir, "crt-music.m4a");
  await run("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=8",
    "-c:a", "aac", "-y", crtMusic,
  ]);
  crtOut = join(dir, "crt.mp4");
  await renderLofi({ background: crtBg, music: crtMusic, cuts: [], out: crtOut });

  out = join(dir, "out.mp4");
  // One speech at t=12, well clear of both ends. Deliberately the VIDEO
  // fixture: the render this whole describe block measures is the one whose
  // speech has a picture to suppress.
  await renderLofi({ crt: false,  background: bg, music, cuts: [{ path: speech, at: 12 }], out });
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

/** A rectangle of one frame, decoded to raw RGB. Used to compare the logo's
 *  corner across time — a single pixel cannot tell a rotation from noise,
 *  and the whole frame is dominated by the background that never changes. */
async function regionAt(
  path: string, t: number, x: number, y: number, w: number, h: number,
) {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-ss", String(t), "-i", path, "-frames:v", "1",
     "-vf", `crop=${w}:${h}:${x}:${y}`,
     "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 64 << 20 },
  );
  return stdout as unknown as Buffer;
}

const boxAt = (path: string, t: number, x: number, y: number, side: number) =>
  regionAt(path, t, x, y, side, side);

/** Mean distance from the flat teal background, over the columns of a
 *  region that satisfy `keep`.
 *
 *  DISTANCE rather than brightness because the bars are coloured now. White
 *  bars could only ever brighten the background, so brightness was a fair
 *  proxy for "a bar is here"; a rainbow bar can be darker than the teal, or
 *  the same brightness in a different hue, and brightness says nothing
 *  about either. Distance sees any bar of any colour.
 *
 *  Column-wise rather than whole-region because that is the only way to see
 *  the GAPS: a band with no gaps and a band with them have similar overall
 *  means, and differ entirely in how the bars are distributed across each
 *  slot. */
function columnDist(
  buf: Buffer, w: number, h: number, keep: (x: number) => boolean,
): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!keep(x)) continue;
      const i = (y * w + x) * 3;
      sum += Math.hypot((buf[i] ?? 0) - 0x10, (buf[i + 1] ?? 0) - 0x80, (buf[i + 2] ?? 0) - 0x80);
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/** Which way the covered pixels of a column range move AWAY from the teal,
 *  as a unit vector — the colour of the bars, independent of how faint they
 *  are. A pixel less than 20 from the teal is background and does not
 *  vote. */
function colourDirection(
  buf: Buffer, w: number, h: number, lo: number, hi: number,
): { n: number; dir: [number, number, number] } {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = lo; x < hi; x++) {
      const i = (y * w + x) * 3;
      const d = [(buf[i] ?? 0) - 0x10, (buf[i + 1] ?? 0) - 0x80, (buf[i + 2] ?? 0) - 0x80];
      const m = Math.hypot(d[0]!, d[1]!, d[2]!);
      if (m < 20) continue;
      for (let c = 0; c < 3; c++) sum[c]! += d[c]! / m;
      n++;
    }
  }
  const m = Math.hypot(sum[0]!, sum[1]!, sum[2]!);
  return { n, dir: [sum[0]! / m, sum[1]! / m, sum[2]! / m] };
}

/** Mean absolute per-channel difference between two equal-sized boxes.
 *
 *  The scale that matters here was measured on a real render: two samples of
 *  the SAME orientation differ by 1.6 (libx264 being lossy, nothing more),
 *  and any two different orientations of this mark differ by 15 to 20. The
 *  thresholds below sit in that gap with room on both sides. */
/** The mark alone, unanimated — the scale and pad `LOGO_FILTER` starts
 *  from, without its breathing. What the spin test rotates, so the angle is
 *  the only thing that moves. */
const STILL_MARK =
  `format=rgba,scale=300:300:force_original_aspect_ratio=decrease,` +
  `pad=${LOGO_RECT.side}:${LOGO_RECT.side}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;

/** RGBA frames of `filter` run over the real mark asset, one per instant.
 *
 *  Driven at a LOW frame rate by default so `t` can be walked an hour out
 *  in a few thousand small frames — legitimate for what these tests ask,
 *  since every effect on the mark is a function of the timestamp and not
 *  of how many frames it took to get there. `times` must be ascending and
 *  land on the frame grid. */
async function markFrames(filter: string, times: number[], fps = 2): Promise<Buffer[]> {
  const sel = times.map((t) => `eq(n\\,${Math.round(t * fps)})`).join("+");
  const { stdout } = await run(
    "ffmpeg",
    [
      "-v", "error",
      "-loop", "1", "-framerate", String(fps),
      "-t", String(Math.max(...times) + 1), "-i", LOGO_PATH,
      "-vf", `${filter},select='${sel}',format=rgba`,
      "-fps_mode", "passthrough", "-f", "rawvideo", "-",
    ],
    { encoding: "buffer", maxBuffer: 1 << 29 },
  );
  const size = LOGO_RECT.side * LOGO_RECT.side * 4;
  expect(stdout.length).toBe(size * times.length);
  return times.map((_, i) => stdout.subarray(i * size, (i + 1) * size));
}

/** How many pixels of an RGBA frame are solidly opaque. */
function opaqueArea(rgba: Buffer): number {
  let n = 0;
  for (let i = 3; i < rgba.length; i += 4) if ((rgba[i] ?? 0) > 200) n++;
  return n;
}

/** Where an RGBA frame's opaque pixels are centred. */
function centroid(rgba: Buffer): { x: number; y: number } {
  const side = LOGO_RECT.side;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let p = 0; p < side * side; p++) {
    if ((rgba[p * 4 + 3] ?? 0) <= 200) continue;
    sx += p % side;
    sy += Math.floor(p / side);
    n++;
  }
  return { x: sx / n, y: sy / n };
}

/** The soft-alpha pixels of an RGBA frame — a glow is made of these — and
 *  their mean colour. */
function halo(rgba: Buffer): { count: number; rgb: [number, number, number] } {
  let n = 0;
  const sum = [0, 0, 0];
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] ?? 0;
    if (a < 20 || a > 200) continue;
    n++;
    for (let c = 0; c < 3; c++) sum[c]! += rgba[i + c] ?? 0;
  }
  return { count: n, rgb: [sum[0]! / n, sum[1]! / n, sum[2]! / n] };
}

function boxDiff(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / a.length;
}

/** Whether a sample is the teal background picture. Every frame of every
 *  render here should be — that is the feature. */
function isBackground(p: { r: number; g: number; b: number }): boolean {
  return p.g > 90 && p.b > 90 && p.r < 80;
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

/** The AUDIO STREAM's own duration, in seconds — deliberately not
 *  `probeFile`'s, which reports the CONTAINER's `format.duration` and would
 *  read a full 30s even on a render whose audio track silently died at
 *  15s. `-select_streams a:0` is what makes this the stream's own claim
 *  rather than the file's overall one. */
async function audioStreamDuration(path: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=duration",
    "-of", "default=nk=1:nw=1",
    path,
  ]);
  return Number(stdout.trim());
}

describe("FADE", () => {
  // The crackle-boost window sampled below is placed from this value.
  it("is the 0.5s the crackle-boost samples assume", () => {
    expect(FADE).toBe(0.5);
  });
});

describe("spinAt", () => {
  it("stays far inside rotate's 2048-radian ceiling, however long the render", () => {
    // The spin is wrapped into one turn, so the angle rotate is handed stays
    // bounded for a render of any length. Swept past four days of timeline.
    let worst = 0;
    for (let t = 0; t < 4e5; t += 0.37) worst = Math.max(worst, Math.abs(spinAt(t)));
    expect(worst).toBeLessThan(2 * Math.PI + 1e-9);
  });

  it("turns at one steady rate, always forwards", () => {
    // A plain metronome spin, deliberately. A wobbling one — speed swelling,
    // easing, and briefly turning back — shipped for one review and was
    // taken out at the user's request, so this pins its absence: every step
    // forward and the same size, one turn per SPIN_SECONDS.
    const dt = 0.01;
    const rate = (2 * Math.PI) / SPIN_SECONDS;
    let worst = 0;
    for (let t = 0; t < 1000; t += dt) {
      const d = spinAt(t + dt) - spinAt(t);
      if (Math.abs(d) > Math.PI) continue; // the wrap, not motion
      worst = Math.max(worst, Math.abs(d / dt - rate));
    }
    expect(worst).toBeLessThan(1e-6);
  });
});

describe("glitchAt", () => {
  it("never glitches in the opening seconds, and then every 5-7s", () => {
    // One burst per six-second window, placed within the window's first
    // second — so consecutive bursts are 5 to 7 seconds apart — and the first
    // window has none, so no render opens on a glitch. Swept over three
    // hours of timeline on the render's own frame grid.
    const starts: number[] = [];
    let was = false;
    for (let k = 0; k < 3 * 3600 * 30; k++) {
      const now = glitchAt(k / 30) !== null;
      if (now && !was) starts.push(k / 30);
      was = now;
    }
    expect(starts[0]).toBeGreaterThanOrEqual(6);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 1; i < starts.length; i++) {
      lo = Math.min(lo, starts[i]! - starts[i - 1]!);
      hi = Math.max(hi, starts[i]! - starts[i - 1]!);
    }
    expect(lo).toBeGreaterThanOrEqual(5 - 0.05);
    expect(hi).toBeLessThanOrEqual(7 + 0.05);
    // Roughly one every six seconds for the whole three hours.
    expect(starts.length).toBeGreaterThan(1750);
  });

  it("tears a band that stays on the picture, by up to 80px either way", () => {
    for (let k = 0; k < 600 * 30; k++) {
      const g = glitchAt(k / 30);
      if (!g) continue;
      expect(g.top).toBeGreaterThanOrEqual(0);
      expect(g.top + g.height).toBeLessThanOrEqual(1080);
      expect(Math.abs(g.shift)).toBeLessThanOrEqual(80);
    }
  });
});

describe("parseProgress", () => {
  it("reads the LAST out_time_us block", () => {
    const text = [
      "frame=30", "out_time_us=1000000", "progress=continue",
      "frame=60", "out_time_us=2500000", "progress=continue",
    ].join("\n");
    expect(parseProgress(text)).toBeCloseTo(2.5, 3);
  });

  it("returns 0 for a file ffmpeg has not written to yet", () => {
    expect(parseProgress("")).toBe(0);
  });

  it("ignores a trailing partial block", () => {
    expect(parseProgress("out_time_us=3000000\nprogress=continue\nframe=9")).toBeCloseTo(3, 3);
  });

  it("survives ffmpeg's N/A before the first frame", () => {
    expect(parseProgress("out_time_us=N/A\nprogress=continue")).toBe(0);
  });
});

describe("progressLine", () => {
  it("names the phase, the percent and both clocks", () => {
    expect(progressLine({ phase: "render", done: 430, total: 3600 })).toBe(
      "rendering 12% (00:07:10/01:00:00)",
    );
  });

  it("calls the pre-pass by its own name", () => {
    expect(progressLine({ phase: "music", done: 30, total: 120 })).toBe(
      "joining tracks 25% (00:00:30/00:02:00)",
    );
  });

  // A total of 0 is what `renderProgress` reports before either function has
  // probed anything. Dividing by it gives NaN or Infinity, and a log line
  // reading `NaN%` is worse than no line — so the CALLER skips these, and
  // this pins the value it tests against.
  it("reports 0% rather than NaN for a total of 0", () => {
    expect(progressLine({ phase: "render", done: 0, total: 0 })).toBe(
      "rendering 0% (00:00:00/00:00:00)",
    );
  });

  // ffmpeg's last block can land marginally past the duration probed from
  // the source. 101% reads as a bug in the renderer rather than as rounding.
  it("clamps past the end rather than reporting over 100%", () => {
    expect(progressLine({ phase: "render", done: 61, total: 60 })).toBe(
      "rendering 100% (00:01:01/00:01:00)",
    );
  });
});

describe("scanFolder", () => {
  it("finds the media files with their durations, in name order", async () => {
    const { files } = await scanFolder(scanDir);
    expect(files.map((f) => f.name)).toEqual(["a-first.m4a", "b-second.m4a"]);
    expect(files[0]?.seconds).toBeCloseTo(2, 0);
    expect(files[1]?.seconds).toBeCloseTo(3, 0);
    expect(files[0]?.path).toBe(join(scanDir, "a-first.m4a"));
  });

  // A real music folder has cover art, a .DS_Store and a tracklist in it.
  // Those are not failures and must not be reported as any.
  it("ignores a non-media extension outright", async () => {
    const { files, skipped } = await scanFolder(scanDir);
    expect(files.some((f) => f.name === "notes.txt")).toBe(false);
    expect(skipped).not.toContain("notes.txt");
  });

  // The loud half of the split: a file that LOOKS like media and has no
  // audio stream is the one case worth naming, because silently dropping it
  // is a track missing from a render nobody can explain.
  it("reports a media file with no audio stream as skipped", async () => {
    const { files, skipped } = await scanFolder(scanDir);
    expect(skipped).toEqual(["silentfilm.mp4"]);
    expect(files.some((f) => f.name === "silentfilm.mp4")).toBe(false);
  });

  it("refuses a directory that is not there, by name", async () => {
    const missing = join(dir, "no-such-folder");
    await expect(scanFolder(missing)).rejects.toThrow(missing);
  });
});

describe("trackEnvelope", () => {
  // The length is what `fill` indexes against: BUCKETS_PER_SEC buckets a
  // second, the same rate the browser's own decode produced before the
  // scan existed.
  it("returns BUCKETS_PER_SEC buckets a second", async () => {
    const env = await trackEnvelope(loudThenQuiet, 4);
    expect(env.length).toBe(4 * BUCKETS_PER_SEC);
  });

  // Deliberately NOT bit-equality against the browser's decode: ffmpeg's
  // resampler and WebAudio's are different code and will not agree sample
  // for sample. The envelope is a RANKING input for finding quiet stretches,
  // so what has to hold is the shape — a loud half reads louder than a
  // silent one — and claiming more than that would be claiming something
  // this function does not provide.
  it("reads the loud half louder than the silent half", async () => {
    const env = await trackEnvelope(loudThenQuiet, 4);
    const half = env.length / 2;
    const loud = Math.max(...env.slice(0, half));
    const quiet = Math.max(...env.slice(half));
    // 0.1 describes the FIXTURE, not a property of the function: lavfi's
    // `sine` emits at about -18 dB on this build rather than full scale, so
    // the loud half peaks at 0.130 — which is also exactly what ffmpeg's own
    // `astats` reports for this file (-17.689 dB), i.e. the decode agrees
    // with ffmpeg to five figures. Raise the fixture's amplitude before
    // raising this bound.
    expect(loud).toBeGreaterThan(0.1);
    expect(quiet).toBeLessThan(0.01);
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

  it("reads real progress while a render is in flight, then sweeps the file behind it", async () => {
    // This used to read `beforeAll`'s own already-finished render, on the
    // premise that a finished ffmpeg run leaves its `<out>.progress` file on
    // disk for a later poll to read. That premise is exactly the debt this
    // suite's sibling fix removed: `renderLofi` now deletes its own
    // `<out>.progress` in a `finally`, the instant ffmpeg exits, so by the
    // time any `it` runs after `beforeAll` the file described here is
    // already gone. Proving the on-disk `-progress` output is real and
    // parses through a live run therefore needs a render still IN FLIGHT to
    // poll against, so this starts a second one rather than reusing `out`.
    const out2 = join(dir, "out2.mp4");
    const pending = renderLofi({ crt: false,  background: bg, music, cuts: [], out: out2 });
    let settled = false;
    pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    let seenPhase: "music" | "render" | undefined;
    let seenTotal = 0;
    let seenDone = 0;
    while (!settled) {
      const p = renderProgress();
      // `phase` and `total` are set once, early, and hold for the whole
      // render — unlike `done` they are not moving targets, so sampling them
      // inside this same loop is not racy and costs nothing extra.
      seenPhase = p.phase;
      seenTotal = Math.max(seenTotal, p.total);
      seenDone = Math.max(seenDone, p.done);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await pending;
    expect(seenPhase).toBe("render");
    // Proves the music's own duration is wired through to the slot, the same
    // thing the old on-disk read proved.
    expect(seenTotal).toBeGreaterThan(29.5);
    // Real ffmpeg output was read and parsed to a positive position — the
    // failure this guards against is a progress bar that never renders
    // anything. (Reading the LAST out_time_us block rather than the first is
    // covered exactly by the synthetic `parseProgress` tests above.)
    //
    // Deliberately NOT restoring the old `done` close to `total` assertion.
    // That could only ever be read from a FINISHED render's file, and a
    // finished render's file is exactly what this fix now deletes — so
    // "progress reaches near-completion" is no longer observable from
    // outside the render at all, not just harder to catch with a poll. That
    // loss is the real cost of the fix, and it is the right trade against
    // leaving litter in the user's own OUT_DIR.
    expect(seenDone).toBeGreaterThan(0);
    // THE assertion for the sweep itself: nothing is left on disk once the
    // render — successful or not — has finished, which is what keeps this
    // file off the user's own `OUT_DIR` in a real run.
    expect(existsSync(`${out2}.progress`)).toBe(false);
  }, 120_000);

  it("keeps the audio STREAM itself as long as the music, not just the container", async () => {
    // `probeFile` reads `format.duration` — the CONTAINER's claim — which
    // stayed a faithful 30s even while `sidechaincompress`'s framesync
    // behaviour silently truncated the actual audio stream to the last
    // speech's own end (15s on this fixture: a speech at t=12 that runs 3s).
    // A structural check on the container could never have caught that; this
    // reads the stream's own duration instead.
    //
    // Bounded against the music's own probed length rather than at
    // `> 29.5`: half a second of slack on a thirty-second render is enough
    // room for a proportional truncation to hide in, which is exactly what
    // the concatenated-track test below was written for.
    const { seconds } = await probeAudio(music);
    expect(await audioStreamDuration(out)).toBeCloseTo(seconds, 1);
  });

  it("keeps the music audible near the end of the render", async () => {
    // Behavioural, not structural: even a correctly-reported stream length
    // proves nothing about what is actually IN it. Sampled well past the
    // beforeAll fixture's one speech (at t=12, 3s long, ends at t=15), in
    // the bed's own 220 Hz band — the same band "ducks the music under the
    // speech" already measures. This is the assertion that fails if the bed
    // ever goes silent early again for a different reason, structural
    // duration check or not.
    const near = await loudness(out, 28, 2, "bandpass=f=220:width_type=h:width=40");
    expect(near.mean).toBeGreaterThan(-40);
  });

  // The ONE test that runs `concatMusic`'s output through `renderLofi`,
  // which is the path a multi-track render actually takes and the one
  // nothing on this branch covered: `concatMusic` was tested standalone and
  // `renderLofi` only ever on a single track, so the gap between them was
  // invisible from both sides.
  //
  // What lived in that gap is the audio STREAM dying early while the
  // container stayed faithful — the same silent shape the
  // `sidechaincompress` pad above documents, one stage further down. The
  // closing `amix ... duration=first` takes its length from `[ducked]`,
  // which takes its own from `[music]`, and a concatenated track EOFs a
  // little short of the duration `probeAudio` reports for it; the container
  // and the video track ran full length throughout. Measured on this
  // fixture before `renderLofi`'s closing `apad`: a 4.836009s audio stream
  // inside a 6.066667s container, against a music file `probeAudio` reports
  // as 6.060408s — a fifth of the render silent. With the pad: 6.06.
  //
  // The container assertion cannot stand in for this one. It reads
  // `format.duration`, which was faithful throughout — and the single-track
  // assertions beside it were bounded at `> 29.5`, half a second of slack on
  // a thirty-second render, which is the wrong instrument for a failure that
  // is a fraction of the whole rather than a fixed offset. Hence
  // `audioStreamDuration` and a 0.05s window here, and the same treatment
  // applied to those two above.
  it("keeps the audio stream full length on a CONCATENATED track set", async () => {
    const joined = join(dir, "multi.flac");
    await concatMusic([tone440a, tone1760, tone440b], joined);
    const multi = join(dir, "multi.mp4");
    await renderLofi({ crt: false,  background: bg, music: joined, cuts: [{ path: silent, at: 2 }], out: multi });

    // The speech is the DIGITAL SILENCE fixture so nothing but the music and
    // the crackle is in the stream being measured.
    const { seconds } = await probeAudio(joined);
    expect(await audioStreamDuration(multi)).toBeCloseTo(seconds, 1);
  }, 120_000);

  // Note what is deliberately NOT asserted here: the concat's leg ORDER.
  // `peakHzAt` finds the loudest BIN, and the render mixes in a
  // full-spectrum crackle bed that the tones do not outrank — measured, the
  // peak at t=1.0 inside this render is 2603.93 Hz where the tone is 440.
  // The order is proved on `concatMusic`'s own output instead, upstream of
  // the crackle, by the test of that name in the describe block below; a
  // second copy here would only be measuring the noise.

  // THE assertion this feature turns on: a speech is audio, and the picture
  // holds the frame from the first sample to the last. The fixture's speech
  // is a solid crimson video, so every one of these samples goes red the
  // moment anything overlays it — and near-black at the two edges the
  // moment the background starts dipping again. Both are what the old
  // cut-in graph did on purpose; both are now regressions.
  //
  // The edge samples are the ones that matter most. `t=12` and `t=15` are
  // the speech's own start and end, where the dip used to bottom out, so a
  // reinstated fade shows here long before it shows mid-speech.
  it("keeps the background picture while a speech plays, and never dips", async () => {
    for (const t of [4, 11.9, 12, 13.5, 15, 15.1, 28]) {
      const p = await pixelAt(out, t, 960, 540);
      expect({ t, ...p, background: isBackground(p) }).toMatchObject({
        t,
        background: true,
      });
    }
  }, 120_000);

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
    //
    // Still measured against the SOURCE, not against the bed, even though
    // the crackle now plays at full spectrum and puts its own floor up here.
    // Two reasons that floor does not spoil the measurement: it sits some
    // 20 dB below the speech's own residual, and it is present in both
    // windows anyway. A bed-relative assertion was tried and is WRONG —
    // `lowpass` is second-order, 12 dB an octave, so a band-limited speech
    // still leaves real energy one octave up. Demanding it add nothing over
    // the bed fails on correct code.
    const high = "highpass=f=6000";
    const inSpeech = await loudness(out, 13, 2, high);
    const source = await loudness(speech, 0.5, 2, high);
    expect(inSpeech.mean).toBeLessThan(source.mean - 12);
  });

  it("refuses a speech with no audio stream", async () => {
    // `probeAudio` is the gate, and it is a gate rather than a stand-in on
    // purpose: a video with no sound can only contribute silence to a mix
    // that never shows it, so rendering it produces a file whose defect is
    // invisible until someone listens to the whole thing. The graph used to
    // carry an `anullsrc` stand-in for exactly this input; it does not any
    // more.
    await expect(
      renderLofi({ crt: false, 
        background: bg,
        music,
        cuts: [{ path: noaudio, at: 12 }],
        out: join(dir, "never.mp4"),
      }),
    ).rejects.toThrow(/no audio stream/);
  });

  it("mixes two audio-only speeches into their own windows", async () => {
    // Both are .m4a — no video stream anywhere in the graph but the
    // background picture. This is the audio-only upload path end to end.
    const two = join(dir, "two.mp4");
    await renderLofi({ crt: false, 
      background: bg,
      music,
      cuts: [{ path: voice, at: 6 }, { path: voice, at: 20 }],
      out: two,
    });
    // The 1200 Hz sine sits inside the voice's own 300-3000 Hz band, so it
    // survives the vinyl chain, and a narrow bandpass finds it with nothing
    // else of the fixture's in the way (the music is 220 Hz).
    const band = "bandpass=f=1200:width_type=h:width=120";
    const first = await loudness(two, 6.5, 1, band);
    const second = await loudness(two, 20.5, 1, band);
    const between = await loudness(two, 13, 2, band);
    expect(first.mean).toBeGreaterThan(between.mean + 12);
    expect(second.mean).toBeGreaterThan(between.mean + 12);
    // And the picture is untouched throughout, including inside both
    // windows.
    expect(isBackground(await pixelAt(two, 6.5, 960, 540))).toBe(true);
    expect(isBackground(await pixelAt(two, 20.5, 960, 540))).toBe(true);
  }, 180_000);

  it("plays one speech file at every one of its drops", async () => {
    // Three drops of ONE file. If drops were opened as separate inputs and
    // one were mis-indexed, the tone would be missing from that window while
    // the render still succeeded — the silent failure this asserts against.
    // `voice` is the existing 1200 Hz audio-only fixture, reused rather than
    // duplicated.
    const repeat = join(dir, "repeat.mp4");
    await renderLofi({ crt: false, 
      background: bg,
      music,
      cuts: [
        { path: voice, at: 4 },
        { path: voice, at: 12 },
        { path: voice, at: 20 },
      ],
      out: repeat,
    });
    // width=120, not the 200 a first draft of this test used: measured
    // against the real bundled crackle asset (which plays full-spectrum,
    // unconditionally, under every render), a 200 Hz-wide band around 1200 Hz
    // has a floor of -54.2 dB even with NO speech at all — wider than the
    // -55 dB "absent" threshold below needs. width=120 is the bandwidth the
    // sibling "mixes two audio-only speeches" test above already uses for
    // this identical 1200 Hz tone, and its floor measures -56.5..-57.3 dB in
    // the same two windows this test checks.
    const band = "bandpass=f=1200:width_type=h:width=120";
    for (const at of [4.5, 12.5, 20.5]) {
      expect((await loudness(repeat, at, 1, band)).mean).toBeGreaterThan(-45);
    }
    // And absent between them, which is what proves the delays are distinct
    // rather than all three landing on one moment.
    for (const at of [8, 16]) {
      expect((await loudness(repeat, at, 1, band)).mean).toBeLessThan(-55);
    }
  }, 120_000);

  it("renders a speech whose audio is digital silence", async () => {
    // Legal input: it HAS an audio stream, so `probeAudio` passes it, and it
    // reaches the full vinyl chain — which the old graph's stand-in branch
    // deliberately skipped. `acrusher`'s `mode=lin` is what keeps this from
    // reaching the AAC encoder as NaN; flip it to `mode=log` and this test
    // is the one that dies, with `Error submitting audio frame to the
    // encoder: Invalid argument`.
    const quiet = join(dir, "quiet.mp4");
    await renderLofi({ crt: false,  background: bg, music, cuts: [{ path: silent, at: 12 }], out: quiet });
    const probed = await probeFile(quiet);
    expect(probed.hasAudio).toBe(true);
    expect(probed.seconds).toBeGreaterThan(29.5);
    expect(await audioStreamDuration(quiet)).toBeCloseTo((await probeAudio(music)).seconds, 1);
    expect(isBackground(await pixelAt(quiet, 13, 960, 540))).toBe(true);
  }, 120_000);

  it("animates a GIF background and loops it under the whole track", async () => {
    // The fixture GIF is 1.5s: red [0, 0.5), green [0.5, 1.0), blue
    // [1.0, 1.5). So the colour at any t is decided by `t % 1.5`, and
    // sampling past the first period is what proves the LOOP rather than a
    // single play followed by a frozen last frame — which is exactly what a
    // background that merely "worked" would look like for the first 1.5s of
    // a three-minute render.
    const moving = join(dir, "moving.mp4");
    await renderLofi({ crt: false, 
      background: gif,
      music,
      cuts: [{ path: voice, at: 12 }],
      out: moving,
    });

    const dominant = (p: { r: number; g: number; b: number }) =>
      p.r > 100 && p.g < 90 && p.b < 90
        ? "red"
        : p.g > 70 && p.r < 90 && p.b < 90
          ? "green"
          : p.b > 100 && p.r < 90 && p.g < 90
            ? "blue"
            : `other(${p.r},${p.g},${p.b})`;

    // Sampled 0.2s into each half-second cell, away from the boundaries,
    // where a frame of rounding either way cannot change the answer. t=0.2
    // is the first period; 5.2 and 26.7 are the fourth and the eighteenth
    // (5.2 - 3*1.5 = 0.7, 26.7 - 17*1.5 = 1.2), so the last of them is 25s
    // past the GIF's own end.
    const cases: [number, string][] = [
      [0.2, "red"],
      [0.7, "green"],
      [1.2, "blue"],
      [1.7, "red"],
      [5.2, "green"],
      [26.7, "blue"],
    ];
    for (const [t, want] of cases) {
      const colour = dominant(await pixelAt(moving, t, 960, 540));
      expect({ t, colour }).toEqual({ t, colour: want });
    }

    // And the render is still exactly the TRACK's length rather than the
    // GIF's — the property `-t` on the background input is there to keep.
    const probed = await probeFile(moving);
    expect(probed.seconds).toBeGreaterThan(29.5);
    expect(probed.seconds).toBeLessThan(30.5);
  }, 180_000);

  it("still holds a lone still picture for the whole render", async () => {
    // The other side of `frameCount`'s fork, and the reason it cannot be
    // collapsed into one input form: `-stream_loop -1` on a still HANGS
    // (measured — a JPEG under it never produced a frame and ffmpeg had to
    // be killed), so the still branch must keep `-loop 1`. This is the
    // assertion that fails, by timing out, if the two are ever "simplified"
    // into one.
    //
    // The beforeAll render covers this already, but it covers it as part of
    // the picture sweep. Named here so the fork has a test that says so.
    expect(isBackground(await pixelAt(out, 0.2, 960, 540))).toBe(true);
    expect(isBackground(await pixelAt(out, 25.7, 960, 540))).toBe(true);
  });

  // TWO assertions, and the split is the point. The pixel test below crops
  // at `LOGO_RECT`, so it proves the mark is wherever that constant says —
  // move the constant and the test's own aim moves with it, which is exactly
  // what happened: putting the logo at the LEFT edge passed the pixel test
  // outright. The corner is therefore asserted as arithmetic on the rect
  // itself, where nothing can follow it.
  it("starts the mark in the top-right corner", () => {
    const { x, y, side } = LOGO_RECT;
    // Stated as the four GAPS rather than as "x is past the midpoint",
    // which a mark parked at x=1000 would also satisfy. A corner is a small
    // gap on two adjacent sides and a large one on the other two.
    const gap = {
      left: x,
      right: WIDE_W - (x + side),
      top: y,
      bottom: WIDE_H - (y + side),
    };
    expect(gap.right).toBeLessThan(120);
    expect(gap.top).toBeLessThan(120);
    expect(gap.left).toBeGreaterThan(gap.right * 4);
    expect(gap.bottom).toBeGreaterThan(gap.top * 4);
    // Wholly inside the frame — a negative gap means ffmpeg is clipping the
    // very corners the padding exists to protect.
    expect(gap.right).toBeGreaterThanOrEqual(0);
    expect(gap.top).toBeGreaterThanOrEqual(0);
    // Even on both axes: an overlay at an odd offset in yuv420p lands on a
    // half-chroma-sample boundary.
    expect(x % 2).toBe(0);
    expect(y % 2).toBe(0);
  });

  it("draws the mark where logoAt says it is, and nowhere else", async () => {
    // Crops at `logoAt(4)` rather than at a constant, because the mark
    // moves now — and that is exactly why the arithmetic above is asserted
    // separately. A crop that follows the mark proves it is drawn, never
    // that it is drawn in the right PLACE: point `logoAt` anywhere and this
    // test's own aim follows it. The mirrored box below is what keeps it
    // honest.
    const { x, y, side } = logoAt(4);
    const corner = await boxAt(out, 4, x, y, side);
    const flat = Buffer.alloc(corner.length);
    // The fixture background is flat teal, so a box with nothing drawn in it
    // is a constant. Filling a reference with that exact colour turns "is
    // anything here" into a number.
    for (let i = 0; i < flat.length; i += 3) {
      flat[i] = 0x10;
      flat[i + 1] = 0x80;
      flat[i + 2] = 0x80;
    }
    expect(boxDiff(corner, flat)).toBeGreaterThan(10);

    // And the MIRRORED box is untouched. With a moving mark this is what
    // says `logoAt` agrees with the ffmpeg expression rather than merely
    // being self-consistent: if the two spellings of the bounce drifted,
    // the mark would be at the mirrored position (or neither) and one of
    // these two assertions would fail.
    const mirrored = await boxAt(out, 4, WIDE_W - x - side, y, side);
    expect(boxDiff(mirrored, flat)).toBeLessThan(2);
  }, 120_000);

  // Pure arithmetic, no render — the bounce's own two rules. Kept apart
  // from the pixel test above for the reason the corner assertion is: a
  // test that crops wherever `logoAt` points cannot also be what proves
  // `logoAt` is right.
  it("is drawn exactly where logoAt says, to within a few pixels", async () => {
    // The sharp version of the test above. That one proves the mark is IN
    // the box `logoAt` names; it cannot tell a box that is right from one
    // that is off by the whole overhang, because a shifted mark still
    // overlaps the crop — measured: dropping the overhang from the ffmpeg
    // expression alone, with `logoAt` left alone, passed every other test in
    // this file (at 48px, and again at 88px). With the bounce turning on the
    // vinyl's rim, being right to the pixel is what "touches the wall"
    // means; that mutation fails here at 85.36.
    //
    // So: every pixel well away from the flat teal, in a window round the
    // box, and their centroid against the box's centre. The drawing is near
    // enough symmetric that its own centroid sits within a pixel of centre.
    // t=2, where the whole window is clear of the bars' band.
    const t = 2;
    const { x, y, side } = logoAt(t);
    const pad = 60;
    const wx = Math.max(0, x - pad);
    const wy = Math.max(0, y - pad);
    const ww = Math.min(WIDE_W, x + side + pad) - wx;
    const wh = Math.min(WIDE_H - VIZ_RECT.h, y + side + pad) - wy;
    const win = await regionAt(out, t, wx, wy, ww, wh);
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let p = 0; p < ww * wh; p++) {
      const i = p * 3;
      if (Math.hypot((win[i] ?? 0) - 0x10, (win[i + 1] ?? 0) - 0x80, (win[i + 2] ?? 0) - 0x80) < 60) continue;
      sx += p % ww;
      sy += Math.floor(p / ww);
      n++;
    }
    expect(n).toBeGreaterThan(10_000);
    expect(Math.abs(wx + sx / n - (x + side / 2))).toBeLessThan(4);
    expect(Math.abs(wy + sy / n - (y + side / 2))).toBeLessThan(4);
  }, 120_000);

  it("keeps the VINYL inside the frame, and lets it reach every wall", () => {
    // The bounce turns round on the record's own rim, `VINYL_RIM` from the
    // centre: the box may hang past the frame by everything outside that, so
    // the vinyl meets the wall at every hit whatever the angle. The figure's
    // limbs reach further (164px) and so poke past the frame for a moment
    // when they point at the wall — chosen, over a gap that ran to ~70px
    // when the bounce turned on the limbs instead. Sampled on the render's
    // own frame grid, which is where `overlay` evaluates the position.
    const half = LOGO_RECT.side / 2;
    const lo = { x: Infinity, y: Infinity };
    const hi = { x: -Infinity, y: -Infinity };
    let odd = 0;
    for (let k = 0; k <= 600 * RENDER_FPS; k++) {
      const { x, y } = logoAt(k / RENDER_FPS);
      if (x % 2 !== 0 || y % 2 !== 0) odd++;
      lo.x = Math.min(lo.x, x + half - VINYL_RIM);
      lo.y = Math.min(lo.y, y + half - VINYL_RIM);
      hi.x = Math.max(hi.x, x + half + VINYL_RIM);
      hi.y = Math.max(hi.y, y + half + VINYL_RIM);
    }
    // Even on both axes, for the reason every overlay offset here is.
    expect(odd).toBe(0);
    // Never past a wall...
    expect(lo.x).toBeGreaterThanOrEqual(0);
    expect(lo.y).toBeGreaterThanOrEqual(0);
    expect(hi.x).toBeLessThanOrEqual(WIDE_W);
    expect(hi.y).toBeLessThanOrEqual(WIDE_H);
    // ...and right up to every one of them. The slack is one frame's travel
    // (2.5px at 75px/s) plus the even-floor, since the nearest frame to a
    // wall is rarely the instant of contact.
    expect(lo.x).toBeLessThan(5);
    expect(lo.y).toBeLessThan(5);
    expect(hi.x).toBeGreaterThan(WIDE_W - 5);
    expect(hi.y).toBeGreaterThan(WIDE_H - 5);
  });

  it("counts a hit at every wall touch, and nowhere else", () => {
    // The size and the glow's colour step on a hit, so the hit count must
    // move exactly when the mark turns round — on either axis — and at no
    // other frame. Turning round is read straight off `logoAt` as a change of
    // direction, independently of how `hitsAt` is computed.
    const turns: number[] = [];
    const steps: number[] = [];
    let dir = { x: 0, y: 0 };
    let prev = logoAt(0);
    // Forty minutes, so the sweep holds a CORNER (the first is at 30m46s).
    let corners = 0;
    for (let k = 1; k <= 40 * 60 * RENDER_FPS; k++) {
      const cur = logoAt(k / RENDER_FPS);
      for (const axis of ["x", "y"] as const) {
        const d = Math.sign(cur[axis] - prev[axis]);
        if (d !== 0 && dir[axis] !== 0 && d !== dir[axis]) turns.push(k);
        if (d !== 0) dir = { ...dir, [axis]: d };
      }
      // A CORNER is both walls on one frame: the count steps by two there,
      // and both turns land on that frame. The first version of this test
      // counted steps rather than their size and came up one short on
      // exactly such a corner.
      const jump = hitsAt(k / RENDER_FPS) - hitsAt((k - 1) / RENDER_FPS);
      if (jump === 2) corners++;
      for (let j = 0; j < jump; j++) steps.push(k);
      prev = cur;
    }
    expect(corners).toBeGreaterThan(0);
    expect(turns.length).toBeGreaterThan(50);
    expect(steps.length).toBe(turns.length);
    // Within a couple of frames of each other: a turn is only VISIBLE once
    // the even-floored position has moved back the other way.
    for (const [i, k] of steps.entries()) expect(Math.abs(k - turns[i]!)).toBeLessThanOrEqual(3);
  });

  it("keeps turning in the real render", async () => {
    // Follows the mark, because it no longer sits still.
    //
    // This used to pin the PERIOD too, with a full-turn sample that had to
    // match t=0. It cannot any more: the mark breathes, hue-swings
    // and glows on periods that deliberately never line up, so no instant
    // after t=0 shows the same picture again. The period is pinned where it
    // can be isolated — "spins at exactly the angle spinAt names", on the
    // mark alone — and this test is left saying only that the composed
    // render still moves. Measured at the two samples: 19.92 and 20.42 before
    // the extra effects, and they only add difference.
    const at = (t: number) => {
      const { x, y, side } = logoAt(t);
      return boxAt(out, t, x, y, side);
    };
    const zero = await at(0);
    expect(boxDiff(zero, await at(SPIN_SECONDS / 4))).toBeGreaterThan(10);
    expect(boxDiff(zero, await at(SPIN_SECONDS / 2))).toBeGreaterThan(10);
  }, 120_000);

  it("spins at exactly the angle spinAt names, an hour in as much as at the start", async () => {
    // `spinAt` and `SPIN_EXPR` are one rule in two languages, the way
    // `bounce` and `bounceExpr` are, and this is what proves they agree: the
    // expression rendered by `rotate` over time against a CONSTANT angle
    // `spinAt` computed for the same instant. Any drift between the two —
    // a period, a sign — shows up as a picture that does not
    // match.
    //
    // It also carries the old ceiling test's job. ffmpeg's `rotate` holds its
    // angle in a fixed-point value that overflows past 2048 RADIANS and then
    // freezes for the rest of the render (t = 3259.49s at a bare 10s spin;
    // measured alive at 3258 and byte-identical from 3260.48). At t=3300 a
    // frozen rotate would still be showing the angle from 3259 while
    // `spinAt(3300)` names another, so dropping the `mod` fails here.
    //
    // Isolated on a STILL mark — no breathing, no hue, no glow — because
    // those are exactly what make the composed picture never repeat, and
    // only the angle is under test.
    const times = [0, 2.5, 5, 7.5, 3300, 3302.5];
    const got = await markFrames(`${STILL_MARK},rotate=a='${SPIN_EXPR}':c=none`, times);
    const want: Buffer[] = [];
    for (const t of times) {
      want.push(...(await markFrames(`${STILL_MARK},rotate=a=${spinAt(t)}:c=none`, [0])));
    }
    // The references must actually differ from one another, or a `rotate`
    // that ignored its angle entirely would match every one of them.
    expect(boxDiff(want[0]!, want[1]!)).toBeGreaterThan(10);
    for (const i of times.keys()) expect(boxDiff(got[i]!, want[i]!)).toBeLessThan(1);
  }, 120_000);

  it("measures VINYL_RIM off the asset itself", async () => {
    // The bounce turns round on this number, so it has to be the record's
    // real rim. Along every angle from the centre the drawing ends at the
    // rim or, where a limb sticks out, beyond it — so the SHORTEST of those
    // reaches is the rim. Measured 124.5 here; the farthest limb is 164.
    // Re-measured rather than trusted, so a replacement logo with a bigger
    // or smaller record fails loudly instead of overshooting a wall or
    // stopping short of it.
    const [still] = await markFrames(STILL_MARK, [0]);
    const side = LOGO_RECT.side;
    const c = side / 2;
    let rim = Infinity;
    for (let deg = 0; deg < 360; deg++) {
      const a = (deg * Math.PI) / 180;
      let last = 0;
      for (let r = 0; r < c; r += 0.25) {
        const x = Math.floor(c + r * Math.cos(a));
        const y = Math.floor(c + r * Math.sin(a));
        if ((still![(y * side + x) * 4 + 3] ?? 0) > 8) last = r;
      }
      rim = Math.min(rim, last);
    }
    expect(Math.abs(rim - VINYL_RIM)).toBeLessThan(1.5);
  }, 120_000);

  it("changes size and glow colour on a hit, and holds both until the next", async () => {
    // A hit with a long quiet stretch after it, picked off the same `hitsAt`
    // the graph evaluates. Sampled half a second either side of it, and again
    // two seconds later inside the same stretch — by which time the mark has
    // spun a fifth of a turn, which is what makes "held" a real claim.
    const fps = RENDER_FPS;
    let hit = 0;
    for (let k = 2 * fps; k < 120 * fps; k++) {
      if (hitsAt(k / fps) === hitsAt((k - 1) / fps)) continue;
      let next = k + 1;
      while (hitsAt(next / fps) === hitsAt(k / fps)) next++;
      if (next - k >= 3 * fps) { hit = k; break; }
    }
    expect(hit).toBeGreaterThan(0);
    const [before, after, later] = await markFrames(
      LOGO_FILTER,
      [(hit - fps / 2) / fps, (hit + fps / 2) / fps, (hit + (5 * fps) / 2) / fps],
      fps,
    );
    const sizeBefore = markScaleAt((hit - fps / 2) / fps);
    const sizeAfter = markScaleAt((hit + fps / 2) / fps);
    // The golden-ratio steps never land two neighbours close together.
    expect(Math.abs(sizeAfter - sizeBefore)).toBeGreaterThan(0.05);
    // Area goes as the square of the size; rotation does not change it.
    const want = (sizeAfter / sizeBefore) ** 2;
    expect(opaqueArea(after!) / opaqueArea(before!)).toBeCloseTo(want, 1);
    expect(Math.abs(opaqueArea(later!) / opaqueArea(after!) - 1)).toBeLessThan(0.02);

    // The glow jumps round the colour wheel on the hit and stays put after.
    const colour = (f: Buffer) => halo(f).rgb;
    const dist = (a: number[], b: number[]) =>
      Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    expect(halo(after!).count).toBeGreaterThan(halo((await markFrames(STILL_MARK, [0]))[0]!).count * 4);
    expect(dist(colour(before!), colour(after!))).toBeGreaterThan(40);
    expect(dist(colour(after!), colour(later!))).toBeLessThan(8);
  }, 120_000);

  it("keeps the mark centred in its box at every size", async () => {
    // `pad` places its input once from the size it was configured with,
    // while `scale=eval=frame` changes that size at every hit — without
    // `pad`'s own `eval=frame` a resized mark sat 31px off-centre and the
    // bounce carried it around off-axis. Sampled at the smallest size in the
    // first two minutes.
    let smallest = 0;
    for (let k = 0; k < 120 * RENDER_FPS; k++) {
      if (markScaleAt(k / RENDER_FPS) < markScaleAt(smallest / RENDER_FPS)) smallest = k;
    }
    expect(markScaleAt(smallest / RENDER_FPS)).toBeLessThan(0.92);
    const [f] = await markFrames(LOGO_FILTER, [smallest / RENDER_FPS], RENDER_FPS);
    const c = centroid(f!);
    const mid = LOGO_RECT.side / 2;
    expect(Math.abs(c.x - mid)).toBeLessThan(3);
    expect(Math.abs(c.y - mid)).toBeLessThan(3);
  }, 120_000);

  // Same split as the mark's, and for the same reason: the pixel tests crop
  // at `VIZ_RECT`, so they follow it wherever it goes. The band's PLACE is
  // arithmetic.
  it("spans the full width along the bottom", () => {
    expect(VIZ_RECT.x).toBe(0);
    expect(VIZ_RECT.w).toBe(WIDE_W);
    expect(VIZ_RECT.y + VIZ_RECT.h).toBe(WIDE_H);
    // A third of the frame, give or take — the bound is loose because this
    // is a taste setting, but a band taller than half the frame or thinner
    // than a tenth is a mistake rather than a retune.
    expect(VIZ_RECT.h).toBeGreaterThan(WIDE_H / 10);
    expect(VIZ_RECT.h).toBeLessThan(WIDE_H / 2);

    // There IS a gap, by construction. This belongs here rather than in the
    // pixel test below for a reason worth keeping: that test classifies
    // columns with this same `fill`, so widening a bar to its whole slot
    // makes it call every column a bar and none a gap — it then compares a
    // full set against an EMPTY one and passes. Measured: it did. The
    // constant has to be checked somewhere it cannot also be the ruler.
    expect(VIZ_BAR.fill).toBeGreaterThan(VIZ_BAR.slot * 0.4);
    expect(VIZ_BAR.fill).toBeLessThan(VIZ_BAR.slot * 0.9);
  });

  // Sampled over the band's BOTTOM 120px rather than all 360 of it. Bars are
  // lit from the bottom and thin out upward, so averaged over the whole band
  // their contribution sinks into the noise; the bottom 120 is the same
  // signal measured where it lives.
  //
  // Every number below was RE-MEASURED when the bars went from white to a
  // rainbow, on distance from the teal rather than on brightness — see
  // `columnDist`. Printed side by side on the same fixture, white against
  // rainbow: band 6.85 / 5.58, lit columns 8.93 / 7.08, gaps 2.00 / 2.08,
  // the right half quiet 2.59 / 2.39 and under the speech 43.05 / 33.97. The
  // rainbow is a little fainter than white everywhere — a coloured bar
  // moves the picture less than a white one — and every bound sits clear of
  // it on both sides.
  const BAND_SAMPLE = 120;

  it("draws bars in the band and leaves the rest of the frame alone", async () => {
    const { x, y, w, h } = VIZ_RECT;
    const band = await regionAt(out, 4, x, y + h - BAND_SAMPLE, w, BAND_SAMPLE);
    expect(columnDist(band, w, BAND_SAMPLE, () => true)).toBeGreaterThan(4);

    // The strip directly ABOVE the band carries no bars, which is what makes
    // this "along the bottom" rather than "somewhere in the frame" — sampled
    // CLEAR OF THE MARK, which is the part worth knowing. At t=4 the
    // bouncing mark sits across this very strip (logoAt(4) is x=1154,
    // y=340..766), and measured over the full width the strip reads 18.9. The
    // old brightness version of this test passed anyway, because a dark
    // vinyl does not BRIGHTEN anything: it was blind to the mark being here
    // at all. Clear of it the strip reads 2.24 — libx264's own noise on the
    // flat teal.
    const clear = logoAt(4).x - 40;
    const above = await regionAt(out, 4, x, y - 200, clear, 150);
    expect(columnDist(above, clear, 150, () => true)).toBeLessThan(3.5);
  }, 120_000);

  it("leaves a gap between neighbouring bars", async () => {
    // `gifsync`'s bars fill 70% of their slot. Measured here: lit columns sit
    // 7.08 from the teal and gap columns 2.08 — the gaps are background to
    // within encoder noise. Dropping the masking expression makes the two
    // equal.
    const { x, y, w, h } = VIZ_RECT;
    const band = await regionAt(out, 4, x, y + h - BAND_SAMPLE, w, BAND_SAMPLE);
    const isBar = (c: number) => c % VIZ_BAR.slot < VIZ_BAR.fill;
    // Both sets non-empty, or the comparison below is vacuous — see the
    // geometry test above for the mutation that made it so.
    const cols = Array.from({ length: w }, (_, c) => c);
    expect(cols.filter(isBar).length).toBeGreaterThan(0);
    expect(cols.filter((c) => !isBar(c)).length).toBeGreaterThan(0);

    expect(columnDist(band, w, BAND_SAMPLE, isBar)).toBeGreaterThan(5);
    expect(columnDist(band, w, BAND_SAMPLE, (c) => !isBar(c))).toBeLessThan(3);
  }, 120_000);

  it("colours the bars, and not all one colour", async () => {
    // The rainbow runs ACROSS the band as well as drifting in time, so at one
    // instant two stretches of it are two different colours. Compared on the
    // DIRECTION each covered pixel moves away from the teal, not on its mean
    // colour: this fixture's bars are faint, so a mean is swamped by the
    // background (27.8 apart for white, only 56.6 for the rainbow), while a
    // direction ignores how faint a bar is and reads only which way it
    // pulls. White pulls every bar the same way — measured 0.4 degrees apart
    // — and the rainbow 81.0.
    //
    // Two eighths of the RIGHT half, mid-speech, because the white-noise
    // speech lights that whole half hard. Not the left quarter: this fixture's
    // background is teal, and at t=13.5 the rainbow puts teal there — the bars
    // vanish into it (609 covered pixels, against 20,000 on the right). That
    // is a real property of coloured bars on a background of the same hue,
    // not a render bug; it is just not what this test is about.
    const { x, y, w, h } = VIZ_RECT;
    const band = await regionAt(out, 13.5, x, y + h - BAND_SAMPLE, w, BAND_SAMPLE);
    const a = colourDirection(band, w, BAND_SAMPLE, w / 2, (w * 5) / 8);
    const b = colourDirection(band, w, BAND_SAMPLE, (w * 7) / 8, w);
    expect(a.n).toBeGreaterThan(1000);
    expect(b.n).toBeGreaterThan(1000);
    const cos = a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2];
    expect((Math.acos(Math.min(1, cos)) * 180) / Math.PI).toBeGreaterThan(30);
  }, 120_000);

  it("follows the whole mix, not just the music", async () => {
    // THE reason the visualiser is split off the finished audio rather than
    // off `[music]`. The fixture's music is a 220 Hz sine, so the upper
    // bars have nothing to show; its speech is white noise, so while that
    // plays they light up. Measured in the band's own right half, which is
    // where the high frequencies land.
    //
    // Tapping `[music]` instead leaves this half unchanged throughout, and
    // no other assertion here would notice.
    const { y, w, h } = VIZ_RECT;
    const half = w / 2;
    const band = (t: number) => regionAt(out, t, half, y + h - BAND_SAMPLE, half, BAND_SAMPLE);
    const quiet = await band(5);
    // The speech runs [12, 15]; sampled in the middle of it.
    const loud = await band(13.5);
    // Measured 2.39 quiet against 33.97 under the speech.
    expect(columnDist(loud, half, BAND_SAMPLE, () => true)).toBeGreaterThan(
      columnDist(quiet, half, BAND_SAMPLE, () => true) + 15,
    );
  }, 120_000);

  // The crackle bed and its per-speech boost, each measured in the band that
  // can actually see it — and on PEAK, because this asset is sparse pops
  // over near-silence (a 41 dB crest factor) whose mean sits below the
  // fixture's own noise floor. A mean-based version of this test was tried
  // and could not tell the bed from silence: switching the bed off moved it
  // by 0.2 dB. The renders are deterministic, so peak is stable here.
  //
  // The SILENT fixture is what makes the boost measurable at all: a real
  // speech is broadband across these same bands and would drown the thing
  // under test.
  it("lays a crackle bed down and lifts it under a speech", async () => {
    const crackly = join(dir, "crackle.mp4");
    await renderLofi({ crt: false,  background: bg, music, cuts: [{ path: silent, at: 12 }], out: crackly });

    // Above 6 kHz nothing else in this render lives: the music is a 220 Hz
    // sine and the speech is digital silence, so the crackle — which plays
    // at full spectrum by design — owns the band outright.
    const bedHigh = await loudness(crackly, 5, 2, "highpass=f=6000");
    expect(bedHigh.max).toBeGreaterThan(-40);

    // The lift shows best lower down, where the boost leg adds most. The two
    // legs read different moments of the asset, so they are uncorrelated and
    // POWER-sum — equal gains would give +3 dB, and the bound sits above
    // that so it cannot pass on the boost leg merely existing at bed level.
    //
    // The margin is thin on purpose and worth knowing before retuning: a
    // PEAK is whichever leg's loudest pop lands in the window rather than a
    // sum, so it tracks `20 * log10(CRACKLE_BOOST / CRACKLE_BED)` and the
    // current pair measures +3.6 dB here. Quietening the boost much further
    // fails this assertion before the boost stops being audible — which is
    // the right way round, but it means a failure here is a signal to think
    // about the bound rather than to nudge it.
    const band = "bandpass=f=1700:width_type=h:width=1500";
    const bed = await loudness(crackly, 5, 2, band);
    // Inside the boost's own fades: the speech runs [12, 14] and the leg
    // ramps over the first and last FADE of it, so only [12.5, 13.5] is at
    // full boost.
    const under = await loudness(crackly, 12.6, 0.8, band);
    expect(under.max).toBeGreaterThan(bed.max + 3);
  }, 120_000);
});

/** The dominant frequency at `at` seconds, via a 0.2s window through
 *  `astats`-free means: an `ebur128`-free FFT is not available here, so this
 *  slices the window out and asks `aspectralstats` for its centroid, which
 *  on a pure sine is the sine.
 *
 *  The first and last of the ~9 frames `aspectralstats` prints for a 0.2s
 *  window carry the seek's priming transient and the window's flush
 *  transient — measured on a steady 1760 Hz tone, they read 2468 Hz and
 *  2103 Hz against 1771 Hz (±1 Hz) for every frame between them, which is
 *  a bigger miss than `toBeCloseTo`'s tolerance allows and would otherwise
 *  make this a frequency-plus-edge-noise reader rather than a frequency
 *  one. Dropped rather than averaged in. */
async function peakHzAt(path: string, at: number): Promise<number> {
  const { stderr } = await run("ffmpeg", [
    "-v", "info", "-ss", String(at), "-t", "0.2", "-i", path,
    "-af", "aspectralstats=measure=centroid,ametadata=mode=print:key=lavfi.aspectralstats.1.centroid",
    "-f", "null", "-",
  ]);
  const hits = [...stderr.matchAll(/centroid=([\d.]+)/g)].map((m) => Number(m[1]));
  if (hits.length === 0) throw new Error(`no centroid read from ${path} at ${at}s`);
  const steady = hits.length > 2 ? hits.slice(1, -1) : hits;
  return steady.reduce((a, b) => a + b, 0) / steady.length;
}

describe("the CRT screen", () => {
  /** Mean r, g, b over a region of the CRT render. */
  const meanRgb = async (t: number, x: number, y: number, w: number, h: number) => {
    const buf = await regionAt(crtOut, t, x, y, w, h);
    const sum = [0, 0, 0];
    for (let i = 0; i < buf.length; i += 3) for (let c = 0; c < 3; c++) sum[c]! += buf[i + c] ?? 0;
    const n = buf.length / 3;
    return sum.map((v) => v / n) as [number, number, number];
  };

  it("is still exactly as long as the music", async () => {
    // The screen's static mask is a one-frame source looped forever; the
    // blend that applies it must end with the picture, not with the mask.
    expect((await probeFile(crtOut)).seconds).toBeCloseTo(8, 1);
  }, 120_000);

  it("keeps grey grey — no colour cast from a blend in the wrong format", async () => {
    // THE silent failure of this stage. `blend` works in whatever pixel
    // format it is handed, and on YUV its modes apply to the two colour
    // planes as well as brightness: `multiply` drags them toward zero, which
    // is GREEN, and `screen` pushes them up, which is PURPLE. Both happened
    // in the trial this was built from — a whole render turned green, then
    // mauve — and neither raises an error. Every blend runs in planar RGB,
    // and a flat grey that comes out with its three channels still equal is
    // what proves it. Sampled clear of the mark and the bars.
    for (const t of [1, 3]) {
      const [r, g, b] = await meanRgb(t, 300, 440, 120, 80);
      expect(Math.abs(r - g)).toBeLessThan(4);
      expect(Math.abs(b - g)).toBeLessThan(4);
    }
  }, 120_000);

  it("draws straight scanlines and bends the screen into black corners", async () => {
    // The mask is applied LAST, after the curvature, so its lines are the
    // output's own rows: every third row darker, exactly.
    const w = 200;
    const h = 90;
    const buf = await regionAt(crtOut, 2, 500, 500, w, h);
    const rows = [0, 0, 0];
    const counts = [0, 0, 0];
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const i = (row * w + col) * 3;
        rows[(500 + row) % 3]! += ((buf[i] ?? 0) + (buf[i + 1] ?? 0) + (buf[i + 2] ?? 0)) / 3;
        counts[(500 + row) % 3]!++;
      }
    }
    const [dark, lit1, lit2] = rows.map((v, k) => v / counts[k]!) as [number, number, number];
    expect(dark).toBeLessThan(0.8 * Math.min(lit1, lit2));

    // The bulge pulls the picture in from every corner, leaving black.
    for (const [x, y] of [[0, 0], [1912, 0], [0, 1072], [1912, 1072]] as const) {
      const [r, g, b] = await meanRgb(2, x, y, 8, 8);
      expect((r + g + b) / 3).toBeLessThan(16);
    }
  }, 120_000);

  it("fringes a hard edge red on one side and blue on the other", async () => {
    // The white stripe starts at x=900 and ends at x=1020. Red is pulled
    // left and blue right, so just outside the left edge the red channel
    // has already arrived while blue has not, and the right edge is the
    // mirror. Near the centre, where the bulge moves an edge by under a
    // pixel.
    const [lr, , lb] = await meanRgb(2, 896, 480, 3, 120);
    const [rr, , rb] = await meanRgb(2, 1021, 480, 3, 120);
    expect(lr - lb).toBeGreaterThan(30);
    expect(rb - rr).toBeGreaterThan(30);
  }, 120_000);

  it("does not flicker — the picture's overall brightness holds still", async () => {
    // A 7 Hz brightness pulse shipped with the first version of this screen
    // and was taken out because it tired the user's eyes. This pins its
    // absence. The rolling lines and bands that stayed are SPATIAL — at any
    // instant they darken some rows and not others — so over a patch many
    // rows tall their average holds; a flicker moves the whole patch at once.
    const means: number[] = [];
    for (let k = 0; k <= 12; k++) {
      const [r, g, b] = await meanRgb(1 + k / 30, 300, 150, 300, 300);
      means.push((r + g + b) / 3);
    }
    expect(Math.max(...means) - Math.min(...means)).toBeLessThan(1.5);
  }, 120_000);

  it("rolls lines and bands down the picture", async () => {
    // The two effects taken from CRTFilter: fine retrace lines crawling down
    // and faint signal-loss bands rolling down, both brightness patterns that
    // depend on the row and the time only. So one row of a flat grey changes
    // brightness from one instant to the next, where the static scanlines
    // alone would hold it still. Sampled 0.3s apart — about half a retrace
    // cycle — over two rows, because a one-row crop cannot be taken from
    // 4:2:0 video, whose colour is stored per PAIR of rows.
    const row = async (t: number) => {
      const [r, g, b] = await meanRgb(t, 300, 452, 120, 2);
      return (r + g + b) / 3;
    };
    // Measured 8.42 here, and exactly 0 with both depths set to 0. The first
    // bound was a guess of 8 — a hair under the measurement — and sits at 4
    // now, clear of both.
    expect(Math.abs((await row(1)) - (await row(1.3)))).toBeGreaterThan(4);
  }, 120_000);

  it("tears a band sideways during a glitch, and nowhere else", async () => {
    // The first glitch, picked off the same `glitchAt` the graph evaluates,
    // at an instant where its tear is wide. Inside the band the white stripe
    // has moved sideways by about the tear; in the rows just outside it, it
    // has not. Rows either side of the band, rather than one far away, so the
    // bulge moves both by the same amount.
    let t = 0;
    let g: NonNullable<ReturnType<typeof glitchAt>> | null = null;
    for (let k = 0; k < 8 * 30; k++) {
      const cand = glitchAt(k / 30);
      if (cand && Math.abs(cand.shift) > 30 && cand.top > 40 && cand.top + cand.height < 1000) {
        t = k / 30;
        g = cand;
        break;
      }
    }
    expect(g).not.toBeNull();
    // An even row (4:2:0 crops snap to even) that the scanlines leave lit.
    // Rounded FIRST: the band's top is a fraction (a hash times 880), and
    // a fraction is never even, so the first version of this loop spun
    // forever — a hung test run at full CPU with no ffmpeg in sight.
    const lit = (y: number) => {
      let r = Math.round(y);
      while (r % 2 !== 0 || r % 3 === 0) r++;
      return r;
    };
    const edge = async (y: number) => {
      const buf = await regionAt(crtOut, t, 0, lit(y), WIDE_W, 2);
      // The stripe's left edge: the first column, scanning from the left
      // third, that is much brighter than the grey around it.
      for (let x = 640; x < 1280; x++) {
        if (((buf[x * 3] ?? 0) + (buf[x * 3 + 1] ?? 0) + (buf[x * 3 + 2] ?? 0)) / 3 > 170) return x;
      }
      return -1;
    };
    const mid = Math.round(g!.top + g!.height / 2);
    const inside = await edge(mid);
    const above = await edge(g!.top - 20);
    expect(Math.abs(inside - above - g!.shift)).toBeLessThan(15);
    // And outside every glitch the same two rows agree.
    expect(glitchAt(3)).toBeNull();
  }, 120_000);

  it("lays moving grain over flat areas", async () => {
    // One scanline class only (rows not darkened), so the lines themselves
    // are not mistaken for noise. A flat grey without the grain decodes to
    // a near-constant; with it, the pixels scatter.
    const w = 120;
    const buf = await regionAt(crtOut, 2, 300, 441, w, 60);
    const vals: number[] = [];
    for (let row = 0; row < 60; row++) {
      if ((441 + row) % 3 === 0) continue;
      for (let col = 0; col < w; col++) vals.push(buf[(row * w + col) * 3 + 1] ?? 0);
    }
    const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length);
    expect(sd).toBeGreaterThan(3);
  }, 120_000);
});

describe("concatMusic", () => {
  it("returns the single input untouched, writing nothing", async () => {
    // THE identity: one track must not pay a pass, a temp file or a new
    // failure mode for a feature it does not use.
    const single = join(dir, "single.flac");
    expect(await concatMusic([tone440a], single)).toBe(tone440a);
    expect(existsSync(single)).toBe(false);
  });

  it("joins three tracks to their summed duration", async () => {
    const joined = join(dir, "joined.flac");
    const got = await concatMusic([tone440a, tone1760, tone440b], joined);
    expect(got).toBe(joined);
    const { seconds } = await probeAudio(joined);
    expect(seconds).toBeGreaterThan(5.8);
    expect(seconds).toBeLessThan(6.2);
  });

  it("keeps each track's own tone in its own third", async () => {
    const ordered = join(dir, "ordered.flac");
    await concatMusic([tone440a, tone1760, tone440b], ordered);
    // 1760 Hz lives in the middle two seconds alone, so the middle sample is
    // what proves the ORDER rather than merely the length.
    expect(await peakHzAt(ordered, 1.0)).toBeCloseTo(440, -2);
    expect(await peakHzAt(ordered, 3.0)).toBeCloseTo(1760, -2);
    expect(await peakHzAt(ordered, 5.0)).toBeCloseTo(440, -2);
  });

  // The clamp the spec claimed was mutation-tested and was not. All three
  // tone fixtures are 2s, so `min(TRACK_FADE, secs / 3)` is active on every
  // one of them — but the seam test below survives removing it, because both
  // numbers it compares move the wrong way to notice. Measured with the
  // clamp forced to a bare `TRACK_FADE`: its `inside` sample is t=1.0 in the
  // FIRST track, which has no fade-in at all under the `i > 0` guard and
  // reads -28 either way, while the seam reads -55.4 — so `seam < inside -
  // 10` holds by 27 dB and the clamp goes unpinned. What the clamp actually
  // moves is the MIDDLE track, which is the only one carrying both ramps: at
  // its own centre, unclamped, a 1.5s fade-in and a 1.5s fade-out multiply
  // to 0.44 and it measures -31.2 against -24.1 clamped, the 7 dB that
  // factor predicts.
  //
  // Hence a short track in the MIDDLE, for the reason
  // `server/longform.test.ts` records against the identical clamp: placed
  // first, its fade-in is suppressed by the `i > 0` guard and can never
  // overlap anything. Measured on this fixture — middle -24.1 against the
  // first track's -24 clamped, and -33 against -28 unclamped, which is what
  // the two-dB bound below reads.
  it("keeps a short middle track at full level across its own middle", async () => {
    const shortMid = join(dir, "shortmid.flac");
    await concatMusic([tone440a, toneShort, tone440b], shortMid);
    // The middle track runs [2.0, 3.8); 2.9 is its own centre, and the one
    // instant an unclamped pair of 1.5s ramps attenuates most.
    const middle = (await loudness(shortMid, 2.9, 0.1)).mean;
    // The first track's centre, as the reference for "full level" — a raw
    // dB figure would be a property of the fixture's own amplitude rather
    // than of the clamp.
    const first = (await loudness(shortMid, 1.0, 0.1)).mean;
    expect(middle).toBeGreaterThan(first - 2);
  });

  it("dips at each seam and not at the head or tail", async () => {
    const seams = join(dir, "seams.flac");
    await concatMusic([tone440a, tone1760, tone440b], seams);
    const seam = (await loudness(seams, 1.95, 0.1)).mean;
    const inside = (await loudness(seams, 1.0, 0.1)).mean;
    const head = (await loudness(seams, 0.0, 0.1)).mean;
    const tail = (await loudness(seams, 5.9, 0.1)).mean;
    expect(seam).toBeLessThan(inside - 10);
    // The mix opens and closes deliberately — fading either is fading
    // something that already starts and ends on purpose.
    expect(head).toBeGreaterThan(seam + 10);
    expect(tail).toBeGreaterThan(seam + 10);
  });
});
