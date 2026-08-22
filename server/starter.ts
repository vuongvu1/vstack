import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { toolError } from "./errors.ts";

const run = promisify(execFile);

const asset = (name: string) => fileURLToPath(new URL(`assets/${name}`, import.meta.url));

/** The bed under the whole starter screen. Long (2m36s) and trimmed to the
 *  screen by an input `-t`, so only the seconds actually used get decoded. */
export const MUSIC_PATH = asset("starter-music.mp3");

/** The cue that lands after the voice, right before the cut to the clip.
 *  Both ship next to this module rather than in `media/`, which is the
 *  gitignored clip cache. */
export const CUE_PATH = asset("before-video-start-sound.mp3");

/** The voice that reads the title. `Linh` is macOS' Vietnamese voice and the
 *  only one installed for vi_VN by default — the novelty family (Eddy, Flo,
 *  Rocko…) ships for 14 locales and Vietnamese is not among them.
 *
 *  Overridable so picking a different one costs no code edit: audition with
 *  `pnpm voices`, then `VSTACK_VOICE="<name>" pnpm server`. Checked at boot
 *  (`checkStarter`), because a name that `say` does not know is an install or
 *  typo problem, not an export-time surprise. */
export const VOICE = process.env.VSTACK_VOICE ?? "Linh";

/** The screen's shape: music alone, then the voice, then the cue.
 *
 *  `TAIL` is the cue's slot, so it has to cover the cue's own length (0.43s)
 *  — a longer cue file would be clipped at the cut rather than pushing the
 *  clip later, which is the right trade for a fixed asset but worth knowing.
 *  `LEAD_IN` is the beat of music before the title is spoken. */
const LEAD_IN = 0.35;
const TAIL = 0.45;
/** A one-word title reads in ~0.5s, which is too fast to register as a
 *  screen at all. */
const MIN_DURATION = 1.6;
const BLUR_SIGMA = 30;
/** The music is a bed under a voice, so it sits well below it. The cue is a
 *  transition, not scenery, so it does not. */
const MUSIC_GAIN = 0.35;
/** Where in the track the bed starts.
 *
 *  ponytail: 0 plays the file from its beginning, which is the least
 *  surprising default — but the screen is only a couple of seconds long, so it
 *  hears whatever the track opens with. The bundled one opens on a soft intro
 *  (mean -14 dB at 0:00 against -3 dB by 0:20), so raise this to drop into a
 *  livelier bar, or raise MUSIC_GAIN. This and the gain are the two knobs. */
const MUSIC_START = 0;
const CUE_GAIN = 0.9;
/** Long enough not to click, short enough to still be under the cue. */
const MUSIC_FADE = 0.35;
/** Every leg going into `concat` is forced to this, so the two segments'
 *  audio parameters match rather than happening to. */
const RATE = 48_000;

export function starterDuration(voiceSeconds: number): number {
  return Math.max(MIN_DURATION, LEAD_IN + voiceSeconds + TAIL);
}

/** Boot check: the voice and the sting. Both are hard requirements of every
 *  export, so a missing one should stop the server rather than fail the
 *  render after the download and the encode have already been paid for. */
export async function checkStarter(): Promise<void> {
  for (const path of [MUSIC_PATH, CUE_PATH]) {
    if (!existsSync(path)) {
      console.error(`vstack: starter audio missing at ${path}.`);
      process.exit(1);
    }
  }
  let voices: Voice[];
  try {
    voices = await installedVoices();
  } catch {
    console.error('vstack: "say" not found — the starter screen needs macOS text-to-speech.');
    process.exit(1);
  }
  if (!voices.some((v) => v.name === VOICE)) {
    console.error(
      `vstack: "say" has no voice named ${VOICE}. Fix: install it under System ` +
        "Settings → Accessibility → Spoken Content → System Voice → Manage " +
        "Voices…, or pick one you have with `pnpm voices`.",
    );
    process.exit(1);
  }
}

export type Voice = { name: string; locale: string };

/** Every voice `say` can use, as name + locale.
 *
 *  Parsed rather than grepped because a voice name can contain spaces and
 *  parentheses — "Eddy (English (US))" — so the locale token is the only
 *  reliable delimiter, and matching a name by regex would mean escaping it.
 *  Shared by `checkStarter` and the audition script so there is one parser. */
export async function installedVoices(): Promise<Voice[]> {
  let stdout: string;
  try {
    ({ stdout } = await run("say", ["-v", "?"], { maxBuffer: 1 << 20 }));
  } catch (err) {
    throw toolError("say", err);
  }
  const voices: Voice[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(.+?)\s+([a-z]{2}_[A-Z]{2})\s/.exec(line);
    if (m?.[1] && m[2]) voices.push({ name: m[1].trim(), locale: m[2] });
  }
  return voices;
}

/** Reads the title aloud into `out` (AIFF) and returns its duration.
 *
 *  The text goes via a file, not argv: `say -f` cannot mistake a title that
 *  starts with "-" for an option, and there is no argv length ceiling to
 *  think about. `execFile` means no shell either way. */
export async function speak(text: string, dir: string, out: string): Promise<number> {
  const script = join(dir, "title.txt");
  await writeFile(script, text, "utf8");
  try {
    await run("say", ["-v", VOICE, "-f", script, "-o", out]);
  } catch (err) {
    throw toolError("say", err);
  }
  const data = (await probeJson(out, ["format=duration"])) as Probed;
  const seconds = Number(data.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`say produced no audible title (${out}).`);
  }
  return seconds;
}

async function probeJson(path: string, entries: string[]): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await run("ffprobe", [
      "-v", "error",
      ...entries.flatMap((e) => ["-show_entries", e]),
      "-of", "json",
      path,
    ]));
  } catch (err) {
    throw toolError("ffprobe", err);
  }
  return JSON.parse(stdout);
}

type Probed = {
  streams?: { codec_type?: string; r_frame_rate?: string }[];
  format?: { duration?: string };
};

/** What the intro has to match to survive `concat`: the clip's frame rate,
 *  and whether it has an audio stream at all (`exportClip` maps audio with
 *  `0:a?`, so a silent source produces a video-only file — and `concat`
 *  needs the same stream count in both segments).
 *
 *  JSON, not `-of default=nk=1`: that form prints one line per *stream*, so
 *  reading a per-file answer out of it means guessing which line is which.
 *  Taking the first line said "codec_type=video" and therefore "no audio" for
 *  every clip that had some — and the export replaced it all with silence. */
async function probeMain(
  path: string,
): Promise<{ fps: string; seconds: number; hasAudio: boolean }> {
  const data = (await probeJson(path, [
    "stream=codec_type,r_frame_rate",
    "format=duration",
  ])) as Probed;
  const streams = data.streams ?? [];
  const fps = streams.find((s) => s.codec_type === "video")?.r_frame_rate ?? "";
  const seconds = Number(data.format?.duration);
  return {
    fps: /^\d+\/\d+$/.test(fps) ? fps : "30/1",
    seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

export type StarterOpts = {
  /** The finished vertical clip from `exportClip`. */
  main: string;
  /** Transparent 1080x1920 PNG of the title, rendered by the client. */
  title: string;
  /** The spoken title, from `speak`. */
  voice: string;
  /** `speak`'s reported duration — the screen is sized around it. */
  voiceSeconds: number;
  out: string;
};

/** Prepends the starter screen to a finished clip.
 *
 *  Two ffmpeg passes, not one: the screen's background is the clip's own
 *  first frame, and extracting it first turns "loop a still" into an
 *  ordinary `-loop 1 -t` image input. Doing it inside the export's filter
 *  graph would need a `split` + `trim` + `loop` chain whose only job is
 *  feeding a filter that is already there for the mask.
 *
 *  ponytail: the background is the *composite's* first frame, gutters and
 *  all, which also makes the cut into the clip continuous. Blur the raw
 *  source frame instead if the white bars ever look wrong. */
export async function prependStarter(opts: StarterOpts): Promise<string> {
  const seconds = starterDuration(opts.voiceSeconds);
  const d = seconds.toFixed(3);
  const { fps, seconds: clip, hasAudio } = await probeMain(opts.main);
  // Beside the output, so the caller's temp dir takes it away with everything
  // else — nothing here has its own dir to clean up.
  const still = `${opts.out}.still.png`;

  try {
    await run("ffmpeg", ["-v", "error", "-i", opts.main, "-frames:v", "1", "-y", still]);
  } catch (err) {
    throw toolError("ffmpeg", err);
  }

  // Inputs: 0 blurred background, 1 title art, 2 clip, 3 music, 4 voice,
  // 5 cue, and — only when the clip is silent — 6 as its stand-in silence.
  // The music's `-ss`/`-t` are input options, so ffmpeg seeks and then stops
  // decoding at the screen's length instead of chewing through all 2m36s.
  const args = [
    "-v", "error",
    "-loop", "1", "-t", d, "-i", still,
    "-loop", "1", "-t", d, "-i", opts.title,
    "-i", opts.main,
    "-ss", String(MUSIC_START), "-t", d, "-i", MUSIC_PATH,
    "-i", opts.voice,
    "-i", CUE_PATH,
  ];
  if (!hasAudio) {
    args.push("-f", "lavfi", "-i", `anullsrc=r=${RATE}:cl=stereo`);
  }

  const fmt = `aformat=sample_fmts=fltp:sample_rates=${RATE}:channel_layouts=stereo`;
  // `-shortest` can't bound the silence leg: the video is already finite, but
  // concat consumes both audio segments to EOF, so the stand-in is trimmed by
  // the clip's own audio-free length instead.
  const mainAudio = hasAudio
    ? `[2:a]${fmt}[am]`
    : `[6:a]atrim=duration=${clip.toFixed(3)},${fmt}[am]`;
  const graph = [
    // The intro is forced to the clip's frame rate and to yuv420p because
    // concat requires matching parameters, and an image input defaults to
    // 25 fps regardless of what the clip is.
    `[0:v]gblur=sigma=${BLUR_SIGMA},fps=${fps},format=yuv420p,setsar=1[bg]`,
    "[bg][1:v]overlay=0:0:format=auto[intro]",
    // Both legs are pinned to square pixels. `scale=` in the export's filter
    // graph carries the *source's* sample aspect through to the composite —
    // an anamorphic YouTube upload lands as 1080x1920 with SAR 1214:1215 —
    // and concat rejects a SAR mismatch outright rather than picking one.
    // Square is also what a 1080x1920 short is supposed to be.
    "[2:v]setsar=1[clip]",
    "[intro][clip]concat=n=2:v=1:a=0[v]",
    // The bed. Faded out rather than cut, because the input -t above ends it
    // mid-bar and a hard stop clicks.
    `[3:a]afade=t=out:st=${(seconds - MUSIC_FADE).toFixed(3)}:d=${MUSIC_FADE},` +
      `volume=${MUSIC_GAIN},${fmt}[music]`,
    // Both of the other two are placed by a delay: the voice after the
    // lead-in, the cue in the tail slot the voice leaves free.
    `[4:a]adelay=${Math.round(LEAD_IN * 1000)}:all=1,${fmt}[voice]`,
    `[5:a]adelay=${Math.round((seconds - TAIL) * 1000)}:all=1,` +
      `volume=${CUE_GAIN},${fmt}[cue]`,
    // apad then atrim pins the intro's audio to exactly the video's length —
    // amix alone ends with its longest input, which is none of the three.
    `[music][voice][cue]amix=inputs=3:duration=longest:normalize=0,` +
      `apad,atrim=duration=${d},${fmt}[ai]`,
    mainAudio,
    "[ai][am]concat=n=2:v=0:a=1[a]",
  ].join(";");

  args.push(
    "-filter_complex", graph,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    "-y", opts.out,
  );

  try {
    await run("ffmpeg", args, { maxBuffer: 16 << 20 });
  } catch (err) {
    throw toolError("ffmpeg", err);
  }
  return opts.out;
}
