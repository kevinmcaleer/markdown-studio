import { getShareToken } from "../api";

// Images on slides, fetched for export. Only images stored in Markdown Studio
// (or inline data: URLs) are included: the page's security policy doesn't let
// it fetch from other sites, and the preview couldn't show those either.

export type LoadedImage = { bytes: Uint8Array; mime: string; width: number; height: number };

export type ImageLoader = (src: string) => Promise<LoadedImage | null>;

export function isLocalImage(src: string): boolean {
  if (src.startsWith("data:image/")) return true;
  try {
    return new URL(src, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** Fetches each image once, however many slides it's on. */
export function imageLoader(): ImageLoader {
  const cache = new Map<string, Promise<LoadedImage | null>>();
  return (src) => {
    let found = cache.get(src);
    if (!found) {
      found = load(src).catch(() => null);
      cache.set(src, found);
    }
    return found;
  };
}

async function load(src: string): Promise<LoadedImage | null> {
  if (!isLocalImage(src)) return null;
  const share = getShareToken();
  const response = await fetch(src, { credentials: "same-origin", headers: share && !src.startsWith("data:") ? { "X-Share-Token": share } : {} });
  if (!response.ok) return null;
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) return null;
  const { width, height } = await naturalSize(blob);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, width, height };
}

async function naturalSize(blob: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth || 800, height: img.naturalHeight || 600 };
  } catch {
    return { width: 800, height: 600 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function dataUrl(image: LoadedImage): string {
  let binary = "";
  for (let i = 0; i < image.bytes.length; i += 0x8000) binary += String.fromCharCode(...image.bytes.subarray(i, i + 0x8000));
  return `data:${image.mime};base64,${btoa(binary)}`;
}

/** The largest box with the image's shape that fits in `w` x `h`, centred in it. */
export function contain(image: { width: number; height: number }, x: number, y: number, w: number, h: number) {
  const scale = Math.min(w / image.width, h / image.height);
  const iw = image.width * scale;
  const ih = image.height * scale;
  return { x: x + (w - iw) / 2, y: y + (h - ih) / 2, w: iw, h: ih };
}
