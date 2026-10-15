# Known broken tests (not run by any gate)

- `ops/self-hosted/linux-runner/p3-execution-budget.test.mjs` always fails with
  "Vitest failed to access its internal state": it imports `vitest` but is run with
  `node --test`, and it is not in any vitest `include` glob. No gate (`pnpm verify:ci`,
  `pnpm test:harness`, the WSL fresh-clone check) runs it. Fix by moving it to `node:test`
  or into a vitest include, then wire it into a gate.

# Known gaps (follow-ups)

- FT3 (#11, streaming): the gateway falls back to the next free model when a non-stream answer is
  cut at `max_tokens` with no content (`EMPTY_COMPLETION`). Streaming responses are piped to the
  client as they arrive, so an empty length-cut stream is not detected and does not fall back.
  Fixing it needs the SSE path to hold the first content or tool-call delta before committing to a
  model.
