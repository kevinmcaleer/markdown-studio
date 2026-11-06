import { afterEach, describe, expect, it, vi } from "vitest";
import { mp4Config, mp4Configs } from "./mp4";

afterEach(() => vi.unstubAllGlobals());

describe("mp4Config", () => {
  it("is null where the browser has no video encoder, so the animation is a GIF", async () => {
    vi.stubGlobal("VideoEncoder", undefined);
    expect(await mp4Config(800, 600, 15)).toBeNull();
  });

  it("is null for an odd size, which H.264 can't take", async () => {
    vi.stubGlobal("VideoFrame", class {});
    vi.stubGlobal("VideoEncoder", { isConfigSupported: async () => ({ supported: true }) });
    expect(await mp4Config(801, 600, 15)).toBeNull();
  });

  it("picks the first H.264 profile the browser can encode", async () => {
    const tried: string[] = [];
    vi.stubGlobal("VideoFrame", class {});
    vi.stubGlobal("VideoEncoder", {
      isConfigSupported: async (c: VideoEncoderConfig) => {
        tried.push(c.codec);
        if (c.codec === "avc1.4d0028") throw new TypeError("no");
        return { supported: c.codec === "avc1.42001f" };
      },
    });
    const config = await mp4Config(800, 600, 15);
    expect(tried[0]).toBe("avc1.4d0028");
    expect(tried.at(-1)).toBe("avc1.42001f");
    expect(config).toMatchObject({ codec: "avc1.42001f", width: 800, height: 600, framerate: 15 });
  });

  it("tries Baseline at level 4.0, so an encoder that only does Baseline still makes a 1080p MP4", async () => {
    vi.stubGlobal("VideoFrame", class {});
    vi.stubGlobal("VideoEncoder", { isConfigSupported: async (c: VideoEncoderConfig) => ({ supported: c.codec === "avc1.42e028" }) });
    expect(await mp4Config(1080, 1920, 20)).toMatchObject({ codec: "avc1.42e028" });
  });
});

describe("mp4Configs", () => {
  it("gives the browser's choice, then its software encoder, for when one gives up part way", async () => {
    vi.stubGlobal("VideoFrame", class {});
    vi.stubGlobal("VideoEncoder", { isConfigSupported: async () => ({ supported: true }) });
    const configs = await mp4Configs(1280, 720, 20);
    expect(configs.map(c => [c.codec, c.hardwareAcceleration])).toEqual([
      ["avc1.4d0028", undefined],
      ["avc1.4d0028", "prefer-software"],
    ]);
  });
});
