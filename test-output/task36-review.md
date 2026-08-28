# Task36 final re-review: c7f509f..9df5445

## Verification

- `pnpm exec vitest run packages/scene3d-core/src/tools.test.ts packages/agent-tools/src/index.test.ts packages/agent-tools/src/scene3d-execution.test.ts packages/agent-tools/src/scene3d-mcp.test.ts` — 48 tests passed.
- `pnpm --filter @joy-media/scene3d-core build` — passed.
- `pnpm --filter @joy-media/agent-tools build` — passed.
- `git diff --check c7f509f..9df5445` — passed.

## Decision

NOT APPROVED.

The follow-up adds operation digests, a one-time in-memory ledger, an execution seam, audit/idempotency callbacks, and an in-process MCP-shaped gateway. The approval/policy boundary and production host integration still have blocking gaps.

## Findings

1. **[P1] The operation digest is not a cryptographic approval binding.**

   `scene3DToolInputDigest` and `scene3DToolDiffDigest` use a 32-bit FNV-style hash (`packages/scene3d-core/src/tools.ts:290-322`). This is collision-prone and unsuitable for authorizing untrusted agent input: an attacker can construct a different request with the same digest. Use a cryptographic SHA-256 digest (or a trusted signed approval/plan hash) over canonicalized tool/input/diff data.

2. **[P1] Policy/approval enforcement remains optional and caller-forgeable.**

   `Scene3DPlanExecutor` only calls `ApprovalEngine.evaluateStep` when both optional `planStep` and `editorContext` are supplied (`packages/agent-tools/src/scene3d-execution.ts:83-97`). With those omitted, a caller can construct a matching `Scene3DApprovalBinding` directly and execute a write without the policy/approval engine. The executor should require a trusted approval issuer or mandatory policy/plan inputs, rather than treating a structurally matching object as an authorization grant.

3. **[P1] The MCP gateway is not an MCP transport and the Studio chat is still disconnected.**

   `Scene3DMcpGateway` is an in-process wrapper (`packages/agent-tools/src/scene3d-mcp.ts`) but there is still no `apps/mcp-server` stdio package, protocol server, or transport/session authentication. `ThreeDStudioChat.tsx` remains proposal-only and does not call preview/approval/execution, so the requested mocked “propose → dry run → approve → undo” journey is not reachable.

4. **[P1] The normal registry still cannot execute the new tools.**

   `createToolRegistry()` adds 3D definitions to `tools`, but `getTool('scene3d.add')` remains `undefined` because only the existing query/edit implementations populate `toolImplMap` (`packages/agent-tools/src/registry.ts:68-83`), and `getToolsByCategory()` filters only the old tool list. The new executor is a separate seam and is not wired into the standard plan executor/registry contract.

5. **[P1] Commit failure can consume approval without recording execution or allowing retry.**

   `Scene3DPlanExecutor` consumes the approval in `Scene3DApprovalLedger` before calling `request.commit.commit` (`packages/agent-tools/src/scene3d-execution.ts:119-145`). If persistence throws, the executor propagates the exception without failure audit/idempotency state; the approval is already consumed, so retry cannot recover. Commit must be transactional or the executor needs explicit rollback/failed-commit handling.

6. **[P2] Shared revision/commit is still an external callback with no concurrency check.**

   The gateway returns a session snapshot and the executor returns a new revision to `commit`, but does not compare-and-swap the persisted revision. A different idempotency key can submit another approval against the same stale snapshot unless every host implements that check.

7. **[P2] Runtime allow-list and read schemas remain incomplete.**

   `Scene3DMcpGateway.read` and `.preview` rely on TypeScript unions only; unknown runtime names are not rejected by the core read/default command paths. Also, registry output schemas still advertise every read result as an object even though `scene3d.assets` returns an array. Validate names at runtime and publish exact read/write schemas.

The `ce3fcfe` diff enhancement, approval ledger, executor, and gateway tests pass; they do not cover digest collisions, omitted policy inputs, registry execution, transport authentication, commit failure, or stale commit races.
