import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Builds the venv the starter screen's voice needs.
 *
 *  `pnpm tts-setup`
 *
 *  One-off, like `pnpm youtube-auth`, and idempotent — re-running it upgrades
 *  the package in place. It lands in `~/.vstack/vieneu/` rather than the repo
 *  because Vite serves the project root statically, so 750 MB of wheels there
 *  would be fetchable by any page the browser has open.
 *
 *  The ~285 MB model is *not* downloaded here: VieNeu pulls it from Hugging
 *  Face into `~/.cache/huggingface` the first time a `Vieneu` is constructed,
 *  which is the first export. Warming it here would mean a 4s model load in a
 *  script whose only job is pip.
 *
 *  ponytail: no uv, no lockfile, no version pin. One `pip install` on one
 *  machine. Pin the day a VieNeu release breaks `tts.py`.
 */
const VENV = join(homedir(), ".vstack", "vieneu");
const PYTHON = join(VENV, "bin", "python");

/** VieNeu needs >=3.10, and this box's `python3` is 3.14 — new enough that
 *  onnxruntime may have no wheel for it. Preferring an explicit 3.13 keeps
 *  the install off that cliff, with `python3` as the fallback for a machine
 *  that has no Homebrew 3.13. */
const CANDIDATES = [
  "/opt/homebrew/opt/python@3.13/bin/python3.13",
  "/usr/local/opt/python@3.13/bin/python3.13",
  "python3",
];

const base = CANDIDATES.find((p) => p === "python3" || existsSync(p));
if (base === undefined) {
  console.error("vstack: no python3 found. Fix: `brew install python@3.13`.");
  process.exit(1);
}

console.warn(`vstack: building the speech venv at ${VENV} (a few hundred MB)…`);
try {
  await run(base, ["-m", "venv", VENV]);
  await run(PYTHON, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"]);
  await run(PYTHON, ["-m", "pip", "install", "--quiet", "--upgrade", "vieneu"], {
    maxBuffer: 1 << 24,
  });
} catch (err) {
  console.error("vstack: the install failed.", err);
  process.exit(1);
}

// Proves the wheel is importable *and* that the preset table it ships is
// readable — which is exactly what `checkStarter` will do at boot, so a
// failure surfaces here rather than on the next `pnpm server`.
const tts = new URL("../server/tts.py", import.meta.url).pathname;
const { stdout } = await run(PYTHON, [tts, "--list"], { maxBuffer: 1 << 20 });
const count = stdout.trim().split("\n").filter(Boolean).length;
console.warn(
  `vstack: ready — ${count} voices. The ~285 MB model downloads on the first` +
    " export. Audition with `pnpm voices`.",
);
