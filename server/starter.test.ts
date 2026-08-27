import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OUTPUT } from "../src/geometry.ts";
import {
  END_PATH,
  VOICE,
  installedVoices,
  prependStarter,
  speak,
  starterDuration,
  synthesize,
} from "./starter.ts";

const run = promisify(execFile);

/** The clip the starter screen gets prepended to: left half green, right
 *  half red, 1 second. The hard seam down the middle is what makes the blur
 *  observable — a solid colour blurs to itself. */
const CLIP_S = 1;
const SEAM = OUTPUT.w / 2;
/** The title art's opaque corner. Away from the seam and away from the
 *  centre, so the two assertions can't be reading the same pixels. */
const ART = 100;

let dir = "";
let main = "";
let mute = "";
let anamorphic = "";
let art = "";
let voice = "";
let voiceSeconds = 0;
/** The bundled outro's own length, probed rather than hardcoded — every
 *  duration assertion below is now screen + clip + outro, and swapping the
 *  asset should move the expectation with it. */
let endSeconds = 0;

async function clip(out: string, withAudio: boolean, sar = "1/1"): Promise<void> {
  const args = [
    "-v", "error",
    "-f", "lavfi", "-i", `color=c=green:s=${SEAM}x${OUTPUT.h}:d=${CLIP_S}:r=30`,
    "-f", "lavfi", "-i", `color=c=red:s=${SEAM}x${OUTPUT.h}:d=${CLIP_S}:r=30`,
  ];
  if (withAudio) args.push("-f", "lavfi", "-i", `sine=f=440:d=${CLIP_S}`);
  args.push(
    "-filter_complex", `[0:v][1:v]hstack=inputs=2,setsar=${sar}[v]`,
    "-map", "[v]",
    ...(withAudio ? ["-map", "2:a", "-c:a", "aac"] : []),
    "-pix_fmt", "yuv420p", "-y", out,
  );
  await run("ffmpeg", args);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vstack-starter-"));
  main = join(dir, "main.mp4");
  mute = join(dir, "mute.mp4");
  // A non-square sample aspect, which is what `scale=` passes through from an
  // anamorphic source: a real export of one lands as 1080x1920 at 1214:1215.
  // 40:41 rather than that exact ratio because libx264 normalises a SAR that
  // close to square back to 1:1, which would make this fixture prove nothing.
  anamorphic = join(dir, "anamorphic.mp4");
  await clip(main, true);
  await clip(mute, false);
  await clip(anamorphic, true, "40/41");

  // The title art the client would have rendered, stood in for by a
  // transparent frame with one opaque magenta square. Written as raw RGBA and
  // encoded by ffmpeg, the same way mask.ts avoids needing a PNG encoder.
  const rgba = new Uint8Array(OUTPUT.w * OUTPUT.h * 4);
  for (let y = 0; y < ART; y++) {
    for (let x = 0; x < ART; x++) {
      const i = (y * OUTPUT.w + x) * 4;
      rgba[i] = 255;
      rgba[i + 2] = 255;
      rgba[i + 3] = 255;
    }
  }
  const raw = join(dir, "art.rgba");
  art = join(dir, "art.png");
  await writeFile(raw, rgba);
  await run("ffmpeg", [
    "-v", "error",
    "-f", "rawvideo", "-pixel_format", "rgba",
    "-video_size", `${OUTPUT.w}x${OUTPUT.h}`,
    "-i", raw, "-frames:v", "1", "-y", art,
  ]);

  voice = join(dir, "voice.aiff");
  voiceSeconds = await speak("Ăn cơm chưa bạn ơi", dir, voice);
  endSeconds = Number((await probeOut(END_PATH)).format.duration);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Reads one RGB pixel out of a frame of the encoded file. */
async function pixelAt(path: string, t: number, x: number, y: number) {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-ss", String(t), "-i", path, "-frames:v", "1",
     "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 64 << 20 },
  );
  const buf = stdout as unknown as Buffer;
  const i = (y * OUTPUT.w + x) * 3;
  return { r: buf[i] ?? 0, g: buf[i + 1] ?? 0, b: buf[i + 2] ?? 0 };
}

/** The loudest sample in `dur` seconds of audio starting at `t`, as 0..1.
 *
 *  Coarse on purpose: this is here to tell audio from silence, which is the
 *  failure that hid behind "the file has an audio stream" — the clip's own
 *  sound was being replaced wholesale by the silence stand-in and every
 *  stream-shape assertion still passed. */
async function peakAt(path: string, t: number, dur = 1): Promise<number> {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-ss", String(t), "-t", String(dur), "-i", path,
     "-f", "s16le", "-ac", "1", "-"],
    { encoding: "buffer", maxBuffer: 16 << 20 },
  );
  const buf = stdout as unknown as Buffer;
  let peak = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
  }
  return peak / 32768;
}

async function probeOut(path: string) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-show_entries", "stream=codec_type,width,height,sample_aspect_ratio",
    "-of", "json", path,
  ]);
  return JSON.parse(stdout) as {
    format: { duration: string };
    streams: {
      codec_type: string;
      width?: number;
      height?: number;
      sample_aspect_ratio?: string;
    }[];
  };
}

describe("installedVoices", () => {
  it("parses the preset table into whole names, gender, region and style", async () => {
    const voices = await installedVoices();
    expect(voices.length).toBeGreaterThan(10);
    // Names carry spaces and Vietnamese diacritics — "Thùy Dung", "Minh Đức" —
    // so the TSV split has to keep each field whole. A parser that split on
    // whitespace would halve every one of them.
    const spaced = voices.find((v) => v.name.includes(" "));
    expect(spaced?.name).toMatch(/^\S+ \S+/u);
    // Every row is fully populated: an empty region would collapse the
    // dropdown's grouping into one unnamed pile.
    for (const v of voices) {
      expect(v.gender).toMatch(/^(male|female)$/);
      expect(v.region).not.toBe("");
      expect(v.style).not.toBe("");
    }
    // The fallback voice has to be here, or checkStarter fails the boot.
    expect(voices).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: VOICE })]),
    );
  });
});

describe("speak", () => {
  it("reads the title in Vietnamese and reports a real duration", () => {
    // Six syllables — anything near zero means the engine wrote an empty file
    // and the screen would be sized around nothing.
    expect(voiceSeconds).toBeGreaterThan(0.5);
    expect(starterDuration(voiceSeconds)).toBeGreaterThan(voiceSeconds);
  });

  it("pairs argv into voices and outputs when given several jobs", async () => {
    // The variadic contract: `tts.py` walks argv in twos after the text file,
    // so an off-by-one in that stride would write one voice into the other's
    // path — or synthesise the second file with the first voice, which no
    // single-job call can catch. Both files existing with different bytes is
    // what proves the pairing held.
    const [a, b] = [join(dir, "a.wav"), join(dir, "b.wav")];
    const voices = (await installedVoices()).slice(0, 2).map((v) => v.name);
    await synthesize("Ăn cơm chưa bạn ơi", dir, [
      { voice: voices[0] ?? VOICE, out: a },
      { voice: voices[1] ?? VOICE, out: b },
    ]);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
    expect(readFileSync(a).equals(readFileSync(b))).toBe(false);
  });
});

describe("prependStarter", () => {
  it("prepends a blurred, titled screen and keeps the clip intact", async () => {
    const out = join(dir, "out.mp4");
    await prependStarter({ main, title: art, voice, voiceSeconds, out });

    // Regression: `out` used to live inside a `mkdtemp` dir that took its
    // `.still.png` away for free. Now that callers pass a real `out/` path
    // (see server/index.ts), nothing but prependStarter itself knows to
    // remove the intermediate — this fixture's own temp dir would hide the
    // leak the same way `out/` used to, so this checks the exact sibling path
    // rather than relying on `afterAll`'s sweep.
    expect(existsSync(`${out}.still.png`)).toBe(false);

    const intro = starterDuration(voiceSeconds);
    const info = await probeOut(out);
    // All three segments are re-encoded into one file, so the total is the
    // screen plus the clip plus the outro. The tolerance is an encoder's last
    // GOP, not slack for a wrong duration — and this is what fails if the
    // outro leg is ever dropped from either concat.
    expect(Number(info.format.duration)).toBeCloseTo(intro + CLIP_S + endSeconds, 1);
    const video = info.streams.find((s) => s.codec_type === "video");
    expect(video?.width).toBe(OUTPUT.w);
    expect(video?.height).toBe(OUTPUT.h);

    // The title art is opaque only in its corner, and only over the screen.
    const titled = await pixelAt(out, 0.2, ART / 2, ART / 2);
    expect(titled.r).toBeGreaterThan(200);
    expect(titled.b).toBeGreaterThan(200);
    expect(titled.g).toBeLessThan(80);

    // Inside the band, at the seam, the screen is the clip's first frame
    // blurred — so both channels are present. This is the assertion that
    // fails if the blur is dropped: an unblurred seam pixel is one pure
    // colour or the other.
    //
    // Sampled at the vertical centre, NOT near the bottom: only a band around
    // OUTPUT.h / 2 is blurred now, and a sample outside it passes on chroma
    // bleed alone — which is a test that no longer guards anything.
    const blurred = await pixelAt(out, 0.2, SEAM, OUTPUT.h / 2);
    expect(blurred.r).toBeGreaterThan(30);
    expect(blurred.g).toBeGreaterThan(30);

    // …and outside the band the frame is untouched: full strength, no blur,
    // no scrim. This is the other half of the pair — it fails if the blur
    // ever goes back to covering the whole frame, which would drag this
    // pixel down by the scrim factor.
    const sharp = await pixelAt(out, 0.2, SEAM + 200, OUTPUT.h - 100);
    expect(sharp.r).toBeGreaterThan(200);
    expect(sharp.g).toBeLessThan(60);

    // Past the screen, the clip itself, unblurred and untitled.
    const clipPixel = await pixelAt(out, intro + 0.3, SEAM + 200, OUTPUT.h - 100);
    expect(clipPixel.r).toBeGreaterThan(200);
    expect(clipPixel.g).toBeLessThan(60);
    const corner = await pixelAt(out, intro + 0.3, ART / 2, ART / 2);
    expect(corner.g).toBeGreaterThan(100);

    // The screen's three layers, each checked in a window where only it can
    // be heard. Thresholds separate signal from silence rather than naming a
    // level — silence reads below 0.0001 here.
    //
    // The title hit, at the top of the screen with the title itself. The bed
    // alone peaks three orders of magnitude below this, so only the hit
    // clears it.
    expect(await peakAt(out, 0, 0.3)).toBeGreaterThan(0.1);
    // The bed has no isolated window in this fixture any more — the title hit
    // now covers the head, and past starterDuration's 1.6s floor the voice
    // ends exactly where the cue begins. It gets its own test below, with a
    // fixture built to leave a gap.
    // The voice, over the bed.
    expect(await peakAt(out, 0.4, 0.5)).toBeGreaterThan(0.05);
    // The cue, in the tail slot the voice leaves free. Only the cue is loud
    // enough to clear this — the bed alone peaks around a tenth.
    expect(await peakAt(out, intro - 0.4, 0.3)).toBeGreaterThan(0.5);

    // And the clip keeps its own sound. This is the regression assertion:
    // `hasAudio` read the wrong ffprobe line, so every clip was treated as
    // silent and mixed against a silence stand-in. The fixture's own sine
    // peaks around 0.13 and aac shaves a little off.
    expect(await peakAt(out, intro + 0.2, 0.5)).toBeGreaterThan(0.05);

    // The outro brings its own sound. Duration alone would still pass if the
    // outro's audio leg were missing and the video leg padded — concat would
    // just run the two streams to different lengths — so the tail is checked
    // for signal too. The asset peaks around 0.59.
    expect(await peakAt(out, intro + CLIP_S + 0.5, 0.5)).toBeGreaterThan(0.05);
  });

  // The bed is the one layer with nothing to isolate it in the main fixture:
  // the title hit owns the head, and once a real spoken title pushes the
  // screen past starterDuration's 1.6s floor, the screen is exactly
  // LEAD_IN + voice + TAIL and the voice ends on the frame the cue starts.
  //
  // So this one hands prependStarter a deliberately short, silent voice. The
  // floor then applies, the voice is over by 0.55s and the cue does not begin
  // until 1.15s, which leaves a window where only the music can be playing —
  // the title hit is 40 dB down by then.
  it("keeps the music bed playing under the whole screen", async () => {
    const quiet = join(dir, "quiet.aiff");
    await run("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono",
      "-t", "0.2", "-y", quiet,
    ]);

    const out = join(dir, "bed-out.mp4");
    await prependStarter({ main, title: art, voice: quiet, voiceSeconds: 0.2, out });

    // Guard the premise rather than assume it: if the floor ever stops
    // applying here, the window below silently stops being bed-only.
    expect(starterDuration(0.2)).toBe(1.6);
    expect(await peakAt(out, 0.9, 0.2)).toBeGreaterThan(0.03);
  });

  it("squares the pixels of an anamorphic clip instead of failing to concat", async () => {
    // concat refuses a SAR mismatch rather than choosing a side, so without
    // the clip leg's setsar this is not a subtly wrong aspect — it is
    // "Nothing was written into output file". Only real footage hits it.
    const out = join(dir, "anamorphic-out.mp4");
    await prependStarter({ main: anamorphic, title: art, voice, voiceSeconds, out });
    const info = await probeOut(out);
    const video = info.streams.find((s) => s.codec_type === "video");
    expect(video?.sample_aspect_ratio).toBe("1:1");
    expect(video?.width).toBe(OUTPUT.w);
    expect(video?.height).toBe(OUTPUT.h);
  });

  it("gives a silent clip an audio track so the two segments can concat", async () => {
    const out = join(dir, "mute-out.mp4");
    await prependStarter({ main: mute, title: art, voice, voiceSeconds, out });
    const info = await probeOut(out);
    // exportClip maps audio with `0:a?`, so a silent source really does
    // produce a video-only file — and concat needs matching stream counts.
    expect(info.streams.filter((s) => s.codec_type === "audio")).toHaveLength(1);
    expect(Number(info.format.duration)).toBeCloseTo(
      starterDuration(voiceSeconds) + CLIP_S + endSeconds,
      1,
    );
    // …and the stand-in really is silence, so a silent source stays silent
    // rather than inheriting the sting's tail. The window is 0.5s, not the
    // default 1s: the fixture clip is only 1s long, and a 1s window from
    // +0.2 would spill into the outro, which has sound of its own.
    expect(await peakAt(out, starterDuration(voiceSeconds) + 0.2, 0.5)).toBeLessThan(0.01);
  });
});
