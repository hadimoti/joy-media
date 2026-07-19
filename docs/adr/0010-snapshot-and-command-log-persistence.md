# ADR-0010: Persist projects as verified snapshots plus validated command transactions

Status: Accepted
Date: 2026-07-19

## Context

The command spike established deterministic, serializable semantic commands; the P00 exit criteria also require replay/reopen evidence. A durable project cannot rely solely on mutable in-memory state or an unbounded unverified event stream (§12.1–§12.2).

## Decision

1. Persistence uses periodic versioned project snapshots plus an ordered append-only log of validated command transactions after the snapshot.
2. On open, the runtime validates the snapshot schema/checksum, replays later transactions through the normal command engine, and stops at the last valid revision with a recovery report if validation/replay fails.
3. Logs retain command envelope and transaction versions, IDs, ordering, and integrity metadata. Snapshots are compacted only after a replacement snapshot has been verified and the retention policy permits it.
4. Local durable storage is the default. Optional server sync transports the same validated snapshot/log contract but does not replace local recovery.
5. Audio/render fixtures use serializable source inputs and deterministic integer time mapping, so reopen/export verification compares output hashes and timing metrics rather than trusting wall-clock playback.

## Alternatives considered

- **Snapshot only** — rejected: loses semantic audit/recovery history and makes granular sync/undo evidence impossible.
- **Log only forever** — rejected: startup/recovery cost grows without bound and corruption has too much blast radius.
- **Persist renderer/audio runtime state** — rejected: decoded buffers, browser objects, and device clocks are ephemeral and nonportable.

## Consequences

- P01 owns the durable storage adapter, checksums, migration catalog, checkpoint/compaction policy, and recovery UI.
- Command handlers remain the only way a replay changes project state.
- New persisted fields require schema/version/migration treatment; transient caches and local physical paths never enter snapshots.

## Validation and rollback

Command serialization/replay is covered by `packages/commands/src/{commands,history,random-invariants}.test.ts`; the audio spike reopens a serialized PCM fixture and verifies waveform/export hash. Roll back a persistence implementation if a reopened snapshot/log does not reproduce the validated revision.

## Related contracts/tests

Master plan §12.1–§12.2 · `docs/adr/0003-command-transaction-undo-semantics.md` · WP-00.1/00.2/00.7.
