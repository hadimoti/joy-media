# ADR-0013 — Marketplace commercial boundary

**Status:** Accepted
**Date:** 2026-07-20

## Context

P09 introduces a reviewed catalog, not a commercial marketplace. Payments, seller payouts, consumer refunds, tax handling, and content moderation create non-technical obligations that cannot be inferred or approved by engineering.

## Decision

JOY is **not** authorized to operate a paid or public marketplace at this stage. The catalog remains reviewed and private/team-scoped. The product must not implement or advertise checkout, subscription collection, seller onboarding, license sales, payouts, refunds, tax calculation/remittance, or public publishing.

Before a commercial marketplace may be scoped, the owner must provide the intended business model, merchant role, supported jurisdictions, and seller/buyer audience. Jurisdiction-specific legal/compliance review must then approve the written licensing, consumer/refund, privacy, tax, payout/identity, moderation, and record-retention policies. A payment provider agreement and an operations/security design must be reviewed before integration; JOY must not store raw payment-card data.

## Consequences

The reviewed-catalog APIs remain non-commercial. `docs/architecture/p09-marketplace-business-gate.md` is the authoritative evidence register for any future launch. Absence of its required evidence is a release blocker, not an invitation to implement a placeholder payment flow.
