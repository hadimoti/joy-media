# P09 — Marketplace, Collaboration, and Scale

**Status:** in-progress · **Gate:** P08 complete + owner approved opening on 2026-07-20. This plan records the staged, bounded scope.

## Work packages

- [x] **WP-09.1 — Reviewed catalog foundation (done 2026-07-20).** Publisher identity binds trusted signing keys; signed releases are immutable, enter pending review, then become approved/rejected, revocable/quarantinable, and compatibility/permission-visible.
- [ ] **WP-09.2 — Team libraries and review.** Brand/asset libraries, time-coded proxy review, approvals, project branch/version comparison.
- [ ] **WP-09.3 — Collaboration policy.** Proxy collaboration with a dedicated conflict-model ADR before any selective real-time feature.
- [ ] **WP-09.4 — Marketplace business gate.** Licensing/billing/refunds/moderation/tax/payout boundaries; implement only after required external authority and compliance review.
- [ ] **WP-09.5 — Scale/mobile evidence.** GPU Worker pools, multi-region delivery, and mobile companion only when measured demand justifies each.

## Exit criteria

- [x] Reviewed releases are publisher-verified, immutable, review-gated, revocable, and permission/compatibility-visible.
- [ ] Team assets and time-coded review survive branch/version comparison without mutating source projects.
- [ ] Collaboration preserves revision history and uses an approved conflict model.
- [ ] No paid-marketplace or multi-region claim ships without its explicit authority, compliance, and measured-need evidence.

## Opening protocol

1. Owner approval: recorded in ADR-0011.
2. Exit criteria: defined above before implementation.
3. Work packages: partitioned above; WP-09.1 starts first.
