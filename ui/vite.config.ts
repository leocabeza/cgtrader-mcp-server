import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Per-tool UI bundler. Each UI has its own directory (ui/<tool>/) with its
// own index.html entry. Callers pass --root ui/<tool> so Vite resolves the
// entry relative to that directory and emits dist/index.html inside it.
//
// We keep a single shared vite config rather than duplicating one per tool
// because every UI has identical bundling requirements (singlefile, inline
// assets). The shape of each UI (HTML/CSS/JS) is what differs.

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "index.html",
    },
  },
});
