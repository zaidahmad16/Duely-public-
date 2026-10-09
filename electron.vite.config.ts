import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: { build: { rollupOptions: { input: { index: resolve("src/main/index.ts") } } } },
  preload: { build: { rollupOptions: { input: { index: resolve("src/preload/index.ts") } } } },
  renderer: { root: "src/renderer", build: { rollupOptions: { input: { index: resolve("src/renderer/index.html") } } } },
});
