# JOY Live Director R2 — P1: cold-session Living Look discoverability (2026-09-09)

**Package:** P1 — plan §4 P1 ("Close the real cold-session agent discoverability
gap, if confirmed") / P0-R1 provenance report §9.

**This is not product acceptance, technical acceptance, or deployment approval.**
External GPT-6 Astra's candidate-specific
`APPROVE_FOR_DEPLOY <sha> <tree> <lock-sha256>` and the owner's separate
deployment go-ahead remain mandatory and unmet.

---

## 1. Verdict

**GAP CONFIRMED AND FIXED.**

A fresh JOY-agent session that reopens a saved project with applied Living Looks
could **not**, before this change, discover any applied-Look state through the
host tools. It had no way to obtain a Look instance id, its pinned pack
id/version, its entity bindings, its orphan/missing-target state, or its
overrides — so `look_update` / `look_reset_overrides` / `look_detach` were
effectively unreachable without a raw `look-…` token supplied out of band
(prior chat memory or the owner typing an id). The authoritative _revision_
was already discoverable (`read_project_context` `overview.revision`); nothing
else about applied Looks was.

The fix adds a bounded, project-scoped **`looks`** context domain to the
existing `read_project_context` host tool, sourced from the reopened canonical
`LookInstancesDocument`, threaded through the existing context builder /
snapshot / paged-context / host-page path with the existing pagination,
omission, redaction and byte-limit rules. `overview` gained
`lookInstanceCount` / `orphanedLookInstanceCount` so the domain is discoverable
without prior context. No new agent architecture, project-schema migration, or
parallel mutation API. Mutations still run through
`resolveLivingLookRun` → `stageLookRun`/`stageLookInstancesOnly` →
`validate_proposal` staging → operator approval → `JoyCodeCompoundRunner`,
with the existing revision/lease/approval/compound-Undo machinery unchanged.

---

## 2. Session identity, interval, branch, worktree

|                                      |                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| Implementer session                  | Claude Code (`claude-sonnet-5`), single interactive session                                  |
| UTC interval                         | ~2026-09-09T19:49Z – ~2026-09-09T20:15Z                                                      |
| Branch                               | `codex/joy-r2-p1-discovery-20260909T194904Z`                                                 |
| Worktree                             | `C:\Users\HadiMoti\joy-r2-p1-20260909T194904Z`                                               |
| Accepted parent (base)               | `d0d5cad2cd9904c1716c3b30eeb3b02f9a2e41fd` / tree `3d02abdfa61e20a4665ab08db4659e9a87fe4717` |
| Application baseline beneath P0 docs | `d01770b1eafeb10f9cc0386ca3122d8314a4ee90`                                                   |
| Evidence root (P1, new)              | `C:\Users\HadiMoti\Desktop\joy-r2-p1-evidence-20260909T194904Z\`                             |
| Push state                           | **not pushed** (local scoped commit only)                                                    |

Concurrent work preserved — untouched, not copied/adopted/run/staged:

- `C:\Users\HadiMoti\.config\superpowers\worktrees\joy-media\joy-live-director\apps\editor-web\src\looks-encoded-sample-acceptance.test.ts`
  (untracked in that worktree; absent from this tree by construction).
- P0 evidence roots `…\joy-r2-p0-evidence-20260909T185139Z\` and
  `…\joy-r2-p0-r1-evidence-20260909T192442Z\` — not read for write, unchanged.
- All other worktrees' `node_modules` / `dist` — untouched; this worktree ran
  its own isolated `pnpm install --frozen-lockfile` (lock bytes preserved) and
  its own `tsc -b` emit.

---

## 3. Base → result

|                                                             |                                                                                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Base SHA / tree                                             | `d0d5cad2cd9904c1716c3b30eeb3b02f9a2e41fd` / `3d02abdfa61e20a4665ab08db4659e9a87fe4717`                                     |
| Result SHA / tree                                           | _filled in the return report after commit (a commit cannot contain its own hash)_                                           |
| `pnpm-lock.yaml` — git blob @ base                          | `bcf36b0d24e24d55305898e783b4813723e22d90`                                                                                  |
| `pnpm-lock.yaml` — raw SHA-256 (unchanged, base and result) | `c9e147f8f56265b5e53e64800c1f691d67675ac2618434bfc821f666176b88aa` (133 132 B)                                              |
| Lock modified?                                              | **No.** `pnpm install --frozen-lockfile` reported "Lockfile is up to date"; raw SHA-256 identical before and after install. |

The lock identity remains the D-03 baseline value `c9e147f8…` (which is **not**
the frozen-CI lock `36426937…`). No dependency added or changed.

---

## 4. Source-path map and root cause

### 4.1 The persistence → hydration → context → host → tool-contract → mutation chain (as traced)

1. **Persistence / hydration.**
   `apps/editor-web/src/editor-session.ts` — `#lookInstancesPersistence`
   (`LocalProjectPersistence<LookInstancesDocument>`), `recoverLookInstancesOrEmpty`
   on construction → `session.lookInstances` (canonical, hydrated from its own
   log), `#lookInstancesRevision` recovered and folded into
   `session.projectRevisionId` (`get projectRevisionId()`), and
   `get orphanedLookInstanceIds()` computed from live visual objects.
   Round-trip proven by `editor-session-look-instances.test.ts` (unchanged).
2. **Context construction.**
   `apps/editor-web/src/joy-agent/context-input.ts` — `buildJoyAgentContextInput(session)`
   built `projectId / revision / tracks / clips / assets / visualObjects /
conversation / entity-refs`. **It never read `session.lookInstances`.**
3. **Snapshot / paged context.**
   `apps/editor-web/src/joy-agent/context-snapshot.ts` —
   `createJoyAgentContextSnapshot` / `createJoyAgentPagedContext`. No look field.
4. **Host response.**
   `apps/editor-web/src/joy-agent/tool-bridge.ts` — `read_project_context`
   (`createJoyAgentHostRpcMethods` → `pageForContext`). `HOST_CONTEXT_DOMAINS =
[overview, brief, tracks, clips, assets, visual-objects, titles]` — **no
   `looks`**; `overview` reported no look counts.
5. **Worker-visible tool contract.**
   `apps/editor-web/src/joy-agent/bounded-tool-loop.ts` — `READ_PROJECT_CONTEXT_TOOL`
   `domain` enum had no `looks`. `LOOK_UPDATE_TOOL` / `LOOK_RESET_OVERRIDES_TOOL`
   / `LOOK_DETACH_TOOL` require `instanceId` matching `^look-…$` (and reset
   requires `bindingIds`) with no discoverable source.
6. **Mutation input.**
   `apps/editor-web/src/joy-agent/look-tool-bridge.ts` (`parseLook*Args`) →
   `apps/editor-web/src/joy-agent/living-look-run.ts` (`resolveLivingLookRun`)
   looks up `session.lookInstances.instances[request.instanceId]` — an unknown
   id returns `{ kind: 'blocked', reason: 'unknown-instance' }`.
7. **Scoped agent run.**
   `apps/editor-web/src/joy-agent/look-scoped-host.ts` (`runScopedLookToolLoop`)
   builds the look-scoped host from `buildContextInput(scope)` +
   `createJoyAgentPagedContext` + `createJoyAgentHostRpcMethods` — inheriting the
   same gap. Allow-list is `read_project_context` + the four `look_*` tools.

**Only** channel by which an instance id reached the agent: `AgentPanel.tsx`
appends staged instance ids to the **conversation thread text** after a Look run
("`Look instance(s): …`") — explicitly excluded as a discovery source (chat
memory). On a fresh session with cleared conversation, nothing.

### 4.2 Root cause

`read_project_context` — the one project-context host tool — had no
projection of the canonical `LookInstancesDocument`. Every other
agent-reachable project fact (tracks, clips, assets, visual objects, titles,
brief) had a domain; applied Looks did not. The mutation tools' identity
requirements therefore had no discoverable origin.

### 4.3 Why this patch is the smallest necessary

- It adds **one** value to `HOST_CONTEXT_DOMAINS` and **one** to the
  model-visible `domain` enum — the two places the domain vocabulary is
  defined for this path. (`packages/agent-tools/src/creative-skill.ts`
  `contextSelectors` is a _third_, advisory, per-skill list; it does not gate
  `read_project_context` domains and no built-in skill lists `looks`, so it is
  deliberately left unchanged.)
- It reuses `createJoyAgentContextSnapshot`'s existing sanitize/omit/byte-pack
  loop (`append(...)`, `RESERVED_OMISSION_LABELS`) and
  `createJoyAgentPagedContext`'s existing `pageChunks` / record-cap pattern —
  no new pagination or redaction machinery.
- The `looks` page carries only opaque ids, enums, bounded scalar maps and
  small id lists — the same value classes `validateLookInstance`
  (`packages/project-schema/src/living-look.ts`) already admits into a
  persisted record. No project document, URL, path, media ref or credential is
  serialized. Stored strings pass the snapshot's `safeText` / `UNSAFE_CONTEXT_TEXT`
  filter again at the boundary; the host page re-asserts the id shapes.
- Mutations are untouched: the discovered ids feed the **existing**
  `look_*` → `resolveLivingLookRun` → staging → approval → compound-Undo path.
  Context reading performs no write and does not increment a revision.
- No schema/persistence change, no new dependency, no weakened validation.

---

## 5. Before / after cold-session host responses

Full artifact: `…\joy-r2-p1-evidence-20260909T194904Z\before-after\read_project_context.json`
(captured through the real persistence→hydration→context→host boundary; a
brand-new `EditorSession` reopens the stored bytes before the context is built).

### 5.1 Before the patch

- `read_project_context { domain: 'looks' }` → **rejected**:
  `HostRpcDiagnosticError: JOY_AGENT_RPC_INVALID_REQUEST`
  (`tool-bridge.ts` `parseContextReadArgs`, domain not in `HOST_CONTEXT_DOMAINS`).
  Raw capture: `…\before-after\prepatch-looks-domain-rejected.txt`.
- `read_project_context { domain: 'overview' }` → object with
  `trackCount / clipCount / assetCount / visualObjectCount` but **no**
  `lookInstanceCount` and **no** applied-Look information.
- Regression test `cold-session-look-discovery.test.ts` against the base tree:
  **9 / 9 cases FAIL** (`…\raw\phase1-RED-baseline.log`).

### 5.2 After the patch — reopened project, one applied Look with a hand-edited override

`overview` (excerpt):

```json
{
  "projectId": "local-editor-project",
  "revision": "local-revision:v1:golden-social-edit:timeline=0:document=0:graph=0:artifacts=0:looks=1",
  "lookInstanceCount": 1,
  "orphanedLookInstanceCount": 0,
  "omitted": []
}
```

`looks` domain page:

```json
{
  "projectId": "local-editor-project",
  "revision": "local-revision:…:looks=1",
  "domain": "looks",
  "items": [
    {
      "instanceId": "look-p1eviddoc-1111-2222-333333333333",
      "definitionId": "editorial-clean",
      "definitionVersion": 1,
      "compositionId": "root",
      "packStatus": "known",
      "packTitle": "Editorial Clean",
      "packLatestVersion": 1,
      "entityBindings": { "headline": "intro-title" },
      "missingBindingIds": [],
      "orphaned": false,
      "overriddenBindingIds": ["headline"],
      "controlValues": { "energy": 0.5 },
      "createdEntityIds": []
    }
  ]
}
```

Every field required by the objective is present: instance id, pack
identity+version, target bindings, orphan/missing-target state, overrides, and
the authoritative revision (page + overview envelope). Digest of the
before/after artifact: see `…\joy-r2-p1-evidence-20260909T194904Z\SHA256SUMS`.

Reproducible command (from the worktree):

```
./node_modules/.bin/vitest run apps/editor-web/src/joy-agent/cold-session-look-discovery.test.ts
```

---

## 6. Acceptance matrix

All in `apps/editor-web/src/joy-agent/cold-session-look-discovery.test.ts`
(new). Every case reopens a brand-new `EditorSession` over the stored bytes
before building context; the simulated agent (`discoverLooks()`) receives only
the host method map — no fixture id is passed in.

| #   | Plan acceptance case                                                                                                                                                                                                                                                        | Test                                                                                                                                                                                                                          | Outcome |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Saved/reopened, fresh session, no chat: discover instance/pack/version/bindings/overrides/revision from host tools                                                                                                                                                          | `case 1 — a saved/reopened project exposes instance/pack/version/bindings/overrides/revision through host tools alone`                                                                                                        | PASS    |
| 2   | Multiple instances exceeding one page: stable traversal, no loss/dup, bounded size, revision-consistent across pages                                                                                                                                                        | `case 2 — multiple instances page without loss or duplication and stay revision-consistent` (5 instances, pageSize 2 → 3 pages, all same revision)                                                                            | PASS    |
| 3   | Empty Looks; orphaned/deleted targets; unknown pack — truthful, no crash, no invented bindings                                                                                                                                                                              | `case 3 — empty Looks, orphaned targets, and an unknown pack…` + `case 3b — a pack id with no built-in definition is surfaced as unknown, still with its bindings`                                                            | PASS    |
| 4   | Project isolation: project B never exposes project A's instances, even with stale prior context; canonical-vs-visual doc identity preserved                                                                                                                                 | `case 4 — project B never exposes project A instances, even reusing a stale context builder`                                                                                                                                  | PASS    |
| 5   | Override update / reset / detach from discovered ids: stage through existing tools, prove no mutation before approval, then correct approved behavior; rejection/cancellation and stale revision via existing helpers; compound Undo for a representative approved mutation | `case 5 — update / reset / detach derive ids from discovery, stage without mutating, then apply and Undo` + `case 5b — a stale revision between discovery and apply is refused, nothing committed`                            | PASS    |
| 6   | Malformed/oversized context input and unsafe stored text: existing validation/redaction/size controls remain effective                                                                                                                                                      | `case 6 — unsafe stored text in a Look record is redacted at the context boundary; size controls hold` (a `https://…` control value and a `C:\…` packTitle are dropped, `omitted` gains `lookInstances`, safe fields survive) | PASS    |
| 7   | ≥1 integration test crosses actual persistence hydration and the context/host boundary                                                                                                                                                                                      | Entire file (every case reopens a fresh `EditorSession`); `case 7 — the integration crosses real persistence hydration: a mutated fixture is not accepted as "reopened"` makes the reopen explicit                            | PASS    |

Supplementary regression coverage (existing suites, re-run — see §7):
`context-snapshot.test.ts`, `tool-bridge.test.ts`, `look-scoped-host.test.ts`,
`look-tool-bridge.test.ts`, `bounded-tool-loop.test.ts`,
`editor-session-look-instances.test.ts`, `project-package-look-instances.test.ts`,
`LivingLooksPanel.test.tsx`, `agent-panel-intents.test.ts`,
`agent-panel-resilience.test.ts` — all pass unchanged.

### Fixtures / limitations

- **Deterministic fixtures (labelled FIXTURE):** the staging cases use a
  hand-written `drivingClient` that calls the trusted host's `look_*` method
  exactly as the bounded tool-loop would after a model tool call, then emits the
  terminal events a real Worker would — mirroring the existing
  `look-scoped-host.test.ts` pattern. **No live provider request was made or is
  authorized.** No stub is presented as a live-model result.
- The simulated agent's tool sequence never receives a fixture id; test
  _assertions_ compare discovered values against known fixture ids, which is
  permitted.
- No browser test was run (not required for this boundary). No render/export,
  CI, migration, or production path was touched.
- P2/P3/P4+ items (typography, baked-audio media acceptance, verifier coverage,
  the 21 ms start-offset, `font-assets` timeout, CI fold/qualification) remain
  **out of scope and untouched**.

---

## 7. Files changed, commands, toolchain

### 7.1 Files changed (staged)

| File                                                                | +/-               | Change                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/editor-web/src/joy-agent/context-snapshot.ts`                 | +194 / -3         | `JoyAgentLookInstanceContext` type; `lookInstances` on input + snapshot + `JoyAgentPagedContext`; `sanitizeLookInstances` (opaque-id / bounded-scalar / redaction rules); byte-pack + omission accounting; paged-context normalization + `host-look-instances-cap`. |
| `apps/editor-web/src/joy-agent/context-input.ts`                    | +37 / -1          | Derive `lookInstances` from `session.lookInstances` + `session.orphanedLookInstanceIds` + live visual objects; resolve pack title/version from `BUILT_IN_LOOK_PACKS`; per-binding `missingBindingIds`.                                                              |
| `apps/editor-web/src/joy-agent/tool-bridge.ts`                      | +37 / -0          | `'looks'` in `HOST_CONTEXT_DOMAINS`; `overview` → `lookInstanceCount` / `orphanedLookInstanceCount`; `looks` branch in `pageForContext` (boundary id re-assertion + optional `query`).                                                                              |
| `apps/editor-web/src/joy-agent/bounded-tool-loop.ts`                | +13 / -3 (approx) | `'looks'` in the model-visible `domain` enum + description; `look_update` / `look_reset_overrides` / `look_detach` descriptions point at `read_project_context domain=looks`.                                                                                       |
| `apps/editor-web/src/joy-agent/cold-session-look-discovery.test.ts` | new, ~430 lines   | The P1 regression + acceptance suite.                                                                                                                                                                                                                               |

`git diff --cached --stat` and `git diff --cached --check` output is recorded in
the return report (post-commit).

### 7.2 Changed-file SHA-256 (worktree, pre-commit)

```
49df9f571426147de0e0d9921a81e0c9b3df4ac6b99603c10e154a85e3f3969c  context-snapshot.ts
c8f737ec4bd4b62105143468c1e6ffcfd1861e8b62f81ea1d649e8225ece2d88  context-input.ts
9dcde1ced8e28f80e96efe51118b9dc85dca3872400384996aea4965d3c73b49  tool-bridge.ts
809635fabf8b065a441220cd942a916a555d68068776b346b14b568932ea57c5  bounded-tool-loop.ts
f7f15029ed1200d1d3b68ff19be406f91ae3842a61bf966dcb029247289c98e5  cold-session-look-discovery.test.ts
```

### 7.3 Command / log index (all under `…\joy-r2-p1-evidence-20260909T194904Z\raw\`)

| Log                                               | Command (cwd = worktree)                                                                                                    | Exit                                               |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `pnpm-install.log`                                | `pnpm install --frozen-lockfile` (pnpm 11.15.0)                                                                             | 0 — "Lockfile is up to date", lock bytes unchanged |
| `phase1-RED-baseline.log`                         | `vitest run …/cold-session-look-discovery.test.ts` with the 4 source edits stashed                                          | 1 — **9/9 cases fail** (gap proven)                |
| `typecheck-tsc-b.log`                             | `./node_modules/.bin/tsc -b` (final entry)                                                                                  | 0                                                  |
| `phase2-GREEN-verbose.log`                        | `vitest run` cold-session + context-snapshot + tool-bridge + look-scoped-host + look-tool-bridge + bounded-tool-loop        | 0 — **65/65**                                      |
| `phase2-joy-agent-suite.log`                      | `vitest run apps/editor-web/src/joy-agent  editor-session-look-instances  project-package-look-instances  LivingLooksPanel` | 0 — **418/418** (60 files)                         |
| `phase2-agentpanel-extras.log`                    | `vitest run agent-panel-intents  agent-panel-resilience  living-look-audio  living-look-audio-render`                       | 0 — **20/20**                                      |
| `lint-format.log`                                 | `eslint <5 files>` ; `prettier --check <5 files>`                                                                           | 0 / 0                                              |
| `before-after/read_project_context.json`          | throwaway capture spec (created, run, **deleted** — cleanup)                                                                | pre/post host responses                            |
| `before-after/prepatch-looks-domain-rejected.txt` | same capture with the patch stashed                                                                                         | shows `JOY_AGENT_RPC_INVALID_REQUEST`              |

`pnpm -w run check` (full: typecheck + lint + format:check + **whole** vitest
suite) and `pnpm build` beyond the `tsc -b` emit were **not** run — P1 bounds
work to targeted checks; the full suite / CI is explicitly excluded.
Note: a fresh worktree has no `packages/*/dist`; `tsc -b` (the `pnpm typecheck`
step) is the emit that produced it here, and is required before
`engine-client.test.ts` can resolve `@joy-media/joy-agent-engine`. That suite
fails identically on the untouched base tree without the emit — not a
regression.

### 7.4 Toolchain provenance

| Tool       | Version  | Path                                               |
| ---------- | -------- | -------------------------------------------------- |
| node       | v22.22.3 | `C:\Users\HadiMoti\AppData\Local\hermes\node\node` |
| pnpm       | 11.15.0  | `C:\Users\HadiMoti\AppData\Local\hermes\node\pnpm` |
| vitest     | 3.2.7    | worktree `node_modules` (isolated install)         |
| typescript | 5.9.3    | worktree `node_modules`                            |
| eslint     | 9.39.5   | worktree `node_modules`                            |
| prettier   | 3.9.6    | worktree `node_modules`                            |

---

## 8. Concurrent-work preservation & task-owned resource cleanup

- **Preserved / untouched:** the untracked `looks-encoded-sample-acceptance.test.ts`
  in the `joy-live-director` worktree; both P0 Desktop evidence roots; every
  other worktree's branch HEAD, `node_modules` and `dist`; the frozen CI tag;
  `pnpm-lock.yaml` bytes.
- **Created by this task:** the branch + worktree above; the worktree's
  `node_modules` (isolated `--frozen-lockfile` install) and `tsc -b` `dist`
  emit; the P1 evidence root; scratch helper files under the session scratchpad.
- **Cleaned up:** the throwaway `_p1_evidence_capture.test.ts` (created to dump
  the before/after host responses, then removed). No other resource created.
- No `git fetch/pull/merge`, no reset/clean/prune, no push, no CI dispatch, no
  migration, no production contact, no credential or config change, no Gbrain
  write.

---

## 9. Remaining findings & four-axis status (no release-acceptance claim)

### 9.1 Findings from this package

1. `packages/agent-tools/src/creative-skill.ts` `contextSelectors` is a third,
   advisory copy of the context-domain vocabulary (validated only as unique safe
   identifiers, not against `HOST_CONTEXT_DOMAINS`). Left unchanged — no built-in
   skill needs `looks` and it does not gate `read_project_context`. A future
   change that wants a skill to _pre-load_ the looks domain would touch it.
2. A fresh worktree cannot run `engine-client.test.ts` (and, by extension, a
   naïve full `pnpm test`) until `tsc -b` has emitted
   `packages/joy-agent-engine/dist` — pre-existing, environment-level, not a
   regression. Worth a one-line note in the repo's contributor docs but out of
   P1 scope.
3. `controlValues` string values are surfaced to the agent (needed to reason
   about `look_update`). They are bounded to 120 chars and pass the
   `UNSAFE_CONTEXT_TEXT` redaction filter; the persisted-record validator
   already forbids URL/path/script payloads in them. No leak observed in tests.

### 9.2 Four-axis status (unchanged by P1 except where noted)

| Axis                   | Status                                                                                                                                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implementation         | R2 reported complete at `d01770b1`; P1 closes the cold-session Look discoverability gap the revised plan (§3 item 9, §4 P1) flagged as possibly-blocking. Direct source audit of GAP-1a/2/3/5 still not performed here.                                                             |
| Technical acceptance   | PARTIAL / PENDING (P0-R1 §6.2). P1 adds cold-session discoverability evidence at the persistence↔host boundary; typography (P2), baked-audio media acceptance (P3), intended-resolution verifier coverage + the 21 ms start-offset (P3), `font-assets` timeout (P2/P3) remain open. |
| Subjective review      | PENDING (owner-only); unaffected by P1.                                                                                                                                                                                                                                             |
| Release infrastructure | BLOCKED (P0-R1 §6.4); unaffected by P1. Artifact uploads blocked, CI-v2 independent acceptance / ci-opt fold / final R2 release gate still owed. Lock identity for this candidate is `c9e147f8…`, still ≠ frozen-CI `36426937…`.                                                    |

---

## 10. STOP

P1 is complete. Return for Codex review; **do not begin P2.**
