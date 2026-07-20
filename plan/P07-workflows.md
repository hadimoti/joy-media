# P07 — Workflow Automation

**Status:** done · **Gate to enter:** commands/jobs stable (P06 in progress or done) · **Master plan:** §36 Phase 7, §23, §2.10
**Goal:** proven creative operations become repeatable, durable, inspectable production systems — versioned graphs, not conversations.

## Work packages

- [x] **WP-07.1 — Workflow runtime.** `workflow-engine`: format/versioning, typed nodes/edges, DAG validation (cycles rejected), checkpoints, retry, cancel, deterministic run keys/idempotency (§23.5).
- [x] **WP-07.2 — Node library v1.** Input/analysis/transform/generation/decision/editor/render/output/control node categories (§23.2); approval/wait nodes that park as `waiting_for_input` without holding Worker resources (§23.6); map/batch execution.
- [x] **WP-07.3 — Authoring + operations.** Code/JSON authoring with schema validation (visual builder deferred, §23.7); run dashboard with per-node logs/artifacts; headless inputs/outputs (§7.4).
- [x] **WP-07.4 — First-party workflows.** Long-video→draft-reels, multilingual promo, podcast cleanup (§23.4) as tested, versioned definitions.

## Exit criteria (§36 Phase 7)

- [x] Interrupted workflow resumes without duplicating completed work.
- [x] Approval waits without consuming Worker resources.
- [x] One input batch generates multiple _editable_ project variants.
- [x] Costs, remote transfers, and outputs are auditable.
- [x] Workflow versioning keeps old runs reproducible.

Gate reviewed 2026-07-20; evidence recorded in `STATE.md` session log.
