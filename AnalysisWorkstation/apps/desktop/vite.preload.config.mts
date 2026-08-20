import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, "src/preload/index.ts"),
      formats: ["cjs"],
      fileName: () => "index.cjs",
    },
    outDir: resolve(import.meta.dirname, "dist/electron/preload"),
    emptyOutDir: false,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      external: ["electron"],
    },
    target: "node22",
  },
});
