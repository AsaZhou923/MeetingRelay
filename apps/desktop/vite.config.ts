import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST || false;

export default defineConfig({
  root: ".",
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  server: {
    port: 1420,
    strictPort: true,
    host,
  },
  build: {
    target: "chrome105",
    minify: "oxc",
    sourcemap: false,
    outDir: "dist",
    emptyOutDir: true,
  },
});
