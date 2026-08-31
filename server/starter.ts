import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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

/** The hit that lands with the title, at the very start of the screen. A
 *  sharp attack with about a second of audible decay inside a 3s file — the
 *  tail is already at -57 dB by the time the screen ends, so the `atrim`
 *  below truncates silence rather than cutting a sound off.
 *
 *  The app plays this same file when a phase completes (`bell` in
 *  `src/main.ts`), which is why it lives here and is imported across the
 *  client/server line rather than duplicated. */
export const TITLE_SOUND_PATH = asset("start-title-sound.mp3");

/** The outro, concatenated after the clip. A finished 1080x1920 video with
 *  its own audio, not a still — so it needs no filter beyond the frame-rate
 *  and SAR normalisation `concat` demands of every leg.
 *
 *  ponytail: its dimensions are taken on trust. `checkStarter` only checks
 *  the file exists; swap in something that is not 1080x1920 and `concat`
 *  refuses the whole export loudly ("Nothing was written into output file"),
 *  which beats a silent stretch. Scale it here if that ever needs to be
 *  forgiving instead. It must also carry an audio stream — the outro leg is
 *  unconditional, so a silent one would break the audio concat for every
 *  export rather than for a subset. */
export const END_PATH = asset("end_video.mp4");

/** The venv `pnpm tts-setup` builds, holding VieNeu-TTS and its wheels.
 *
 *  Under `$HOME`, never the repo: Vite serves the project root statically, so
 *  a 750 MB site-packages tree there would be fetchable by any page the
 *  browser has open. `youtube.ts` already established `~/.vstack/` as where
 *  this tool keeps what must stay out of that root, and this module
 *  re-derives the directory for the same reason that one does — so neither
 *  has to import the other. */
const VENV = join(homedir(), ".vstack", "vieneu");
const PYTHON = join(VENV, "bin", "python");
const TTS = fileURLToPath(new URL("tts.py", import.meta.url));

/** The voice that reads the title when the client names none.
 *
 *  macOS `say` used to do this job and no longer can. Its only Vietnamese
 *  voice is `Linh`, and even `Linh (Enhanced)` — a separate name, not a
 *  silent upgrade — tops out at `quality=2`; vi_VN has no `quality=3`
 *  premium tier at all. The Siri voices System Settings offers under
 *  Read & Speak are unreachable from any app: their `gryphon-neural` bundles
 *  appear in neither `say -v '?'` nor `AVSpeechSynthesisVoice.speechVoices()`,
 *  so picking one there changes what macOS reads aloud and nothing else.
 *
 *  VieNeu-TTS ships twenty presets instead, and the client picks one per
 *  export — this constant is only the fallback. `VSTACK_VOICE` still
 *  overrides it, and `checkStarter` rejects a name the engine does not know
 *  at boot rather than at export time. */
export const VOICE = process.env.VSTACK_VOICE ?? "Thùy Dung";

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
/** A black scrim under the title, as a brightness multiplier: 0.65 is the
 *  same as compositing black at 35% over the blurred frame.
 *
 *  Multiplicative, not `eq=brightness`. Brightness adds a constant offset, so
 *  a white UI panel — which is most of what gets clipped here — only falls
 *  from 255 to about 217 and white text still competes with it. Multiplying
 *  crushes the whites proportionally, which is the whole point.
 *
 *  Applied to the background BEFORE the title is overlaid, so the title
 *  itself keeps full brightness. 1 disables it. This and BLUR_SIGMA are the
 *  two knobs for how the screen reads; it also changes the thumbnail, which
 *  is this same frame. */
const SCRIM = 0.65;
/** How tall the blurred band behind the title is, and how soft its edges are.
 *
 *  Only a band, not the whole frame: the clip is what makes someone stop
 *  scrolling, and blurring all of it throws that away. `renderTitleArt`
 *  centres the title block on `OUTPUT.h / 2`, so the band is centred there
 *  too.
 *
 *  820 covers roughly four lines at `MAX_SIZE` (180px each). A longer title
 *  spills onto sharp video — still readable thanks to the outline, just less
 *  deliberate. The exact fix is for the client to report the block's real
 *  height alongside the PNG; this is the approximation until that is worth a
 *  field on `/api/export`.
 *
 *  ponytail: fixed band. Have `renderTitleArt` return its block height when a
 *  long title actually looks wrong. */
const BAND_H = 820;
/** Feathering the mask is what stops the band reading as a bar across the
 *  frame — a hard edge shows two visible seams. */
const BAND_FEATHER = 60;

/** Turns the clip's first frame into the starter screen's background: sharp
 *  everywhere except a feathered band across the middle, which is blurred and
 *  darkened so the title has something quiet to sit on.
 *
 *  `blend` with an explicit expression rather than `maskedmerge` with a
 *  feathered mask. maskedmerge looked like the obvious filter and is not: fed
 *  a correct greyscale mask (verified 0 outside the band, 255 at the centre)
 *  it returned a pixel halfway between the two layers where the mask was
 *  fully white — blurred+scrimmed `(84,40,0)` and sharp `(251,0,0)` merged to
 *  `(154,9,0)`. `blend`'s output matches the arithmetic exactly at every
 *  sample.
 *
 *  A is the sharp layer, B the treated one; the weight ramps 0→1 across
 *  BAND_FEATHER pixels at each edge. `H` is the frame height, so nothing here
 *  needs to know OUTPUT.
 *
 *  Applied in the frame-extraction pass, not the composite: the background is
 *  one static image, and a per-pixel expression evaluated across every frame
 *  of the screen would be paying ~300M evaluations for a picture that never
 *  changes. */
const SCREEN_FILTER =
  "[0:v]format=rgb24,split=2[sharp][tosoften];" +
  `[tosoften]gblur=sigma=${BLUR_SIGMA},` +
  `colorchannelmixer=rr=${SCRIM}:gg=${SCRIM}:bb=${SCRIM},format=rgb24[soft];` +
  "[sharp][soft]blend=all_expr='" +
  `A+(B-A)*clip(min(Y-(H-${BAND_H})/2\,(H+${BAND_H})/2-Y)/${BAND_FEATHER}\,0\,1)'`;
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
/** Was 0.9, which read as a shout over the bed. `server/starter.test.ts`
 *  isolates the cue in the tail slot and needs a peak above 0.5, so this is
 *  about as low as it goes before that window stops being cue-only. */
const CUE_GAIN = 0.6;
/** The title hit peaks at -6 dB in the file, louder than the bed at
 *  MUSIC_GAIN, and it overlaps the start of the voice. Turned down so it
 *  announces the title without burying the first syllable. */
const TITLE_GAIN = 0.6;
/** Long enough not to click, short enough to still be under the cue. */
const MUSIC_FADE = 0.35;
/** Every leg going into `concat` is forced to this, so the two segments'
 *  audio parameters match rather than happening to. */
const RATE = 48_000;

export function starterDuration(voiceSeconds: number): number {
  return Math.max(MIN_DURATION, LEAD_IN + voiceSeconds + TAIL);
}

/** Boot check: the voice engine and the sting. Both are hard requirements of
 *  every export, so a missing one should stop the server rather than fail the
 *  render after the download and the encode have already been paid for.
 *
 *  This is also what fills the preset cache `knownVoices` serves, which is
 *  why it runs before any route does. */
export async function checkStarter(): Promise<void> {
  for (const path of [MUSIC_PATH, CUE_PATH, TITLE_SOUND_PATH, END_PATH]) {
    if (!existsSync(path)) {
      console.error(`vstack: bundled asset missing at ${path}.`);
      process.exit(1);
    }
  }
  if (!existsSync(PYTHON)) {
    console.error(
      `vstack: no text-to-speech venv at ${VENV}. Fix: \`pnpm tts-setup\` ` +
        "(builds it and downloads ~285 MB of VieNeu-TTS model on first run).",
    );
    process.exit(1);
  }
  try {
    presets = await installedVoices();
  } catch (err) {
    console.error(
      `vstack: the text-to-speech venv at ${VENV} cannot list its voices. ` +
        "Fix: `pnpm tts-setup` to rebuild it.",
      err,
    );
    process.exit(1);
  }
  if (!presets.some((v) => v.name === VOICE)) {
    console.error(
      `vstack: VieNeu-TTS has no voice named ${VOICE}. Fix: pick one with ` +
        "`pnpm voices`, or unset VSTACK_VOICE.",
    );
    process.exit(1);
  }
}

export type Voice = {
  name: string;
  /** `male` / `female`, straight from the preset table. */
  gender: string;
  /** `Bắc` / `Trung` / `Nam` — the accent, which the UI groups by. Note this
   *  collides confusingly with `gender: "male"`, whose Vietnamese label is
   *  also "Nam"; they are different columns and both are the engine's words. */
  region: string;
  /** The delivery: news read, natural, storytelling. */
  style: string;
};

/** The preset table, cached by `checkStarter` at boot.
 *
 *  `/api/export` validates the client's voice against this, so it has to be
 *  populated before any route can serve — hence filled at boot rather than
 *  lazily. Empty only in tests, which call `speak` directly. */
let presets: Voice[] = [];

export function knownVoices(): Voice[] {
  return presets;
}

/** Every voice the engine ships, as name + gender + region + style.
 *
 *  Cheap on purpose: `tts.py --list` reads the preset JSON out of the
 *  installed wheel without constructing a `Vieneu`, which is 0.06s against
 *  the 4.2s an ONNX session costs. Boot pays it on every restart, and
 *  `node --watch` restarts a lot. */
export async function installedVoices(): Promise<Voice[]> {
  let stdout: string;
  try {
    ({ stdout } = await run(PYTHON, [TTS, "--list"], { maxBuffer: 1 << 20 }));
  } catch (err) {
    throw toolError("vieneu", err);
  }
  const voices: Voice[] = [];
  for (const line of stdout.split("\n")) {
    const [name, gender = "", region = "", style = ""] = line.split("\t");
    if (name) voices.push({ name, gender, region, style });
  }
  return voices;
}

/** Speaks `text` once per job, all in one process.
 *
 *  Batched because the ONNX session setup is ~4.2s and each voice after it is
 *  ~0.4s: auditioning all twenty presets is ~12s this way and ~84s as twenty
 *  separate spawns. `speak` is the single-job case.
 *
 *  The text goes via a file, not argv — a title starting with "-" must not be
 *  readable as an option, and there is no argv length ceiling to think about.
 *  `execFile` means no shell either way. Voice names *are* argv, which is why
 *  `/api/export` checks the client's against `knownVoices` first. */
export async function synthesize(
  text: string,
  dir: string,
  jobs: { voice: string; out: string }[],
): Promise<void> {
  if (jobs.length === 0) return;
  const script = join(dir, "title.txt");
  await writeFile(script, text, "utf8");
  try {
    await run(PYTHON, [TTS, script, ...jobs.flatMap((j) => [j.voice, j.out])]);
  } catch (err) {
    throw toolError("vieneu", err);
  }
}

/** Reads the title aloud into `out` (48 kHz WAV) and returns its duration. */
export async function speak(
  text: string,
  dir: string,
  out: string,
  voice: string = VOICE,
): Promise<number> {
  await synthesize(text, dir, [{ voice, out }]);
  const data = (await probeJson(out, ["format=duration"])) as Probed;
  const seconds = Number(data.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`vieneu produced no audible title (${out}).`);
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
  // `opts.out` is `out/<name>.part.mp4` now — a real file in `out/`, not a
  // path inside a `mkdtemp` dir the caller sweeps up afterwards — so this
  // intermediate has no other owner. `prependStarter` is the only code that
  // knows this path, so it has to be the one that removes it too, in the
  // `finally` below.
  const still = `${opts.out}.still.png`;

  try {
    try {
      await run("ffmpeg", [
      "-v", "error",
      "-i", opts.main,
      "-frames:v", "1",
      "-filter_complex", SCREEN_FILTER,
      "-y", still,
    ]);
    } catch (err) {
      throw toolError("ffmpeg", err);
    }

    // Inputs: 0 blurred background, 1 title art, 2 clip, 3 music, 4 voice,
    // 5 cue, 6 title hit, 7 outro, and — only when the clip is silent — 8 as
    // its stand-in silence.
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
      "-i", TITLE_SOUND_PATH,
      "-i", END_PATH,
    ];
    if (!hasAudio) {
      args.push("-f", "lavfi", "-i", `anullsrc=r=${RATE}:cl=stereo`);
    }

    const fmt = `aformat=sample_fmts=fltp:sample_rates=${RATE}:channel_layouts=stereo`;
    // `-shortest` can't bound the silence leg: the video is already finite,
    // but concat consumes both audio segments to EOF, so the stand-in is
    // trimmed by the clip's own audio-free length instead.
    const mainAudio = hasAudio
      ? `[2:a]${fmt}[am]`
      // Index 8, not 6: the title sound took 6 and the outro 7. This leg
      // only exists when the clip is silent, so a stale index here would be
      // wrong only for silent clips — the quietest possible way to break.
      : `[8:a]atrim=duration=${clip.toFixed(3)},${fmt}[am]`;
    const graph = [
      // The intro is forced to the clip's frame rate and to yuv420p because
      // concat requires matching parameters, and an image input defaults to
      // 25 fps regardless of what the clip is.
      // The still arrives already treated — blurred and darkened behind the
      // title, sharp elsewhere. See SCREEN_FILTER: it runs once, in the
      // frame-extraction pass, rather than per pixel on every frame here.
      `[0:v]fps=${fps},format=yuv420p,setsar=1[bg]`,
      "[bg][1:v]overlay=0:0:format=auto[intro]",
      // Both legs are pinned to square pixels. `scale=` in the export's
      // filter graph carries the *source's* sample aspect through to the
      // composite — an anamorphic YouTube upload lands as 1080x1920 with SAR
      // 1214:1215 — and concat rejects a SAR mismatch outright rather than
      // picking one. Square is also what a 1080x1920 short is supposed to be.
      "[2:v]setsar=1[clip]",
      // The outro gets the same treatment as the intro for the same reason:
      // concat matches parameters, and this asset is 34 fps where the clip is
      // usually 30.
      `[7:v]fps=${fps},format=yuv420p,setsar=1[end]`,
      "[intro][clip][end]concat=n=3:v=1:a=0[v]",
      // The bed. Faded out rather than cut, because the input -t above ends
      // it mid-bar and a hard stop clicks.
      `[3:a]afade=t=out:st=${(seconds - MUSIC_FADE).toFixed(3)}:d=${MUSIC_FADE},` +
        `volume=${MUSIC_GAIN},${fmt}[music]`,
      // Both of the other two are placed by a delay: the voice after the
      // lead-in, the cue in the tail slot the voice leaves free.
      `[4:a]adelay=${Math.round(LEAD_IN * 1000)}:all=1,${fmt}[voice]`,
      `[5:a]adelay=${Math.round((seconds - TAIL) * 1000)}:all=1,` +
        `volume=${CUE_GAIN},${fmt}[cue]`,
      // No adelay: the title is on screen from the first frame, so its sound
      // starts with it and fills the lead-in the voice leaves quiet.
      `[6:a]volume=${TITLE_GAIN},${fmt}[titlehit]`,
      // apad then atrim pins the intro's audio to exactly the video's length
      // — amix alone ends with its longest input, which is none of the three.
      `[music][voice][cue][titlehit]amix=inputs=4:duration=longest:normalize=0,` +
        `apad,atrim=duration=${d},${fmt}[ai]`,
      mainAudio,
      `[7:a]${fmt}[ae]`,
      "[ai][am][ae]concat=n=3:v=0:a=1[a]",
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
  } finally {
    // force:true only suppresses ENOENT. A throwing finally would override
    // even a clean completion, escaping this function entirely — so this
    // cleanup must swallow its own errors rather than propagate them, the
    // same idiom the export route's own partial/temp-dir cleanup uses.
    await rm(still, { force: true }).catch((err: unknown) => {
      console.error("vstack: starter still cleanup failed:", err);
    });
  }
}
