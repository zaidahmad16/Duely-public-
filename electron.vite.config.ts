import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: { build: { rollupOptions: { input: { index: resolve("src/main/index.ts") } } } },
  // a sandboxed preload can't be an ES module: CommonJS
  preload: { build: { rollupOptions: { input: { index: resolve("src/preload/index.ts") }, output: { format: "cjs", entryFileNames: "[name].cjs" } } } },
  renderer: { root: "src/renderer", build: { rollupOptions: { input: { index: resolve("src/renderer/index.html") } } } },
});
