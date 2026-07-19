# ADR-0009: Worker-initiated protocol and local-only asset execution

Status: Accepted
Date: 2026-07-19

## Context

The Worker lets a lightweight VPS coordinate a capable local machine without turning the VPS into a media workstation (§26). WP-00.5 must prove pairing, capability reporting, progress, cancellation, retry, and the guarantee that an original local asset does not move through the control plane.

## Decision

1. Workers initiate pairing, connection, hello/capability reporting, and job polling. The coordinator never opens an inbound connection to a Worker.
2. Pairing uses a short-lived offer and a Worker identity/public-key fingerprint. The resulting session token identifies the paired Worker; private keys and filesystem information are never sent in protocol messages.
3. Capability snapshots include platform, architecture, supported job capabilities, max concurrency, and **opaque local asset IDs**. They do not include raw paths, file bytes, or process command lines.
4. The first job type is `asset.thumbnail`, constrained to `privacy: 'local-only'`. It is assigned only to a Worker that reports both thumbnail capability and possession of the opaque source asset ID.
5. The lifecycle records queued → assigned → preparing/running → succeeded/failed/canceled, bounded progress, cancellation request/delivery, and retry only from failed within `maxAttempts`. A cancellation request prevents success from being reported afterward.
6. P00.5's `InMemoryWorkerCoordinator` is a deterministic protocol proof, not a VPS service, durable queue, cryptographic transport, or process supervisor. X01/P01 own those production concerns.

## Alternatives considered

- **VPS reaches into the Worker over an inbound port** — rejected: fragile behind NAT/firewalls and enlarges the local machine's attack surface.
- **Send source paths or bytes in job payloads** — rejected: paths are nonportable and may reveal private data; bytes violate local-only execution.
- **Treat cancellation as immediate success/failure** — rejected: only the owning Worker can safely stop and clean up its local process/output.
- **Retry canceled jobs automatically** — rejected: cancellation expresses current user intent; retry applies only to eligible failures.

## Consequences

- The scheduler can favor Workers that already hold the needed asset, preserving privacy and avoiding large transfers.
- Every future job payload must use opaque IDs, allowlisted typed fields, and explicit privacy policy; process adapters resolve local IDs only inside the Worker.
- The next Worker iterations need durable leases/heartbeats, revocation, authenticated transport, resource governor, output validation, and bounded subprocess supervision.

## Validation and rollback

`packages/job-protocol/src/protocol.test.ts` covers outbound pairing, capability snapshot, local thumbnail progress, cancellation, retry, and raw-path rejection. Revert/disable a protocol version if it permits a path, asset byte, or an unsupported lifecycle transition into an outbound message.

## Related contracts/tests

`packages/job-protocol/src/protocol.ts` · master plan §26.3–§26.11 · WP-00.5. ADR-0007 and ADR-0008 remain reserved for the browser/desktop role and asset-identity decisions in WP-00.6.
