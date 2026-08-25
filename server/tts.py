"""Vietnamese text-to-speech for the starter screen, via VieNeu-TTS v3 Turbo.

Two modes:

    tts.py --list
    tts.py <text-file> <voice> <out.wav> [<voice> <out.wav> ...]

`--list` reads the preset table straight out of the package asset rather than
constructing a `Vieneu`: the presets are a static JSON that ships in the wheel
(speaker embeddings plus pre-encoded reference codes), so listing them costs
0.06s where a model load costs 4.2s. Boot calls this on every start.

The synth mode is variadic on purpose. Each process pays the 4.2s ONNX session
setup exactly once and then ~0.4s per voice, so `pnpm voices` auditioning all
twenty is ~12s in one process instead of ~84s across twenty.

The text arrives as a file, never argv — a title starting with "-" must not be
readable as an option, and there is no argv length ceiling to think about. The
voice names are argv, but the server validates them against `--list` before
they get here.
"""

import json
import sys
from importlib.util import find_spec
from pathlib import Path

USAGE = "usage: tts.py --list | <text-file> <voice> <out.wav> [<voice> <out.wav> ...]"


def preset_path() -> Path:
    """The shipped preset table, located without importing the package."""
    spec = find_spec("vieneu")
    if spec is None or not spec.submodule_search_locations:
        sys.exit("vieneu is not installed in this interpreter")
    return Path(spec.submodule_search_locations[0]) / "assets" / "voices_v3_turbo.json"


def do_list() -> None:
    """Prints one TSV row per preset: name, gender, region, style."""
    path = preset_path()
    if not path.exists():
        sys.exit(f"vieneu preset table missing at {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    for name, v in data.get("presets", {}).items():
        # Region lives only inside the description — "Nữ · Nam · Phong cách
        # tin tức" is gender · region · style — so it is parsed out here
        # rather than read off a field of its own.
        parts = [p.strip() for p in v.get("description", "").split("·")]
        region, style = (parts[1], parts[2]) if len(parts) >= 3 else ("", v.get("style", ""))
        print("\t".join((name, v.get("gender", ""), region, style)))


def do_speak(text_file: str, jobs: list[tuple[str, str]]) -> None:
    from vieneu import Vieneu

    text = Path(text_file).read_text(encoding="utf-8")
    # int8 ONNX: the README's own recommendation on Apple Silicon, where the
    # torch-free CPU path beats the MPS build.
    tts = Vieneu(mode="v3turbo", backend="onnx", precision="int8")
    for voice, out in jobs:
        tts.save(tts.infer(text, voice=voice), out)


if __name__ == "__main__":
    argv = sys.argv[1:]
    if argv == ["--list"]:
        do_list()
    elif len(argv) >= 3 and len(argv) % 2 == 1:
        pairs = [(argv[i], argv[i + 1]) for i in range(1, len(argv), 2)]
        do_speak(argv[0], pairs)
    else:
        sys.exit(USAGE)
