import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    // `/out` joins `/api` because finished exports live outside the project
    // root now (~/Desktop/vstack by default), where Vite's static serving
    // cannot reach them. `/media` deliberately stays unproxied — the clip
    // cache IS under the root, and Vite serves it for free.
    proxy: { "/api": "http://localhost:8787", "/out": "http://localhost:8787" },
  },
  // media/ holds the clip cache and must never enter a production build.
  build: { copyPublicDir: false },
});
