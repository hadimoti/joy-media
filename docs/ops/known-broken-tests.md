# Known broken tests (not run by any gate)

- `ops/self-hosted/linux-runner/p3-execution-budget.test.mjs` always fails with
  "Vitest failed to access its internal state": it imports `vitest` but is run with
  `node --test`, and it is not in any vitest `include` glob. No gate (`pnpm verify:ci`,
  `pnpm test:harness`, the WSL fresh-clone check) runs it. Fix by moving it to `node:test`
  or into a vitest include, then wire it into a gate.
