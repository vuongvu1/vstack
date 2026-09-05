import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeFile } from "./ffmpeg.ts";
import { END_PATH } from "./starter.ts";
import {
  FADE,
  MIN_KEPT,
  TRANSITION_PATH,
  TRANSITION_PEAK,
  checkLongform,
  detectTrim,
  keptRange,
  stackWide,
} from "./longform.ts";

const run = promisify(execFile);

let dir = "";
let red = "";
let blue = "";
let wide = "";
/** A realistic vstack short: a static starter screen, a moving body, and
 *  the real bundled outro. */
let full = "";
/** The same, minus the outro — an "old short", made before that asset
 *  existed. This is the fixture the tail detector has to say no to. */
let headless = "";
/** Neither: a raw upload that never went through this app. */
let raw = "";
let outroSeconds = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vstack-long-"));

  // Two 1080x1920 vertical parts in different colours, both with audio. The
  // colours are what make the leg ORDER testable: reversing the concat gives
  // blue-then-red and the second sample fails.
  red = join(dir, "red.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=red:s=1080x1920:d=2:r=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-y", red,
  ]);

  // Deliberately silent: the anullsrc stand-in is exercised by the first
  // test rather than by one of its own, because a missing audio leg makes
  // the concat filter's leg count disagree with n= and fail outright.
  blue = join(dir, "blue.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=blue:s=1080x1920:d=2:r=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-y", blue,
  ]);

  // A 16:9 part, to prove an upload that is NOT vertical still lands inside
  // the frame rather than overflowing it.
  wide = join(dir, "wide.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=green:s=1920x1080:d=2:r=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-y", wide,
  ]);

  // A vstack short is starter + body + outro. The starter screen is ONE
  // composited frame repeated, which is what `freezedetect` isolates; the
  // body has to move, or the head scan would run straight through it.
  const starter = join(dir, "starter.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=navy:s=1080x1920:d=1.8:r=30",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", "1.8",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-y", starter,
  ]);
  const body = join(dir, "body.mp4");
  await run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=s=1080x1920:d=6:r=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    "-y", body,
  ]);

  // Concatenated the way `prependStarter` does it, so the fixtures carry the
  // same normalisation a real export's legs get.
  const join3 = async (out: string, parts: string[]) => {
    const n = parts.length;
    const v = parts.map((_, i) => `[${i}:v]fps=30,setsar=1[v${i}]`).join(";");
    const a = parts.map((_, i) => `[${i}:a]aresample=44100[a${i}]`).join(";");
    const labels = parts.map((_, i) => `[v${i}][a${i}]`).join("");
    await run("ffmpeg", [
      "-v", "error",
      ...parts.flatMap((p) => ["-i", p]),
      "-filter_complex", `${v};${a};${labels}concat=n=${n}:v=1:a=1[v][o]`,
      "-map", "[v]", "-map", "[o]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
      "-y", out,
    ]);
  };

  full = join(dir, "full-short.mp4");
  await join3(full, [starter, body, END_PATH]);

  headless = join(dir, "old-short.mp4");
  await join3(headless, [starter, body]);

  // Faint noise on the still, then motion. This is the fixture that proves
  // `-60dB` isolates a SYNTHESISED still rather than merely a static-looking
  // one: a `color=` source emits bit-identical frames, which no camera ever
  // does, and at -60dB real footage does not freeze at all.
  const noisy = join(dir, "noisy-still.mp4");
  await run("ffmpeg", [
    "-v", "error",
    // The noise is part of the lavfi graph, not a -vf on the output: with two
    // inputs an output filter needs an explicit -map, and this reads as what
    // it is — a noisy source rather than a clean one that got dirtied.
    "-f", "lavfi", "-i", "color=c=maroon:s=1080x1920:d=3:r=30,noise=alls=6:allf=t",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", "3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
    "-c:a", "aac",
    "-y", noisy,
  ]);
  raw = join(dir, "raw-upload.mp4");
  await join3(raw, [noisy, body]);

  outroSeconds = (await probeFile(END_PATH)).seconds;
  // Explicit timeout: these fixtures are seven real encodes, two of them
  // concatenating the bundled outro, and vitest's default hook timeout is
  // 10s. It passes in isolation and times out in the full suite, where the
  // files run in parallel and compete for CPU — so the default is not a
  // budget this setup can rely on.
}, 180_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** One frame at `t`, decoded to raw RGB, sampled at (x, y). Thresholds
 *  rather than equality everywhere it is used: libx264 is lossy, so a solid
 *  red source frame comes back at r=254 rather than r=255. */
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

/** Mean and peak volume in dB over a window, the same measurement
 *  `server/starter.test.ts` uses to check one audio layer at a time. -91 dB
 *  is ffmpeg's floor for digital silence.
 *
 *  `max` matters as much as `mean` here: a transition swell is a transient,
 *  so its mean over any window wide enough to contain it is dominated by the
 *  programme either side. Measured on a two-part render, the swell moves the
 *  0.2s window over the cut by 12.9 dB of PEAK and 4.4 dB of mean. */
async function loudness(path: string, t: number, dur: number) {
  const { stderr } = await run(
    "ffmpeg",
    ["-hide_banner", "-ss", String(t), "-t", String(dur), "-i", path,
     "-map", "0:a", "-af", "volumedetect", "-f", "null", "-"],
  );
  const mean = /mean_volume: (-?[0-9.]+) dB/.exec(stderr);
  const max = /max_volume: (-?[0-9.]+) dB/.exec(stderr);
  return { mean: mean ? Number(mean[1]) : -91, max: max ? Number(max[1]) : -91 };
}

describe("FADE", () => {
  // The tests below hardcode the [1.5, 2.5] window this constant produces on
  // a pair of 2s parts. Retuning FADE moves that window, so this is the
  // assertion that tells you which tests to re-check rather than leaving
  // them to fail obscurely.
  it("is the 0.5s the boundary samples assume", () => {
    expect(FADE).toBe(0.5);
  });
});

describe("keptRange", () => {
  const none = { head: 0, tail: 0 };

  it("is the identity with nothing detected", () => {
    expect(keptRange(30, none, false)).toEqual({ ss: 0, dur: 30 });
    expect(keptRange(30, none, true)).toEqual({ ss: 0, dur: 30 });
  });

  // The starter goes from EVERY part, including the first and the last. A
  // part's title card announces that part, and the compilation's own title
  // is in the publish panel with a thumbnail the user picked — so no card is
  // doing a job any more, and part one's would mislabel the whole video.
  it("takes the head off every part, the last one included", () => {
    expect(keptRange(30, { head: 1.8, tail: 0 }, false)).toEqual({ ss: 1.8, dur: 28.2 });
    expect(keptRange(30, { head: 1.8, tail: 0 }, true)).toEqual({ ss: 1.8, dur: 28.2 });
  });

  // The outro is the other way round: the last part keeps it, because it is
  // the finished video's own ending.
  it("takes the tail off every part but the last", () => {
    expect(keptRange(30, { head: 0, tail: 5.04 }, false)).toEqual({ ss: 0, dur: 24.96 });
    expect(keptRange(30, { head: 0, tail: 5.04 }, true)).toEqual({ ss: 0, dur: 30 });
  });

  it("takes both off a middle part", () => {
    const r = keptRange(30, { head: 1.8, tail: 5.04 }, false);
    expect(r.ss).toBeCloseTo(1.8, 5);
    expect(r.dur).toBeCloseTo(23.16, 5);
  });

  it("takes only the head off the last part", () => {
    const r = keptRange(30, { head: 1.8, tail: 5.04 }, true);
    expect(r.ss).toBeCloseTo(1.8, 5);
    expect(r.dur).toBeCloseTo(28.2, 5);
  });

  // The backstop. Detection means we now only cut what was actually found,
  // so this is far less likely to fire than it was when the tail was
  // assumed — but a part that IS almost entirely starter and outro would
  // still come back at zero or negative seconds, which ffmpeg reads as "no
  // frames" and `concat` reads as a missing leg.
  it("keeps a part whole rather than cutting it below MIN_KEPT", () => {
    expect(keptRange(6, { head: 1.8, tail: 5.04 }, false)).toEqual({ ss: 0, dur: 6 });
    expect(keptRange(2, { head: 1.8, tail: 0 }, false)).toEqual({ ss: 0, dur: 2 });
  });

  it("floors at MIN_KEPT rather than at zero", () => {
    // 7.8 - 1.8 - 5.04 = 0.96, under the floor: whole part.
    expect(keptRange(7.8, { head: 1.8, tail: 5.04 }, false)).toEqual({ ss: 0, dur: 7.8 });
    // 7.84 - 1.8 - 5.04 = 1.0, exactly the floor: cut.
    const r = keptRange(7.84, { head: 1.8, tail: 5.04 }, false);
    expect(r.dur).toBeCloseTo(MIN_KEPT, 5);
  });
});

describe("detectTrim", () => {
  // The whole point of detecting rather than assuming: this is what a real
  // vstack short looks like, and both ends are found.
  it("finds the starter and the outro on a vstack short", async () => {
    const { seconds } = await probeFile(full);
    const trim = await detectTrim(full, seconds, END_PATH, outroSeconds);
    expect(trim.head).toBeCloseTo(1.8, 1);
    expect(trim.tail).toBeCloseTo(outroSeconds, 5);
  }, 120_000);

  // THE REGRESSION. A short made before the outro asset existed has no
  // outro, and the previous rule stripped one anyway — 5.04s of real
  // content off the end of every part but the last, silently. The head is
  // still found, because that short does have a starter.
  it("finds no outro on an old short that never had one", async () => {
    const { seconds } = await probeFile(headless);
    const trim = await detectTrim(headless, seconds, END_PATH, outroSeconds);
    expect(trim.head).toBeCloseTo(1.8, 1);
    expect(trim.tail).toBe(0);
  }, 120_000);

  // A file this app never touched. Neither end is cut — and the head is 0
  // even though the part opens on three seconds of a locked-off shot,
  // because at -60dB real footage does not freeze. That is the assertion
  // that fails if the threshold is loosened to -40dB.
  it("finds neither end on a raw upload that opens on a static shot", async () => {
    const { seconds } = await probeFile(raw);
    const trim = await detectTrim(raw, seconds, END_PATH, outroSeconds);
    expect(trim.head).toBe(0);
    expect(trim.tail).toBe(0);
  }, 120_000);

  // The outro asset alone is all outro and no starter. Nothing here should
  // be confused by a part whose entire length is the thing being matched —
  // `keptRange`'s MIN_KEPT is what stops it rendering to nothing.
  it("matches the outro asset against itself", async () => {
    const trim = await detectTrim(END_PATH, outroSeconds, END_PATH, outroSeconds);
    expect(trim.tail).toBeCloseTo(outroSeconds, 5);
    expect(keptRange(outroSeconds, trim, false)).toEqual({ ss: 0, dur: outroSeconds });
  }, 120_000);
});

describe("the transition sound", () => {
  it("is bundled where the render expects it", async () => {
    await expect(checkLongform()).resolves.toBeUndefined();
    // NOT probeFile: that demands a video stream and this asset is audio
    // only, so it throws "ffprobe found no video stream".
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "a",
      "-show_entries", "stream=codec_type", "-of", "csv=p=0", TRANSITION_PATH,
    ]);
    expect(stdout.trim()).toBe("audio");
  });

  // The sound is mixed over the finished concat at absolute times, NOT into
  // a part's own leg — a leg is faded out at exactly the moment the sound
  // needs to be heard, and `concat` would cut it at the boundary anyway.
  //
  // Two 2s parts, so the only boundary is t=2 and the dip spans [1.5, 2.5].
  // Without the sound that window is the quietest part of the render (both
  // legs are faded to silence through it); with the sound it is the LOUDEST.
  it("fills the dip that the fades leave silent", async () => {
    const out = join(dir, "whoosh.mp4");
    await stackWide([red, red], out);

    // A 0.2s window straddling the cut. The fades span [1.5, 2.5], so the
    // programme is at its quietest here and the swell has the window almost
    // to itself. Measured: peak -35.0 dB without the sound against -22.1
    // with it, and -22.1 is the asset's OWN peak — which is what proves the
    // swell is placed by TRANSITION_PEAK and lands dead on the boundary
    // rather than a second late.
    const cut = await loudness(out, 1.9, 0.2);
    expect(cut.max).toBeGreaterThan(-28);

    // And the parts keep their own level: `amix` defaults to dividing every
    // input by the count, which would halve the whole render's volume just
    // for carrying one swell. Measured -24.1 dB mean either way, so
    // `normalize=0` is what this pins.
    const body = await loudness(out, 0.4, 0.5);
    expect(body.mean).toBeGreaterThan(-27);
    expect(body.max).toBeGreaterThan(-24);
  }, 120_000);

  // `amix` defaults to `duration=longest`, and a sound delayed to land on
  // the last boundary can outrun the programme — the asset is 2.6s and only
  // its first 1.6s is audible, so the tail would silently extend the render
  // past the duration `outName` already committed to.
  it("does not extend the output past the parts' own length", async () => {
    // SHORT parts, and that is the whole point of this test. The asset is
    // 2.61s long; with two 2s parts the swell lands at 0.8s and finishes at
    // 3.41s, comfortably inside the 4s render, so `duration=longest` would
    // pass unnoticed. Two 1.2s parts put the boundary at 1.2s, the swell
    // starts at 0 (the delay clamps) and runs to 2.61s against a 2.4s
    // programme — so `longest` extends the render past the duration
    // `outName` has already committed to, and `first` does not.
    const brief = join(dir, "brief-part.mp4");
    await run("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "color=c=red:s=1080x1920:d=1.2:r=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      "-y", brief,
    ]);

    const out = join(dir, "whoosh-len.mp4");
    await stackWide([brief, brief], out);

    const probed = await probeFile(out);
    expect(probed.seconds).toBeGreaterThan(2.3);
    // 2.4s programme against a 2.61s swell: this is the assertion that
    // fails at `duration=longest`.
    expect(probed.seconds).toBeLessThan(2.55);
  }, 120_000);

  // A one-part stack has no boundary, so no sound input is appended at all.
  // This is the branch that fails if the graph references an input it never
  // declared.
  it("adds no sound to a stack with no boundary", async () => {
    const out = join(dir, "whoosh-lone.mp4");
    await stackWide([red], out);

    const probed = await probeFile(out);
    expect(probed.hasAudio).toBe(true);
    expect(probed.seconds).toBeGreaterThan(1.8);
    expect(probed.seconds).toBeLessThan(2.2);
  }, 120_000);

  // The asset opens on roughly 0.6s of near-silence and peaks at
  // TRANSITION_PEAK, so it is placed by its PEAK rather than its start — a
  // delay of `boundary` would land the swell a whole second after the cut.
  // This pins the constant the placement arithmetic depends on.
  it("peaks where TRANSITION_PEAK says it does", async () => {
    const atPeak = await loudness(TRANSITION_PATH, TRANSITION_PEAK - 0.15, 0.3);
    const atStart = await loudness(TRANSITION_PATH, 0, 0.3);
    expect(atPeak.mean).toBeGreaterThan(atStart.mean + 20);
  }, 120_000);
});

describe("stackWide", () => {
  it("widens two vertical parts onto their own blurred backgrounds, in order", async () => {
    const out = join(dir, "stack.mp4");
    await stackWide([red, blue], out);

    const probed = await probeFile(out);
    expect(probed.width).toBe(1920);
    expect(probed.height).toBe(1080);
    expect(probed.seconds).toBeGreaterThan(3.5);
    expect(probed.seconds).toBeLessThan(4.5);
    // The second part is silent, so this is also the anullsrc stand-in's
    // assertion: without it the concat filter's leg count disagrees with n=.
    expect(probed.hasAudio).toBe(true);

    // Centre of the frame is the letterboxed foreground at full saturation.
    const early = await pixelAt(out, 1, 960, 540);
    expect(early.r).toBeGreaterThan(150);
    expect(early.g).toBeLessThan(80);
    expect(early.b).toBeLessThan(80);

    // ORDER. Reversing stackWide's legs gives blue here and fails.
    const late = await pixelAt(out, 3, 960, 540);
    expect(late.b).toBeGreaterThan(150);
    expect(late.r).toBeLessThan(80);
    expect(late.g).toBeLessThan(80);

    // A 1080x1920 part fits 1920x1080 as 608x1080 centred, so x=20 is
    // background. NOT BLACK is the whole point: if the blur leg were
    // dropped the graph would pillarbox and these would all be near zero.
    // Each edge carrying its OWN part's colour is what proves the
    // background tracks the part it belongs to rather than being shared.
    const edgeEarly = await pixelAt(out, 1, 20, 540);
    expect(edgeEarly.r).toBeGreaterThan(80);

    const edgeLate = await pixelAt(out, 3, 20, 540);
    expect(edgeLate.b).toBeGreaterThan(80);
  }, 120_000);

  it("fits a part that is not vertical instead of overflowing the frame", async () => {
    const out = join(dir, "mixed.mp4");
    await stackWide([red, wide], out);

    const probed = await probeFile(out);
    expect(probed.width).toBe(1920);
    expect(probed.height).toBe(1080);

    // A 16:9 part fills the frame edge to edge, so the centre is its colour.
    const mid = await pixelAt(out, 3, 960, 540);
    expect(mid.g).toBeGreaterThan(100);
    expect(mid.r).toBeLessThan(90);
  }, 120_000);

  // Pins the anySilent === false branch: no anullsrc input is appended at
  // all, so every leg's audio comes straight from its own part (`i:a`).
  // This is the PRODUCTION-COMMON case — every part vstack itself exports
  // has audio — and the one that fails if the no-anullsrc input-index
  // arithmetic is ever broken.
  it("stacks two sounded parts with no anullsrc input at all", async () => {
    const out = join(dir, "both-sound.mp4");
    await stackWide([red, red], out);

    const probed = await probeFile(out);
    expect(probed.width).toBe(1920);
    expect(probed.height).toBe(1080);
    expect(probed.hasAudio).toBe(true);
    expect(probed.seconds).toBeGreaterThan(3.5);
    expect(probed.seconds).toBeLessThan(4.5);
  }, 120_000);

  // Pins the shared-anullsrc branch with MORE THAN ONE silent leg: both
  // parts' audio legs reference the same anullsrc input label. This is the
  // case that fails if the shared label cannot be referenced twice.
  it("stacks two silent parts off one shared anullsrc input", async () => {
    const out = join(dir, "both-silent.mp4");
    await stackWide([blue, blue], out);

    const probed = await probeFile(out);
    expect(probed.width).toBe(1920);
    expect(probed.height).toBe(1080);
    expect(probed.hasAudio).toBe(true);
    expect(probed.seconds).toBeGreaterThan(3.5);
    expect(probed.seconds).toBeLessThan(4.5);
  }, 120_000);

  // The outro strip. Both parts are 2s; a 0.8s tail leaves 1.2 + 2 = 3.2.
  // The two failure modes this pins are both a whole tail away: not
  // stripping at all is 4.0, and stripping the LAST part too is 2.4.
  it("takes the tail off every part but the last", async () => {
    const out = join(dir, "stripped.mp4");
    const t = { head: 0, tail: 0.8 };
    await stackWide([red, red], out, [t, t]);

    const probed = await probeFile(out);
    expect(probed.seconds).toBeGreaterThan(3.0);
    expect(probed.seconds).toBeLessThan(3.4);
  }, 120_000);

  // A single part is the last part, so its outro stays — the tail must not
  // shorten a one-part stack.
  it("leaves a lone part's outro alone however big the tail", async () => {
    const out = join(dir, "lone.mp4");
    await stackWide([red], out, [{ head: 0, tail: 0.8 }]);

    const probed = await probeFile(out);
    expect(probed.seconds).toBeGreaterThan(1.8);
    expect(probed.seconds).toBeLessThan(2.2);
  }, 120_000);

  // The head strip, end to end. Each part is a 1s navy "starter" followed
  // by 2s of its own colour, and `head: 1` should leave only the colour —
  // so t=0 is the FIRST part's colour rather than navy. Sampling at t=0.05
  // works because part one has no fade-in (the `i > 0` guard).
  it("cuts the head off every part, so the output opens on the body", async () => {
    const cap = async (colour: string) => {
      const p = join(dir, `cap-${colour}.mp4`);
      await run("ffmpeg", [
        "-v", "error",
        "-f", "lavfi", "-i", "color=c=navy:s=1080x1920:d=1:r=30",
        "-f", "lavfi", "-i", `color=c=${colour}:s=1080x1920:d=2:r=30`,
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map", "[v]", "-map", "2:a",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        "-y", p,
      ]);
      return p;
    };
    const one = await cap("red");
    const two = await cap("lime");

    const out = join(dir, "headless-stack.mp4");
    const t = { head: 1, tail: 0 };
    await stackWide([one, two], out, [t, t]);

    // 3s each, 1s of head off both: 2 + 2 = 4.
    const probed = await probeFile(out);
    expect(probed.seconds).toBeGreaterThan(3.8);
    expect(probed.seconds).toBeLessThan(4.2);

    // Navy is (0, 0, 128). Red here instead is the whole assertion: without
    // the `-ss` the output would open on the starter screen.
    const head = await pixelAt(out, 0.05, 960, 540);
    expect(head.r).toBeGreaterThan(150);
    expect(head.b).toBeLessThan(80);

    // And the SECOND part's head is cut too — at t=2.05 (just past the
    // boundary and its fade) the frame is lime, not navy.
    const later = await pixelAt(out, 2.6, 960, 540);
    expect(later.g).toBeGreaterThan(150);
    expect(later.b).toBeLessThan(90);
  }, 120_000);

  // The transition. Both parts are 2s, so the boundary sits at t=2 with a
  // 0.5s fade-out before it and a 0.5s fade-in after. The seam is near black
  // and both parts keep full colour outside the window — dropping either
  // fade leaves that seam at full saturation.
  it("dips to black between parts and only between them", async () => {
    const out = join(dir, "faded.mp4");
    await stackWide([red, red], out);

    // Duration is untouched: a dip costs no screen time, which is what keeps
    // `outName`'s duration and the render in agreement.
    const probed = await probeFile(out);
    expect(probed.seconds).toBeGreaterThan(3.8);
    expect(probed.seconds).toBeLessThan(4.2);

    // The seam. Sampled just inside part one's tail rather than exactly at
    // t=2, which lands on the first frame of part two — the fade-in's own
    // st=0, also black, but for the other part's reason.
    const seam = await pixelAt(out, 1.97, 960, 540);
    expect(seam.r).toBeLessThan(60);
    expect(seam.g).toBeLessThan(60);
    expect(seam.b).toBeLessThan(60);

    // Well inside each part, outside the [1.5, 2.5] window: full colour.
    for (const t of [1.0, 3.0]) {
      const mid = await pixelAt(out, t, 960, 540);
      expect(mid.r).toBeGreaterThan(150);
    }

    // NOT at the ends. The compilation opens on a title card and closes on
    // the bundled outro, both of which already start and end deliberately —
    // so fading them would be fading something that needs no help.
    const head = await pixelAt(out, 0.05, 960, 540);
    expect(head.r).toBeGreaterThan(150);
    const tail = await pixelAt(out, 3.9, 960, 540);
    expect(tail.r).toBeGreaterThan(150);
  }, 120_000);

  // A part shorter than two fades would otherwise have its fade-in overlap
  // its fade-out, which reads as a part that never reaches full brightness
  // rather than as a transition. `seconds / 3` is the clamp.
  //
  // The short part goes in the MIDDLE, and that placement is the whole test:
  // only a part with a neighbour on BOTH sides gets both fades, so a brief
  // part placed first has its fade-in suppressed by the `i > 0` guard and
  // can never overlap anything. Found by mutation testing — the first
  // version of this test put it first and passed with the clamp removed.
  it("shrinks the fade rather than overlapping it on a very short middle part", async () => {
    const brief = join(dir, "brief.mp4");
    await run("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "color=c=red:s=1080x1920:d=0.3:r=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      "-y", brief,
    ]);

    const out = join(dir, "brief-stack.mp4");
    await stackWide([blue, brief, blue], out);

    // The brief part occupies [2.0, 2.3]. Clamped, its fades are 0.1s, so
    // 2.15 sits between them at full colour.
    //
    // Unclamped, this test fails LOUDLY rather than darkly at today's FADE:
    // a 0.5s fade over a 0.3s part puts the fade-out's `st` at -0.2 and
    // ffmpeg refuses the graph outright (`Error: ffmpeg failed:`). Below
    // `2 * FADE` it would instead fail on the pixel, the two ramps
    // multiplying to roughly quarter brightness. Both are the same defect —
    // a part too short for its own transition — so this assertion is
    // deliberately on the colour, which catches it at either FADE.
    const peak = await pixelAt(out, 2.15, 960, 540);
    expect(peak.r).toBeGreaterThan(150);
  }, 120_000);

  it("refuses an empty part list", async () => {
    await expect(stackWide([], join(dir, "never.mp4"))).rejects.toThrow(/at least one/);
  });
});
