# ADR-0003: Command, transaction, and undo semantics

Status: Accepted
Date: 2026-07-19

## Context

Master plan §11 defines the command system as JOY Media's most important internal API but leaves concrete semantics — inverse computation, atomicity mechanics, id generation, validity guarantees — to implementation. WP-00.2 (command spike) had to fix these. This is required early ADR #3 from §41.1.

## Decision

1. **Commands are a discriminated union applied by pure functions.** `applyCommand(project, command)` never mutates; it returns the next project. Exhaustive switches enforce coverage at compile time (§45.2).
2. **The inverse is computed at apply time, from pre-state, and returned alongside the result.** Inverses are ordinary commands (e.g. insert ↔ remove, move ↔ move-back, split ↔ join), not JSON patches — history stays semantic and auditable (§11.2).
3. **Commands guarantee a valid document.** After the type-specific checks, `applyCommand` runs full structural validation on the result and rejects with `COMMAND_VALIDATION_RESULT_INVALID` if anything is wrong (e.g. a nested-composition insert that would create a cycle). An applied command can never produce an invalid project.
4. **Errors are coded** (`CommandError` with `COMMAND_VALIDATION_*` / `COMMAND_HISTORY_*` codes per Appendix C), never bare strings (§28.3).
5. **Atomicity via immutability.** A transaction applies commands sequentially against local values; any failure throws and the caller's project reference is untouched — no rollback machinery. The transaction record stores commands plus inverses already reversed for undo.
6. **History is linear and transaction-scoped** (§11.5): one undo step per transaction, labels explain what will be undone, a new transaction clears the redo stack.
7. **New entity ids are supplied by the caller in the payload** (e.g. `splitClip.newClipId`), never generated inside handlers — so serialization/replay is deterministic and the same log always reproduces the same document.
8. **Split/join are exact inverses**, with join validating both timeline adjacency and source continuity (same asset + contiguous source range, or same nested composition + contiguous child offset).

Spike-scope simplifications (to revisit in P01, not silently inherit): no overlap within a track; moves stay on one track; envelope carries only `type` + `payload` (actor, baseRevision, idempotencyKey, coalescing, interactive sessions land with WP-01.1); trim-start only shifts the source in-point (no speed).

## Alternatives considered

- **JSON-patch/undo-by-snapshot** — rejected: patches tied to array indices break after unrelated edits (§11.5 requires semantic restoration) and snapshots hide intent from audit/agents.
- **Inverse computed at undo time** — rejected: requires the pre-state to still be derivable then; computing at apply time captures it exactly and keeps undo O(commands).
- **Handler-generated ids (UUID inside apply)** — rejected: breaks replay determinism and idempotent retry.
- **Mutable store with rollback journal** — rejected: immutability makes atomicity and A/B branches trivial and matches the evaluator's needs.

## Consequences

- Randomized invariant tests (25 seeds × 40 ops) prove: schema validity after every command, inverse round-trips, undo-all → initial, redo-all → final, serialized-log replay → final.
- Result-validation on every apply is O(project); acceptable now, revisit with dirty-region validation when projects grow (P02 benchmarks will tell).
- UI/agent layers must generate ids up front (ULID/UUIDv7 per §10.4) before dispatching.

## Validation and rollback

`packages/commands/src/{commands,history,random-invariants}.test.ts`. Changing these semantics later requires a superseding ADR; persisted command logs version through the envelope's `commandVersion` (P01).

## Related contracts/tests

`packages/commands/src/commands.ts` · `history.ts` · master plan §11, §28.3, §44 (anti-patterns), Appendix C.
