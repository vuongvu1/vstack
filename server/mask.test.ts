import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Rect } from "../src/geometry.ts";
import { CORNER_RADIUS, GUTTER, windowsOf } from "../src/frame.ts";
import { DEFAULT_LAYOUT, layoutById } from "../src/layout.ts";
import { probeFile } from "./ffmpeg.ts";
import { ensureMask, maskPath } from "./mask.ts";

const run = promisify(execFile);

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vstack-mask-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Decodes the PNG back to raw RGBA so alpha can be asserted per pixel. */
async function rgbaOf(path: string): Promise<Buffer> {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
    { encoding: "buffer", maxBuffer: 64 << 20 },
  );
  return stdout as unknown as Buffer;
}

function alphaAt(rgba: Buffer, x: number, y: number): number {
  return rgba[(y * 1080 + x) * 4 + 3] ?? -1;
}

describe("maskPath", () => {
  it("names the layout and both constants, so a constant change misses", () => {
    // The mask is cached across runs. If the filename ignored GUTTER or
    // CORNER_RADIUS, editing either constant would silently keep exporting
    // the old border while the preview showed the new one.
    const name = basename(maskPath(DEFAULT_LAYOUT, [], dir));
    expect(name).toContain(DEFAULT_LAYOUT.id);
    expect(name).toContain(`g${GUTTER}`);
    expect(name).toContain(`r${CORNER_RADIUS}`);
    expect(name.endsWith(".png")).toBe(true);
  });

  it("gives different layouts different files", () => {
    const other = layoutById("2h-2h");
    if (!other) throw new Error("test asked for unknown layout");
    expect(maskPath(DEFAULT_LAYOUT, [], dir)).not.toBe(maskPath(other, [], dir));
  });

  describe("maskPath — custom boxes", () => {
    const A: Rect = { x: 300, y: 700, w: 480, h: 480 };
    const B: Rect = { x: 302, y: 700, w: 480, h: 480 };

    it("is byte-identical to the no-customs name when there are none", () => {
      // The whole feature is inert until used: today's cached masks must keep
      // hitting, and this is what proves the filename did not move.
      expect(maskPath(DEFAULT_LAYOUT, [], dir)).toBe(maskPath(DEFAULT_LAYOUT, undefined, dir));
      expect(basename(maskPath(DEFAULT_LAYOUT, [], dir))).toBe(
        `${DEFAULT_LAYOUT.id}-g${GUTTER}-r${CORNER_RADIUS}.png`,
      );
    });

    it("gives a different file to a different custom rect", () => {
      // The mask outlives the process. Keyed on the layout alone, nudging a
      // custom box by 2px would keep serving the previous border to exports
      // while the preview showed the new one.
      expect(maskPath(DEFAULT_LAYOUT, [A], dir)).not.toBe(maskPath(DEFAULT_LAYOUT, [], dir));
      expect(maskPath(DEFAULT_LAYOUT, [A], dir)).not.toBe(maskPath(DEFAULT_LAYOUT, [B], dir));
    });

    it("keeps the name hex-only, so nothing client-shaped reaches the path", () => {
      const name = basename(maskPath(DEFAULT_LAYOUT, [A, B], dir));
      expect(name).toMatch(/^[a-z0-9-]+-g\d+-r\d+-c[0-9a-f]{8}\.png$/);
    });
  });
});

describe("ensureMask", () => {
  it("renders a 1080x1920 mask whose alpha matches the windows", async () => {
    const path = await ensureMask(DEFAULT_LAYOUT, [], dir);
    expect(path).toBe(maskPath(DEFAULT_LAYOUT, [], dir));
    expect(await probeFile(path)).toMatchObject({ width: 1080, height: 1920 });

    const rgba = await rgbaOf(path);
    const [top] = windowsOf(DEFAULT_LAYOUT);
    if (!top) throw new Error("1-1 has no first window");

    // Inside a piece: fully transparent, so the video shows through.
    expect(alphaAt(rgba, 540, 480)).toBe(0);
    expect(alphaAt(rgba, 540, 1440)).toBe(0);
    // Frame margin, seam, and the square corner outside the arc: white.
    expect(alphaAt(rgba, 0, 0)).toBe(255);
    expect(alphaAt(rgba, 540, 960)).toBe(255);
    expect(alphaAt(rgba, top.x, top.y)).toBe(255);
  });

  it("leaves no raw intermediate behind", async () => {
    await ensureMask(DEFAULT_LAYOUT, [], dir);
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(dir)).filter((f) => !f.endsWith(".png"))).toEqual([]);
  });

  it("reuses a cached mask instead of re-rendering it", async () => {
    const path = await ensureMask(DEFAULT_LAYOUT, [], dir);
    const before = (await stat(path)).mtimeMs;
    await ensureMask(DEFAULT_LAYOUT, [], dir);
    expect((await stat(path)).mtimeMs).toBe(before);
  });

  describe("ensureMask — custom boxes", () => {
    it("renders the ring and the window for a floating piece", async () => {
      const custom: Rect = { x: 300, y: 700, w: 480, h: 480 };
      const path = await ensureMask(DEFAULT_LAYOUT, [custom], dir);
      expect(path).toBe(maskPath(DEFAULT_LAYOUT, [custom], dir));
      const rgba = await rgbaOf(path);
      expect(alphaAt(rgba, custom.x + custom.w / 2, custom.y + custom.h / 2)).toBe(0);
      expect(alphaAt(rgba, custom.x + custom.w / 2, custom.y - GUTTER / 2)).toBe(255);
      // The seam the piece straddles, inside its window: transparent.
      expect(alphaAt(rgba, custom.x + custom.w / 2, 960)).toBe(0);
    });
  });
});
