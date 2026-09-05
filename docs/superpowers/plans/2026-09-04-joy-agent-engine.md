# JOY Agent Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the KiloCode/cloud/local-DSH product fork with one built-in, browser-resident JOY Agent Engine that uses session-only BYOK model transport, preserves JOY’s guarded edit/Undo authority, and shows truthful live activity and staged visual edits across the exact panels and entities being used.

**Architecture:** A JOY-owned package wraps pinned AI SDK Core primitives behind a versioned dedicated-Worker protocol. The Worker owns the ephemeral provider connection and may request bounded reads or propose operations; the main thread owns project state, schema validation, scratch preview compilation, approval, atomic apply, Undo, and UI activity. A sanitized monotonic event stream drives Dockview tabs, nested sections, entity highlights, Program Monitor preview, and Timeline ghost edits.

**Tech Stack:** TypeScript 5.8, React 19, Vite 7 Web Workers, Dockview 4, Vitest 3, Playwright 1.62, AI SDK Core 7.0.92, @ai-sdk/openai-compatible 3.0.43, Zod 4.1.x, existing @joy-media/agent-tools, command bus, Pixi renderer, and provider/job packages.

---

Design source: docs/superpowers/specs/2026-09-04-joy-agent-engine-design.md

## Delivery rules

- Work on a codex/joy-agent-engine branch or isolated worktree.
- Use red-green-refactor for every task. Do not use a real provider key in
  automated tests.
- Do not deploy or remove the old production path until Tasks 1–12 pass.
- No compatibility fallback may silently change provider/model. A temporary
  development comparison switch must be absent from the production bundle at
  Task 13.
- Preserve historical kilocode and joy-code-server provenance as readable
  legacy data. Never rewrite existing project history.
- Keep BYOK connection data out of React state, browser storage, project data,
  JOY API calls, logs, telemetry, traces, snapshots, and error payloads.
- Commit after each task using the listed commit message.

## Milestone 0: prove the dependency and record the authority boundary

### Task 1: Add the superseding ADR and Worker bundle spike

**Files:**

- Create: docs/adr/0042-built-in-joy-agent-engine.md
- Modify: docs/adr/README.md
- Create: docs/OPEN_SOURCE_RELEASE.md
- Create: packages/joy-agent-engine/package.json
- Create: packages/joy-agent-engine/tsconfig.json
- Create: packages/joy-agent-engine/src/index.ts
- Create: packages/joy-agent-engine/src/spike.ts
- Create: apps/editor-web/src/joy-agent/engine.worker.ts
- Create: tooling/release/verify-joy-agent-worker.mjs
- Modify: apps/editor-web/package.json
- Modify: apps/editor-web/tsconfig.json
- Modify: package.json
- Modify: tsconfig.json
- Modify: pnpm-lock.yaml
- Modify: THIRD_PARTY_NOTICES.md

**Step 1: write the failing bundle-verification test**

The verification script must fail when no joy-agent Worker chunk exists and
must reject a Worker chunk that:

- exceeds 900 KiB raw or 250 KiB gzip;
- contains node:, child_process, fs/promises, process.cwd, or a Node polyfill;
- imports AI SDK DevTools or telemetry instrumentation.

Add a root script:

```json
{
  "scripts": {
    "verify:joy-agent-worker": "node tooling/release/verify-joy-agent-worker.mjs"
  }
}
```

Run:

```powershell
pnpm --filter @joy-media/editor-web build
pnpm verify:joy-agent-worker
```

Expected: FAIL with JOY_AGENT_WORKER_NOT_FOUND.

**Step 2: create the package and pinned dependency spike**

packages/joy-agent-engine/package.json must use exact, not ranged, production
versions:

```json
{
  "name": "@joy-media/joy-agent-engine",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run"
  },
  "dependencies": {
    "@joy-media/agent-tools": "workspace:*",
    "@ai-sdk/openai-compatible": "3.0.43",
    "ai": "7.0.92",
    "zod": "4.1.8"
  }
}
```

Add @joy-media/joy-agent-engine as a workspace dependency of editor-web, add
the package to the root TypeScript project references, and export both the
package root and its contract-only entry point. The package must not export a
Worker global or any React code.

spike.ts creates an OpenAI-compatible model and a minimal ToolLoopAgent with
one harmless typed tool. engine.worker.ts imports and instantiates the spike so
Vite creates the real Worker dependency graph:

```ts
const worker = new Worker(new URL('./joy-agent/engine.worker.ts', import.meta.url), {
  type: 'module',
  name: 'joy-agent-engine',
});
worker.terminate();
```

Run:

```powershell
pnpm install
pnpm --filter @joy-media/editor-web build
pnpm verify:joy-agent-worker
pnpm audit --prod --audit-level=moderate
```

Expected: build and audit pass; script prints the measured raw/gzip Worker
size and reports no forbidden Node/polyfill imports.

If the spike fails any hard gate, stop this implementation and replace AI SDK
with a smaller JOY-owned fetch/tool-loop adapter before proceeding. Do not
weaken the gate without recording a new ADR.

**Step 3: record the architecture and open-source release blockers**

ADR-0042 accepts the design, supersedes the product/runtime decisions in
ADR-0020, ADR-0036, and ADR-0041, and states that AI SDK is replaceable. It
does not delete historical ADRs.

docs/OPEN_SOURCE_RELEASE.md must state that public redistribution remains
subject to the remaining asset review. The later 2026-09-05 migration removed
Fontiran assets and replaced them with pinned OFL-1.1 Fontsource packages.
Update third-party notices with the pinned Apache-2.0 AI SDK packages and
Zod’s license.

**Step 4: verify workspace wiring**

Run:

```powershell
pnpm --filter @joy-media/joy-agent-engine build
pnpm --filter @joy-media/editor-web build
pnpm typecheck
pnpm format:check
```

Expected: all pass and no package imports from Node-only DSH code.

**Step 5: commit**

```powershell
git add docs/adr/0042-built-in-joy-agent-engine.md docs/adr/README.md docs/OPEN_SOURCE_RELEASE.md packages/joy-agent-engine apps/editor-web/src/joy-agent/engine.worker.ts tooling/release/verify-joy-agent-worker.mjs apps/editor-web/package.json apps/editor-web/tsconfig.json package.json tsconfig.json pnpm-lock.yaml THIRD_PARTY_NOTICES.md
git commit -m "feat(agent): prove browser worker foundation"
```

## Milestone 1: establish safe engine and provider contracts

### Task 2: Implement immutable contracts, limits, and redaction

**Files:**

- Create: packages/joy-agent-engine/src/contracts.ts
- Create: packages/joy-agent-engine/src/limits.ts
- Create: packages/joy-agent-engine/src/redaction.ts
- Create: packages/joy-agent-engine/src/contracts.test.ts
- Create: packages/joy-agent-engine/src/redaction.test.ts
- Modify: packages/joy-agent-engine/src/index.ts

**Step 1: write failing contract tests**

Tests must prove:

- a run event requires protocolVersion 1, runId, monotonic seq, and safe code;
- phases are the exact design-state union;
- task kinds are the exact product-entry union;
- limits clamp to the approved maxima;
- safe events reject apiKey, authorization, endpoint, prompt, rawRequest,
  rawResponse, reasoning, and DOM selector fields;
- redaction handles circular values and never throws.

The central safe event shape is:

```ts
export interface JoyAgentEventBase {
  readonly protocolVersion: 1;
  readonly runId: string;
  readonly seq: number;
  readonly at: string;
}

export type JoyAgentPhase =
  | 'connecting'
  | 'thinking'
  | 'inspecting'
  | 'planning'
  | 'previewing'
  | 'awaiting-approval'
  | 'applying'
  | 'completed'
  | 'failed'
  | 'cancelled';
```

Run:

```powershell
pnpm exec vitest run packages/joy-agent-engine/src/contracts.test.ts packages/joy-agent-engine/src/redaction.test.ts
```

Expected: FAIL because the modules do not exist.

**Step 2: implement contracts and fixed defaults**

limits.ts exports frozen defaults:

- maxSteps 12;
- maxToolCalls 24;
- maxConcurrentReads 2;
- maxOperations 32;
- wallTimeMs 180000;
- probeTimeMs 15000;
- contextBytes 524288;
- toolPayloadBytes 65536;
- providerResponseBytes 2097152;
- maxOutputTokens 8192.

User overrides may only lower a safety maximum or select a lower provider/media
budget.

**Step 3: implement allow-list projection**

redaction.ts must construct new safe objects from known properties. Do not
recursively redact and then forward arbitrary provider objects. Map errors to
stable codes such as:

- JOY_AGENT_ABORTED;
- JOY_AGENT_TIMEOUT;
- JOY_AGENT_CORS_OR_NETWORK;
- JOY_AGENT_AUTH_FAILED;
- JOY_AGENT_RESPONSE_TOO_LARGE;
- JOY_AGENT_INVALID_TOOL;
- JOY_AGENT_INVALID_PROPOSAL;
- JOY_AGENT_STALE_REVISION;
- JOY_AGENT_PROVIDER_INCOMPATIBLE.

**Step 4: run focused and package tests**

```powershell
pnpm exec vitest run packages/joy-agent-engine/src
pnpm --filter @joy-media/joy-agent-engine build
```

Expected: all pass.

**Step 5: commit**

```powershell
git add packages/joy-agent-engine/src
git commit -m "feat(agent): define safe engine contracts"
```

### Task 3: Add session provider validation and hardened fetch

**Files:**

- Create: packages/joy-agent-engine/src/provider-config.ts
- Create: packages/joy-agent-engine/src/provider-config.test.ts
- Create: packages/joy-agent-engine/src/provider.ts
- Create: packages/joy-agent-engine/src/provider.test.ts
- Modify: packages/joy-agent-engine/src/index.ts

**Step 1: write failing provider-config tests**

Test:

- OpenRouter normalizes exactly to https://openrouter.ai/api/v1;
- custom accepts https://provider.example/v1 and removes one trailing slash;
- custom rejects a full /chat/completions endpoint;
- custom rejects HTTP, username/password, query, fragment, localhost,
  127.0.0.1, ::1, link-local, and literal RFC1918 hosts in the public web
  policy;
- model ID and key must be non-empty and bounded;
- the returned public status contains provider kind/model/capability only and
  never returns base URL or key.

Run:

```powershell
pnpm exec vitest run packages/joy-agent-engine/src/provider-config.test.ts
```

Expected: FAIL.

**Step 2: implement pure normalization**

Use separate secret-bearing and safe status types:

```ts
export interface ByokSessionConfig {
  readonly provider: 'openrouter' | 'openai-compatible';
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey: string;
}

export interface ByokSessionStatus {
  readonly provider: ByokSessionConfig['provider'];
  readonly modelId: string;
  readonly capability: 'untested' | 'tool-loop' | 'plan-only' | 'incompatible';
}
```

No toJSON method or logging helper may exist on ByokSessionConfig.

**Step 3: write failing hardened-fetch tests**

Inject a fake lower-level fetch and prove:

- only the normalized origin is reachable;
- redirect is error;
- credentials is omit;
- cache is no-store;
- referrerPolicy is no-referrer;
- Authorization is not forwarded to any other origin;
- response is aborted when Content-Length or streamed bytes exceed 2 MiB;
- provider error bodies and headers never appear in the thrown safe error.

**Step 4: implement provider construction**

provider.ts wraps fetch before calling:

```ts
const provider = createOpenAICompatible({
  name: 'joy-byok',
  baseURL: config.baseUrl,
  apiKey: config.apiKey,
  fetch: hardenedFetch,
});
return provider(config.modelId);
```

Do not support arbitrary headers. Do not install AI SDK DevTools. Do not attach
telemetry/tracing to model calls.

**Step 5: verify**

```powershell
pnpm exec vitest run packages/joy-agent-engine/src/provider-config.test.ts packages/joy-agent-engine/src/provider.test.ts
pnpm --filter @joy-media/joy-agent-engine build
```

Expected: all pass.

**Step 6: commit**

```powershell
git add packages/joy-agent-engine/src/provider-config.ts packages/joy-agent-engine/src/provider-config.test.ts packages/joy-agent-engine/src/provider.ts packages/joy-agent-engine/src/provider.test.ts packages/joy-agent-engine/src/index.ts
git commit -m "feat(agent): harden direct BYOK transport"
```

### Task 4: Implement capability probing and the bounded model loop

**Files:**

- Create: packages/joy-agent-engine/src/tools.ts
- Create: packages/joy-agent-engine/src/tools.test.ts
- Create: packages/joy-agent-engine/src/engine.ts
- Create: packages/joy-agent-engine/src/engine.test.ts
- Modify: packages/joy-agent-engine/src/index.ts

**Step 1: write failing tool-schema tests**

Define exact Zod schemas for the eight initial tools. Tests must reject:

- unknown keys;
- more than 32 operations;
- oversized strings/payloads;
- model-supplied panelId, selector, className, endpoint, headers, or capability;
- unsupported operation kinds and dependency cycles.

Each tool has trusted metadata:

```ts
export interface JoyAgentToolMetadata {
  readonly access: 'read' | 'preview' | 'submit';
  readonly capability: ToolCapability;
  readonly activityCode: string;
  readonly surface: string;
  readonly parallel: boolean;
}
```

Only access read may set parallel true.

**Step 2: write failing engine tests with ai/test mocks**

Use MockLanguageModelV3 exported by ai/test. Cover:

- harmless capability probe returns tool-loop;
- structured planning without tools returns plan-only;
- neither capability returns incompatible;
- ToolLoopAgent stops at 12 steps/24 tools;
- parallel reads never exceed two;
- preview/submit tools execute serially;
- AbortSignal cancels an in-flight model and pending tool bridge;
- wall clock, token, response, operation, and spend limits fail closed;
- Worker-facing events contain no prompt, reasoning, tool payload, endpoint, or
  provider error object;
- no provider/model fallback occurs.

Run:

```powershell
pnpm exec vitest run packages/joy-agent-engine/src/tools.test.ts packages/joy-agent-engine/src/engine.test.ts
```

Expected: FAIL.

**Step 3: implement the tool-loop path**

engine.ts accepts a LanguageModelV3 and a JoyAgentToolBridge. It constructs:

```ts
new ToolLoopAgent({
  model,
  instructions: JOY_AGENT_INSTRUCTIONS,
  tools: createJoyAgentTools(bridge),
  stopWhen: [stepCountIs(limits.maxSteps), joyToolCallLimit(limits.maxToolCalls)],
});
```

The instruction states that the model proposes bounded operations and never
claims an edit is applied until submit_plan receives a committed result.
Hidden reasoning is never requested or surfaced.

**Step 4: implement explicit plan-only mode**

Use AI SDK structured output with the existing JoyCodeModelPlanV1 schema. The
user-visible capability must say Plan-only. It uses the same configured
provider and model; it is not a fallback to another route.

**Step 5: verify**

```powershell
pnpm exec vitest run packages/joy-agent-engine/src
pnpm --filter @joy-media/joy-agent-engine build
pnpm verify:joy-agent-worker
```

Expected: all pass and Worker remains under budget.

**Step 6: commit**

```powershell
git add packages/joy-agent-engine/src
git commit -m "feat(agent): add bounded provider-neutral tool loop"
```

## Milestone 2: make BYOK a real session boundary

### Task 5: Implement Worker RPC, cancellation, and teardown

**Files:**

- Replace: apps/editor-web/src/joy-agent/engine.worker.ts
- Delete: packages/joy-agent-engine/src/spike.ts
- Create: apps/editor-web/src/joy-agent/protocol.ts
- Create: apps/editor-web/src/joy-agent/protocol.test.ts
- Create: apps/editor-web/src/joy-agent/engine-client.ts
- Create: apps/editor-web/src/joy-agent/engine-client.test.ts
- Create: apps/editor-web/src/joy-agent/byok-session.ts
- Create: apps/editor-web/src/joy-agent/byok-session.test.ts
- Modify: apps/editor-web/src/App.tsx

**Step 1: write failing protocol and lifecycle tests**

Prove:

- protocol version mismatch is rejected before configuration;
- configure input is never echoed;
- only one active run mutates preview state;
- cancel aborts the model and every pending RPC;
- Clear, provider change, signOut at App.tsx:3425, fatal error, and dispose
  terminate the Worker and replace it only on the next configure;
- late messages from a terminated Worker are ignored;
- no configuration/status object can be JSON-stringified into a key/base URL;
- window unload requires no storage cleanup because nothing was stored.

**Step 2: implement discriminated messages**

protocol.ts owns MainToWorkerMessage and WorkerToMainMessage. All messages are
parsed at runtime with exact schemas before use. tool-result must bind
requestId, runId, toolCallId, and run revision.

**Step 3: implement engine-client**

Use one Worker instance per configured session. Maintain an AbortController per
run, request timeouts, and a disposed generation number. expose:

```ts
interface JoyAgentEngineClient {
  configure(config: ByokSessionConfig): Promise<ByokSessionStatus>;
  testConnection(): Promise<ByokSessionStatus>;
  startRun(request: JoyAgentRunRequest): AsyncIterable<JoyAgentSafeEvent>;
  cancel(runId: string): Promise<void>;
  clear(): void;
  dispose(): void;
}
```

clear and dispose call terminate immediately. They never send the secret back
through a diagnostic event.

**Step 4: integrate sign-out teardown**

App.tsx must call client.clear before logoutJoySession and also during App
unmount. Fatal Worker errors clear preview/activity before surfacing a safe
retry state.

**Step 5: verify**

```powershell
pnpm exec vitest run apps/editor-web/src/joy-agent/protocol.test.ts apps/editor-web/src/joy-agent/engine-client.test.ts apps/editor-web/src/joy-agent/byok-session.test.ts
pnpm --filter @joy-media/editor-web build
```

Expected: all pass.

**Step 6: commit**

```powershell
git add apps/editor-web/src/joy-agent apps/editor-web/src/App.tsx
git add -A packages/joy-agent-engine/src/spike.ts
git commit -m "feat(agent): isolate BYOK lifecycle in worker"
```

### Task 6: Replace Agent Settings with session-only model connection

**Files:**

- Create: apps/editor-web/src/agent-policy-settings.ts
- Create: apps/editor-web/src/agent-policy-settings.test.ts
- Create: apps/editor-web/src/ByokSessionForm.tsx
- Create: apps/editor-web/src/ByokSessionForm.test.tsx
- Create: apps/editor-web/src/AgentSettingsDialog.test.tsx
- Modify: apps/editor-web/src/AgentSettingsDialog.tsx
- Modify: apps/editor-web/src/App.tsx
- Modify: apps/editor-web/src/AgentPanel.tsx
- Modify: apps/editor-web/src/app.css
- Delete after import migration: apps/editor-web/src/agent-settings.ts
- Replace: apps/editor-web/src/agent-settings.test.ts

**Step 1: write failing storage migration tests**

Seed joy-media.agent-settings.v1 with every legacy field, including
deepSeekHarnessEndpoint, deepSeekHarnessModel, joyCodeEngine, activeHost, and a
sentinel string. Loading version 2 must:

- migrate only execution mode, allowed capabilities, budgets, privacy policy,
  and livePreview;
- write joy-media.agent-policy.v2;
- remove joy-media.agent-settings.v1;
- leave the sentinel absent from all storage keys and values;
- never define provider, baseUrl, modelId, apiKey, or capability in the
  persisted interface.

Run:

```powershell
pnpm exec vitest run apps/editor-web/src/agent-policy-settings.test.ts
```

Expected: FAIL.

**Step 2: implement AgentPolicyPreferences v2**

Default livePreview is true. Follow agent belongs to an in-memory UI session
state and always starts false; it is not part of AgentPolicyPreferences. Keep
existing Preview and Approve as the execution default. Remove activeHost,
joyCodeEngine, DeepSeek fields, reasoningModel, and server-model loading.

**Step 3: write failing form tests**

ByokSessionForm must prove:

- API key uses an uncontrolled ref, not value/onChange state;
- OpenRouter fixes the base URL and asks for model/key;
- Custom enables HTTPS Base URL and requires the disclosure;
- Test & Use transfers the current DOM values once, then blanks the key input;
- Clear calls engineClient.clear and resets safe readiness;
- status reads Tool loop, Plan-only, Incompatible, or CORS/network;
- copy says JOY does not save or proxy the connection and provider charges may
  apply;
- no KiloCode, code-server, cloud planner, local DSH, or server-secret text
  appears.

**Step 4: implement the redesigned dialog**

Sections are:

1. JOY Agent Engine — Built in / Browser Worker / current safe status.
2. Model connection — this page session only.
3. Privacy.
4. Editing policy and budgets.
5. Live work — Preview live and Follow agent.

The footer distinguishes session-only connection from browser-saved editing
policy. Never pass config through onChange for policy settings.

At this intermediate commit, remove App’s local/cloud planner composition and
adapt AgentPanel to accept AgentPolicyPreferences while its deterministic
recipes remain available. Free-form work stays visibly unavailable until the
new engine is connected in Task 9; it must not temporarily fall back to the
old cloud route. Migrate every import before deleting agent-settings.ts so the
commit builds independently.

**Step 5: verify UI and storage**

```powershell
pnpm exec vitest run apps/editor-web/src/agent-policy-settings.test.ts apps/editor-web/src/ByokSessionForm.test.tsx apps/editor-web/src/agent-settings.test.ts
pnpm exec vitest run apps/editor-web/src/AgentSettingsDialog.test.tsx
pnpm --filter @joy-media/editor-web build
```

Expected: all pass.

**Step 6: commit**

```powershell
git add apps/editor-web/src/agent-policy-settings.ts apps/editor-web/src/agent-policy-settings.test.ts apps/editor-web/src/ByokSessionForm.tsx apps/editor-web/src/ByokSessionForm.test.tsx apps/editor-web/src/AgentSettingsDialog.tsx apps/editor-web/src/AgentSettingsDialog.test.tsx apps/editor-web/src/App.tsx apps/editor-web/src/AgentPanel.tsx apps/editor-web/src/app.css apps/editor-web/src/agent-settings.test.ts
git rm apps/editor-web/src/agent-settings.ts
git commit -m "feat(agent): redesign settings for session-only BYOK"
```

## Milestone 3: connect the engine to guarded JOY planning

### Task 7: Build bounded context and the trusted tool bridge

**Files:**

- Create: apps/editor-web/src/joy-agent/context-snapshot.ts
- Create: apps/editor-web/src/joy-agent/context-snapshot.test.ts
- Create: apps/editor-web/src/joy-agent/tool-bridge.ts
- Create: apps/editor-web/src/joy-agent/tool-bridge.test.ts
- Modify: packages/agent-tools/src/registry.ts
- Create: packages/agent-tools/src/registry.test.ts
- Modify: packages/agent-tools/src/index.ts

**Step 1: write failing snapshot tests**

Given a project with large media metadata and plugin payloads, prove the
snapshot:

- contains project ID, exact revision, selected IDs, playhead/window, bounded
  track/clip facts, safe asset metadata, and catalog IDs;
- excludes raw media bytes, signed URLs, secrets, auth state, provider config,
  private plugin data, storage handles, and command dispatchers;
- truncates deterministically below 512 KiB;
- does not mutate source objects;
- marks omitted sections explicitly.

**Step 2: implement code-owned snapshot projection**

Build one immutable snapshot at run start. Read tools query that frozen value;
they do not read live mutable EditorSession state during the model loop.

**Step 3: replace generic tool schemas**

registry.ts currently exposes generic object schemas. Add exact schema
metadata for the tools made model-visible. Do not expose existing execute
methods to the Worker. tool-bridge.ts implements pure reads and proposal
submission only.

**Step 4: write and pass bridge tests**

Test invalid tool IDs, stale revision, argument/result byte limits, two-read
concurrency, serialized preview calls, cancellation, and sanitized failures.

Run:

```powershell
pnpm exec vitest run apps/editor-web/src/joy-agent/context-snapshot.test.ts apps/editor-web/src/joy-agent/tool-bridge.test.ts packages/agent-tools/src/registry.test.ts
```

Expected: all pass.

**Step 5: commit**

```powershell
git add apps/editor-web/src/joy-agent/context-snapshot.ts apps/editor-web/src/joy-agent/context-snapshot.test.ts apps/editor-web/src/joy-agent/tool-bridge.ts apps/editor-web/src/joy-agent/tool-bridge.test.ts packages/agent-tools/src/registry.ts packages/agent-tools/src/registry.test.ts packages/agent-tools/src/index.ts
git commit -m "feat(agent): bridge bounded JOY context and tools"
```

### Task 8: Create the immutable live preview branch

**Files:**

- Create: apps/editor-web/src/joy-agent/preview-controller.ts
- Create: apps/editor-web/src/joy-agent/preview-controller.test.ts
- Create: apps/editor-web/src/agent-preview-projection.ts
- Create: apps/editor-web/src/agent-preview-projection.test.ts
- Modify: apps/editor-web/src/joy-code-compound-compiler.ts
- Modify: apps/editor-web/src/joy-code-compound-compiler.test.ts
- Modify: packages/agent-tools/src/atomic.ts
- Create: packages/agent-tools/src/atomic.test.ts

**Step 1: write failing preview-invariance tests**

For timeline plus text/caption/transition operations, prove:

- each validated partial operation creates a new immutable preview bundle;
- JoyCodeCompoundDraft timeline commands apply only to a cloned timeline;
- its staged document is used only as preview;
- EditorSession project, history, persistence callbacks, sync, and export
  inputs are byte-for-byte unchanged;
- the bundle includes runId, seq, baseRevision, proposalHash, and semantic diff;
- revision drift, user edit, reject, cancel, failure, and timeout clear it;
- approve applies the exact draft once and one Undo restores both buses.

Run:

```powershell
pnpm exec vitest run apps/editor-web/src/joy-agent/preview-controller.test.ts apps/editor-web/src/agent-preview-projection.test.ts
```

Expected: FAIL.

**Step 2: extract pure staging where needed**

Add a non-committing stagePlanPreview path for older deterministic AgentEditPlan
recipes. Keep runPlanAtomically backward compatible by composing stage then
commit. The preview path must not accept a live commit callback.

**Step 3: implement preview-controller**

Coalesce multiple validated preview updates to one requestAnimationFrame. Keep
only the latest sequence for the active run/revision. Never persist the bundle.

**Step 4: verify parity and Undo**

```powershell
pnpm exec vitest run apps/editor-web/src/joy-agent/preview-controller.test.ts apps/editor-web/src/agent-preview-projection.test.ts apps/editor-web/src/joy-code-compound-compiler.test.ts apps/editor-web/src/joy-code-compound-runner.test.ts packages/agent-tools/src/atomic.test.ts
```

Expected: all pass.

**Step 5: commit**

```powershell
git add apps/editor-web/src/joy-agent/preview-controller.ts apps/editor-web/src/joy-agent/preview-controller.test.ts apps/editor-web/src/agent-preview-projection.ts apps/editor-web/src/agent-preview-projection.test.ts apps/editor-web/src/joy-code-compound-compiler.ts apps/editor-web/src/joy-code-compound-compiler.test.ts packages/agent-tools/src/atomic.ts packages/agent-tools/src/atomic.test.ts
git commit -m "feat(agent): stage revision-bound live previews"
```

### Task 9: Route Joy Code through the new engine

**Files:**

- Modify: apps/editor-web/src/AgentPanel.tsx
- Create: apps/editor-web/src/AgentPanel.test.tsx
- Modify: apps/editor-web/src/App.tsx
- Modify: apps/editor-web/src/joy-code-history.ts
- Modify: apps/editor-web/src/joy-code-history.test.ts
- Modify: apps/editor-web/src/agent-panel-intents.ts
- Modify: apps/editor-web/src/agent-panel-intents.test.ts
- Modify: apps/editor-web/src/app-menu.ts
- Modify: apps/editor-web/src/app-menu.test.ts

**Step 1: write failing Joy Code parity tests**

Test:

- natural-language run requires a configured session and never calls the JOY
  control-plane planner;
- recognized deterministic recipes execute as trusted JOY engine shortcuts and
  retain preview/approval/Undo behavior without model cost;
- Tool-loop and Plan-only modes both finalize JoyCodeModelPlanV1;
- stream text, Stop, Retry, approval, rejection, stale revision, and error
  states are real engine states;
- stopping aborts work rather than only hiding a timer;
- actor for new history/provenance is joy-agent;
- persisted conversation history contains no provider config or safe activity
  internals;
- app menu says JOY Agent Engine and contains no KiloCode host row.

**Step 2: replace local AgentPanel planning state**

Remove THINKING_REVEAL_MS, local fake thinking phase, direct server/local plan
selection, and the kilocode actor constant. AgentPanel consumes the engine
client, preview controller, and shared activity store introduced below.

Rename KiloCodeAttachedAsset to JoyAgentAttachedAsset and App callbacks to
attachJoyAgentAsset/detachJoyAgentAsset.

**Step 3: preserve deterministic recipes**

Move current intent recognition/builders behind a trusted shortcut adapter.
They emit the same safe run/activity/preview events as model-driven plans.
They never pretend a provider was called.

**Step 4: verify focused parity**

```powershell
pnpm exec vitest run apps/editor-web/src/AgentPanel.test.tsx apps/editor-web/src/agent-panel-intents.test.ts apps/editor-web/src/joy-code-history.test.ts apps/editor-web/src/app-menu.test.ts packages/agent-tools/src/joy-code-plan.test.ts
pnpm --filter @joy-media/editor-web build
```

Expected: all pass.

**Step 5: commit**

```powershell
git add apps/editor-web/src/AgentPanel.tsx apps/editor-web/src/AgentPanel.test.tsx apps/editor-web/src/App.tsx apps/editor-web/src/joy-code-history.ts apps/editor-web/src/joy-code-history.test.ts apps/editor-web/src/agent-panel-intents.ts apps/editor-web/src/agent-panel-intents.test.ts apps/editor-web/src/app-menu.ts apps/editor-web/src/app-menu.test.ts
git commit -m "feat(agent): route Joy Code through JOY engine"
```

## Milestone 4: make the agent visibly and truthfully live

### Task 10: Add the normalized presence store and trusted surface map

**Files:**

- Create: apps/editor-web/src/agent-presence.ts
- Create: apps/editor-web/src/agent-presence.test.ts
- Create: apps/editor-web/src/agent-ui-targets.ts
- Create: apps/editor-web/src/agent-ui-targets.test.ts
- Modify: apps/editor-web/src/App.tsx

**Step 1: write failing reducer tests**

The reducer must:

- accept only monotonically increasing seq for the active run;
- ignore wrong-run, stale-revision, and post-terminal events;
- clear targets/preview on cancel/fail and after completed handoff;
- retain awaiting-approval as a stable, non-animated state;
- expose measured progress only when current/total are valid;
- never derive progress from timers or token deltas;
- never persist or serialize events;
- notify only selectors whose phase/target/preview slice changed.

**Step 2: write failing target-map tests**

Map every model-visible tool to a durable panel and nested section. Validate
entity IDs against the snapshot/result. Explicitly test:

- timeline clip/track targets;
- Create media/text/captions/audio/templates;
- Enhance motion/transitions/effects/filters/color/adjust;
- Inspector Visual/Enhance/Mask/Adjust/Effects/Audio/Speed;
- Joy Code Composer/Brief/3D;
- unknown tool maps to Joy Code only;
- provider-supplied panelId/sectionId/selector/className is ignored.

**Step 3: implement useSyncExternalStore selectors**

Create one in-memory store at App scope. Do not put token deltas or message text
in it. Expose useAgentPanelPresence(panelId), useAgentSectionPresence(panelId,
sectionId), and useAgentEntityPresence(kind, id).

**Step 4: verify**

```powershell
pnpm exec vitest run apps/editor-web/src/agent-presence.test.ts apps/editor-web/src/agent-ui-targets.test.ts
```

Expected: all pass.

**Step 5: commit**

```powershell
git add apps/editor-web/src/agent-presence.ts apps/editor-web/src/agent-presence.test.ts apps/editor-web/src/agent-ui-targets.ts apps/editor-web/src/agent-ui-targets.test.ts apps/editor-web/src/App.tsx
git commit -m "feat(agent): normalize live agent presence"
```

### Task 11: Add global, dock-tab, panel, and section presence

**Files:**

- Create: apps/editor-web/src/AgentActivityIndicator.tsx
- Create: apps/editor-web/src/AgentActivityIndicator.test.tsx
- Modify: apps/editor-web/src/PanelTab.tsx
- Modify: apps/editor-web/src/PanelTab.test.tsx
- Modify: apps/editor-web/src/PanelShell.tsx
- Modify: apps/editor-web/src/PanelShell.test.tsx
- Modify: apps/editor-web/src/FeatureHub.tsx
- Create or modify: apps/editor-web/src/FeatureHub.test.tsx
- Modify: apps/editor-web/src/App.tsx
- Modify: apps/editor-web/src/app.css

**Step 1: write failing component tests**

Prove:

- idle renders no global indicator;
- real activity renders Joy mark, safe phase label, target, Show target,
  Follow, and Stop;
- Stop invokes engine cancellation;
- Follow defaults off and is session-only;
- targeted inactive Dockview tab has an agent marker without aria-selected;
- targeted nested section has a marker without changing roving tab selection;
- awaiting approval is static and named Needs approval;
- role status announces phase changes only;
- no provider/model prompt text appears in labels.

**Step 2: implement global indicator and reveal behavior**

Place AgentActivityIndicator in App’s header center/spacer. Show target performs
one activatePanel call. Follow listens to real primary-target changes, resolves
featureActivationRoute, changes the relevant hub/section, and calls
panel.api.setActive. It must preserve document.activeElement and must not add a
missing panel or update the saved Dockview layout when Follow is off.

**Step 3: implement distinct visual states**

Use existing JOY gold/neutral/ok/danger tokens only:

- inactive target: small amber top tick/dot;
- primary working target: restrained 1.8-second low-opacity halo;
- panel: 1px inset amber edge and safe badge;
- nested target: moving amber underline;
- awaiting approval: static strong border;
- completed: green confirmation for 1200 ms from a real terminal event;
- failed: static danger marker.

Do not change the existing solid amber user-selected state.

App’s Dockview Panel wrapper provides the durable api.id through a
PanelIdentityContext, so PanelShell can subscribe without requiring a
panelId prop to be threaded through every existing panel in this task.

**Step 4: add full reduced-motion rules**

Under prefers-reduced-motion, set every new presence animation and transition
to none while retaining static dots, borders, patterns, icons, and text.

**Step 5: verify**

```powershell
pnpm exec vitest run apps/editor-web/src/AgentActivityIndicator.test.tsx apps/editor-web/src/PanelTab.test.tsx apps/editor-web/src/PanelShell.test.tsx apps/editor-web/src/FeatureHub.test.tsx
pnpm --filter @joy-media/editor-web build
```

Expected: all pass.

**Step 6: commit**

```powershell
git add apps/editor-web/src/AgentActivityIndicator.tsx apps/editor-web/src/AgentActivityIndicator.test.tsx apps/editor-web/src/PanelTab.tsx apps/editor-web/src/PanelTab.test.tsx apps/editor-web/src/PanelShell.tsx apps/editor-web/src/PanelShell.test.tsx apps/editor-web/src/FeatureHub.tsx apps/editor-web/src/FeatureHub.test.tsx apps/editor-web/src/App.tsx apps/editor-web/src/app.css
git commit -m "feat(agent): show live panel and section activity"
```

### Task 12: Render real Monitor, Timeline, Inspector, Asset, Brief, and 3D previews

**Files:**

- Create: apps/editor-web/src/agent-timeline-preview.ts
- Create: apps/editor-web/src/agent-timeline-preview.test.ts
- Create: apps/editor-web/src/AgentTimelineOverlay.tsx
- Create: apps/editor-web/src/AgentTimelineOverlay.test.tsx
- Modify: apps/editor-web/src/TimelinePanel.tsx
- Modify: apps/editor-web/src/TimelinePanel.interaction.test.tsx
- Modify: apps/editor-web/src/InspectorPanel.tsx
- Create: apps/editor-web/src/InspectorPanel.test.tsx
- Modify: apps/editor-web/src/AssetLibraryPanel.tsx
- Create: apps/editor-web/src/AssetLibraryPanel.test.tsx
- Modify: apps/editor-web/src/CreativeBriefPanel.tsx
- Modify: apps/editor-web/src/CreativeBriefPanel.test.tsx
- Modify: apps/editor-web/src/JoyCode3DViewer.tsx
- Modify: apps/editor-web/src/JoyCode3DViewer.test.ts
- Modify: apps/editor-web/src/App.tsx
- Modify: apps/editor-web/src/app.css

**Step 1: write failing projection/overlay tests**

Test add/remove/move/trim/effect/property diffs. Assert:

- overlay is pointer-events none;
- canonical clip remains interactive and selected state unchanged;
- add has dashed ghost plus icon;
- remove has hatch plus icon;
- move/trim shows origin and ghost destination;
- diff summary is accessible without relying on color;
- exact data-clip-id, data-track-id, data-asset-id, and new
  data-property-key targets are used.

**Step 2: render preview in the real Program Monitor**

MonitorPanelContent selects preview timeline/visual only while phase is
previewing or awaiting-approval and the base revision matches. Add a
non-blocking AGENT PREVIEW — NOT APPLIED frame and keyboard-accessible
Before/Preview toggle.

Reject, Stop, failure, user edit, or revision change must show canonical on the
next frame. During approve, keep preview until the committed revision matches,
then remove it without a mixed canonical/preview frame.

**Step 3: render Timeline and Inspector truthfully**

Augment or replace the isolated 400x120 AgentTimelineCanvas with
AgentTimelineOverlay on the real timeline viewport. Inspector shows canonical
to preview values and Preview badges; it never silently changes a committed
input value. Any human input invalidates the preview.

**Step 4: integrate assets, Brief, and 3D**

- Assets highlight exact cards and only show pending generation cards from real
  provider/job events.
- Creative Brief uses shared phases, marks its nested tab, and sets aria-busy
  only during real work.
- 3D accepts a validated preview scene and marks the viewport/tab. It never
  auto-orbits or animates to fake activity.

**Step 5: verify**

```powershell
pnpm exec vitest run apps/editor-web/src/agent-timeline-preview.test.ts apps/editor-web/src/AgentTimelineOverlay.test.tsx apps/editor-web/src/TimelinePanel.interaction.test.tsx apps/editor-web/src/InspectorPanel.test.tsx apps/editor-web/src/AssetLibraryPanel.test.tsx apps/editor-web/src/CreativeBriefPanel.test.tsx apps/editor-web/src/JoyCode3DViewer.test.ts
pnpm --filter @joy-media/editor-web build
```

Expected: all pass.

**Step 6: commit**

```powershell
git add apps/editor-web/src/agent-timeline-preview.ts apps/editor-web/src/agent-timeline-preview.test.ts apps/editor-web/src/AgentTimelineOverlay.tsx apps/editor-web/src/AgentTimelineOverlay.test.tsx apps/editor-web/src/TimelinePanel.tsx apps/editor-web/src/TimelinePanel.interaction.test.tsx apps/editor-web/src/InspectorPanel.tsx apps/editor-web/src/InspectorPanel.test.tsx apps/editor-web/src/AssetLibraryPanel.tsx apps/editor-web/src/AssetLibraryPanel.test.tsx apps/editor-web/src/CreativeBriefPanel.tsx apps/editor-web/src/CreativeBriefPanel.test.tsx apps/editor-web/src/JoyCode3DViewer.tsx apps/editor-web/src/JoyCode3DViewer.test.ts apps/editor-web/src/App.tsx apps/editor-web/src/app.css
git commit -m "feat(agent): render truthful live edit previews"
```

## Milestone 5: make it the whole application engine

### Task 13: Migrate Creative Brief and every AI entry point

**Files:**

- Modify: apps/editor-web/src/CreativeBriefPanel.tsx
- Replace: apps/editor-web/src/creative-brief-panel-runner.ts
- Replace: apps/editor-web/src/creative-brief-panel-runner.test.ts
- Modify: apps/editor-web/src/AssetLibraryPanel.tsx
- Modify: apps/editor-web/src/EffectsPanel.tsx
- Modify: apps/editor-web/src/MotionPanel.tsx
- Modify: apps/editor-web/src/ColorPanel.tsx
- Modify: apps/editor-web/src/CaptionsPanel.tsx
- Modify: apps/editor-web/src/AudioPanel.tsx
- Modify: apps/editor-web/src/JoyCode3DViewer.tsx
- Modify: apps/editor-web/src/App.tsx
- Create: apps/editor-web/src/joy-agent/entry-points.ts
- Create: apps/editor-web/src/joy-agent/entry-points.test.ts
- Modify: packages/joy-agent-engine/src/tools.ts
- Modify: packages/joy-agent-engine/src/tools.test.ts
- Modify: apps/editor-web/src/agent-ui-targets.ts
- Modify: apps/editor-web/src/agent-ui-targets.test.ts

**Step 1: add failing task-parity tests**

For each task kind, prove it uses the same configured engine client and emits
the same run/activity/preview/approval contract:

| Entry point          | Required typed result                                   |
| -------------------- | ------------------------------------------------------- |
| Creative Brief       | existing validated CreativeBriefV1                      |
| Asset Edit with AI   | attached asset metadata plus bounded edit proposal      |
| Effects/Motion/Color | document operation proposal and live property preview   |
| Captions/Audio       | bounded caption/audio proposal or explicit approved job |
| 3D                   | validated scene operation/preview                       |

No entry point may call createCreativeBrief, joy-code/plans, or an engine-
specific browser transport.

entry-points.ts is the exhaustive code-owned inventory for Joy Code, Brief,
Asset Edit, Text, Effects, Filters, Transitions, Color, Motion, Camera,
Captions, Audio, 3D, Workflows, and media-job assistance. Its test scans the
registered actions and fails if an agent action has no task kind, target map,
policy capability, or shared engine-client handler.

**Step 2: extend exact tools by domain**

Add read and proposal tools for the above domains. Keep schemas exact, map
targets in code, and require explicit approval for remote media upload, paid
jobs, filesystem/export writes, project overwrite, and plugins.

**Step 3: replace Creative Brief server runner**

The new runner creates a creative-brief task with a bounded local snapshot and
validates CreativeBriefV1 in the Worker/main boundary. It does not sync a
project to obtain server reasoning.

**Step 4: route UI actions**

All listed panels call the shared task API. Model connection absence opens the
new Settings model section. Deterministic local panel actions remain available
without BYOK and still use the same JOY activity/preview/apply conventions.

**Step 5: verify**

```powershell
pnpm exec vitest run packages/joy-agent-engine/src/tools.test.ts apps/editor-web/src/creative-brief-panel-runner.test.ts apps/editor-web/src/agent-ui-targets.test.ts apps/editor-web/src/joy-agent/entry-points.test.ts apps/editor-web/src/CreativeBriefPanel.test.tsx apps/editor-web/src/AssetLibraryPanel.test.tsx
pnpm --filter @joy-media/editor-web build
pnpm typecheck
```

Expected: all pass and rg finds no UI task path calling control-plane AI
methods.

**Step 6: commit**

```powershell
git add packages/joy-agent-engine/src/tools.ts packages/joy-agent-engine/src/tools.test.ts apps/editor-web/src/agent-ui-targets.ts apps/editor-web/src/agent-ui-targets.test.ts apps/editor-web/src/joy-agent/entry-points.ts apps/editor-web/src/joy-agent/entry-points.test.ts apps/editor-web/src/CreativeBriefPanel.tsx apps/editor-web/src/creative-brief-panel-runner.ts apps/editor-web/src/creative-brief-panel-runner.test.ts apps/editor-web/src/AssetLibraryPanel.tsx apps/editor-web/src/EffectsPanel.tsx apps/editor-web/src/MotionPanel.tsx apps/editor-web/src/ColorPanel.tsx apps/editor-web/src/CaptionsPanel.tsx apps/editor-web/src/AudioPanel.tsx apps/editor-web/src/JoyCode3DViewer.tsx apps/editor-web/src/App.tsx
git commit -m "feat(agent): unify application AI entry points"
```

### Task 14: Integrate real media jobs, budgets, and progress

**Files:**

- Create: apps/editor-web/src/joy-agent/media-job-bridge.ts
- Create: apps/editor-web/src/joy-agent/media-job-bridge.test.ts
- Modify: packages/joy-agent-engine/src/tools.ts
- Modify: packages/joy-agent-engine/src/tools.test.ts
- Modify: packages/agent-tools/src/approval.ts
- Create: packages/agent-tools/src/approval.test.ts
- Modify: apps/editor-web/src/JobsPanel.tsx
- Create: apps/editor-web/src/JobsPanel.test.tsx
- Modify: apps/editor-web/src/agent-presence.ts

**Step 1: write failing approval/progress tests**

Prove:

- model-provider spend and media-job spend are separate;
- paid/remote media jobs require their existing explicit policy grant;
- provider/model selection never selects a media provider implicitly;
- the engine receives only opaque job ID plus safe progress/result metadata;
- progress is determinate only when the job reports current/total;
- cancel propagates to the real job API when supported and otherwise reports
  cancellation pending honestly;
- generated media is not imported into the project before explicit approval.

**Step 2: implement the bridge**

media-job-bridge.ts translates an approved tool request into the existing
provider/job boundary. It does not send the model BYOK key to a media provider
and does not expose a media provider credential to the Worker.

**Step 3: connect Jobs and live surfaces**

Jobs remains the durable job-status UI. Shared agent presence points to Jobs
and the target panel while the job is real. Pending output cards use actual
preview URLs and provenance only.

**Step 4: verify**

```powershell
pnpm exec vitest run apps/editor-web/src/joy-agent/media-job-bridge.test.ts packages/joy-agent-engine/src/tools.test.ts packages/agent-tools/src/approval.test.ts apps/editor-web/src/JobsPanel.test.tsx
```

Expected: all pass.

**Step 5: commit**

```powershell
git add apps/editor-web/src/joy-agent/media-job-bridge.ts apps/editor-web/src/joy-agent/media-job-bridge.test.ts packages/joy-agent-engine/src/tools.ts packages/joy-agent-engine/src/tools.test.ts packages/agent-tools/src/approval.ts packages/agent-tools/src/approval.test.ts apps/editor-web/src/JobsPanel.tsx apps/editor-web/src/JobsPanel.test.tsx apps/editor-web/src/agent-presence.ts
git commit -m "feat(agent): bridge approved media jobs"
```

## Milestone 6: remove misleading legacy runtime and release safely

### Task 15: Remove product KiloCode, cloud planner, and local DSH paths

**Files:**

- Delete: apps/editor-web/src/local-deepseek-harness.ts
- Delete: apps/editor-web/src/local-deepseek-harness.test.ts
- Delete: apps/editor-web/src/joy-code-server-session.ts
- Delete: apps/editor-web/src/joy-code-server-session.test.ts
- Delete: apps/editor-web/src/joy-code-request-coordinator.ts
- Delete: apps/editor-web/src/joy-code-request-coordinator.test.ts
- Delete: packages/adapter-deepseek-harness/**
- Delete: packages/agent-tools/src/kilocode-host.ts
- Delete: packages/agent-tools/src/kilocode-host.test.ts
- Modify: packages/agent-tools/src/index.ts
- Modify: apps/editor-web/package.json
- Modify: apps/editor-web/tsconfig.json
- Modify: vitest.config.ts
- Modify: pnpm-lock.yaml
- Modify: apps/editor-web/src/AgentPanel.tsx
- Modify: apps/editor-web/src/AssetLibraryPanel.tsx
- Modify: apps/editor-web/src/dual-lens-model.ts
- Modify: apps/editor-web/src/dual-lens-model.test.ts
- Modify: apps/editor-web/src/data-lanes.ts
- Modify: apps/editor-web/src/data-lanes.test.ts
- Modify: apps/editor-web/src/app.css
- Modify: STATE.md

**Step 1: add a legacy-provenance compatibility test**

Fixtures with actor kilocode and joy-code-server must still render as Legacy
Joy Code. New runs must render as JOY Agent Engine. The test must not rewrite
the fixture or emit a migration command.

**Step 2: prove no live imports remain**

Run before deletion:

```powershell
rg -n -i "kilocode|deepseek-harness|cloud-openrouter|joy-code-server|code-server-extension" apps/editor-web/src packages/agent-tools/src
```

Classify every remaining match as either a file being removed or explicit
legacy-read compatibility. Product copy and runtime imports must reach zero.

**Step 3: delete legacy browser/package paths**

Remove dependencies, workspace references, Vitest aliases, lockfile links, and
exports. Rename remaining Kilo-specific variable/type names. Update historical
status documentation with a dated supersession note; do not falsify old
entries.

**Step 4: verify no product fallback**

```powershell
rg -n -i "Editing Host: KiloCode|code-server-extension|JOY cloud planner|Local DeepSeek harness" apps/editor-web/src
pnpm typecheck
pnpm exec vitest run packages/agent-tools/src apps/editor-web/src/AgentPanel.test.tsx apps/editor-web/src/dual-lens-model.test.ts apps/editor-web/src/data-lanes.test.ts
pnpm --filter @joy-media/editor-web build
```

Expected: rg exits with no matches; all checks pass.

**Step 5: commit**

```powershell
git add -A apps/editor-web packages/adapter-deepseek-harness packages/agent-tools vitest.config.ts pnpm-lock.yaml STATE.md
git commit -m "refactor(agent): remove legacy Kilo and DSH runtime"
```

### Task 16: Retire unused server AI endpoints after browser parity

**Files:**

- Modify: apps/api/src/http-server.ts
- Modify: apps/api/src/http-server.test.ts
- Modify: apps/api/src/server.ts
- Modify: apps/editor-web/src/control-plane-client.ts
- Modify: apps/editor-web/src/control-plane-client.test.ts
- Delete: apps/api/src/joy-code-admission-gate.ts
- Delete: apps/api/src/joy-code-admission-gate.test.ts
- Delete: apps/api/src/joy-code-client-request-validation.ts
- Delete: apps/api/src/joy-code-client-request-validation.test.ts
- Delete: apps/api/src/joy-code-consent.ts
- Delete: apps/api/src/joy-code-input-resolver.ts
- Delete: apps/api/src/joy-code-input-resolver.test.ts
- Delete: apps/api/src/joy-code-opt-in.test.ts
- Delete: apps/api/src/joy-code-opt-in-http.test.ts
- Delete: apps/api/src/joy-code-production-runtime.ts
- Delete: apps/api/src/joy-code-production-runtime.test.ts
- Delete: apps/api/src/joy-code-runtime.ts
- Delete: apps/api/src/joy-code-runtime.test.ts
- Delete: apps/api/src/joy-code-runtime-config.ts
- Delete: apps/api/src/joy-code-runtime-config.test.ts
- Delete: apps/api/src/joy-code-runtime-factory.ts
- Delete: apps/api/src/joy-code-runtime-factory.test.ts
- Delete: apps/api/src/joy-code-secret-resolver.ts
- Delete: apps/api/src/joy-code-secret-resolver.test.ts
- Delete: apps/api/src/creative-brief-admission-gate.ts
- Delete: apps/api/src/creative-brief-admission-gate.test.ts
- Delete: apps/api/src/creative-brief-client-request-validation.ts
- Delete: apps/api/src/creative-brief-client-request-validation.test.ts
- Delete: apps/api/src/creative-brief-input-resolver.ts
- Delete: apps/api/src/creative-brief-input-resolver.test.ts
- Delete: apps/api/src/creative-brief-production-runtime.ts
- Delete: apps/api/src/creative-brief-production-runtime.test.ts
- Delete: apps/api/src/creative-brief-request-validation.ts
- Delete: apps/api/src/creative-brief-request-validation.test.ts
- Delete: apps/api/src/creative-brief-runtime.ts
- Delete: apps/api/src/creative-brief-runtime.test.ts
- Delete: apps/api/src/creative-brief-runtime-composition.ts
- Delete: apps/api/src/creative-brief-runtime-composition.test.ts
- Delete: apps/api/src/creative-brief-runtime-config.ts
- Delete: apps/api/src/creative-brief-runtime-config.test.ts
- Delete: apps/api/src/creative-brief-runtime-factory.ts
- Delete: apps/api/src/creative-brief-runtime-factory.test.ts
- Delete: apps/api/src/creative-brief-secret-resolver.ts
- Delete: apps/api/src/creative-brief-secret-resolver.test.ts
- Delete: apps/api/src/openrouter-systemd-credential-source.ts
- Delete: apps/api/src/openrouter-systemd-credential-source.test.ts
- Delete: apps/api/src/systemd-credential-secret-source.ts
- Delete: apps/api/src/systemd-credential-secret-source.test.ts

**Step 1: add endpoint-retirement tests**

Authenticated POST requests to the former Joy Code plan and Creative Brief AI
routes must return 410 Gone with a stable code pointing the browser to its
built-in engine. No secret resolver may be invoked. Existing non-AI project
sync, asset, job, render, and collaboration routes must remain unchanged.

**Step 2: remove browser methods and server runtime composition**

Remove plan/opt-in methods from BrowserControlPlaneClient and the matching
server runtime factories, resolvers, secret references, and admission gates.
Keep unrelated OpenRouter/media adapters if used outside these two agent paths.

**Step 3: keep database compatibility for one release**

Do not destructively drop consent columns in this task. Stop reading/writing
them and record their later additive-removal migration separately.

**Step 4: verify API regression**

```powershell
pnpm exec vitest run apps/api/src/http-server.test.ts apps/editor-web/src/control-plane-client.test.ts
pnpm --filter @joy-media/api build
pnpm --filter @joy-media/editor-web build
pnpm typecheck
```

Expected: all pass; retired routes return 410; no server model credential is
resolved by an editor agent request.

**Step 5: commit**

```powershell
git add -A apps/api/src apps/editor-web/src/control-plane-client.ts apps/editor-web/src/control-plane-client.test.ts
git commit -m "refactor(agent): retire server reasoning endpoints"
```

### Task 17: Add deterministic security, accessibility, and live-preview E2E

**Files:**

- Create: tests/e2e/fixtures/fake-openai-provider.ts
- Create: tests/e2e/agent-byok-security.spec.ts
- Create: tests/e2e/agent-live-presence.spec.ts
- Create: tests/e2e/agent-live-preview.spec.ts
- Modify: playwright.config.ts
- Modify: tooling/release/verify-joy-agent-worker.mjs
- Modify: package.json
- Modify: docs/OPEN_SOURCE_RELEASE.md

**Step 1: implement a route-backed test-only CORS provider**

The Playwright fixture intercepts the approved HTTPS provider origins and
supports deterministic streaming, one forced tool call, structured plan-only
output, auth failure, malformed tools, oversize body, slow response, redirect
attempt, cancellation, and measured usage. It controls CORS response headers
without adding a localhost exception to production URL policy. It records only
whether an Authorization header existed, never its value.

**Step 2: write the BYOK security E2E**

Use a sentinel endpoint, model, and key. After configure/run/Clear/reload:

- scan localStorage, sessionStorage, IndexedDB, Cache Storage, cookies, OPFS,
  project JSON, downloadable export, console messages, page errors, and JOY-
  origin requests;
- assert none contains any sentinel;
- assert only the fake provider origin saw Authorization;
- assert Clear, sign-out, provider change, fatal Worker error, and reload cause
  a new unconfigured session;
- assert redirects, CORS/network, timeout, oversize, malformed tool, and stale
  revision all fail closed with stable safe errors.

**Step 3: write live-presence and preview E2E**

With Follow off:

- focus remains in the composer;
- correct inactive Dock tab, nested section, and exact entity markers update
  from real events;
- no selected tab/layout changes.

With Follow on:

- the correct durable panel and nested section becomes visible;
- keyboard focus remains on the original input.

For preview:

- Program Monitor and real Timeline show validated staged edits;
- canonical project/history/storage/export remain unchanged before approval;
- Before shows canonical;
- Reject, Stop, error, and revision drift restore canonical;
- Approve creates one history entry and one Undo restores both timeline and
  document.

**Step 4: add reduced-motion, keyboard, axe, and screenshot assertions**

Run at desktop-minimum, desktop-1280, desktop-1581, and desktop-1920. Under
reduced motion, all agent animation names are none while static state remains.
Controls have accessible names; state is not color-only; phase live-region
announcements are throttled.

**Step 5: run the complete release gate**

```powershell
pnpm exec playwright test tests/e2e/agent-byok-security.spec.ts tests/e2e/agent-live-presence.spec.ts tests/e2e/agent-live-preview.spec.ts
pnpm verify:joy-agent-worker
pnpm verify:ci
```

Expected: all pass. A real-provider smoke test is optional/manual and must not
create a key-bearing trace, video, HAR, screenshot, log, or CI artifact.

**Step 6: update open-source readiness**

Record the measured Worker size, audit result, dependency notices, and the
remaining top-level third-party/license redistribution review. The
Fontiran-specific asset gate is closed by the 2026-09-05 Fontsource migration;
do not claim the complete app is publicly redistributable until the separate
whole-artifact owner/legal review is resolved.

**Step 7: commit**

```powershell
git add tests/e2e playwright.config.ts tooling/release/verify-joy-agent-worker.mjs package.json docs/OPEN_SOURCE_RELEASE.md
git commit -m "test(agent): gate BYOK and live preview release"
```

## Final acceptance checklist

- [x] AI SDK Worker spike passes size, browser, audit, and notice gates.
- [x] Provider connection fields exist only in the Worker session and clear on
      every required lifecycle event.
- [x] OpenRouter and custom HTTPS transport use the hardened exact-origin fetch.
- [x] Tool-loop and explicit plan-only modes work without provider/model fallback.
- [x] Worker has no mutation authority and receives no live EditorSession.
- [x] All proposals pass existing JOY validation, approval, revision, atomic
      command, and one-Undo boundaries.
- [x] Joy Code, Creative Brief, Asset AI, design, captions/audio, 3D, and media
      job requests use one engine client.
- [x] Every visible work cue comes from a real safe event or validated preview.
- [x] Program Monitor, Timeline, Inspector, assets, Brief, and 3D show truthful
      live states without focus stealing.
- [x] Reject/Stop/failure/timeout/revision drift restore canonical state exactly.
- [x] Product UI/runtime has no KiloCode, code-server, cloud planner, or local
      DSH identity/path.
- [x] Historical Kilo/joy-code-server provenance remains readable as legacy.
- [x] Retired server reasoning routes resolve no server model credentials.
- [x] Secret-leak, CORS, redirect, timeout, oversize, malformed-tool,
      accessibility, reduced-motion, visual, build, typecheck, test, lint,
      format, audit, and Worker-budget gates pass.
- [x] The 2026-09-05 migration replaced the bundled Fontiran assets with
      pinned OFL-1.1 Fontsource packages. Remaining third-party and login-gate
      asset licensing is tracked separately in THIRD_PARTY_NOTICES.md.
