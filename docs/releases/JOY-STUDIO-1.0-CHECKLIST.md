# JOY Studio 1.0 release checklist

Run from a clean checkout after installing Node 22 and pnpm:

1. `pnpm check`
2. `pnpm --filter @joy-media/editor-web build`
3. `pnpm --filter @joy-media/api build`
4. `pnpm --filter @joy-media/worker build`
5. `pnpm test:release`
6. Record authenticated browser evidence for `authenticated-editor-1.0` (login, project open,
   timeline edit, Motion Studio publish/place/preview, save/reopen, undo/redo, and verified export).
7. Run `pnpm release:gate` with the evidence JSON and archive the generated report, manifest, SBOM,
   artifact hashes, browser screenshots, and golden evidence in local/CI evidence storage; these
   generated outputs are ignored and are not committed to the source repository.

The gate must fail for zero tests, dirty generated output, fixture production handlers, missing
builds/manifest/SBOM, stale feature status, or an unverified journey. A quick browser export,
mocked API evidence, or an export without a passed inspection can never be marked as verified
delivery. Do not waive real-media, actual-render, persistence, privacy, or authentication checks.

## Scope

- Production: authenticated editor shell, project library, timeline, monitor/export, Joy Code
  deterministic edits, Motion Studio scene round-trip, Effect Studio, and the durable Production
  Board read surface with governed approval/cancel/retry actions.
- Demo-only: plugin demo panel and other fixture-backed demonstrations.
- Experimental: templates, workflow authoring, 3D preview, and Worker/provider jobs. The Production
  Board does not promote those capabilities; unavailable adapters and execution paths remain
  fail-closed and are explained in the board.
- Hidden: PSD import, durable 3D authoring, MCP authoring, and marketplace/collaboration transport.

## Operations

Back up the database and object-store metadata before deployment. Pair Workers through the owner
approval flow and verify capabilities before submitting jobs. A deployment requires an immutable
API/web release directory, health checks, browser smoke, and a recorded rollback target. Roll back
by restoring the previous immutable release symlinks and restarting only the affected service.
