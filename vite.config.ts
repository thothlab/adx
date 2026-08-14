import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import path from "node:path";

export default defineConfig({
  plugins: [solid()],
  // Tests default to the `node` environment. vite-plugin-solid otherwise forces
  // `jsdom`, which isn't a dependency here, so every test file would fail the
  // run. Component tests that need a DOM opt in per-file with
  // `// @vitest-environment jsdom` (and add jsdom then).
  test: { environment: "node" },
  clearScreen: false,
  server: {
    // 1430/1431, not Tauri's default 1420/1421: Pane runs on the default pair
    // on the same machine, and `strictPort` turns the overlap into a hard
    // "Port is already in use" failure of `tauri dev` rather than a fallback.
    // Keep these in sync with `devUrl` in `src-tauri/tauri.conf.json`.
    port: 1430,
    strictPort: true,
    host: "127.0.0.1",
    hmr: { protocol: "ws", host: "127.0.0.1", port: 1431 },
    watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: {
    target: "es2022",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
