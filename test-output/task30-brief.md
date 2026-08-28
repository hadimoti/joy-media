### Task 30 — Build the 1.0 release gate and prove all journeys

**Files**

- Modify: `.github/workflows/ci.yml` and root `package.json`
- Create: `tooling/release/package.json`, `tooling/release/src/gate.ts`, and
  `tooling/release/src/gate.test.ts`
- Modify: `tooling/release/README.md` and root `tsconfig.json`
- Modify: `README.md`, `apps/editor-web/README.md`, `apps/api/README.md`,
  `apps/worker/README.md`, `deploy/README.md`, and `STATE.md`
- Create: `docs/releases/JOY-STUDIO-1.0-CHECKLIST.md`

**Red**

Make the gate fail on zero tests, dirty generated artifacts, fixture handlers in production
registries, missing builds/manifest/SBOM, unverified browser journeys, or stale feature status.

**Green**

1. Add one non-deploying command for typecheck/lint/format/tests/builds/goldens/browser journeys,
   producing machine-readable results, artifact hashes, and SBOM/manifest.
2. Make CI upload reports/browser/golden evidence.
3. Document setup, Worker pairing, production/demo/experimental scope, backup, deploy prerequisites,
   and rollback.

**Verify**

```powershell
pnpm check
pnpm --filter @joy-media/editor-web build
pnpm --filter @joy-media/api build
pnpm --filter @joy-media/worker build
pnpm test:release
```

Run the complete 1.0 browser journey. A waiver requires named owner, reason, and expiry and cannot
cover the real-media, actual-render, persistence, privacy, or auth gates.

**Commit:** `build(release): add reproducible JOY Studio 1.0 gates`

---

## Phase 7 — 1.1 Templates and PSD

Tasks 31–32 are sequential because PSD application uses the compound transaction closure.

