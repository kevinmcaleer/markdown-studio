import { afterEach, describe, expect, it, vi } from "vitest";
import { mp4Config } from "./mp4";

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
    expect(tried).toEqual(["avc1.4d0028", "avc1.42001f"]);
    expect(config).toMatchObject({ codec: "avc1.42001f", width: 800, height: 600, framerate: 15 });
  });
});
