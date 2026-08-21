Task 5 implementer report

Summary:
- Added `monitor-media-source.ts` to resolve timeline clip media through `PlayableAssetResolver` handles, return actionable pending/unavailable/revoked states, reject reference fixtures unless an explicit test adapter opts in, and own media element cleanup through `MonitorMediaElementBinding`.
- Removed production `/media/reference/${assetId}.mp4` source synthesis from `App.tsx`; Monitor playback, transition partner decode, frame identity, and browser export now use authorized blob-backed sources.
- Added control-plane asset/derivative metadata refresh in `App.tsx` so arbitrary media-library asset IDs can be converted into playable resolver requests when metadata is available.
- Added a shared `playableAssetDescriptorFromBrowserAsset` helper for complete control-plane asset metadata and wired resolver construction through `media-session.ts`.

TDD evidence:
- Red: `pnpm exec vitest run apps/editor-web/src/monitor-media-source.test.ts apps/editor-web/src/editor-web-live-gate.test.ts` failed because `./monitor-media-source.js` did not exist.
- Green: focused tests pass with 8/8 tests.

Verification:
- `pnpm exec vitest run apps/editor-web/src/monitor-media-source.test.ts apps/editor-web/src/editor-web-live-gate.test.ts` passed.
- `pnpm --filter @joy-media/editor-web build` passed. Vite reported the existing chunk-size warning.

Notes:
- I could not dispatch a separate reviewer from this subagent context because the collaboration tool was not exposed, so I performed a local diff review and tightened export-source release on preparation failure before final verification.
