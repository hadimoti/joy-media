# P09 scale and mobile evidence gate

**Status:** No scale/mobile initiative authorized (ADR-0014)  
**Current measured demand:** None recorded  
**Implementation status:** No GPU pool, multi-region service, or mobile companion is planned or deployed by P09.

## Evidence register

| Candidate             | Demand evidence                                                                                         | Technical/operational evidence                                                                                   | Owner approval | State  |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------- | ------ |
| GPU Worker pool       | Named workloads, sustained queue/SLO breach, user impact, and volume window                             | Bottleneck analysis, capacity/cost model, isolation/driver/security plan, rollout and rollback                   | Missing        | Closed |
| Multi-region delivery | Geographic usage distribution, latency/reliability target, and customer impact                          | Data residency review, replication/failover consistency model, security/operations ownership, cost/rollback plan | Missing        | Closed |
| Mobile companion      | Validated mobile user job, target audience, usability/accessibility need, adoption/retention hypothesis | Privacy/offline model, platform/support plan, release/telemetry and rollback design                              | Missing        | Closed |

## Measurement rules

- Evidence must come from consented production telemetry, support records, or a documented research study with a defined sampling window; a synthetic benchmark cannot establish market demand.
- Measurements must name the affected user group, baseline, target/SLO, time window, and uncertainty/limitations.
- A cost estimate must include steady-state and failure/incident operations, not only provisioning.
- Any new external region or GPU capability requires a separate privacy/security and incident-response review.
- A mobile experiment may not silently become a supported app; its support and maintenance owner must be approved before public release.

## Reopen protocol

1. Create a dated evidence record satisfying the relevant row above.
2. Obtain owner approval for a bounded pilot and its success/stop criteria.
3. Review the candidate's privacy, security, operational, and cost design.
4. Implement the smallest reversible pilot, measure the agreed outcome, and record rollback results.
5. Only then authorize a new work package or revise this ADR.

This gate is intentionally closed until evidence exists; no absence of a complaint or synthetic benchmark is a demand signal.
