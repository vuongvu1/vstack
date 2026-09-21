import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeAudio, probeFile } from "./ffmpeg.ts";
import {
  FADE,
  LOGO_RECT,
  SPIN_SECONDS,
  VIZ_BAR,
  VIZ_RECT,
  concatMusic,
  parseProgress,
  renderLofi,
  renderProgress,
} from "./lofi.ts";

const run = promisify(execFile);

/** The render's own shape, for the corner assertions below. Not imported
 *  from `WIDE` because this file already hardcodes 1920 in `pixelAt`. */
const WIDE_W = 1920;
const WIDE_H = 1080;

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
/** Three 2s tones for `concatMusic`'s own fixtures — see the tests below for
 *  why the frequencies rather than the lengths are what prove the order. */
let tone440a = "";
let tone1760 = "";
let tone440b = "";

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

  out = join(dir, "out.mp4");
  // One speech at t=12, well clear of both ends. Deliberately the VIDEO
  // fixture: the render this whole describe block measures is the one whose
  // speech has a picture to suppress.
  await renderLofi({ background: bg, music, cuts: [{ path: speech, at: 12 }], out });
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

/** Mean brightness over the columns of a region that satisfy `keep`.
 *
 *  Column-wise rather than whole-region because that is the only way to see
 *  the GAPS: a band with no gaps and a band with them have similar overall
 *  means, and differ entirely in how that brightness is distributed across
 *  each bar's slot. */
function columnMean(
  buf: Buffer, w: number, h: number, keep: (x: number) => boolean,
): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!keep(x)) continue;
      const i = (y * w + x) * 3;
      sum += ((buf[i] ?? 0) + (buf[i + 1] ?? 0) + (buf[i + 2] ?? 0)) / 3;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/** Mean absolute per-channel difference between two equal-sized boxes.
 *
 *  The scale that matters here was measured on a real render: two samples of
 *  the SAME orientation differ by 1.6 (libx264 being lossy, nothing more),
 *  and any two different orientations of this mark differ by 15 to 20. The
 *  thresholds below sit in that gap with room on both sides. */
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
    const pending = renderLofi({ background: bg, music, cuts: [], out: out2 });
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
    const dur = await audioStreamDuration(out);
    expect(dur).toBeGreaterThan(29.5);
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
      renderLofi({
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
    await renderLofi({
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
    await renderLofi({
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
    await renderLofi({ background: bg, music, cuts: [{ path: silent, at: 12 }], out: quiet });
    const probed = await probeFile(quiet);
    expect(probed.hasAudio).toBe(true);
    expect(probed.seconds).toBeGreaterThan(29.5);
    expect(await audioStreamDuration(quiet)).toBeGreaterThan(29.5);
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
    await renderLofi({
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
  it("puts the logo rect in the top-right corner", () => {
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

  it("draws the mark in that rect and nowhere else", async () => {
    const { x, y, side } = LOGO_RECT;
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

    // And the MIRRORED box on the left is untouched, which is what makes
    // this a corner assertion rather than an "is it anywhere" one. Dropping
    // the overlay's x offset to 0 fails here rather than above.
    const mirrored = await boxAt(out, 4, WIDE_W - x - side, y, side);
    expect(boxDiff(mirrored, flat)).toBeLessThan(2);
  }, 120_000);

  it(`turns once every ${SPIN_SECONDS}s`, async () => {
    const { x, y, side } = LOGO_RECT;
    const at = (t: number) => boxAt(out, t, x, y, side);
    const zero = await at(0);

    // A quarter turn and a half turn must both look different. The HALF turn
    // is the one that pins the period: at SPIN_SECONDS / 2 a mark spinning
    // twice as fast would be back at its starting angle and match, so
    // without this sample a 5s period passes every other assertion here.
    expect(boxDiff(zero, await at(SPIN_SECONDS / 4))).toBeGreaterThan(10);
    expect(boxDiff(zero, await at(SPIN_SECONDS / 2))).toBeGreaterThan(10);

    // And a full turn brings it back. Measured at 1.6 on a real render —
    // pure encoder noise — against 15-20 for any other angle, so this bound
    // is nowhere near either side. A 20s period fails here.
    expect(boxDiff(zero, await at(SPIN_SECONDS))).toBeLessThan(6);
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

  // Sampled over the band's BOTTOM 120px rather than all 360 of it, and the
  // thresholds are small on purpose. Bars are lit from the bottom and thin
  // out upward, so averaged over the whole band their contribution is +0.9
  // over the flat background — real, but too close to the noise to assert
  // on. Over the bottom 120 it is +2.5, which is the same signal measured
  // where it lives. Every number below was measured on this fixture.
  const BAND_SAMPLE = 120;
  const FLAT = (0x10 + 0x80 + 0x80) / 3;

  it("draws bars in the band and leaves the rest of the frame alone", async () => {
    const { x, y, w, h } = VIZ_RECT;
    const band = await regionAt(out, 4, x, y + h - BAND_SAMPLE, w, BAND_SAMPLE);
    // +2.5 measured; the bound is well under it and well over the +0.0 a
    // render with no visualiser gives.
    expect(columnMean(band, w, BAND_SAMPLE, () => true)).toBeGreaterThan(FLAT + 1.5);

    // The strip directly ABOVE the band carries no bars, which is what makes
    // this "along the bottom" rather than "somewhere in the frame". Stated
    // as "no brighter than the background" rather than "equal to it":
    // libx264 decodes the flat teal about 0.7 under its source value, and
    // that rounding is not what this test is about.
    const above = await regionAt(out, 4, x, y - 200, w, 150);
    expect(columnMean(above, w, 150, () => true)).toBeLessThan(FLAT + 0.5);
  }, 120_000);

  it("leaves a gap between neighbouring bars", async () => {
    // `gifsync`'s bars fill 70% of their slot. Measured here: lit columns
    // sit +3.8 over the background and gap columns -0.6, i.e. the gaps are
    // background to within chroma-subsampling noise. Dropping the masking
    // expression makes the two equal.
    const { x, y, w, h } = VIZ_RECT;
    const band = await regionAt(out, 4, x, y + h - BAND_SAMPLE, w, BAND_SAMPLE);
    const isBar = (c: number) => c % VIZ_BAR.slot < VIZ_BAR.fill;
    // Both sets non-empty, or the comparison below is vacuous — see the
    // geometry test above for the mutation that made it so.
    const cols = Array.from({ length: w }, (_, c) => c);
    expect(cols.filter(isBar).length).toBeGreaterThan(0);
    expect(cols.filter((c) => !isBar(c)).length).toBeGreaterThan(0);

    const inBar = columnMean(band, w, BAND_SAMPLE, isBar);
    const inGap = columnMean(band, w, BAND_SAMPLE, (c) => !isBar(c));
    expect(inBar - FLAT).toBeGreaterThan(2);
    expect(inGap - FLAT).toBeLessThan(1);
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
    // Measured at +0.2 quiet against +18.6 under the speech, so the bound
    // has an order of magnitude of room on both sides.
    expect(columnMean(loud, half, BAND_SAMPLE, () => true)).toBeGreaterThan(
      columnMean(quiet, half, BAND_SAMPLE, () => true) + 8,
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
    await renderLofi({ background: bg, music, cuts: [{ path: silent, at: 12 }], out: crackly });

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
