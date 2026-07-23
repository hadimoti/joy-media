# WP-18 — Plugin Host Wiring (first-party demo panel)

**Status:** done 2026-07-23 · **Parts:** P08 host integration · **Master plan:** §24
**Prerequisite:** P08 package WPs done; P07/WP-17 accepted

## Why
P08 SDK was unit-complete with zero `apps/editor-web` consumers.

## Done
- Browser-safe `@joy-media/plugin-sdk/browser` (policy + `FirstPartyPluginHost`, no Node crypto)
- Editor `plugin-host.ts` seeds `joy.first-party.demo-panel` disabled; safe mode default on
- Plugins panel: enable/disable, safe-mode toggle, demo contribution mount + non-destructive project data
- Workspace registers `plugins` panel

## Exit
- [x] editor-web imports SDK browser surface
- [x] demo panel mounts only when enabled and safe mode off
- [x] safe mode / disable proven by tests
- [x] typecheck clean; vite build without node:crypto
