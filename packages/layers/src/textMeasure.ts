// Fabric.js measures every letter once at 400px and scales the width down to
// the text's real size. That is only right when a font keeps the same shape at
// every size. The system fonts Layers uses (SF Pro on a Mac, and other fonts
// with optical sizes or size-specific spacing) are drawn a little wider at
// small sizes than a scaled-down 400px measurement says. The letters on screen
// then run past the place Fabric thinks they end: centred text looks pushed to
// the right and clipped, and while editing the caret and the letter Backspace
// removes sit to the left of the letters you can see.
//
// So measure each letter at the size it is drawn, keeping a width cache for
// each size (Fabric's cache is kept per font, style and weight only).

import { cache, FabricText as Text } from "fabric";

type MeasureStyle = { fontFamily: string; fontStyle: string; fontWeight: string | number; fontSize?: number };

/** The cache key for a font at one size: Fabric keys by family, so the size goes in with it. */
export function sizedFamily(style: { fontFamily: string; fontSize?: number }): string {
  return style.fontSize ? `${style.fontFamily}@${style.fontSize}` : style.fontFamily;
}

let installed = false;

/** Make Fabric measure text at its real size. Safe to call more than once. */
export function measureTextAtRealSize(): void {
  if (installed) return;
  installed = true;

  const getFontCache = cache.getFontCache.bind(cache);
  cache.getFontCache = (style: MeasureStyle) => getFontCache({ ...style, fontFamily: sizedFamily(style) });

  // clearFontCache(family) would now miss the sized keys, so drop them all.
  const clear = cache.clearFontCache.bind(cache);
  cache.clearFontCache = (fontFamily?: string) => {
    if (!fontFamily) return clear();
    const prefix = `${fontFamily.toLowerCase()}@`;
    for (const key of [...cache.charWidthsCache.keys()]) {
      if (key === fontFamily.toLowerCase() || key.startsWith(prefix)) cache.charWidthsCache.delete(key);
    }
  };

  type Measure = (this: Text, ch: string, style: MeasureStyle, prev: string | undefined, prevStyle: unknown) => unknown;
  const proto = Text.prototype as unknown as { _measureChar: Measure };
  const measure = proto._measureChar;
  proto._measureChar = function (ch, style, prev, prevStyle) {
    const own = Object.prototype.hasOwnProperty.call(this, "CACHE_FONT_SIZE");
    const saved = this.CACHE_FONT_SIZE;
    if (style.fontSize) this.CACHE_FONT_SIZE = style.fontSize;
    try {
      return measure.call(this, ch, style, prev, prevStyle);
    } finally {
      if (own) this.CACHE_FONT_SIZE = saved;
      else delete (this as { CACHE_FONT_SIZE?: number }).CACHE_FONT_SIZE;
    }
  };
}
