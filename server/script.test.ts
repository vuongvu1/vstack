import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scriptMp3 } from "./script.ts";
import { VOICE } from "./starter.ts";

const run = promisify(execFile);
let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vstack-script-test-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scriptMp3", () => {
  // Real engine, so it pays the ~4.2s model load plus synthesis, and the
  // full suite runs it beside other real encodes — the same reason
  // server/starter.test.ts carries an explicit timeout.
  it("reads a multi-chunk script into one mp3", async () => {
    const para =
      "Hôm nay chúng ta sẽ nói về cách làm video ngắn cho kênh của mình. " +
      "Đầu tiên, bạn cần chọn đoạn hay nhất trong buổi phát trực tiếp. ";
    // Opens on "-": the text must travel by file, never argv, or tts.py
    // would read it as an option.
    const script = `- ${para}${para}\n\n${para}${para}`;
    // VieNeu chunks at 256 chars. One chunk is ~12s of audio at the measured
    // ~20 chars/s, so > 15s is what fails if only the first chunk is read.
    expect(script.length).toBeGreaterThan(256);

    const out = join(dir, "out.mp3");
    await scriptMp3(script, VOICE, dir, out);

    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=format_name,duration",
      "-of", "json",
      out,
    ]);
    const format = (JSON.parse(stdout) as { format: { format_name: string; duration: string } })
      .format;
    expect(format.format_name).toBe("mp3");
    expect(Number(format.duration)).toBeGreaterThan(15);
  }, 180_000);
});
