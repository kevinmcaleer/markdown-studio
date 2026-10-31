import { defineConfig } from "vite";
export default defineConfig({ define: { __LAYERS_VERSION__: JSON.stringify("dev") }, server: { port: 5199 } });
