# WP-29 — Export recovery and durable re-download

**Run:** 2026-08-11 07:21 +03:30

**Status:** PASS

**Source under test:** pre-deploy working tree based on `10751b1856de`; final
closeout SHA remains pending

## Accepted browser matrix

`tests/e2e/wp29-export-recovery.spec.ts` passed in installed Google Chrome at
every required viewport (`PLAYWRIGHT_USE_SYSTEM_CHROME=1`):

| Viewport    | Result | Duration |
| ----------- | -----: | -------: |
| 1639 × 1066 |   PASS |   14.2 s |
| 1366 × 768  |   PASS |   13.1 s |
| 1024 × 768  |   PASS |   13.8 s |

Command:

```text
PLAYWRIGHT_BASE_URL=http://127.0.0.1:42773 pnpm exec playwright test tests/e2e/wp29-export-recovery.spec.ts --reporter=html
3 passed (21.6s)
```

The local HTML evidence report was retained at
`test-results/wp29-export-recovery-html/index.html`; it contains one sanitized
JSON verification attachment per viewport. It is intentionally excluded from
Git because Playwright reports contain machine-specific transient paths.

## Proven behavior

Each authenticated disposable project imported the committed three-second MP4
fixture and exercised the real browser export surface. The matrix proves:

1. Reload during an active encode converts the durable running intent into one
   `interrupted-retryable` row rather than leaving Exporting stuck.
2. Retry reuses that logical operation and finishes as one completed row.
3. The MP4 is written and verified in OPFS before terminal history/ledger state.
4. A hard reload hydrates the completed Blob only after byte-length and SHA-256
   verification; re-download produces the same byte count and digest.
5. Cancel creates a retryable terminal row, releases recorder/media/audio
   resources, and removes partial cache state.
6. Retrying the cancelled operation succeeds without a third history row.
7. A project revision change during encoding or finalization rejects the stale
   result instead of overwriting newer edits.

The existing FFprobe acceptance in
`docs/qa/WP-29-step-03-ffprobe-audio-20260810-0621.md` remains the codec/container
proof. This matrix closes the separate reload, retry, cancel, durable cache, and
re-download acceptance.

## Supporting deterministic gates

- `export-history.test.ts`: project-scoped v2 migration and reload recovery.
- `opfs-export-cache.test.ts`: verified put/read/prune/remove behavior.
- `project-operation-ledger.test.ts`: stable operation identity and uncertain
  operation recovery.
- `export-recovery-contract.test.ts`: abort propagation, commit ordering,
  immutable source revision, and retry mismatch rejection.
- `export-mp4-contract.test.ts`: durable cache and recent-process wiring.

No live project, paid provider, production export, or production configuration
was changed by this acceptance run. The disposable browser state was isolated
to the local authenticated test server.
