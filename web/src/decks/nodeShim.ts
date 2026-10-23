// Stand-ins for the Node modules keynotejs 0.1.0 imports, so it runs in the
// browser. Decks only uses the parts that work on bytes (Presentation.fromBytes,
// addSlide, toBytes), never the ones that touch the file system. Remove this
// (and the plugin in vite.config.ts) once keynotejs ships its browser build.

function unavailable(): never {
  throw new Error("Not available in the browser");
}

export const readFile = unavailable;
export const readdir = unavailable;
export const stat = unavailable;
export const writeFile = unavailable;
export const readdirSync = (): string[] => [];
export const join = (...parts: string[]) => parts.join("/");
export const relative = unavailable;
export const resolve = (path: string) => path;
export const sep = "/";
export const fileURLToPath = (url: string | URL) => String(url);
