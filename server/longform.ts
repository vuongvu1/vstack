/** The long-form journey's one ffmpeg pass.
 *
 *  Sits BESIDE `ffmpeg.ts` rather than above it: it takes an output path
 *  from the caller and never needs `MEDIA_DIR` or `OUT_DIR`, the same
 *  posture `starter.ts` and `youtube.ts` already hold. It may read
 *  `probeFile`, and nothing else. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toolError } from "./errors.ts";
import { probeFile } from "./ffmpeg.ts";

const run = promisify(execFile);

/** YouTube's long-form shape, and not configurable: every input this feature
 *  takes is a 1080x1920 short, so a knob here would have one legal value. */
export const WIDE = { w: 1920, h: 1080 };

/** The blur is computed at 480x270 and stretched back up sixteenfold, and
 *  that stretch supplies most of the softening on its own — which is why
 *  this is 12 where `starter.ts`'s own BLUR_SIGMA is 30. Deliberately NOT
 *  imported from there: the two blur different things at different scales,
 *  and one shared constant would make tuning either one move the other.
 *
 *  Do not "improve" this by blurring at full resolution. A 1080x1920 source
 *  scaled to COVER 1920x1080 is 1920x3413, and gblur over that costs roughly
 *  fifty times what it costs here — for a picture whose entire purpose is to
 *  be out of focus. */
const BLUR_SIGMA = 12;
const BG_W = 480;
const BG_H = 270;

/** How long each dip to black takes, at both ends of a boundary — so a
 *  transition costs 2 * FADE of screen time and a beat the eye reads as a
 *  chapter break.
 *
 *  Spent as `fade`/`afade` on the legs `concat` already joins, which is why
 *  the output's duration is UNCHANGED: `keptRange`, `/api/stack`'s `total`
 *  and `outName` all stay exact, and the name cannot come to disagree with
 *  the file it names.
 *
 *  ponytail: a dip, not a crossfade. `xfade` + `acrossfade` would dissolve
 *  the parts into each other instead, and costs three things this does not:
 *  the chain is pairwise rather than per-leg, each step's `offset=` is the
 *  running total minus k * d (so every part's duration feeds every later
 *  offset), and the output comes out `(N-1) * d` SHORTER — which both
 *  `stackWide` and the route's `total` would have to agree on or the
 *  filename stops describing the file. Worth it only if the dissolve
 *  actually looks better here, which on unrelated clips (one part's body
 *  melting into the next part's title card) is not obvious. */
export const FADE = 0.5;

const FPS = 30;
const RATE = 44100;
/** The same crf `exportClip` uses. Unlike `concatClips` this is not an
 *  intermediate — it is the product — so there is no later generation to
 *  keep headroom for. */
const CRF = "20";

/** What a part gives up off each end, in seconds. Both are *detected* rather
 *  than assumed — see `detectTrim`.
 *
 *  `head` is the starter screen a vstack short opens on: the title card, its
 *  spoken title and the cue. `tail` is the bundled outro it closes on. Zero
 *  means "not there", which is the answer for an old short made before that
 *  asset existed and for any upload this app never touched. */
export type Trim = { head: number; tail: number };

/** The shortest a trimmed part is allowed to come back as.
 *
 *  A part cut to zero or negative seconds is read by ffmpeg as "no frames"
 *  and by `concat` as a missing leg, so one odd upload fails the whole
 *  render. Detection makes this far less likely to fire than it was when the
 *  outro was merely assumed — we now only cut what was actually found — but a
 *  part that is almost entirely starter and outro would still reach it. */
export const MIN_KEPT = 1;

/** How much of a part's head can plausibly be a starter screen.
 *
 *  `starterDuration` is `max(1.6, 0.35 + <spoken title> + 0.45)`, so a long
 *  Vietnamese title can run this well past ten seconds — but a freeze longer
 *  than this is a still image rather than a title card, and cutting it would
 *  be cutting the part itself. A sanity bound, not the real defence: that is
 *  `FREEZE_DB` below. */
const MAX_HEAD = 12;

/** `freezedetect`'s threshold, and the single most load-bearing constant in
 *  the head detector.
 *
 *  The starter screen is ONE composited frame repeated, so consecutive frames
 *  are bit-identical and freeze at any threshold. Real footage never is —
 *  even a locked-off tripod shot carries sensor noise and encoding jitter.
 *  Measured: a maroon still with `noise=alls=6` does not freeze at -60dB or
 *  -50dB and DOES at -40dB, while the real starter freezes at all three. So
 *  -60dB separates a synthesised still from a static-looking real one, which
 *  is the distinction this detector actually needs to make. Loosen it and a
 *  part that merely opens on a quiet shot loses that shot. */
const FREEZE_DB = "-60dB";
/** Shorter than this is not a title card. Also keeps a single duplicated
 *  frame mid-motion from registering. */
const FREEZE_MIN = 0.4;
/** The head scan decodes only this far in. `MAX_HEAD` rejects anything
 *  longer anyway, and a full decode of a 40-minute upload to find a 1.8s
 *  title card is work for nothing. */
const HEAD_SCAN = 30;
/** A freeze has to start within this of t=0 to be the starter. The starter
 *  IS the first frame, so anything later is a still inside the body. */
const HEAD_SLOP = 0.15;

/** Frames are compared as tiny greyscale thumbnails: enough shape to tell
 *  two videos apart, small enough that the comparison is free and that
 *  encoder noise averages out. Vertical, matching the inputs. */
const SAMPLE_W = 32;
const SAMPLE_H = 64;
/** Where in the outro to compare — spread across it, so a part whose tail
 *  merely resembles one moment of it does not match. */
const OUTRO_SAMPLES = [0.6, 2.5, 4.4];
/** Mean absolute difference, 0-255, under which two frames are "the same
 *  picture". Measured on real renders: a short carrying the outro scores 1.1
 *  and one without scores 87.6, so anything from about 5 to 40 works and
 *  this sits an order of magnitude clear of both. */
const OUTRO_MATCH = 12;

/** One frame as a raw greyscale thumbnail, or an empty buffer if the seek
 *  lands past the end of the file. */
async function greyFrame(path: string, t: number): Promise<Buffer> {
  try {
    const { stdout } = await run(
      "ffmpeg",
      ["-v", "error", "-ss", String(t), "-i", path, "-frames:v", "1",
       "-vf", `scale=${SAMPLE_W}:${SAMPLE_H}`, "-f", "rawvideo",
       "-pix_fmt", "gray", "-"],
      { encoding: "buffer", maxBuffer: 1 << 20 },
    );
    return stdout as unknown as Buffer;
  } catch {
    // A seek past the end is not an error worth failing a render over — it
    // just means this part cannot be carrying the outro.
    return Buffer.alloc(0);
  }
}

/** Mean absolute difference between two thumbnails, 255 (maximally
 *  different) if either is missing or they disagree on size. */
function frameDiff(a: Buffer, b: Buffer): number {
  if (a.length === 0 || a.length !== b.length) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / a.length;
}

/** How long the starter screen at the front of `path` runs, or 0 if there
 *  isn't one.
 *
 *  `freezedetect` writes its findings to stderr as metadata lines. Only a
 *  freeze that starts at t=0 counts: the starter screen *is* the first frame,
 *  so a freeze further in is a still inside the body and cutting to it would
 *  throw away real footage. */
async function detectHead(path: string): Promise<number> {
  const args = [
    "-v", "info", "-t", String(HEAD_SCAN), "-i", path,
    "-vf", `freezedetect=n=${FREEZE_DB}:d=${FREEZE_MIN}`,
    "-map", "0:v", "-f", "null", "-",
  ];
  let stderr: string;
  try {
    ({ stderr } = await run("ffmpeg", args, { maxBuffer: 16 << 20 }));
  } catch (err) {
    // ffmpeg exits non-zero on plenty of harmless things here. The metadata
    // is on stderr either way, so read it and let the parse decide — a
    // detector that throws would fail a render over a part it merely could
    // not measure.
    stderr = (err as { stderr?: string }).stderr ?? "";
  }

  const start = /freeze_start: ([0-9.]+)/.exec(stderr);
  const end = /freeze_end: ([0-9.]+)/.exec(stderr);
  if (!start || !end) return 0;
  const from = Number(start[1]);
  const to = Number(end[1]);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  // Must begin at the very start, and must be a plausible length for a title
  // card rather than for a still photograph.
  if (from > HEAD_SLOP || to > MAX_HEAD || to <= from) return 0;
  return to;
}

/** Whether `path` ends with the bundled outro, by comparing three frames
 *  across its last `outroSeconds` against the same three of the asset. */
async function hasOutro(
  path: string,
  seconds: number,
  outro: string,
  outroSeconds: number,
): Promise<boolean> {
  if (outroSeconds <= 0 || seconds < outroSeconds) return false;
  for (const t of OUTRO_SAMPLES) {
    if (t >= outroSeconds) continue;
    const want = await greyFrame(outro, t);
    const got = await greyFrame(path, seconds - outroSeconds + t);
    if (frameDiff(want, got) > OUTRO_MATCH) return false;
  }
  return true;
}

/** What `path` gives up off each end.
 *
 *  Both ends are detected rather than assumed, and that is the point: the
 *  previous rule took the outro off every part but the last unconditionally,
 *  so an old short made before `end_video.mp4` existed lost five seconds of
 *  real content, silently. Now a part is only cut where the thing being cut
 *  is actually there.
 *
 *  The outro's path and length come from the caller for the same reason the
 *  old `tail` did: `END_PATH` lives in `starter.ts`, this module's SIBLING,
 *  and importing across that line would put a cycle-shaped edge into a
 *  layering that is deliberately acyclic.
 *
 *  ponytail: no caching. Every render re-detects, which is ~0.6s per part —
 *  irrelevant beside the encode, but it does mean a re-render after a title
 *  fix pays again. Key a cache on path + mtime if that ever matters. */
export async function detectTrim(
  path: string,
  seconds: number,
  outro: string,
  outroSeconds: number,
): Promise<Trim> {
  const [head, outroFound] = await Promise.all([
    detectHead(path),
    hasOutro(path, seconds, outro, outroSeconds),
  ]);
  return { head, tail: outroFound ? outroSeconds : 0 };
}

/** Where a part starts and how long it runs, once its trims are spent.
 *
 *  The two ends follow OPPOSITE rules, and both are deliberate:
 *
 *  - The head goes from every part, the first and the last included. A
 *    part's title card announces that part, and the compilation's own title
 *    lives in the publish panel with a thumbnail the user picked — so no
 *    card is doing a job any more, and part one's would mislabel the whole
 *    video.
 *  - The tail stays on the LAST part, because that outro is the finished
 *    video's own ending.
 *
 *  Falls back to the whole part rather than to a clamped one when the trims
 *  would take it under `MIN_KEPT`: a part that is nearly all furniture is
 *  more likely to have been mis-detected than to be worth a one-second
 *  sliver. */
export function keptRange(
  seconds: number,
  trim: Trim,
  isLast: boolean,
): { ss: number; dur: number } {
  const head = Math.max(0, trim.head);
  const tail = isLast ? 0 : Math.max(0, trim.tail);
  const dur = seconds - head - tail;
  if (dur < MIN_KEPT) return { ss: 0, dur: seconds };
  return { ss: head, dur };
}

/** Letterboxes each part onto a blurred copy of itself and concatenates the
 *  lot into one 1920x1080 file, in ONE encode.
 *
 *  Every leg is normalised before `concat` sees it, for the same reason
 *  `concatClips` and `prependStarter` do it: `concat` REFUSES a mismatch
 *  rather than picking a side, and a SAR difference fails with `Nothing was
 *  written into output file`, which names nothing.
 *
 *  Two scale choices are load-bearing:
 *
 *  - The background is `increase` + `crop`, so it fills the frame edge to
 *    edge with no black anywhere.
 *  - The foreground is `decrease` + `force_divisible_by=2`, so a part that
 *    is NOT vertical fits inside the frame instead of overflowing it. An
 *    upload is any file the user picked; only the common case is 9:16.
 *
 *  A part with no audio gets a leg cut from a shared `anullsrc` input,
 *  appended LAST so the real parts' input indices never move — the same
 *  positional rule `concatClips` follows.
 *
 *  `trims` is what each part gives up off each end — its starter screen and,
 *  unless it is the last part, its outro (see `keptRange`). Both arrive as
 *  input options, `-ss` and `-t`, rather than as `trim` filters: the demuxer
 *  seeks and stops early, so nothing outside the kept range is decoded at
 *  all. Defaults to empty, which is the identity and what every caller that
 *  predates trimming gets. */
export async function stackWide(
  paths: string[],
  out: string,
  trims: Trim[] = [],
): Promise<string> {
  if (paths.length === 0) throw new Error("stackWide needs at least one part.");

  const probed = await Promise.all(paths.map((p) => probeFile(p)));
  const anySilent = probed.some((p) => !p.hasAudio);
  const silenceIndex = paths.length;
  const ranges = probed.map((p, i) =>
    keptRange(p?.seconds ?? 0, trims[i] ?? { head: 0, tail: 0 }, i === paths.length - 1),
  );
  const kept = ranges.map((r) => r.dur);

  const inputs: string[] = [];
  paths.forEach((path, i) => {
    const r = ranges[i];
    // Declared BEFORE the -i they belong to: ffmpeg attaches an option to the
    // NEXT -i, so the other order would make these options on the FOLLOWING
    // part and trim the wrong file. Same lesson as the mask input in
    // `exportClip`. `-ss` before `-i` also makes `-t` a duration measured
    // from the seek point, which is what `keptRange` returns.
    if ((r?.ss ?? 0) > 0) inputs.push("-ss", String(r?.ss));
    if ((r?.dur ?? 0) < (probed[i]?.seconds ?? 0)) inputs.push("-t", String(r?.dur));
    inputs.push("-i", path);
  });
  if (anySilent) {
    inputs.push("-f", "lavfi", "-i", `anullsrc=r=${RATE}:cl=stereo`);
  }

  const legs: string[] = [];
  const labels: string[] = [];
  paths.forEach((_, i) => {
    const p = probed[i];
    const hasAudio = p?.hasAudio === true;
    // The KEPT length, not the file's. A sounded part is already cut by its
    // input `-t` and this is a no-op on it; the shared `anullsrc` carries no
    // `-t` at all, so for a silent part this is the only thing that stops
    // its stand-in leg running past the video it stands in for.
    const seconds = kept[i] ?? 0;
    // The transition. Clamped so a pathologically short part cannot have its
    // fade-in overlap its fade-out, which reads as a part that never reaches
    // full brightness rather than as a transition. At any real length this
    // is a flat FADE.
    const d = Math.min(FADE, seconds / 3);
    // Only BETWEEN parts. The compilation opens on the first part's title
    // card and closes on the bundled outro, both of which already start and
    // end deliberately — fading them would be fading something that needs no
    // help. Declared after `setpts=PTS-STARTPTS` in the chain below so `st=`
    // is measured from this part's own zero rather than from its source
    // timestamps.
    const vFade =
      (i > 0 ? `fade=t=in:st=0:d=${d},` : "") +
      (i < paths.length - 1 ? `fade=t=out:st=${seconds - d}:d=${d},` : "");
    const aFade =
      (i > 0 ? `afade=t=in:st=0:d=${d},` : "") +
      (i < paths.length - 1 ? `afade=t=out:st=${seconds - d}:d=${d},` : "");
    legs.push(
      `[${i}:v]split=2[bg${i}][fg${i}]`,
      `[bg${i}]scale=${BG_W}:${BG_H}:force_original_aspect_ratio=increase,` +
        `crop=${BG_W}:${BG_H},gblur=sigma=${BLUR_SIGMA},` +
        `scale=${WIDE.w}:${WIDE.h},setsar=1[bgz${i}]`,
      `[fg${i}]scale=${WIDE.w}:${WIDE.h}:force_original_aspect_ratio=decrease:` +
        `force_divisible_by=2,setsar=1[fgz${i}]`,
      // `force_divisible_by=2` only guarantees the fitted size is even, not
      // that `(W-w)/2` is: it lands odd whenever `w ≡ 2 (mod 4)` (e.g. a
      // 1084x1920 upload fits to 610x1080, offset 655). An overlay at an odd
      // offset in yuv420p sits on a half-chroma-sample boundary — the same
      // invariant the custom-boxes feature states for its own overlay.
      // floor(x/2)*2 forces both axes even; W/w are only known to ffmpeg, so
      // this stays an expression rather than a TypeScript computation.
      `[bgz${i}][fgz${i}]overlay=floor((W-w)/4)*2:floor((H-h)/4)*2,fps=${FPS},` +
        `setpts=PTS-STARTPTS,${vFade}format=yuv420p[v${i}]`,
    );
    // A silent part's leg is cut out of the shared anullsrc instead, trimmed
    // to this part's own length so the two streams stay in step.
    const audioSrc = hasAudio ? `${i}:a` : `${silenceIndex}:a`;
    legs.push(
      `[${audioSrc}]atrim=0:${seconds},asetpts=PTS-STARTPTS,aresample=${RATE},` +
        `${aFade}aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`,
    );
    labels.push(`[v${i}][a${i}]`);
  });
  legs.push(`${labels.join("")}concat=n=${paths.length}:v=1:a=1[v][a]`);

  try {
    await run(
      "ffmpeg",
      [
        "-v", "error",
        ...inputs,
        "-filter_complex", legs.join(";"),
        "-map", "[v]",
        "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", CRF,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        "-y", out,
      ],
      { maxBuffer: 16 << 20 },
    );
  } catch (err) {
    throw toolError("ffmpeg", err);
  }
  return out;
}
