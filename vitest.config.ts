import { defineConfig } from "vitest/config";

// Mirrors the Wrangler "Text" module rule in wrangler.jsonc so test imports
// of ui/**/dist/*.html resolve to the file's string contents.
export default defineConfig({
  plugins: [
    {
      name: "raw-html-as-string",
      transform(code, id) {
        if (/\/ui\/.*\/dist\/.*\.html$/.test(id)) {
          return {
            code: `export default ${JSON.stringify(code)};`,
            map: null,
          };
        }
      },
    },
  ],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
