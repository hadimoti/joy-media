# P06 — Agent-Assisted Editing

**Status:** done · **Gate to enter:** P02 + P03 exit criteria (P04/P05 enrich it but don't gate it) · **Master plan:** §36 Phase 6, §22, §11.7, §2.9
**Goal:** natural-language intent safely operates the _existing_ editor. The agent uses the same command bus as the human — no parallel editor, no magic flattened output.

**Decisions needed:** Q14 (auto-approval defaults), Q15 (beta workflows).

## Work packages

- [x] **WP-06.1 — Context + tools.** Context builder with bounded retrieval (§22.3); semantic query tools returning stable IDs (§22.5); `agent-tools` generated from safe command definitions (§11.7).
- [x] **WP-06.2 — Plan + policy.** Structured AgentEditPlan schema (§22.4); approval policy engine per §22.6 + Q14; cost/privacy estimation.
- [x] **WP-06.3 — Dry-run + execution.** Transaction simulation with diff report (§22.7); execution with precondition re-checks, idempotent jobs, named reversible transactions, stop-on-policy-failure (§22.8).
- [x] **WP-06.4 — Verification + audit.** Post-run verification per §22.9 ("applied", never "perfect"); A/B temporary branch; one-action revert of an agent run; full audit trail; agent memory/preference separation (§22.10).
- [x] **WP-06.5 — Evaluation suite.** Fixed projects + ≥10 benchmark intents (§22.12); metrics: plan validity, execution success, accepted/reverted rate, cost accuracy; local-only policy leak test.

## Exit criteria (§36 Phase 6)

- [x] Agent completes ≥10 benchmark intents using ordinary commands.
- [x] Every mutation visible in History.
- [x] Paid/remote/destructive actions request approval correctly.
- [x] Failed plans leave the project valid and recoverable.
- [x] An agent edit reverts as one named action.
- [x] No hidden flattened output ever substitutes for editable work.
- [x] Evaluation metrics meet the agreed baseline.
