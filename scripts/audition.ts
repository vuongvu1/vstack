import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { VOICE, installedVoices, synthesize } from "../server/starter.ts";

const run = promisify(execFile);

/** Auditions the starter screen's voice.
 *
 *  `pnpm voices`                          — all twenty VieNeu-TTS presets
 *  `pnpm voices "Ăn cơm chưa bạn ơi"`     — …reading your own title
 *  `pnpm voices "Chào bạn" "Mai Anh" "Thùy Dung"`
 *                                         — named voices only
 *  `pnpm voices --quiet`                  — write the files, play nothing
 *
 *  Each one is spoken aloud *and* written to a file, so a second pass needs no
 *  re-synthesis. Pick one in the framing bar's dropdown, or make it the
 *  server's fallback with `VSTACK_VOICE="<name>" pnpm server`.
 *
 *  All of them are synthesised in a single `synthesize` call, because the ONNX
 *  session setup is ~4.2s against ~0.4s per voice — twenty separate spawns
 *  would be ~84s instead of ~12s. That is also why playback is a second pass
 *  over the files rather than interleaved with generating them.
 */
const DEFAULT_TITLE = "Ăn cơm chưa bạn ơi";

const argv = process.argv.slice(2);
// Files only, no speakers — for auditioning later, or with headphones on.
const quiet = argv.includes("--quiet");
const [title = DEFAULT_TITLE, ...named] = argv.filter((a) => a !== "--quiet");

const all = await installedVoices();
const names = named.length > 0 ? named : all.map((v) => v.name);

const unknown = names.filter((n) => !all.some((v) => v.name === n));
if (unknown.length > 0) {
  console.error(`No such voice: ${unknown.join(", ")}. Run \`pnpm voices\` with no arguments.`);
  process.exit(1);
}

const dir = join(tmpdir(), "vstack-voices");
await mkdir(dir, { recursive: true });

// Slugged, because a preset name has spaces and Vietnamese diacritics in it.
const jobs = names.map((name) => ({
  voice: name,
  out: join(dir, `${name.replace(/[^\dA-Za-z]+/g, "-")}.wav`),
}));

const verb = quiet ? "saved to" : "spoken and saved to";
console.warn(`\n“${title}”\n${jobs.length} voice(s), each ${verb} ${dir}`);
console.warn("Loading the model…\n");
await synthesize(title, dir, jobs);

for (const { voice, out } of jobs) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    out,
  ]);
  const seconds = Number(stdout.trim()).toFixed(2);
  const label = all.find((v) => v.name === voice);
  const about = label ? `  ${label.region} · ${label.gender === "female" ? "Nữ" : "Nam"}` : "";
  console.warn(`  ▶ ${voice}${voice === VOICE ? "  (default)" : ""}${about}  —  ${seconds}s`);
  // Live, after the line is printed, so the label is on screen while it plays.
  if (!quiet) await run("afplay", [out]);
}

console.warn(
  "\nPick one in the framing bar's dropdown, or make it the fallback with" +
    ' `VSTACK_VOICE="<name>" pnpm server`.\n',
);
