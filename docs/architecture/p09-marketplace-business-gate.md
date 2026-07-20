# P09 marketplace business gate

**Status:** Commercial marketplace closed by default (ADR-0013)  
**Owner authority:** Not yet supplied  
**Implementation status:** No billing, public listing, payout, refund, tax, or moderation operation is implemented or authorized.

## Boundary

The current reviewed catalog is a private/team catalogue of signed plugin releases. It is not a storefront. The following are explicitly out of scope until this gate is reopened with evidence:

- checkout, subscriptions, invoices, payment collection, or any storage of payment credentials;
- public seller onboarding, license sales, entitlement transfer, revenue sharing, or payout;
- refunds, chargeback handling, consumer support promises, or tax calculation/remittance;
- marketplace content moderation, appeals, age/identity verification, or jurisdictional access controls;
- claims that JOY operates in a region or supports a commercial transaction type.

## Required evidence to reopen

| Area                | Required external authority/evidence                                                                                                  | Current state |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Product authority   | Owner-approved business model, merchant role, audience, supported jurisdictions, and launch scope                                     | Missing       |
| Licensing           | Written license/entitlement terms and a review of third-party asset/template obligations                                              | Missing       |
| Consumer terms      | Refund, cancellation, support, dispute, privacy, and retention policies reviewed for target jurisdictions                             | Missing       |
| Payments/payouts    | Processor/provider agreement, seller onboarding and payout/identity responsibilities, data-flow review                                | Missing       |
| Tax                 | Jurisdiction-specific tax-registration, calculation, collection, reporting, and remittance decision                                   | Missing       |
| Moderation          | Published content policy, reporting/appeal process, roles, response targets, and audit retention                                      | Missing       |
| Security/operations | Threat model, incident/chargeback runbook, financial reconciliation owner, and explicit confirmation that JOY stores no raw card data | Missing       |
| Implementation      | Approved technical design, test plan, and staged launch/rollback criteria                                                             | Not started   |

## Reopen protocol

1. Record the owner’s requested scope and jurisdictions in a new ADR or superseding decision.
2. Attach dated, jurisdiction-specific counsel/compliance outcomes for every relevant row above.
3. Obtain the payment/payout provider agreement and security review before handling any transaction data.
4. Define a bounded implementation plan with audit, reconciliation, moderation, refund, and rollback tests.
5. Only then change this document’s status and authorize a commercial-marketplace work package.

No unchecked row can be treated as implicitly accepted. This document does not provide legal, tax, or financial advice.
