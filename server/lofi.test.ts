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
