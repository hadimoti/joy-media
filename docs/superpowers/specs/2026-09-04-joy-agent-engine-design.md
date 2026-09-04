# JOY Agent Engine Design

Status: approved direction; ready for staged implementation

Date: 2026-09-04

Scope: JOY Media editor, Joy Code, Creative Brief, AI-assisted design/editing, and their model-facing runtime

## Decision

JOY will ship one built-in, provider-neutral JOY Agent Engine. JOY owns the
session protocol, tool catalog, project context, limits, preview branch,
approval rules, command compilation, atomic apply, Undo, and live activity
events. AI SDK Core is a replaceable implementation library for model streaming
and bounded tool-loop mechanics; it is not the product architecture or mutation
authority.

The engine runs in a dedicated browser Web Worker and connects directly to the
model provider selected by the user. Version 1 supports:

- an OpenRouter preset using the user’s own key;
- an advanced custom OpenAI-compatible HTTPS base URL;
- a user-entered model ID;
- tool-loop mode when the selected model proves tool-call compatibility; and
- a visibly labelled plan-only compatibility mode on the same provider and
  model when structured planning works but tool calls do not.

The product will not present or depend on KiloCode, code-server, the JOY cloud
planner, or a local DeepSeek Harness as its agent engine. Full DeepSeek Harness
is not embedded. The current package named adapter-deepseek-harness is a
one-shot OpenAI-compatible JSON request adapter, not DSH, and will be removed
after parity.

## Why this architecture

Full DSH is a coding-agent control plane with Node-hosted filesystem, shell,
workspace, session, job, skill, and subagent machinery. That is the wrong
authority model and deployment shape for a browser-first media editor whose
project commands, approvals, preview, and Undo already exist.

LangGraph’s durable graph/checkpoint strengths duplicate JOY’s revision,
history, and approval model for this use case. Mastra is server-oriented and
would reintroduce a server runtime between the user’s key and provider. AI SDK
Core provides the smaller required primitive: provider-neutral model calls,
streaming, typed tools, abort signals, stop conditions, and a tool loop that
JOY can keep behind its own protocol.

The dependency choice is conditional on a Worker bundle spike. The approved
initial pins are ai 7.0.92, @ai-sdk/openai-compatible 3.0.43, and a compatible
Zod version. Adoption fails if Vite requires Node polyfills, the Worker chunk
cannot meet an explicit budget, or license/audit gates fail.

## Current state being replaced

The production dialog is not stale. Source currently:

- fixes activeHost to kilocode;
- defaults joyCodeEngine to cloud-openrouter;
- renders a KiloCode code-server-extension host card;
- offers local-deepseek-harness only as an optional alternate branch;
- calls the “local DSH” branch through main-thread fetch; and
- keeps Creative Brief on a separate server runtime.

Only unmatched free-form Joy Code prompts reach the local/cloud planner fork.
Deterministic intents, Creative Brief, assets, and other AI entry points do not
share one agent runtime.

The following existing boundaries remain authoritative:

- packages/agent-tools/src/joy-code-plan.ts: bounded proposal schema;
- apps/editor-web/src/joy-code-compound-compiler.ts: scratch compilation;
- apps/editor-web/src/joy-code-compound-runner.ts: plan/hash/revision-bound approval;
- packages/agent-tools/src/atomic.ts: staged atomic execution;
- apps/editor-web/src/editor-session.ts: the real compound dispatch and Undo;
- the existing media-provider and Local Worker job boundaries.

## Product promises

The Settings UI may promise:

1. JOY does not persist, proxy, sync, log, or include the BYOK connection in
   projects, telemetry, crash reports, or exports.
2. The connection exists only for the current page session and is removed on
   Clear, provider change, logout, fatal Worker failure, or reload.
3. Model context goes directly from this browser to the chosen provider only
   when the user starts or approves a remote operation.
4. JOY never silently switches provider, model, or cloud path.
5. Proposed edits are previews until the current JOY approval policy permits
   one atomic apply.

The UI must not claim that a browser Worker makes secrets inaccessible to
same-origin XSS, extensions, DevTools, or a compromised browser. JavaScript
cannot guarantee cryptographic memory zeroization.

## Runtime topology

```text
Joy Code / Brief / AI Edit / 3D
              |
              v
     JOY Agent Engine client
       |                |
       | safe events    | validated tool requests
       v                v
 Activity + preview   Trusted main-thread bridge
       |                |
       |                +--> bounded snapshots / catalogs
       |                +--> scratch compiler / preview branch
       |                +--> approval policy
       |                +--> EditorSession.dispatchCompound()
       v
 Dock tabs / panels / timeline / Program Monitor

              ^
              |
       versioned Worker RPC
              |
       Dedicated Web Worker
       - ephemeral provider config
       - AI SDK ToolLoopAgent
       - limits / abort / redaction
       - no editor dispatcher
              |
              v
       chosen provider HTTPS origin
```

The Worker never receives an EditorSession, persistence adapter, command bus,
DOM reference, browser storage object, or owner authentication token. It can
request bounded, revision-tagged data and propose bounded operations. The main
thread validates everything again.

## Package boundaries

Create packages/joy-agent-engine:

- contracts.ts — task, tool, activity, proposal, failure, and limit contracts;
- provider-config.ts — pure provider URL/config validation;
- provider.ts — AI SDK provider construction and hardened fetch;
- engine.ts — ToolLoopAgent orchestration and plan-only compatibility path;
- tools.ts — exact Zod schemas and tool metadata;
- limits.ts — immutable defaults and bounded user overrides;
- redaction.ts — safe error/event projection;
- index.ts — public exports.

Create apps/editor-web/src/joy-agent:

- engine.worker.ts — API key and provider lifetime owner;
- protocol.ts — versioned discriminated Worker messages;
- engine-client.ts — configure, test, run, cancel, clear, and dispose;
- byok-session.ts — in-memory readiness/capability state, never credentials;
- context-snapshot.ts — bounded structured-clone-safe context;
- tool-bridge.ts — trusted read results and scratch proposal handling;
- preview-controller.ts — immutable revision-bound preview bundles;
- activity-store.ts — useSyncExternalStore-backed run presence;
- surface-map.ts — code-owned tool-to-panel/section/entity mapping.

React and Dockview remain in editor-web. AI SDK packages remain in
joy-agent-engine. Editor mutation code remains outside both the Worker and AI
SDK tool execute functions.

## Versioned Worker protocol

The protocol starts at version 1 and uses monotonically increasing sequence
numbers per run.

Main thread to Worker:

- configure — provider kind, normalized base URL, model ID, API key, and limits;
- test-connection — minimal no-project capability probe;
- start-run — task kind, revision ID, sanitized context, and user request;
- tool-result — bounded result for a Worker-requested trusted tool;
- cancel-run — AbortSignal-equivalent cancellation for the active run;
- dispose — immediate session teardown.

Worker to main thread:

- ready — protocol version only;
- provider-capability — tool-loop, plan-only, or incompatible;
- activity — safe phase/surface code with no model prose;
- text-delta — assistant-visible answer text only;
- tool-request — stable registered tool ID and validated arguments;
- proposal — bounded validated operation proposal;
- usage — provider-reported safe token/cost totals;
- completed, failed, or cancelled — stable JOY result/error codes.

Configuration is never echoed back. Events never contain the key,
Authorization header, endpoint, raw request/response body, prompt, hidden model
reasoning, or arbitrary provider error metadata.

## Agent tasks and tools

One engine accepts distinct task kinds:

- joy-code-edit;
- creative-brief;
- asset-assist;
- design-assist;
- scene-3d-assist;
- media-job-assist.

Initial trusted tools:

- read_project_summary;
- read_selection;
- read_timeline_window;
- read_asset_metadata;
- read_style_catalog;
- propose_timeline_operations;
- propose_document_operations;
- submit_plan.

Read tools operate against the frozen run snapshot. Proposal tools only append
operations that pass JOY schema validation and scratch compilation. They never
dispatch editor commands. submit_plan finalizes the exact operation list and
proposal hash for approval.

Tool metadata, not model output, declares:

- whether a tool is read-only, previewing, paid, remote, or mutating;
- its required JOY capability;
- its maximum argument/result size;
- its trusted target panel and nested section;
- how validated entity IDs are extracted; and
- whether calls may run in parallel.

Only read-only calls may run in parallel, with a maximum concurrency of two.
Preview/write calls are serialized. Unknown tools fail closed and target only
the Joy Code activity surface.

Explicit version 1 defaults:

- 12 model steps;
- 24 total tool calls;
- 32 proposed operations;
- 180 seconds of model-loop wall time;
- 15 seconds for a connection probe;
- 512 KiB structured context;
- 64 KiB per tool argument/result payload;
- 2 MiB provider response body;
- 8,192 output tokens;
- the configured provider-spend ceiling; and
- separate approval and budget for media jobs.

The limits are enforced by JOY as well as AI SDK stop conditions.

## Provider and BYOK boundary

ByokSessionConfig is wholly separate from persisted AgentPolicyPreferences.
Provider kind, base URL, model ID, API key, and capability result are
session-only. They must not enter localStorage, IndexedDB, Cache Storage, OPFS,
cookies, project documents, autosync, control-plane calls, analytics, traces,
logs, snapshots, or test artifacts.

The API-key field is an uncontrolled password input. On Test & Use, its value
is transferred once to a newly created Worker, then the DOM field is cleared.
React stores only connection status and safe capability labels. Clear or
reconfiguration terminates the Worker rather than attempting unreliable
in-place memory erasure.

OpenRouter preset:

- base URL: https://openrouter.ai/api/v1;
- user enters model ID and key;
- no JOY server request;
- no project data in the capability probe.

Custom compatible provider:

- label it Advanced and CORS-dependent;
- accept an HTTPS base URL, not a completion endpoint;
- reject username, password, query, fragment, loopback, and literal
  private/reserved network addresses in the public web build;
- require an explicit custom-origin disclosure;
- never accept arbitrary custom headers in version 1.

All provider requests use credentials omit, cache no-store, referrer policy
no-referrer, redirect error, a bounded AbortSignal, and Authorization only for
the exact normalized origin. Provider/SDK errors become stable redacted JOY
error codes before crossing the Worker boundary.

Arbitrary custom HTTPS providers require a broader CSP connect-src HTTPS
allowance than an OpenRouter-only build. That tradeoff is explicit. The exact
runtime fetch gate still restricts requests to the one normalized session
origin. Custom providers that do not allow browser CORS fail honestly; JOY
does not proxy or silently fall back.

The capability probe verifies:

- minimal authenticated completion;
- exact structured response validation;
- one harmless forced tool call;
- streaming if the selected mode requests it; and
- usage reporting availability.

Failure of tool calling produces an explicit plan-only choice on the same
provider/model. Failure of both tool calling and structured planning marks the
model incompatible.

## Preview and atomic apply

Every run is anchored to the starting projectRevisionId. A validated proposal
creates an immutable AgentPreviewBundle:

```ts
interface AgentPreviewBundle {
  readonly runId: string;
  readonly seq: number;
  readonly baseRevision: string;
  readonly timelineProject: SpikeProject;
  readonly visualProject: JoyProjectV1;
  readonly diff: AgentPreviewDiff;
  readonly proposalHash: string;
}
```

The preview controller reuses the existing JoyCodeCompoundDraft document and
applies its timeline transaction to a clone. It never calls EditorSession,
writes storage, creates history, syncs a project, affects export, or makes a
command undoable.

Program Monitor renders the preview projection through the real renderer while
showing AGENT PREVIEW — NOT APPLIED and a keyboard-accessible Before/Preview
toggle. Timeline renders pointer-events-none ghost geometry over canonical
interactive clips:

- add: dashed green ghost plus add icon;
- remove: danger hatch and remove icon on the canonical clip;
- move/trim: canonical origin plus amber ghost destination;
- property/effect change: amber target outline and labelled preview value.

Inspector shows canonical to preview values rather than silently replacing
inputs. Assets show a pending output card only after a real job event, and only
show media after a real preview URL exists. 3D uses a validated preview scene;
it never auto-orbits merely to imply activity.

Any authoritative revision change, user edit, rejection, Stop, timeout,
provider failure, Worker failure, or cancellation discards the preview and
returns the exact canonical view. Approval is bound to run, plan, proposal
hash, and base revision. Only EditorSession.dispatchCompound applies it, once,
as one Undo step.

## Engine-owned activity model

Visible activity is driven by real sanitized events:

- run.started;
- phase.changed;
- tool.started;
- target.changed;
- preview.updated;
- progress.updated;
- approval.requested;
- tool.completed;
- run.completed;
- run.failed;
- run.cancelled.

Phases are idle, connecting, thinking, inspecting, planning, previewing,
awaiting-approval, applying, completed, failed, and cancelled.

Each target is semantic:

```ts
interface AgentUiTarget {
  readonly panelId: PanelId;
  readonly sectionId?: string;
  readonly entity?: {
    readonly kind: 'clip' | 'track' | 'asset' | 'object' | 'property' | 'composition';
    readonly ids: readonly string[];
  };
  readonly operation: 'read' | 'preview-add' | 'preview-change' | 'preview-remove' | 'apply';
}
```

surface-map.ts derives targets from trusted tool metadata and validated IDs.
Provider output cannot supply a DOM selector, CSS class, panel ID, status
label, or animation. The reducer ignores a stale sequence, wrong run, wrong
base revision, and all post-terminal events.

No percentage is shown unless a tool/provider supplies measured totals. Token
deltas update the conversation but do not rerender Dockview or every panel.

## Live visual language

User-selected and agent-targeted are deliberately different states.

Global activity indicator:

- compact Joy mark, truthful phase label, target label, measured progress when
  available, Show target, Follow, and Stop;
- absent while idle;
- Stop aborts the real Worker run and clears its preview;
- Follow is session-only and off by default.

Dock tab:

- selected remains the existing solid amber icon;
- inactive agent target gets a small amber top tick/activity dot;
- only the primary active target receives a restrained 1.8-second low-opacity
  halo;
- secondary targets are static.

Panel and nested section:

- 1px inset amber edge on the targeted panel;
- a small Working, Preview, Needs approval, or Applying badge;
- a moving amber underline on the targeted nested tab;
- no change to aria-selected unless Follow actually reveals that section.

Entity:

- exact clip, track, asset, object, or property markers;
- patterns/icons/text as well as color;
- no full-panel wash and no invented animated cursor.

Phase behavior:

| Phase                 | Visible behavior                                                          |
| --------------------- | ------------------------------------------------------------------------- |
| connecting / thinking | Joy Code indicator only until a real tool target exists                   |
| inspecting            | target tab, panel, and exact entities receive the activity marker         |
| planning              | step rail advances only from real tool/step events                        |
| previewing            | real shadow document appears in Monitor, Timeline, and relevant inspector |
| awaiting approval     | animation freezes into a strong static preview border                     |
| applying              | atomic commit state with measured command/job progress only               |
| completed             | brief green confirmation, then target effects clear                       |
| failed                | static danger state with a safe error and Retry                           |
| cancelled             | muted cancelled state; preview and target effects clear                   |

Follow mode resolves featureActivationRoute, activates the correct Dockview
panel and nested section, and never moves the keyboard focus out of the current
input. When Follow is off, it does not add panels, switch tabs, change
selection, or mutate the saved layout. Show target is a one-time reveal.

Reduced motion removes all pulse, halo, shimmer, and moving-underline
animations while preserving static dots, borders, icons, labels, and preview
patterns. One polite live region announces phase changes only. Target regions
use aria-busy where appropriate; streaming tokens are not repeatedly announced.

## Settings redesign

The dialog becomes JOY Agent Engine Settings.

```text
JOY Agent Engine
Built in · Browser Worker · Needs model / Ready / Working

Model connection — this page session only
Provider        [ OpenRouter | Custom compatible ]
Base URL        [ https://openrouter.ai/api/v1       ]
Model ID        [ provider/model-id                  ]
API key         [ •••••••••••••••••••               ]
                [ Test & Use ] [ Clear session ]
Capability      Tool loop / Plan-only / Incompatible

Privacy
JOY does not save or proxy this connection.
The selected provider receives only context needed for an action.

Editing policy
Execution mode · capabilities · provider/media budgets · remote-data approval

Live work
Live preview [on] · Follow agent [off]
```

There is no Agents/KiloCode card and no engine dropdown. JOY Agent Engine is
the engine. Model provider and media-generation providers remain separate
concepts. JOY itself is free; the dialog states that the chosen provider may
charge the user.

Persisted agent policy moves to version 2 and contains only non-provider
editing policy. Migration reads safe policy values from version 1, writes the
new key, and removes the entire old settings key so legacy endpoint/model data
does not remain in storage. Follow agent is deliberately not persisted and
always starts off in a new page session.

## Product integration

All agent entry points use the same engine client:

- Joy Code Composer;
- local deterministic Joy Code recipes, exposed as trusted engine shortcuts;
- Creative Brief;
- Asset Library Edit with AI;
- design/effects/motion/color assistance;
- captions and audio assistance;
- 3D scene assistance;
- media-generation job requests.

Media generation, transcription, rendering, and Local Worker execution remain
independent providers/executors. The JOY Agent Engine plans and requests those
jobs through explicit tools, budgets, and approvals; it does not replace their
implementation.

## Migration and compatibility

New runs use AgentActor id joy-agent. Historical kilocode and joy-code-server
provenance remains readable and is labelled Legacy Joy Code. Existing project
history is never rewritten.

Cutover order:

1. prove dependency/Worker/privacy foundations;
2. achieve plan-only parity with existing Joy Code proposals;
3. add the bounded tool loop and live preview;
4. migrate Creative Brief and the remaining entry points;
5. remove product imports/copy for KiloCode, server planner, and local DSH;
6. retire unused server AI endpoints after one compatibility release;
7. retain old database consent columns unused until a later additive migration.

There is no silent runtime fallback during migration. A development-only
feature switch may compare implementations in tests, but a production session
uses exactly one visible engine path.

## Open-source release boundary

The repository currently has third-party notices but no top-level open-source
license, and its Fontiran assets are documented as commercially licensed and
not cleared for redistribution. The app must not be advertised as
redistributable open source until:

- an owner/legal-approved OSI license is added;
- proprietary font/assets are removed from the public distribution or replaced
  with redistribution-safe alternatives;
- AI SDK and all new dependencies appear in the SBOM/notices;
- production dependency audit and license checks pass.

This is a release gate, not a reason to put model keys or agent execution on a
JOY server.

## Acceptance criteria

1. No current product surface or runtime path identifies KiloCode, code-server,
   local DSH, or JOY cloud planner as the active agent engine.
2. One JOY Agent Engine client serves Joy Code, Brief, assets, design, audio,
   captions, and 3D entry points.
3. Reload, Clear, logout, provider change, and fatal Worker failure destroy the
   Worker and leave zero BYOK connection values in every browser storage
   surface and JOY-origin request.
4. Only the chosen provider origin receives Authorization; redirect, CORS,
   timeout, oversize, malformed-tool, and incompatible-model paths fail closed.
5. The Worker cannot dispatch editor commands. Every edit is validated,
   scratch-compiled, revision-checked, policy-checked, approved when required,
   and applied once through the existing command bus.
6. Live visual state changes within one animation frame of a real safe event.
   No timer invents work and no fake percentage is shown.
7. Preview is visibly real in Program Monitor and Timeline but creates no
   project, history, storage, sync, or export mutation before approval.
8. Reject, Stop, provider failure, Worker failure, timeout, and revision drift
   restore the exact canonical view. Approve creates exactly one Undo step.
9. Follow off never steals focus, selection, or layout. Follow on reveals the
   correct panel/section without moving keyboard focus from the user.
10. Reduced-motion, keyboard, screen-reader, narrow-layout, visual-regression,
    Worker bundle, typecheck, unit, E2E, build, audit, and formatting gates pass.

## References

- AI SDK ToolLoopAgent: https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent
- AI SDK tools: https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
- AI SDK provider management: https://ai-sdk.dev/docs/ai-sdk-core/provider-management
- AI SDK OpenAI-compatible provider: https://ai-sdk.dev/providers/openai-compatible-providers
- DeepSeek Harness repository: https://github.com/deepseek-ai/deepseek-harness
- Existing JOY ADRs superseded by this direction: ADR-0020, ADR-0036, ADR-0041
