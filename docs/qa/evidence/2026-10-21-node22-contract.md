# Node 22 contract and render suites: 2026-10-21

Receipt for the readiness plan item "Run the contract suite on additional supported Node versions".

- Host: Ubuntu 24.04 under WSL on the development PC.
- Node: v22.23.3, the minimum supported major (root `engines` is `>=22`).
- pnpm: 11.15.0, installed with `npm i -g pnpm@11.15.0`.
- FFmpeg and FFprobe: 6.1.1 (distribution package).
- Source: a clean clone of `hadimoti/joy-p0-query-plan` at `2f779f4d155ac85e7c135a6b43ff695fab4136b6`, the bundle head. The five test files in the command were unchanged from that commit to candidate `34da662e`. The CI lane `node-contracts (Node 22.17.0)` in run 39527152795 runs the full `apps/cli/src` suite on Node 22 at `34da662e`, and it passed.

Command, run from the repository root:

```
pnpm exec vitest run apps/cli/src/humanized/cli-contract.e2e.test.ts \
  apps/cli/src/humanized/cli-schemas.e2e.test.ts \
  apps/cli/src/humanized/agent-delivery.e2e.test.ts \
  apps/cli/src/humanized/agent-run.e2e.test.ts \
  apps/cli/src/humanized/render-real.e2e.test.ts \
  --no-file-parallelism
```

Result, from the vitest summary: `Test Files 5 passed (5)`, `Tests 91 passed (91)`.

The raw log stayed on the WSL host at `/tmp/node22-contract.log`, which is not durable. The WSL shell's exit code was not trusted for this run, because `vitest` under WSL exited 0 in earlier runs that reported failures. The summary counts above are the evidence.

Node 24.19.0 remains the Windows evidence for the same suites.
