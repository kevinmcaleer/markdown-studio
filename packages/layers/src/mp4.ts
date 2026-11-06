// MP4 (H.264) for the animated model, encoded by the browser itself
// (WebCodecs' VideoEncoder) and put in an MP4 file by mp4-muxer. Smaller and
// smoother than a GIF, in full colour; where the browser can't encode H.264
// (`mp4Config` gives null), the animation is a GIF instead.

import { ArrayBufferTarget, Muxer } from "mp4-muxer";

/**
 * H.264 profiles to try, most widely played first: Main, Baseline, High
 * (level 4.0), then the same at level 5.1 for big pictures (a 9:16 1080p
 * video), which some encoders want named.
 */
const CODECS = ["avc1.4d0028", "avc1.42001f", "avc1.640028", "avc1.4d0033", "avc1.640033", "avc1.42e033"];

/** About this many bits a second for each pixel of the picture: line art on a flat grey needs little. */
const BITS_PER_PIXEL_SECOND = 2.2;

/** The encoder settings this browser can use for a `width`×`height` video, or null when it can't make an MP4. */
export async function mp4Config(width: number, height: number, fps: number): Promise<VideoEncoderConfig | null> {
  return (await mp4Configs(width, height, fps, 1))[0] ?? null;
}

/**
 * Every encoder setting this browser says it can use (up to `max`), best
 * first: each profile as the browser likes it, then with the software
 * encoder. A hardware encoder can say yes and then fail part way (Safari,
 * some Macs), so the next one is tried before giving up on an MP4.
 */
export async function mp4Configs(width: number, height: number, fps: number, max = 4): Promise<VideoEncoderConfig[]> {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return [];
  // H.264 wants even sizes.
  if (width % 2 || height % 2) return [];
  const out: VideoEncoderConfig[] = [];
  for (const hw of [undefined, "prefer-software"] as const) {
    for (const codec of CODECS) {
      const config: VideoEncoderConfig = {
        codec,
        width,
        height,
        bitrate: Math.round(width * height * BITS_PER_PIXEL_SECOND),
        framerate: fps,
        avc: { format: "avc" },
        ...(hw ? { hardwareAcceleration: hw } : {}),
      };
      try {
        const { supported } = await VideoEncoder.isConfigSupported(config);
        if (supported) {
          out.push(config);
          // One of each kind: the first profile that works with the browser's choice of encoder, and in software.
          break;
        }
      } catch {
        // Not this one.
      }
    }
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Writes the frames of a canvas as an MP4: `add` each frame with how long
 * it shows, then `finish`. A held frame is one frame shown longer.
 */
export class Mp4Writer {
  private muxer: Muxer<ArrayBufferTarget>;
  private encoder: VideoEncoder;
  private failed: Error | null = null;
  private at = 0;
  private lastKey = -Infinity;

  constructor(config: VideoEncoderConfig) {
    this.muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "avc", width: config.width, height: config.height }, fastStart: "in-memory" });
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
      error: e => (this.failed = e instanceof Error ? e : new Error(String(e))),
    });
    this.encoder.configure(config);
  }

  /** The canvas as it is now, shown for `ms` milliseconds. */
  async add(canvas: HTMLCanvasElement, ms: number): Promise<void> {
    if (this.failed) throw this.failed;
    const frame = new VideoFrame(canvas, { timestamp: Math.round(this.at * 1000), duration: Math.round(ms * 1000) });
    // A key frame every two seconds, so a player can start anywhere in the loop.
    const key = this.at - this.lastKey >= 2000;
    if (key) this.lastKey = this.at;
    this.encoder.encode(frame, { keyFrame: key });
    frame.close();
    this.at += ms;
    // Don't let the encoder fall far behind.
    if (this.encoder.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 0));
  }

  async finish(): Promise<Blob> {
    await this.encoder.flush();
    if (this.failed) throw this.failed;
    this.encoder.close();
    this.muxer.finalize();
    return new Blob([this.muxer.target.buffer], { type: "video/mp4" });
  }

  close(): void {
    if (this.encoder.state !== "closed") this.encoder.close();
  }
}
