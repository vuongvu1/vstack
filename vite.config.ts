import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8787" },
  },
  // media/ holds the clip cache and must never enter a production build.
  build: { copyPublicDir: false },
});
