# ADR 0041: Local DSH (DeepSeek-harness) JoyStudio engine

Status: accepted  
Date: 2026-09-01

## Decision

JOY Media keeps one Joy Code dock surface. History, Composer, Creative Brief,
and 3D remain sections of that surface; the former `creative-brief` Dockview
panel ID is migrated to `agent` and is no longer seeded or exposed as a second
top-level panel.

The future JoyStudio Windows/Linux desktop client and headless CLI may select
the `local-deepseek-harness` (DSH) engine from the existing Agent Settings
contract. They store the user-entered
OpenRouter-compatible endpoint, model ID, and API key in the client’s local
credential store (Windows Credential Manager/DPAPI, Linux Secret Service or an
equivalent native vault). The local planner calls that endpoint directly and
bypasses Joy cloud document sync. The API key is used only for the local
Authorization header; it is never included in a request JSON body, project
document, cloud request, audit event, Gbrain record, or release artifact.

The adapter accepts an OpenAI-compatible JSON-mode chat completion response,
strictly validates the bounded Joy Code plan, caps prompt/response sizes, and
fails closed for malformed endpoints, missing keys, provider errors, and
invalid plans. The server OpenRouter planner remains the default only when
the user selects the cloud engine. Selecting the local engine with incomplete
or disallowed configuration fails closed rather than silently routing the
request to cloud.

## Consequences

- The current Joy Code visual shell and accessible section navigation remain
  unchanged; legacy saved layouts cannot create an orphaned Creative Brief tab.
- Local planning is intentionally not cloud-synchronized. Users who need
  server persistence continue to use the existing opt-in cloud planner.
- The browser stores preferences only; its credential implementation is
  memory-only and resets on reload. A packaged JoyStudio client must inject an
  OS-protected vault before release. Browser `localStorage` is not a promise of
  encrypted-at-rest storage.
- Remote (non-loopback) endpoints require HTTPS, an authenticated ready
  session, and explicit local-provider disclosure. `local-only` policy permits
  loopback endpoints only.
