# ADR-0020: KiloCode as the sole editing-agent host

Status: Accepted
Date: 2026-07-26
Supersedes: ADR-0001 Q11 and `D-HERMES` for JOY Media editing/authoring

## Context

The original product decision named Hermes as JOY Media's companion authoring
agent. The owner has now selected the KiloCode extension running inside the
VPS code-server/VS Code-fork UI as the only agent host for editing and
authoring. Hermes remains useful, but for a different operational boundary:
VPN diagnostics and user-support work.

KiloCode's backend credential currently exists in a protected live-VPS
environment file. Its value is not an application input and must not be read
into project code, browser state, prompts, project documents, plugins, or logs.

## Decision

- KiloCode is the sole JOY Media editing-agent host/adapter.
- Do not implement Hermes or a native JOY Agent as alternate editing adapters.
- Hermes does not receive JOY Media project tools or editing commands. It is
  reserved for VPN diagnostics and user-support operations.
- KiloCode remains distinct from reasoning models, media providers, and local
  execution workers. The next adapter manifest describes KiloCode's tool,
  model, health, cancellation, cost-reporting, and settings capabilities.
- The code-server backend resolves KiloCode credentials from a protected
  server-side secret reference. Only the transport that needs the credential
  may receive it; the raw value never crosses into browser code, an agent
  prompt/context, project persistence, plugin APIs, or logs.
- This ADR authorizes defining the boundary. It does not authorize reading or
  copying the existing live `.env`, deploying a new service, or rotating a
  credential.

## Consequences

Milestone C has one agent-host adapter instead of an adapter marketplace.
Removing two speculative adapters reduces configuration and security surface.
The semantic command, capability-policy, approval, audit, and undo contracts
remain host-neutral, so this choice does not couple the creative document to
KiloCode.
