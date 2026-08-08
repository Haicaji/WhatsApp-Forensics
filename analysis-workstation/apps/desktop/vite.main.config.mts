import { builtinModules } from "node:module";
import { resolve } from "node:path";

import { defineConfig } from "vite";

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

export default defineConfig({
  build: {
    ssr: resolve(import.meta.dirname, "src/main/index.ts"),
    outDir: resolve(import.meta.dirname, "dist/electron/main"),
    emptyOutDir: false,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      external: (source) => source === "electron" || nodeBuiltins.has(source),
      output: {
        entryFileNames: "index.cjs",
        format: "cjs",
      },
    },
    target: "node22",
  },
  ssr: {
    noExternal: true,
  },
});
