import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { VOICE, installedVoices } from "../server/starter.ts";

const run = promisify(execFile);

/** Auditions the starter screen's voice.
 *
 *  `pnpm voices`                          — every Vietnamese voice installed
 *  `pnpm voices "Ăn cơm chưa bạn ơi"`     — …reading your own title
 *  `pnpm voices "Chào bạn" Linh "Eddy (English (US))"`
 *                                         — named voices, any language
 *  `pnpm voices --quiet`                  — write the files, play nothing
 *
 *  Each one is spoken aloud *and* written to a file, so a second pass needs no
 *  re-synthesis. Pick one, then run the server with it:
 *  `VSTACK_VOICE="<name>" pnpm server`.
 *
 *  ponytail: a script, not a UI. Choosing a voice is a once-ever decision, and
 *  a dropdown would mean an AppState field, a /api/voices route, a preview
 *  endpoint and save/restore migration. Add all that the day it changes often.
 */
const DEFAULT_TITLE = "Ăn cơm chưa bạn ơi";

const argv = process.argv.slice(2);
// Files only, no speakers — for auditioning later, or with headphones on.
const quiet = argv.includes("--quiet");
const [title = DEFAULT_TITLE, ...named] = argv.filter((a) => a !== "--quiet");

const all = await installedVoices();
const vietnamese = all.filter((v) => v.locale === "vi_VN");
const names = named.length > 0 ? named : vietnamese.map((v) => v.name);

const unknown = names.filter((n) => !all.some((v) => v.name === n));
if (unknown.length > 0) {
  console.error(`No such voice: ${unknown.join(", ")}. Run \`pnpm voices\` with no arguments.`);
  process.exit(1);
}

const dir = join(tmpdir(), "vstack-voices");
await mkdir(dir, { recursive: true });
const script = join(dir, "title.txt");
// Via a file for the same reason `speak` does it: a title starting with "-"
// must not be read as an option.
await writeFile(script, title, "utf8");

const verb = quiet ? "saved to" : "spoken and saved to";
console.warn(`\n“${title}”\n${names.length} voice(s), each ${verb} ${dir}\n`);

for (const name of names) {
  // Slugged, because a voice name has spaces and parentheses in it.
  const file = join(dir, `${name.replace(/[^\dA-Za-z]+/g, "-")}.aiff`);
  await run("say", ["-v", name, "-f", script, "-o", file]);
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    file,
  ]);
  const seconds = Number(stdout.trim()).toFixed(2);
  console.warn(`  ▶ ${name}${name === VOICE ? "  (current)" : ""}  —  ${seconds}s`);
  // Live, after the file, so the printed label is on screen while it plays.
  if (!quiet) await run("say", ["-v", name, "-f", script]);
}

if (named.length === 0 && vietnamese.length === 1) {
  console.warn(
    "\nOnly one Vietnamese voice is installed. More live under System Settings" +
      " → Accessibility → Spoken Content → System Voice → Manage Voices… →" +
      " Vietnamese (an Enhanced/Premium Linh keeps the same name, so nothing" +
      " needs changing here).\nOr audition any language:" +
      ' `pnpm voices "<title>" "Eddy (English (US))"`.',
  );
}
console.warn(`\nTo use one: VSTACK_VOICE="<name>" pnpm server\n`);
