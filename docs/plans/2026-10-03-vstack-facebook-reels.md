# Facebook Reels draft publishing — plan

Spec: `docs/specs/2026-10-03-vstack-facebook-reels-design.md`. Branch
`feat/facebook-reels` (off `feat/horizontal-cut`).

1. **`server/facebook.ts` pure half + tests (TDD).** `buildCaption`,
   `reelLengthError` in `server/facebook.test.ts` first, watch fail, implement.
2. **`server/facebook.ts` network half.** Config paths, `readClient`,
   `readPageToken`, `checkFacebook`, `uploadReel` (start → rupload via
   `node:https` with `putVideo`'s guards → finish `DRAFT`), `reelProgress`,
   `draftsUrl`.
3. **`scripts/facebook-auth.ts` + `pnpm facebook-auth`.** Exchange → `/me/accounts`
   → write token 0600; `FB_PAGE` picks among several Pages.
4. **Routes** in `server/index.ts`: `/api/publish-reel` (isOutName, existsSync,
   probeFile → reelLengthError 400, caption blank 400, upload),
   `/api/publish-reel/progress`; `checkFacebook()` at boot.
5. **Client.** `api.publishReel` / `api.reelProgress`; `fbVideoId` in
   `AppState`, reset beside every `ytThumbnail: false`; `doPublishReel`;
   button + badge + Business Suite link in the preview bar, tall shorts only;
   title `oninput` flips it in place.
6. **Docs + verify.** CLAUDE.md (spec pointer, architecture rows, route count),
   `pnpm test`, `pnpm build`.
