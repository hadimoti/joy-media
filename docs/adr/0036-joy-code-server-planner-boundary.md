# ADR-0036: Joy Code server planner boundary

Status: Accepted for WP-38 implementation
Date: 2026-08-20
Supersedes: The transport and identity wording in ADR-0020 only

## Context

Joy Code already has a browser composer, deterministic local intents, dry-run
plans, approval, command dispatch, audit, and undo. Its missing free-form path
needs a server-side reasoning transport. KiloCode remains the selected
code-server/VS Code-fork editing host, but KiloCode is not a callable JOY
Media HTTP provider and the product must not claim that a direct OpenRouter
request was executed by the KiloCode extension.

The owner has approved a zero-payable-spend OpenRouter experiment using an
exact NVIDIA Nemotron free model. The free endpoint is a logged trial service,
so remote planning requires separate consent and must be limited to bounded
semantic project data from non-confidential projects.

## Decision

- The user-facing product actor is Joy Code.
- The server-side planning actor is joy-code-server.
- OpenRouter is a reasoning transport behind that actor, not an editing host.
- KiloCode remains the code-server editing host and may continue to provide
  local deterministic development workflows. It is not imported as a server
  transport and its Auto Free model selector is not a JOY Media runtime ID.
- The server may return only a strictly validated, untrusted Joy Code plan
  proposal. It may not execute commands, mutate project state, approve a plan,
  or bypass the browser's revision and policy checks.
- The browser revalidates the exact project revision, compiles the proposal
  using code-owned operation and style catalogs, presents a dry-run diff, and
  requires explicit Apply for remote mixed-surface plans.
- All mutations go through existing JOY command/history boundaries and one
  EditorSession.dispatchCompound() call.
- The initial remote model is pinned by a separate runtime policy and may be
  changed only by a reviewed, reverified policy commit. Dynamic
  openrouter/free, kilo-auto/free, paid fallback, and silent model changes
  are forbidden.
- Joy Code gets its own versioned project consent. Creative Brief's
  read-only consent does not authorize edit planning.

## Consequences

The product can add a safe free-form planning path without inventing a second
editor state model or pretending KiloCode is an HTTP model server. Provider
failures remain honest and the feature can stay disabled independently of
Creative Brief. The browser owns proposal compilation and approval, which
keeps provider output outside the mutation authority boundary.

The first release is owner-only and experimental. It must not receive
confidential or personal content while the selected free endpoint has provider
logging terms. New generated media and autonomous execution remain outside
this ADR.
