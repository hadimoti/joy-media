# P07 — Workflow Automation

**Status:** not-started · **Gate to enter:** commands/jobs stable (P06 in progress or done) · **Master plan:** §36 Phase 7, §23, §2.10
**Goal:** proven creative operations become repeatable, durable, inspectable production systems — versioned graphs, not conversations.

## Work packages

- [ ] **WP-07.1 — Workflow runtime.** `workflow-engine`: format/versioning, typed nodes/edges, DAG validation (cycles rejected), checkpoints, retry, cancel, deterministic run keys/idempotency (§23.5).
- [ ] **WP-07.2 — Node library v1.** Input/analysis/transform/generation/decision/editor/render/output/control node categories (§23.2); approval/wait nodes that park as `waiting_for_input` without holding Worker resources (§23.6); map/batch execution.
- [ ] **WP-07.3 — Authoring + operations.** Code/JSON authoring with schema validation (visual builder deferred, §23.7); run dashboard with per-node logs/artifacts; headless inputs/outputs (§7.4).
- [ ] **WP-07.4 — First-party workflows.** Long-video→draft-reels, multilingual promo, podcast cleanup (§23.4) as tested, versioned definitions.

## Exit criteria (§36 Phase 7)

- [ ] Interrupted workflow resumes without duplicating completed work.
- [ ] Approval waits without consuming Worker resources.
- [ ] One input batch generates multiple _editable_ project variants.
- [ ] Costs, remote transfers, and outputs are auditable.
- [ ] Workflow versioning keeps old runs reproducible.
