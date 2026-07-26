# ADR-0021: Agent generation jobs and provenance

Status: Accepted  
Date: 2026-07-26

## Context

`AgentEditPlan` already distinguished synchronous commands from asynchronous
jobs, but execution ignored that distinction. Running generation inside the
atomic command staging loop would hold a stale project snapshot across an
unbounded provider or Worker operation and would make cancellation, progress,
and retry impossible to represent honestly.

Generated media also needs a stronger reproducibility record than commands.
Command replay is deterministic; a provider may remain nondeterministic even
when given the same seed and parameters.

## Decision

- Job steps execute through the `job-protocol` lifecycle before any project
  mutation: start, progress, cancel/retry, terminal result or failure.
- The existing browser/control-plane/outbound-Worker path is one
  `AgentJobClient` implementation. Provider adapters may implement the same
  lifecycle contract.
- A completed state without a verified opaque result asset reference is a
  failure. The UI must never synthesize provider or Worker success.
- A job request carries a stable idempotency key and the project revision used
  to approve it. After every job succeeds, the runner checks that revision
  again and dispatches one deterministic domain transaction containing only
  returned asset/reference IDs.
- Job failure, cancellation, provenance mismatch, revision conflict, or commit
  failure leaves the project unchanged.
- Generated asset records persist provider, model, model version, prompt,
  optional seed, input asset hashes, parameters, generated asset ID, cost, and
  creation time.
- Undo removes the generated asset reference from the project through the
  inverse domain command. It cannot undo provider execution or refund spend.

## Consequences

Heavy work never enters the synchronous atomic timeline staging loop. Plans can
show real progress and safely retry under the same identity. Generation output
is reproducible to the limit of the provider record, while the final project
transaction remains deterministic and replayable.

The pending generation request is not project data. Provenance becomes durable
when the verified result is committed as a generated asset.
