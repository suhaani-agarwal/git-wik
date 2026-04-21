import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { "cli/index": "src/cli/index.ts" },
    format: ["esm"],
    outDir: "dist",
    banner: { js: "#!/usr/bin/env node" },
    splitting: false,
    sourcemap: true,
    clean: true,
  },
  {
    entry: { "mcp/server": "src/mcp/server.ts" },
    format: ["esm"],
    outDir: "dist",
    splitting: false,
    sourcemap: true,
  },
]);
