// Layers: a Canva-style editor for graphics made of text, shapes and pictures.
// A graphic is saved as a PNG with its layers stored inside (see png.ts), so
// it shows anywhere a picture does and can always be opened again.
export { mount, type LayersHandle, type LayersImage, type LayersOptions, type LayersResult } from "./editor";
export * from "./doc";
export { SIZES } from "./doc";
export { TEMPLATES } from "./elements";
export { CHUNK_KEYWORD, readText, writeText } from "./png";
export { snap } from "./snap";

export const VERSION = __LAYERS_VERSION__;
