# WP-37 GPT OpenRouter Free Runtime Closeout Implementation Plan

> **For GPT Sol:** Use the test-driven-development skill and implement this plan task-by-task. Every implementation, review, VPS operation, and closeout step is a GPT task. Do not delegate any part of this plan to Mistral Vibe, Kilo Auto, Hermes, or another coding agent.

**Goal:** Safely activate JOY Media's read-only Creative Brief as an owner-consented, zero-payable-spend experimental feature using one explicitly pinned OpenRouter NVIDIA Nemotron free model, then close WP-37 only after local, VPS, browser, privacy, cost, rollback, and documentation gates pass.

**Architecture:** JOY Media calls OpenRouter directly from the server through the existing `@joy-media/adapter-openrouter` boundary. The product does not call Kilo's gateway and does not use a dynamic free-model router. A fixed free model, a versioned consent record, a systemd service credential, a fixed-origin Node transport, pre-egress policy guards, per-owner limits, post-response cost verification, and a fail-closed circuit breaker surround the existing canonical S1/S2 → S3 Creative Brief pipeline.

**Tech Stack:** TypeScript, Node.js 22 built-in `fetch`, Vitest, React, PostgreSQL 17, systemd credentials, pnpm workspaces, JOY Media immutable API/editor releases.

## Execution status (GPT-only, 2026-08-20)

Completed locally in the canonical repository through commit `8fb1c83`:

- Pinned `nvidia/nemotron-3-nano-30b-a3b:free`, canonical secret reference, zero spend, singleton allowlist, 30-second timeout, and versioned consent identifier.
- Confirmed the live unit name is `joy-media@api.service`; the startup credential source therefore targets `/run/credentials/joy-media@api.service/openrouter-api-key`.
- Enforced adapter pre-egress policy, bounded 256 KiB responses, exact model receipt, zero-cost usage receipt, and disabled provider fallback.
- Added fixed-origin OpenRouter transport, startup-only systemd credential source, owner/project admission gate, circuit breaker, request abort propagation, and explicit browser disclosure.
- Hardened runtime factory composition to remain unavailable for invalid or incomplete configuration.
- Added guarded server composition that reads only six explicit non-secret runtime keys and remains unavailable when mode/config/credential is absent.
- Verification: 402 focused tests pass across the final policy/runtime/HTTP/editor set; adapter/API/editor builds pass; `git diff --check` passes. Editor build emits only existing chunk-size warnings. The composition fixture was aligned with the pinned model and canonical secret reference in `8fb1c83`.
- Read-only VPS preflight (`ssh sweden`): API/Postgres/nginx active; deployed repo clean at `0287946`; service unit `joy-media@api.service` runs as `joy-media`; `/etc/joy-media/api.env` is `0600 root:root` and has no Creative Brief runtime keys; systemd is v257 and supports encrypted credentials.
- Repository-wide `pnpm check` remains red on the pre-existing editor-web typecheck backlog (panel runner/coordinator fixtures and related UI contracts); no unrelated cleanup was mixed into this work.

Still intentionally not executed: production server wiring, VPS credential provisioning, deployment, provider canary, browser live canary, rollback rehearsal, and WP-37 closeout. Those require a separately approved operational step and a real owner-controlled OpenRouter credential; no key has been read or placed in this workspace.

---

## 1. Locked decisions

These decisions are part of the implementation contract. A later agent must not silently reinterpret them.

| Decision                 | Chosen value                                                                                   | Reason                                                                                                                                                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product provider         | OpenRouter's OpenAI-compatible API, called directly by `@joy-media/adapter-openrouter`         | The repository already owns and tests this adapter. Kilo is an editor/gateway product, not JOY Media's runtime boundary.                                                                                                                                                             |
| Initial product model    | `nvidia/nemotron-3-nano-30b-a3b:free`                                                          | It is currently an explicit free OpenRouter variant, has enough context for the bounded semantic snapshot, and is materially faster than Nemotron 3 Ultra for an interactive brief. Reverify immediately before activation because free availability is time-sensitive.              |
| Dynamic routers          | Forbidden in the product: no `kilo-auto/free` and no `openrouter/free`                         | Their underlying model changes over time. `openrouter/free` also returns a different underlying response model, conflicting with the repository's exact model receipt. Dynamic routing weakens reproducibility, privacy disclosure, and model allowlisting.                          |
| Kilo Auto Free           | Development-agent convenience only                                                             | It may be used by a human running a coding agent, but it is not imported, configured, or called by JOY Media.                                                                                                                                                                        |
| Fallback                 | None                                                                                           | Provider/model failure is surfaced honestly. There is no paid model, alternate model, or hidden retry fallback.                                                                                                                                                                      |
| Spend policy             | Exactly zero payable spend                                                                     | Require `spendLimitUsdCents === 0`, an exact `:free` model, a dedicated OpenRouter key/guardrail restricted to that model where supported, and response `usage.cost === 0`. Any ambiguity fails closed.                                                                              |
| Privacy class            | Owner-only experimental use on non-confidential projects                                       | NVIDIA's free endpoint states that prompts and outputs are logged and may be used to improve products. The consent UI must say this plainly. Raw media bytes are never sent; semantic project text may still contain sensitive material.                                             |
| Secret reference         | `joy-media/openrouter/creative-brief/v1`                                                       | This is already the canonical opaque reference in the repository.                                                                                                                                                                                                                    |
| VPS secret storage       | systemd encrypted service credential named `openrouter-api-key`                                | Owner-approved source is the existing Hermes `OPENROUTER_API_KEY` entry, copied once into `/etc/credstore.encrypted/joy-media-openrouter-api-key.cred`; JOY never reads Hermes `.env` directly and the secret stays out of Git, `/etc/joy-media/api.env`, process listings, browser bundles, audit events, and normal logs. |
| Non-secret configuration | `/etc/joy-media/api.env`, mode `0600`                                                          | This is the existing JOY Media convention. It may contain mode, model ID, timeout, secret reference, and allowlist, but never the API key value.                                                                                                                                     |
| Timeout/output           | 30 seconds; 4,096 output tokens                                                                | A brief is interactive and bounded. Failure is preferable to an indefinitely slow free endpoint.                                                                                                                                                                                     |
| Rate/concurrency limit   | 3 requests/minute and 20 requests/day per authenticated owner; one in flight per owner/project | Fits OpenRouter's low free-tier limits, limits abuse, and makes accidental request storms harmless.                                                                                                                                                                                  |
| Activation               | Disabled deployment first, then one explicit owner-approved canary                             | Code deployment and provider activation are separate reversible events.                                                                                                                                                                                                              |

### External facts that must be reverified at activation

- OpenRouter documents `openrouter/free` as a random free-model router; it is intentionally not selected here.
- Kilo documents `kilo-auto/free` as a server-updated dynamic mapping and warns that Auto Free may route to providers that log prompts/outputs.
- OpenRouter currently lists `nvidia/nemotron-3-nano-30b-a3b:free` as free, with NVIDIA as the free provider.
- OpenRouter/NVIDIA currently warn that the free endpoint is trial use, logs prompts and outputs, and should not receive personal, confidential, or business-critical data.
- OpenRouter non-streaming responses currently include `usage.cost`; this field is required by this plan's acceptance policy.

Primary references:

- https://openrouter.ai/docs/guides/routing/routers/free-router
- https://openrouter.ai/nvidia/nemotron-3-nano-30b-a3b%3Afree
- https://openrouter.ai/docs/cookbook/administration/usage-accounting
- https://openrouter.ai/docs/guides/routing/provider-selection
- https://kilo.ai/docs/code-with-ai/agents/auto-model

---

## 2. Starting state and known gaps

Start from canonical repository `C:/Users/HadiMoti/joy-vps/joy-media-fix`, branch `main`, commit `a00e011` or its reviewed descendant, with a clean worktree.

Already complete:

- S1 semantic snapshot and S2 deterministic intelligence.
- S3 validated read-only Creative Brief contract.
- async adapter/runtime contracts, OpenRouter codec/decoder, exact model allowlist, cancellation, timeout, redacted errors, and injected test transport.
- canonical server-side input resolver, owner/project opt-in, browser hydration, panel, and fail-closed HTTP route.
- runtime factory/composition tests and HTTP tests proving injected runtime success plus default unavailability.

Gaps that this plan must close:

1. `spendLimitUsdCents` is passed through but is not presently enforced by `@joy-media/adapter-openrouter`.
2. The adapter accepts arbitrary allowlisted IDs; the parser does not require `:free` or the canonical secret reference.
3. The adapter performs unbounded `response.json()` and does not validate `usage.cost`.
4. No production fixed-origin HTTP transport exists.
5. No production bootstrap maps the opaque secret reference to a systemd credential.
6. No per-owner Creative Brief rate/concurrency limiter or cost circuit breaker exists.
7. The current boolean opt-in does not record which third-party data-handling disclosure was accepted.
8. The panel's current consent text does not disclose external processing or NVIDIA's free-endpoint logging.
9. `apps/api/src/server.ts` intentionally leaves `creativeBriefRuntime` unavailable.
10. No live provider canary, immutable deployment, browser evidence, rollback proof, or WP-37 closeout exists.

---

## 3. Execution rules

- GPT Sol owns every task and review. Do not create Mistral prompts.
- Use a clean worktree before each task. Preserve unrelated changes and stop if another task has modified the same files.
- Test first: commit only after the focused test, relevant package build, and `git diff --check` pass.
- Never print, log, diff, paste, or commit the OpenRouter key.
- Never use a real key in unit/integration tests. Real-network work is reserved for the explicit VPS canary task.
- Never place the key in `/etc/joy-media/api.env`; it contains non-secret configuration only.
- Do not enable `openrouter/free`, `kilo-auto/free`, a paid model, model fallbacks, or automatic retries.
- Do not send raw media, asset bytes, filesystem paths, object-store references, signed URLs, browser tokens, or provider credentials.
- A provider response is not accepted unless project/revision validation, output validation, exact model receipt, and zero-cost receipt all pass.
- If a production gate fails, disable Creative Brief first. Restore the prior immutable release only if code or health is implicated.
- Do not mark WP-37 complete while the feature is only locally tested or while the provider remains unavailable.

---

## 4. GPT task sequence

### GPT-01: Freeze policy constants and configuration validation

**Objective:** Make impossible configurations fail closed before secret resolution or transport.

**Files:**

- Modify: `apps/api/src/creative-brief-runtime-config.ts`
- Modify: `apps/api/src/creative-brief-runtime-config.test.ts`
- Modify: `apps/api/src/creative-brief-secret-resolver.ts`
- Modify: `apps/api/src/creative-brief-secret-resolver.test.ts`

**Required contract:**

```ts
export const CREATIVE_BRIEF_MODEL_ID = 'nvidia/nemotron-3-nano-30b-a3b:free' as const;
export const CREATIVE_BRIEF_SECRET_REFERENCE = 'joy-media/openrouter/creative-brief/v1' as const;
export const CREATIVE_BRIEF_CONSENT_VERSION = 'openrouter-nvidia-free-logging-v1' as const;
```

The enabled parser must require all of the following:

- mode is exactly `openrouter`;
- `MODEL_ID` equals `CREATIVE_BRIEF_MODEL_ID`;
- allowlist is exactly one entry and equals the same model;
- model ends with `:free`;
- spend limit is exactly `0`, not merely within `0..10000`;
- secret reference equals `CREATIVE_BRIEF_SECRET_REFERENCE`;
- timeout is `1000..30000`, with deployment value `30000`;
- unknown prefixed keys still disable the runtime.

**TDD steps:**

1. Add failing tests for paid ID, dynamic router, wrong Nemotron ID, nonzero spend, wrong secret reference, multiple allowlist entries, duplicate/blank entries, timeout above 30 seconds, and the exact valid configuration.
2. Run:

   ```powershell
   pnpm exec vitest run apps/api/src/creative-brief-runtime-config.test.ts apps/api/src/creative-brief-secret-resolver.test.ts
   ```

3. Implement the smallest validation change.
4. Run the focused tests and `pnpm --filter @joy-media/api build`.
5. Run `git diff --check`.
6. Commit only these files:

   ```text
   joy-media(WP-37): Lock free Creative Brief runtime policy
   ```

**Acceptance:** No configuration can opt into a paid, dynamic, differently logged, or differently referenced model.

### GPT-02: Enforce zero-cost and bounded response handling in the adapter

**Objective:** Reject ambiguous cost/model receipts and prevent oversized provider responses.

**Files:**

- Modify: `packages/adapter-openrouter/src/index.ts`
- Modify: `packages/adapter-openrouter/src/index.test.ts`

**Required behavior:**

- Reject before secret resolution when configured or request spend limit is not exactly zero.
- Treat a missing `allowedFreeModelIds` option as policy denial; the adapter must never interpret an omitted allowlist as allow-all.
- Require the adapter allowlist to contain exactly the pinned model for this runtime.
- Keep exact request model and exact provider-reported model equality.
- Require a well-formed non-streaming `usage` object with finite nonnegative integer token counts and finite `cost === 0`.
- Reject missing, malformed, negative, non-finite, or nonzero cost as `provider-failed` with redacted stable codes.
- Read at most 256 KiB of response JSON. Reject a larger `Content-Length` before reading and abort a streamed body that crosses the limit.
- Never include response text, prompt text, key values, URLs, or headers in errors/audit events.
- Reduce `MAX_OUTPUT_TOKENS` from 8,192 to 4,096.
- Add provider routing fields that disable provider fallback and require support for requested parameters. Do not claim zero data retention; the selected free NVIDIA endpoint logs data.
- Emit a separate redacted usage receipt only after model/cost/usage validation. It may contain correlation ID, adapter/model ID, prompt/completion/total token counts, zero cost, and duration; it must never contain prompt/output text, headers, key values, project text, or provider bodies.

Suggested stable codes:

```ts
'OPENROUTER_NONZERO_SPEND_POLICY';
'OPENROUTER_USAGE_MISSING';
'OPENROUTER_USAGE_INVALID';
'OPENROUTER_NONZERO_COST';
'OPENROUTER_RESPONSE_TOO_LARGE';
```

**TDD steps:**

1. Add failing tests for each outcome and prove secret resolver/transport call counts remain zero for pre-egress denial.
2. Add fragmented-stream tests around the 256 KiB boundary.
3. Add a valid receipt fixture with exact model, valid structured output, token counts, and `cost: 0`.
4. Run:

   ```powershell
   pnpm exec vitest run packages/adapter-openrouter/src/index.test.ts
   pnpm --filter @joy-media/adapter-openrouter build
   ```

5. Run `git diff --check` and commit:

   ```text
   joy-media(WP-37): Enforce zero-cost OpenRouter receipts
   ```

**Acceptance:** An accepted brief has an exact pinned model receipt and a parseable zero-cost usage receipt; all ambiguous responses fail closed.

### GPT-03: Add the fixed-origin Node HTTP transport

**Objective:** Provide one audited server transport without giving the adapter general-purpose egress.

**Files:**

- Create: `apps/api/src/openrouter-http-transport.ts`
- Create: `apps/api/src/openrouter-http-transport.test.ts`
- Modify: `apps/api/src/index.ts`

**Required boundary:**

```ts
export interface OpenRouterFetch {
  (input: string, init: RequestInit): Promise<Response>;
}

export function createOpenRouterHttpTransport(
  fetchImpl: OpenRouterFetch = globalThis.fetch,
): HttpPostTransport;
```

The transport must:

- allow only `POST https://openrouter.ai/api/v1/chat/completions`;
- reject credentials in the URL and reject every other origin/path/protocol;
- set `redirect: 'error'` so authorization cannot follow a redirect;
- accept only JSON request bodies and the adapter's abort signal;
- use injected fetch in tests and make zero real network calls;
- return redacted typed failures without echoing URL/body/header values.

**TDD steps:** Write failing origin/method/redirect/signal tests, implement, run the test, run API build, diff-check, then commit:

```text
joy-media(WP-37): Add fixed OpenRouter server transport
```

### GPT-04: Add a systemd credential bootstrap boundary

**Objective:** Resolve the canonical opaque secret reference from one service credential while keeping the key out of environment configuration.

**Files:**

- Create: `apps/api/src/creative-brief-credential-bootstrap.ts`
- Create: `apps/api/src/creative-brief-credential-bootstrap.test.ts`
- Modify: `apps/api/src/creative-brief-secret-resolver.ts` documentation only as needed to distinguish pure resolver logic from the trusted bootstrap edge
- Modify: `apps/api/src/index.ts`
- Modify: `deploy/joy-media-api.override.conf`
- Modify: `deploy/README.md`

**Required boundary:**

```ts
export interface CredentialReader {
  readUtf8(path: string): string;
}

export function createSystemdCreativeBriefSecretSource(options: {
  readonly credentialsDirectory: string | undefined;
  readonly reader: CredentialReader;
}): SecretSource;
```

Rules:

- map only `joy-media/openrouter/creative-brief/v1` to credential file name `openrouter-api-key`;
- reject missing/relative/empty credential directory;
- trim one trailing line ending only; reject blank or multiline credentials;
- cap credential bytes to a small bound such as 512 bytes;
- catch read failures and return `undefined` without path/error disclosure;
- do not cache, stringify, log, or expose the secret;
- use an injected reader in tests;
- only `server.ts` may construct the real Node filesystem reader.

Add a reviewed systemd line:

```ini
LoadCredentialEncrypted=openrouter-api-key:/etc/credstore.encrypted/joy-media-openrouter-api-key.cred
```

Do not install this line on the VPS until GPT-10 verifies systemd support. If unsupported, document the fallback `LoadCredential=` source with root ownership and mode `0400`.

**Verification:** focused credential/bootstrap tests, API build, `git diff --check`.

**Commit:**

```text
joy-media(WP-37): Add systemd Creative Brief credential boundary
```

### GPT-05: Add owner rate limits, concurrency guard, and circuit breaker

**Objective:** Bound free-tier usage and stop repeated provider calls after a policy receipt failure.

**Files:**

- Create: `apps/api/src/creative-brief-runtime-guard.ts`
- Create: `apps/api/src/creative-brief-runtime-guard.test.ts`
- Modify: `apps/api/src/http-server.ts`
- Modify: `apps/api/src/http-server.test.ts`

**Required behavior:**

- key limits by authenticated `actor.id`; concurrency by `actor.id + projectId`;
- permit at most 3 starts in a rolling minute and 20 starts in a rolling day;
- permit one in-flight request per owner/project;
- perform the guard after authentication, ownership, opt-in, and envelope validation but before canonical input resolution and runtime execution;
- return `429 RATE_LIMITED` with a bounded `Retry-After` for rate limits;
- return `409 CREATIVE_BRIEF_IN_PROGRESS` for duplicate concurrency;
- always release concurrency in `finally` for success, validation failure, timeout, cancellation, and thrown error;
- bind request/socket disconnect to an `AbortController` so a disconnected browser cancels the in-flight provider request and releases concurrency;
- open a process-local circuit on `OPENROUTER_NONZERO_COST`, model mismatch, invalid/missing usage, or impossible policy configuration;
- while open, return `503 RUNTIME_POLICY_DISABLED` without resolving a secret or calling transport;
- only an API restart or explicit injected test reset closes the initial breaker; do not add an unauthenticated reset route.

Use an injected clock and no sleeps in tests.

**Verification:** guard tests, Creative Brief HTTP-route tests, API build, diff-check.

**Commit:**

```text
joy-media(WP-37): Guard Creative Brief provider usage
```

### GPT-06: Version the external-processing consent

**Objective:** Record informed consent to the exact free-provider disclosure rather than a timeless boolean.

**Files likely to change:**

- Modify: `apps/api/src/postgres-schema.ts`
- Modify: `apps/api/src/postgres-schema.test.ts`
- Modify: `apps/api/src/control-plane.ts`
- Modify: `apps/api/src/control-plane.test.ts`
- Modify: `apps/api/src/postgres-control-plane.ts`
- Modify: `apps/api/src/postgres-control-plane.test.ts`
- Modify: `apps/api/src/http-server.ts`
- Modify: `apps/api/src/http-server.test.ts`
- Modify: `apps/editor-web/src/control-plane-client.ts`
- Modify: `apps/editor-web/src/control-plane-client.test.ts`
- Modify: `apps/editor-web/src/creative-brief-opt-in-coordinator.ts`
- Modify: `apps/editor-web/src/creative-brief-opt-in-coordinator.test.ts`

**Persisted shape:**

```ts
interface CreativeBriefConsent {
  readonly enabled: boolean;
  readonly version?: typeof CREATIVE_BRIEF_CONSENT_VERSION;
  readonly acceptedAt?: string;
}
```

Add nullable `creative_brief_consent_version` and `creative_brief_consent_at` columns. Existing rows and old `true` booleans must read as disabled until the current version is explicitly accepted. Disabling clears or retires active consent without deleting historical audit evidence if the schema already has an appropriate audit mechanism; do not invent a broad new event system in this task.

The API accepts only the current server constant, never an arbitrary browser-supplied version. Preserve owner isolation and revision CAS behavior.

**Verification:** focused schema/control-plane/HTTP/client/coordinator tests, API and editor builds, diff-check.

**Commit:**

```text
joy-media(WP-37): Version Creative Brief external consent
```

### GPT-07: Make the consent UI truthful

**Objective:** Obtain informed owner consent before semantic project text can leave JOY Media.

**Files:**

- Modify: `apps/editor-web/src/CreativeBriefPanel.tsx`
- Modify: `apps/editor-web/src/CreativeBriefPanel.test.tsx`
- Modify: `apps/editor-web/src/app.css`

**Required disclosure, in plain language:**

- Creative Brief sends a semantic summary and the typed request to OpenRouter and NVIDIA;
- raw audio/video/image bytes are not sent;
- captions, brand text, and project descriptions may be included;
- the selected free NVIDIA trial endpoint logs prompts and outputs and may use them to improve its services;
- do not enable it for personal, confidential, client-confidential, or business-critical material;
- the feature is read-only and recommendations are not automatically applied;
- consent can be disabled per project.

Require an unchecked confirmation control plus an explicit enable button. Do not infer consent from opening the panel or typing. Keep Persian/RTL rendering intact and keyboard/screen-reader behavior accessible.

**Verification:** focused panel tests, editor build, diff-check.

**Commit:**

```text
joy-media(WP-37): Disclose free-provider Creative Brief processing
```

### GPT-08: Compose the production runtime, still disabled by default

**Objective:** Wire all dependencies at the trusted server bootstrap without changing default behavior.

**Files:**

- Create: `apps/api/src/creative-brief-production-runtime.ts`
- Create: `apps/api/src/creative-brief-production-runtime.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/index.ts`

**Required composition:**

```ts
composeCreativeBriefProductionRuntime({
  env: explicitCreativeBriefEnv,
  credentialsDirectory: process.env.CREDENTIALS_DIRECTORY,
  credentialReader,
  transport: createOpenRouterHttpTransport(),
  guard,
  auditSink,
  usageSink,
});
```

`server.ts` may read only the six known non-secret `JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_*` keys into a fresh object; do not spread all of `process.env`. The secret value comes only from the service credential.

Composition returns `DEFAULT_CREATIVE_BRIEF_RUNTIME` when disabled, incomplete, malformed, unsupported, missing a credential, or missing a dependency. Startup and `/health` remain available when Creative Brief is disabled. Do not resolve the credential at module import time.

Tests must cover disabled startup, enabled-with-missing-credential, valid fully injected composition, no unknown environment forwarding, no eager provider request, and redacted failures.

**Verification:** production-runtime, runtime-composition/factory, secret, transport, HTTP tests; API build; diff-check.

**Commit:**

```text
joy-media(WP-37): Compose guarded Creative Brief runtime
```

### GPT-09: Run the complete local release gate

**Objective:** Prove the candidate locally with zero external calls.

**No production code changes unless a failing gate identifies a scoped defect.**

Run at minimum:

```powershell
pnpm exec vitest run packages/adapter-openrouter/src/index.test.ts
pnpm exec vitest run apps/api/src/creative-brief-runtime-config.test.ts apps/api/src/creative-brief-secret-resolver.test.ts apps/api/src/creative-brief-credential-bootstrap.test.ts apps/api/src/openrouter-http-transport.test.ts apps/api/src/creative-brief-runtime-guard.test.ts apps/api/src/creative-brief-runtime-factory.test.ts apps/api/src/creative-brief-runtime-composition.test.ts apps/api/src/creative-brief-production-runtime.test.ts apps/api/src/http-server.test.ts
pnpm exec vitest run apps/editor-web/src/CreativeBriefPanel.test.tsx apps/editor-web/src/creative-brief-opt-in-coordinator.test.ts apps/editor-web/src/control-plane-client.test.ts
pnpm --filter @joy-media/adapter-openrouter build
pnpm --filter @joy-media/api build
pnpm --filter @joy-media/editor-web build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm audit:prod
git diff --check
```

Record exact totals and separate genuinely pre-existing failures from candidate regressions. Do not wave through a new failure.

If a repair is needed, use a separate narrow commit. Otherwise create no empty verification commit.

### GPT-10: Prepare the dedicated OpenRouter credential and VPS preflight

**Objective:** Prepare a reversible activation without changing the running release.

**Authority gate:** This task requires the owner's OpenRouter account access and explicit authorization to install a VPS credential. Never request the key in chat or print it in terminal output.

**OpenRouter key policy:**

- dedicated key name: `joy-media-creative-brief-free-v1`;
- no management key on the VPS;
- restrict the key/guardrail to `nvidia/nemotron-3-nano-30b-a3b:free` where the account supports model allowlists;
- configure a zero-dollar limit if OpenRouter confirms free requests remain usable with that setting; otherwise stop and document the platform limitation rather than silently assigning a positive budget;
- disable paid fallbacks and auto top-up for this key;
- record only key label/hash/expiry and policy metadata, never plaintext.

**Read-only VPS preflight:**

```bash
systemd --version
systemctl cat joy-media@api
systemctl show joy-media@api -p User -p Group -p FragmentPath -p DropInPaths -p EnvironmentFiles
readlink -f /opt/joy-media/releases/current-api
readlink -f /opt/joy-media/web
systemctl is-active joy-media@api postgresql nginx
curl -fsS http://127.0.0.1:8790/health
```

Take a PostgreSQL backup and record its path/hash before schema migration. Verify disk/RAM headroom, port `8790`, current source/release SHAs, public health, `nginx -t`, and rollback targets.

Provision the credential through `systemd-creds encrypt -H` without echoing it. If encrypted credentials are unsupported, stop for review before using the root-owned `0400` fallback. Do not change the active service or enable runtime in this task.

### GPT-11: Deploy the code and migration with runtime disabled

**Objective:** Prove the new code and consent migration in production while provider egress remains impossible.

1. Push the reviewed source commit through the canonical repository flow.
2. Build a new immutable API/editor artifact with the frozen lockfile.
3. Apply only the additive consent migration after the backup.
4. Keep `JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_MODE=disabled`.
5. Install the reviewed systemd override only after `systemd-analyze verify` passes.
6. Switch immutable pointers, restart `joy-media@api`, and verify direct/public health, authentication, project load, opt-in read/write, and the expected `503` unavailable Creative Brief result.
7. Verify no request reached OpenRouter and no secret appears in service environment, logs, process arguments, built assets, or HTTP responses.
8. Retain prior API/editor releases and the database backup.

Rollback immediately on migration, health, authentication, owner-isolation, or public-asset mismatch.

### GPT-12: Activate one sanitized canary

**Objective:** Prove exactly one real, zero-cost, revision-bound brief before broader owner use.

**Preconditions:** Owner approval, credential installed, OpenRouter key policy verified, current model page still says free, provider terms rechecked, and a disposable non-confidential project prepared with synthetic captions/brand data.

Non-secret configuration:

```dotenv
JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_MODE=openrouter
JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_MODEL_ID=nvidia/nemotron-3-nano-30b-a3b:free
JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_TIMEOUT_MS=30000
JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_SPEND_LIMIT_USD_CENTS=0
JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_SECRET_REF=joy-media/openrouter/creative-brief/v1
JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_ALLOWED_FREE_MODEL_IDS=nvidia/nemotron-3-nano-30b-a3b:free
```

Activation sequence:

1. Restart API with the enabled non-secret configuration and credential.
2. Verify health before opening the panel.
3. Confirm the disposable project is opted out and no call occurs.
4. Read and accept the versioned disclosure for that project only.
5. Submit one small Persian/English Creative Brief request.
6. Verify response project/revision, schema, exact reported model, `usage.cost === 0`, bounded tokens/duration, no auto-applied edit, and clean console/network logs.
7. Verify the request contains semantic JSON only and no raw asset bytes, local paths, URLs, tokens, or secrets.
8. Exercise immediate second-call concurrency denial and the configured rate limit using fake/local tests only; do not burn live free requests merely to test limits.
9. Disable the project opt-in after the canary and confirm further runs are blocked.

On nonzero/missing cost, wrong model, missing usage, provider logging-policy drift, unexpected redirect, invalid output, or secret leakage: set mode to `disabled`, restart, verify health/unavailability, revoke the key if exposure is suspected, and stop.

### GPT-13: Signed-in browser gate, rollback proof, and cleanup

**Objective:** Establish honest user-facing evidence without leaving disposable state.

- Test at `https://joyst.ir`, not the legacy redirect hostname.
- Verify persisted versioned consent, exact disclosure text, keyboard access, Persian/RTL input, loading/error/stale states, revision mismatch protection, read-only recommendations, opt-out, and reload behavior.
- Confirm browser traffic is same-origin JOY Media only; the browser must never call OpenRouter directly.
- Confirm no console warnings/errors and no provider response metadata leaks into UI.
- Perform the immutable-release rollback drill: restore prior API/editor pointers, restart/health check, then restore the candidate and repeat health checks.
- Remove the disposable project and canary consent; retain only redacted evidence, release IDs, hashes, token counts, zero-cost fact, and rollback references.

### GPT-14: Close WP-37 honestly

**Objective:** Reconcile plans, state, evidence, and GBrain only after every acceptance gate passes.

**Files:**

- Modify: `plan/WP-37-ai-creative-os-foundation.md`
- Modify: `plan/S4-RUNTIME-ADAPTER-DESIGN-2026-08-18.md`
- Modify: `STATE.md`
- Create or update a focused redacted QA receipt under `docs/qa/wp37/`

Required record:

- source commit and immutable API/editor releases;
- exact model ID and consent version;
- OpenRouter key label/hash only, never plaintext;
- local test/build totals;
- migration backup and rollback targets;
- direct/public health and browser evidence;
- exact model receipt and zero-cost receipt;
- rate/concurrency/circuit-breaker evidence;
- cleanup and opt-out evidence;
- provider limitation: free NVIDIA trial endpoint logs prompts/outputs and is not suitable for confidential or business-critical material.

GBrain may be updated only through its reviewed API after health/backup checks and without upgrading, migrating, or enabling retrieval-reflex. If that operational gate is unavailable, record the blocker and keep WP-37 open rather than claiming completion.

Final documentation commit:

```text
joy-media(WP-37): Close guarded Creative Brief foundation
```

---

## 5. Acceptance matrix

| Gate           | Required evidence                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default safety | Missing/invalid config, missing credential, missing transport, stale revision, opt-out, or open circuit produces no provider call.                |
| Model          | Request and response identify exactly `nvidia/nemotron-3-nano-30b-a3b:free`; dynamic routers and fallbacks are absent.                            |
| Cost           | Pre-egress configuration is zero-only and exact-`:free`; accepted live response reports `usage.cost === 0`; dedicated key cannot use paid models. |
| Privacy        | Versioned consent explicitly discloses semantic text transfer and NVIDIA logging; raw assets and forbidden data never leave JOY Media.            |
| Secret         | Key exists only as a dedicated OpenRouter credential delivered by systemd; no Git/env/log/browser/process exposure.                               |
| Transport      | Exact HTTPS origin/path, POST-only, redirects rejected, abort/timeout enforced, response capped at 256 KiB.                                       |
| Abuse          | 3/minute, 20/day per owner, one concurrent owner/project call, and policy circuit breaker verified.                                               |
| Correctness    | Canonical persisted revision → S1 snapshot → S2 intelligence → model output → S3 validated brief; project/revision mismatch rejected.             |
| UX             | Opt-in is explicit and durable; output is read-only; Persian/RTL and accessibility pass; opt-out blocks future calls.                             |
| Operations     | Immutable disabled-first deploy, backup, migration, health, public parity, signed-in canary, rollback/restore, and cleanup all pass.              |
| Documentation  | Plan, STATE, QA receipt, release identifiers, and GBrain agree; limitations remain visible.                                                       |

WP-37 is closed only when every row passes. If the free-model terms, availability, response receipt, or zero-cost controls cannot meet this matrix, leave the runtime disabled and record WP-37 as blocked rather than substituting a paid or dynamic model.

---

## 6. Risk register

| Risk                                                | Mitigation                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Free model disappears or changes terms              | Reverify immediately before activation; fail closed; no automatic substitution.                                    |
| NVIDIA logs sensitive semantic text                 | Versioned explicit consent, non-confidential-only warning, semantic-only payload, owner-only canary, easy opt-out. |
| `spendLimitUsdCents` creates false confidence       | Enforce zero in parser and adapter, exact `:free` suffix, dedicated key guardrail, verify response cost.           |
| Provider returns a different model                  | Exact response-model equality and circuit breaker.                                                                 |
| Provider sends a huge/malformed body                | 256 KiB cap and schema validation before acceptance.                                                               |
| Authorization follows redirect                      | Fixed HTTPS origin and `redirect: 'error'`.                                                                        |
| Key leaks through environment/logs                  | systemd credential, opaque reference, fixed redacted errors, no debug body/header logging.                         |
| Free-tier request storm                             | Per-owner minute/day limits and per-project concurrency lock.                                                      |
| Process restart clears in-memory limits/breaker     | Acceptable for the owner-only experimental phase; revisit durable limits before multi-user/general availability.   |
| Trial endpoint is unsuitable for production         | Label the feature experimental and non-confidential; do not describe it as business-critical production AI.        |
| Boolean legacy opt-in silently authorizes new terms | Versioned consent invalidates all old opt-ins until reaccepted.                                                    |

## 7. Explicitly deferred

- Paid models or paid fallbacks.
- `openrouter/free`, `kilo-auto/free`, or any dynamic model router in the JOY Media runtime.
- General multi-user launch.
- Raw image/video/audio transfer to a model.
- Automatic application of Creative Brief recommendations.
- Durable cross-instance rate limiting and provider analytics dashboard.
- Provider-agnostic model failover.
- GBrain upgrades, migrations, or retrieval-reflex changes.
