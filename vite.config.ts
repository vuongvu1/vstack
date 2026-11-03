import { defineConfig } from "vite";

// `pnpm prod`: a stable instance to USE while editing the code under `pnpm start`.
// No HMR and no file watching, so edits never reload the open tab. Still the
// dev server rather than `vite build` + `vite preview`, because the framing
// `<video>` reads `/media/` straight off the project root, which only the dev
// server serves.
// ponytail: modules transformed before an edit stay cached; one not yet
// loaded is read fresh from disk. Restart `pnpm prod` to pick up changes.
const prod = !!process.env.VSTACK_PROD;
const api = `http://localhost:${process.env.VSTACK_PORT || 8787}`;

export default defineConfig({
  server: {
    port: 5173,
    // `/out` joins `/api` because finished exports live outside the project
    // root now (~/Desktop/vstack by default), where Vite's static serving
    // cannot reach them. `/media` deliberately stays unproxied — the clip
    // cache IS under the root, and Vite serves it for free.
    proxy: { "/api": api, "/out": api },
    hmr: !prod,
    watch: prod ? null : undefined,
  },
  // media/ holds the clip cache and must never enter a production build.
  build: { copyPublicDir: false },
});
