# vstack

Turn two 9:8 regions of a YouTube video into a 1080×1920 vertical short.

Local single-user tool. Not deployed.

## Setup

    brew install yt-dlp   # ffmpeg is also required
    nvm use
    pnpm install

## Run

Two processes, two terminals:

    pnpm server   # backend on :8787
    pnpm dev      # Vite on :5173

## Docs

- Design: `docs/specs/2026-08-20-vstack-design.md`
- Plan: `docs/plans/2026-08-20-vstack.md`

## Note

Fetching YouTube video files conflicts with YouTube's Terms of Service unless
the content is yours or you hold a license. This tool exists for the former.
