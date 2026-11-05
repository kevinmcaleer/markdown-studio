// The 3D scene eval (evals/): its own run, apart from the unit tests.
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __LAYERS_VERSION__: JSON.stringify("eval") },
  test: { environment: "node", include: ["evals/**/*.eval.ts"], testTimeout: 60_000 },
});
