# ADR-0014 — Scale and mobile evidence gate

**Status:** Accepted
**Date:** 2026-07-20

## Context

P09 names GPU Worker pools, multi-region delivery, and a mobile companion as possible later capabilities. They add ongoing cost, operational complexity, privacy/locality implications, and product surface area. Neither the current roadmap nor observed project evidence justifies them.

## Decision

JOY will not deploy GPU pools, multi-region control/data planes, or a mobile companion merely because they are technically possible. Each capability requires its own measured-need record, bounded design, and owner approval before implementation or public claims.

- **GPU pools:** measured queue delay and workload profile, bottleneck analysis showing that optimized existing workers cannot meet a named SLO, cost/capacity model, hardware/driver isolation plan, and rollback criteria.
- **Multi-region:** measured geographic demand and latency/reliability need, data-residency/security review, replication/failover consistency model, operations ownership, cost model, and rollback plan.
- **Mobile companion:** validated user jobs that require mobile access, accessibility and offline/privacy requirements, platform support/maintenance plan, and a staged usability/retention measure.

## Consequences

Current Worker, local-first, and browser/desktop contracts remain the supported architecture. Benchmark fixtures may measure current behavior, but synthetic benchmarks are not demand evidence. `docs/architecture/p09-scale-mobile-evidence-gate.md` is the required evidence register. No P09 work authorizes a capacity deployment, mobile app, or multi-region product claim.
