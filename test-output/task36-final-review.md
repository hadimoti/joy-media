# Task 36 final review — APPROVED

Reviewed exact range `0ad2eda..23cdcfb` on 2026-08-22.

The final revision closes the earlier approval/replay findings:

- Approval receipts are host-secret signed; their verified payload binds actor, project, scene, revision, plan, step, tool, exact input/diff digests, expiry, and approval ID.
- The executor now computes the bounded candidate purely and passes the approval receipt, CAS expectation, plan/step, idempotency key, and deterministic result into a mandatory host commit contract.
- That commit contract explicitly requires one durable atomic CAS transaction that writes the scene, consumes the receipt, and persists the replay record. The executor does not independently record a success.
- Ambiguous thrown commit outcomes quarantine the receipt and require a durable host status resolution before retry; explicit rejected CAS results remain safely retryable.
- The MCP handler uses the registered allow-list, requires write metadata, and performs runtime top-level input validation before dispatch.

The in-memory ledger/store remains a test seam only. No external MCP transport or deployment is claimed, which is an honest deferral.

## Verification

- `git diff --check 0ad2eda..23cdcfb` — passed.
- `pnpm exec vitest run packages/scene3d-core/src/tools.test.ts packages/agent-tools/src/scene3d-execution.test.ts packages/agent-tools/src/scene3d-mcp.test.ts` — passed (3 files, 15 tests).
- `pnpm --filter @joy-media/scene3d-core build` — passed.
- `pnpm --filter @joy-media/agent-tools test` — passed (17 files, 301 tests).
- `pnpm --filter @joy-media/agent-tools build` — passed.
