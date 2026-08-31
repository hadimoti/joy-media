# ADR 0041: Local DeepSeek-harness Joy Code engine

Status: accepted  
Date: 2026-09-01

## Decision

JOY Media keeps one Joy Code dock surface. History, Composer, Creative Brief,
and 3D remain sections of that surface; the former `creative-brief` Dockview
panel ID is migrated to `agent` and is no longer seeded or exposed as a second
top-level panel.

The future Windows client may select the `local-deepseek-harness` engine from
the existing Agent Settings dialog. It stores the user-entered
OpenRouter-compatible endpoint, model ID, and API key in the client’s local
settings store. The local planner calls that endpoint directly and bypasses
Joy cloud document sync. The API key is used only for the local Authorization
header; it is never included in a request JSON body, project document, cloud
request, audit event, Gbrain record, or release artifact.

The adapter accepts an OpenAI-compatible JSON-mode chat completion response,
strictly validates the bounded Joy Code plan, caps prompt/response sizes, and
fails closed for malformed endpoints, missing keys, provider errors, and
invalid plans. The server OpenRouter planner remains the default when no
complete local configuration is present.

## Consequences

- The current Joy Code visual shell and accessible section navigation remain
  unchanged; legacy saved layouts cannot create an orphaned Creative Brief tab.
- Local planning is intentionally not cloud-synchronized. Users who need
  server persistence continue to use the existing opt-in cloud planner.
- A packaged Windows client must provide an OS-protected local settings
  implementation before release. Browser `localStorage` is only the current
  development boundary and is not a promise of encrypted-at-rest storage.
