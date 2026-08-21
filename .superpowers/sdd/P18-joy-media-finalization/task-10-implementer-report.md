### Task 10 implementer report

Implemented review fixes for the closed typed Worker job protocol.

Changes:

- Persisted typed WorkerJobV1 payload, requirements, idempotency key, and max attempts in the in-memory control plane, PostgreSQL schema/adapter, HTTP enqueue path, Worker client lease DTO, and Worker runtime flow.
- Added durable validated receipt JSON for Worker completions so render.export and render.inspect round-trip report/output/finding receipts without old derivative-column fallthrough.
- Added protocol-compatible AI receipt variants for text.lm-studio, text.openrouter, video.runway, and edit.higgsfield, with Worker runtime mapping from provider-local result kinds.
- Added focused regressions for typed job enqueue/lease idempotency, unsafe payload rejection, durable render.inspect receipt recovery, HTTP typed job round-trip, Worker client typed lease preservation, and AI receipt compatibility.

Verification:

- `pnpm -v` -> `11.15.0`
- `pnpm exec vitest run packages/job-protocol/src/protocol.test.ts apps/api/src/control-plane.test.ts apps/api/src/postgres-control-plane.test.ts apps/api/src/http-server.test.ts apps/worker/src/runtime.test.ts` -> 34 tests passed
- `pnpm exec vitest run apps/worker/src/control-plane-client.test.ts` -> 5 tests passed
- `pnpm exec tsc -b packages/job-protocol apps/api apps/worker --pretty false` -> passed
- `pnpm exec prettier --check packages/job-protocol/src/protocol.ts packages/job-protocol/src/protocol.test.ts apps/api/src/control-plane.ts apps/api/src/control-plane.test.ts apps/api/src/postgres-schema.ts apps/api/src/postgres-control-plane.ts apps/api/src/postgres-control-plane.test.ts apps/api/src/http-server.ts apps/api/src/http-server.test.ts apps/worker/src/control-plane-client.ts apps/worker/src/control-plane-client.test.ts apps/worker/src/runtime.ts apps/worker/src/runtime.test.ts` -> passed
- `git diff --check -- packages/job-protocol/src/protocol.ts packages/job-protocol/src/protocol.test.ts apps/api/src/control-plane.ts apps/api/src/control-plane.test.ts apps/api/src/postgres-schema.ts apps/api/src/postgres-control-plane.ts apps/api/src/postgres-control-plane.test.ts apps/api/src/http-server.ts apps/api/src/http-server.test.ts apps/worker/src/control-plane-client.ts apps/worker/src/control-plane-client.test.ts apps/worker/src/runtime.ts apps/worker/src/runtime.test.ts` -> passed
