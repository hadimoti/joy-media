# JOY Live Director baseline

Recorded: 2026-09-05

## Candidate ownership

- Worktree: `C:\Users\HadiMoti\.config\superpowers\worktrees\joy-media\joy-live-director`
- Branch: `codex/joy-live-director`
- Implementation base commit: `37a33034dbc078751fdb7cf5c0b706eaaad9d858`
- Base tree: `0517945fca8d12ffe1a569e357f80ee192946c47`
- `pnpm-lock.yaml` SHA-256: `f63985ba500c26875465b541e3aab8b7c0402bf80a8237b9bc837393087f6103`
- The worktree was clean before Live Director implementation changes.

This branch is isolated from the owner workspace and from the concurrently owned
`joy-vps` work. No deployment, service change, VPS checkout change, or Desktop
`gbrain` mirror mutation is authorized by this baseline record.

## Gbrain and live facts

`Start-Agent-Process.ps1` completed and updated the private PC workbench to
`c223bddf33dcf25fa295c8e99ebff75bd7d62e6f`; it ingested the other task's
redacted receipt. The authenticated VPS Gbrain MCP endpoint returned
`Transport closed` for identity, brief, and context reads after that bootstrap.
This record therefore relies only on the read-only Desktop brief for deployment
context and marks authoritative live-memory reads and writes **sync pending**.
The Desktop `gbrain` directory remains a pull-only mirror and is not edited.

The Desktop brief identifies the reviewed JOY agent foundation release as
`6a6a336cdd4fb0126c002dda86167f5c92ebfe32` and explicitly leaves full domain
adapters, durable project-scoped lifecycle, complete preview parity, and
rendered/audio verification open. Fontiran redistribution remains closed.

## Baseline validation

Passed before implementation:

```text
pnpm install --frozen-lockfile
pnpm exec vitest run \
  apps/editor-web/src/joy-agent/context-snapshot.test.ts \
  apps/editor-web/src/joy-agent/stage-preview.test.ts \
  apps/editor-web/src/bounded-decoder-pool.test.ts \
  apps/editor-web/src/timeline-frame-store.test.ts \
  packages/playback-engine/src/html-decoder.test.ts \
  packages/property-system/src/property-coverage.test.ts \
  packages/render-ir/src/model.test.ts

7 files passed, 63 tests passed.
```

Known untouched baseline failure:

```text
packages/plugin-sdk/src/cli.test.ts
joy-plugin CLI > creates a panel package from the published scaffold
expected exit status 0, received 1
```

`pnpm test` and the targeted rerun reproduce this failure before any Live
Director source change. It is excluded from no command and must be compared
again against the final candidate; it is not evidence of a new regression.

## Release boundary

The Live Director master plan requires an explicit `APPROVE_FOR_DEPLOY` from an independent Claude Opus
reviewer tied to the final commit, tree, and lock digest before deployment. No implementation
checkpoint is deployable on its own.
