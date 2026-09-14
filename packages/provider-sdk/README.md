# provider-sdk

> **Status: P03 minimum implemented.** Provider manifests, typed capability invocation, local Whisper-family executor seams, normalized word/speaker results, provenance, and typed unavailability errors are covered by tests. P05 extends this into the full provider system.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §21 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** AI/media capability contracts: manifests, capability requests, normalized results, provenance.

**First built in part:** P03 minimum, P05 full. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Provider-specific fields leaking into core schemas (§2.12); providers mutating projects (§21.9).

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.

## BYOK desktop migration additions (wave 3)

Two modules added for the JOY Media desktop migration's BYOK/JOY-Agent wave, both
host-agnostic (no `node:*`, `electron`, or `apps/*` imports) so they work the same from
`apps/desktop`'s Electron main process today or, if a future wave decides to, from a browser
Worker:

- `validation.ts` — `validateProviderProfileInput`: fails closed on an unsupported provider, an
  empty model id, or an insecure base URL (only `https://`, or `http://` to a loopback host).
  Field names (`provider`, `baseUrl`, `modelId`) mirror
  `apps/editor-web/src/joy-agent/protocol.ts`'s `ByokSessionConfig` deliberately.
- `adapters/openai-compatible.ts` — `probeOpenAiCompatibleProvider`: a dependency-injected
  connectivity probe (tiny synthetic request, never real content) that confirms a profile's
  credentials and base URL work, returning a redacted report that never contains the provider
  response body, endpoint, or credential.

Persistent, encrypted secret storage (Electron `safeStorage`/DPAPI) and the IPC surface that
uses these two modules live in `apps/desktop/src/main/secrets/` and
`apps/desktop/src/main/ipc-handlers.ts` — see that package's README.
