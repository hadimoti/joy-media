# JOY Live Director R2 — P1-R1 addendum: truthful Look-context omission (2026-09-09)

Addendum to `joy-r2-p1-cold-session-look-discovery-2026-09-09.md`. Scope: review
corrections 1–3 on the P1 patch (`070e254c`). It does **not** re-open the P1
discovery verdict — the `looks` domain still works — it makes the domain's
_omission reporting_ truthful and corrects overstated claims in the P1 report.

**This is not product acceptance, technical acceptance, or deployment approval.**
External GPT-6 Astra's candidate-specific `APPROVE_FOR_DEPLOY <sha> <tree>
<lock-sha256>` and the owner's separate deployment go-ahead remain mandatory and
unmet.

---

## 1. Verdict and remaining blockers

**Verdict: omission defects CONFIRMED against `070e254c` and FIXED.** The P1
`looks` sanitizer added a bounded projection but under-reported what it dropped:
a reader could not distinguish an _incomplete_ projection from an _empty_
project. Nine distinct under-reporting / mis-handling defects are now covered by
a regression suite that fails on `070e254c` and passes after the fix.

Remaining blockers (unchanged by P1-R1): technical acceptance PARTIAL (P2
typography, P3 baked-audio media acceptance, P3 verifier coverage + 21 ms
start-offset, P2/P3 `font-assets` timeout); subjective review PENDING; release
infrastructure BLOCKED (artifact uploads, CI-v2 acceptance, ci-opt fold, final
R2 gate). Candidate lock is still `c9e147f8…`, not the frozen-CI `36426937…`.

## 2. Session identity, worktree/branch, base/result

|                        |                                                                                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implementer session id | `f5351c9e-5d07-49d8-8a5c-f2b53533707d` (Claude Code, `claude-sonnet-5`)                                                                                                                                              |
| UTC interval           | ~2026-09-09T20:25Z – ~2026-09-09T20:50Z                                                                                                                                                                              |
| Branch                 | `codex/joy-r2-p1-discovery-20260909T194904Z` (HEAD matched `070e254c`, clean — continued in place per the prompt)                                                                                                    |
| Worktree               | `C:\Users\HadiMoti\joy-r2-p1-20260909T194904Z`                                                                                                                                                                       |
| Base                   | `070e254c840b54e11f28b9558be747e0eb9ba04a` / tree `599b1dafa10b061e3a8af9b9f4cc0b899318ea84`                                                                                                                         |
| Result                 | _filled into the return report after commit_                                                                                                                                                                         |
| `pnpm-lock.yaml`       | git blob `bcf36b0d24e24d55305898e783b4813723e22d90` · raw SHA-256 `c9e147f8f56265b5e53e64800c1f691d67675ac2618434bfc821f666176b88aa` — **unchanged** (no install performed; existing isolated `node_modules` reused) |
| Push state             | **not pushed**                                                                                                                                                                                                       |
| Evidence root          | `C:\Users\HadiMoti\Desktop\joy-r2-p1-r1-evidence-20260909T202513Z\`                                                                                                                                                  |

Preserved untouched: `looks-encoded-sample-acceptance.test.ts` in the
`joy-live-director` worktree; `…\joy-r2-p0-evidence-20260909T185139Z\`,
`…\joy-r2-p0-r1-evidence-20260909T192442Z\`, `…\joy-r2-p1-evidence-20260909T194904Z\`,
`C:\Users\HadiMoti\jm-r2-check`, `…\joy-live-director` worktree; every other
worktree's `node_modules`/`dist`; the frozen CI tag; the lock bytes.

## 3. Each review finding → change → exact regression assertion

Application changes are confined to the P1 context path. **Only**
`context-snapshot.ts` and `tool-bridge.ts` changed (not `context-input.ts`,
not `bounded-tool-loop.ts` — no correction required them).

### Correction 1 — truthful omission

| #   | Finding on `070e254c`                                                                                                                               | Change                                                                                                                                                              | Exact regression assertion (file → `it` → expect)                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `entityBindings` `.slice(0, 32)` silently truncates a larger map                                                                                    | `sanitizeLookInstance`: `entries.length > MAX_LOOK_BINDINGS ⇒ omitted.add('lookInstances')`                                                                         | `cold-session-look-omission.test.ts` → _case 1 — entityBindings beyond the nested cap_ → `expect(Object.keys(paged.lookInstances[0].entityBindings).length).toBe(32)` **and** `expect(paged.omitted).toContain('lookInstances')` (genuine reopen via `synchronizeLookInstances`)                                                                                                                                                                                                          |
| 2   | `controlValues` `.slice(0, 32)` silently truncates                                                                                                  | same rule on `controlValues`                                                                                                                                        | _case 2 — controlValues beyond the nested cap_ → `expect(overview.lookInstanceCount).toBe(1)` (record kept), `expect(overview.omitted).toContain('lookInstances')`, `expect(page.omitted).toContain('lookInstances')`, `expect(Object.keys(items[0].controlValues).length).toBe(32)`                                                                                                                                                                                                      |
| 3   | `createdEntityIds` / `overriddenBindingIds` / `missingBindingIds` `.slice(cap)` silently truncates                                                  | new `sanitizeLookIdList` reports `value.length > cap`                                                                                                               | _case 3 — createdEntityIds beyond the nested cap_ → `expect(paged.lookInstances[0].createdEntityIds.length).toBe(64)` **and** `expect(paged.omitted).toContain('lookInstances')` (genuine reopen, 70 ids)                                                                                                                                                                                                                                                                                 |
| 4   | list entries failing the token/safe-text check are `.filter`-ed out silently                                                                        | `sanitizeLookIdList` does `omitted.add('lookInstances')` on every dropped entry                                                                                     | _case 4 — a dropped unsafe override entry is reported_ → `expect(snapshot.lookInstances[0].overriddenBindingIds).toEqual(['headline'])` **and** `expect(snapshot.omitted).toContain('lookInstances')` (2nd entry is `C:\Users\…`)                                                                                                                                                                                                                                                         |
| 5   | `safeText(compositionId, 128)` truncates an over-long id into a _different_ id and surfaces it                                                      | new `exactId()` — accepts an identifier only if unmodified (`value === value.trim()`, within length, matches pattern, safe); a failing required id drops the record | _case 5 — an over-long identifier is rejected with an omission_ → `expect(paged.lookInstances).toEqual([])`, `expect(paged.omitted).toContain('lookInstances')`, `expect(JSON.stringify(paged.lookInstances)).not.toContain('xxxx')` (400-char compositionId)                                                                                                                                                                                                                             |
| 6   | `safeText(target, 128)` truncates a binding target into a different entity id and surfaces it                                                       | `exactId()` on each binding target; a bad entry is dropped + reported, the rest of the record survives                                                              | _case 6 — a truncated binding target is dropped (with omission); the rest of the record survives_ → `expect(snapshot.lookInstances[0].entityBindings).toEqual({ headline: 'intro-title' })` **and** `expect(snapshot.omitted).toContain('lookInstances')`                                                                                                                                                                                                                                 |
| 7   | `packLatestVersion` present-but-invalid silently dropped                                                                                            | reported                                                                                                                                                            | (covered incidentally; see case 9 pattern)                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 8   | `createJoyAgentPagedContext` discards each Look chunk's `.omitted` (chunks past the first `MAX_LOOK_INSTANCES` the compact snapshot never inspects) | keep `lookInstanceChunks`, `some(chunk ⇒ chunk.omitted.includes('lookInstances')) ⇒ omitted.push('lookInstances')`                                                  | _case 10 (hardening) — a field truncated only in a later page chunk is still reported_ → `expect(paged.omitted).toContain('lookInstances')` for a 66-record input whose over-cap field is only in the 2nd chunk; **control:** `expect(clean.omitted).not.toContain('lookInstances')` for 64 pristine records. **Honest note:** on `070e254c` the `> MAX_LOOK_INSTANCES` count rule already forced the label in that exact scenario, so this is a robustness guard, not a pre-fix failure. |

### Correction 1 — predictable malformed shapes (no `TypeError`)

| #   | Finding on `070e254c`                                                                                                           | Change                                                                                  | Exact assertion                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | `overriddenBindingIds` supplied as a string ⇒ `"…".slice(0,64).map(...)` throws `TypeError` out of `createJoyAgentPagedContext` | `sanitizeLookIdList`: `!Array.isArray(value) ⇒ omitted.add + return []`                 | _case 7 — a malformed list shape does not throw; it is reported and neutralised_ → `expect(build).not.toThrow()`, `expect(paged.lookInstances[0].overriddenBindingIds).toEqual([])`, `expect(paged.omitted).toContain('lookInstances')`                                                           |
| 10  | `entityBindings` supplied as an array ⇒ read positionally as `{ '0': …, '1': … }`                                               | `isPlainRecord()` guard: non-record ⇒ `omitted.add`, bindings `{}`                      | _case 8 — a map field supplied as an array is reported, not read positionally_ → `expect(snapshot.lookInstances[0].entityBindings).toEqual({})`, `expect(snapshot.lookInstances[0].instanceId).toBe('look-omit-0001-…')` (record survives), `expect(snapshot.omitted).toContain('lookInstances')` |
| 11  | top-level `input.lookInstances` supplied as a non-array                                                                         | `sanitizeLookInstances` + `createJoyAgentPagedContext`: `!Array.isArray ⇒ omitted + []` | exercised transitively by cases 7–8; `createJoyAgentPagedContext` guard `Array.isArray(input.lookInstances) ? … : []`                                                                                                                                                                             |
| 12  | a rejected `packTitle` (unsafe URL/path) vanishes with no signal                                                                | `raw.packTitle !== undefined && safeText(...) === undefined ⇒ omitted.add`              | _case 9 — a rejected packTitle is reported, not silently dropped_ → `expect(snapshot.lookInstances[0]).not.toHaveProperty('packTitle')`, `expect(JSON.stringify(...)).not.toContain('C:\\Users')`, `expect(snapshot.omitted).toContain('lookInstances')`                                          |

### Correction 1 — incomplete ≠ empty, at every response

| Change                                                                                                                                                                                                                                                                                                                  | Exact assertion                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool-bridge.ts` `assertedLookInstances()` re-asserts every record at the host boundary; `overview.lookInstanceCount` / `orphanedLookInstanceCount` now come from that set; `withLookOmission()` adds `'lookInstances'` to `overview.omitted` **and** the `looks` page `omitted` when the re-assertion drops any record | `cold-session-look-omission.test.ts` cases 2 (both `overview.omitted` and `page.omitted`), 11 (`expect(paged.omitted).toEqual(expect.arrayContaining(['lookInstances','host-look-instances-cap']))`); capture artifact `read_project_context-after.json` `incompleteProjection` vs `read_project_context-before-070e254c.json`                                                                                            |
| Byte + record caps hold on genuinely oversized input                                                                                                                                                                                                                                                                    | _case 11 — oversized input: the serialized byte and record caps hold with a report_ → `expect((paged.snapshot.lookInstances ?? []).length).toBeLessThan(5000)`, `expect(paged.lookInstances.length).toBeLessThanOrEqual(4096)`, `omitted` contains `lookInstances` + `host-look-instances-cap`. **Honest note:** this scenario already passed on `070e254c` — it confirms the existing caps, it is not a pre-fix failure. |

### Correction 2 — isolation & rejection coverage (in `cold-session-look-discovery.test.ts`)

| Change                                                                                                                                                                       | Exact assertion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _case 4_ rewritten: it now **discovers project A's instance id from A's own host tools**, then feeds that id into a `look_update` run **scoped to session B**                | `case 4 — a Look id discovered from project A cannot be presented as, or mutate, project B`: `expect(discoveredAId).toBe('look-cold-aaaa-…')`; `expect(bInstances.map(i=>i.instanceId)).toEqual(['look-cold-bbbb-…'])`; `expect(JSON.stringify(bInstances)).not.toContain('look-cold-aaaa')`; **visual vs timeline identity:** `expect(overviewB.projectId).toBe(hostB.session.visualProject.id)` **and** `expect(hostB.session.visualProject.id).not.toBe(hostB.session.timelineProject.id)`; **no cross-project mutation:** `expect(result.kind).not.toBe('prepared')`, `expect(sessionB.projectRevisionId).toBe(beforeRevision)`, `expect(sessionB.historyEntries).toHaveLength(beforeHistory)`, `expect(sessionB.lookInstances.instances[discoveredAId]).toBeUndefined()`, B's own instance control value still `0.5` |
| _case 5_ (unchanged, identified explicitly per the prompt) already covers **stage-without-mutation, apply, compound Undo, and stale-revision rejection** from discovered ids | `case 5 — update / reset / detach derive ids from discovery, stage without mutating, then apply and Undo`: `expect(agent.projectRevisionId).toBe(beforeRevision)` after staging, `expect(agent.lookInstances.instances[discoveredId].controlValues[controlId]).toBe(0.5)` pre-apply, `.toBe(0.9)` post-apply, `agent.undo()` → `.toBe(0.5)`, detach staged not committed (`toBeDefined()` pre-apply), Undo restores. `case 5b — a stale revision between discovery and apply is refused`: `.toThrow(/STALE/)`, control value unchanged                                                                                                                                                                                                                                                                                    |

### Correction 3 — P1 report corrections

- The P1 report's §6 acceptance matrix said every case "PASS" without naming the
  assertion that carries each claim. This addendum's §4 (below) is the
  assertion-level matrix; the P1 report gets a banner pointing here.
- The P1 report's case-6 line ("a `C:\…` packTitle **are dropped**, `omitted`
  gains `lookInstances`") was **true only by accident** on `070e254c` — the
  co-injected `https://…` control value is what added the label; the packTitle
  drop itself was silent (fixed here, case 9 / correction-1 #12). Discovery
  case 6's title and body are corrected to claim redaction only and to point at
  `cold-session-look-omission.test.ts` for caps/shape/oversize.
- The P1 report's case-4 ("even reusing a stale context builder") described a
  weaker check than performed; case 4 is rewritten (correction 2 above) to the
  real project-switch / session-authority boundary.
- Session identity: the P1 report gave `Claude Code (claude-sonnet-5)` with no
  id. The actual session id is `f5351c9e-5d07-49d8-8a5c-f2b53533707d` (this
  session is the P1-R1 continuation of it).
- No runtime-verification claim is made for anything established only by source
  reading. The persistence→hydration→host path is exercised by real
  `EditorSession` reopen in every genuine-reopen case; the malformed-shape cases
  are explicitly labelled as sanitizer-boundary construction (those shapes
  cannot persist — `validateLookInstancesDocument` rejects them).

## 4. Acceptance matrix — PASS / FAIL / NOT DEMONSTRATED

Legend: **PASS** = asserted and green after the fix; **RED→PASS** = the same
assertion fails on `070e254c` and passes after; **GUARD** = green on `070e254c`
too (documents existing behavior / hardening, not a pre-fix failure).

| Claim                                                                             | Test → `it`                   | Status                                                                                                                     |
| --------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| entityBindings nested-cap truncation reported                                     | omission case 1               | RED→PASS                                                                                                                   |
| controlValues nested-cap truncation reported, at `overview` and `looks`           | omission case 2               | RED→PASS                                                                                                                   |
| createdEntityIds nested-cap truncation reported                                   | omission case 3               | RED→PASS                                                                                                                   |
| dropped unsafe list entry reported (not silent `.filter`)                         | omission case 4               | RED→PASS                                                                                                                   |
| over-long identifier rejected, never truncated-and-surfaced                       | omission case 5               | RED→PASS                                                                                                                   |
| truncated binding target dropped + reported; record survives                      | omission case 6               | RED→PASS                                                                                                                   |
| malformed list shape → no `TypeError`, reported, neutralised                      | omission case 7               | RED→PASS (was a thrown `TypeError`)                                                                                        |
| map-as-array not read positionally; reported; record survives                     | omission case 8               | RED→PASS                                                                                                                   |
| rejected `packTitle` reported                                                     | omission case 9               | RED→PASS                                                                                                                   |
| per-chunk omission preserved past the first snapshot page                         | omission case 10              | GUARD                                                                                                                      |
| oversized input: byte cap + 4096 record cap + `host-look-instances-cap`           | omission case 11              | GUARD                                                                                                                      |
| saved/reopened discovery of id/pack/version/bindings/overrides/revision           | discovery case 1              | PASS                                                                                                                       |
| multi-instance pagination, no loss/dup, revision-consistent                       | discovery case 2              | PASS                                                                                                                       |
| empty / orphaned target / unknown pack reported truthfully                        | discovery cases 3, 3b         | PASS                                                                                                                       |
| A's discovered id cannot be presented as, or mutate, B; visual≠timeline id        | discovery case 4 (rewritten)  | PASS                                                                                                                       |
| update/reset/detach from discovered ids: stage w/o mutation, apply, compound Undo | discovery case 5              | PASS                                                                                                                       |
| stale revision between discovery and apply refused, nothing committed             | discovery case 5b             | PASS                                                                                                                       |
| unsafe stored text (URL/path) dropped at the boundary + flagged                   | discovery case 6 (rewritten)  | PASS                                                                                                                       |
| integration crosses real persistence hydration                                    | discovery case 7 + whole file | PASS                                                                                                                       |
| live-provider tool-loop evidence                                                  | —                             | NOT DEMONSTRATED (no live provider authorized; `drivingClient` is a labelled FIXTURE mirroring `look-scoped-host.test.ts`) |
| `pnpm build` / full `pnpm -w run check` / CI on this delta                        | —                             | NOT DEMONSTRATED (out of P1 scope; targeted checks only)                                                                   |

## 5. Raw command / log and evidence-hash index

All under `C:\Users\HadiMoti\Desktop\joy-r2-p1-r1-evidence-20260909T202513Z\`.
cwd for every command = the worktree. Tools: node v22.22.3, pnpm 11.15.0,
tsc 5.9.3, vitest 3.2.7, eslint 9.39.5, prettier 3.9.6 (worktree `node_modules`,
reused — no install).

| Log                                                      | Command                                                                                                                                                                                                             | Result                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `raw/00-base-state.txt`                                  | read-only `git` / tool-version capture                                                                                                                                                                              | HEAD `070e254c`, clean, lock `c9e147f8…`                                        |
| `raw/01-source-hashes-base.txt`                          | `sha256sum` of the 5 P1 files                                                                                                                                                                                       | matches P1 report §7.2 exactly                                                  |
| `raw/10-RED-baseline.log`                                | `vitest run …/cold-session-look-omission.test.ts` with `context-snapshot.ts` + `tool-bridge.ts` stashed to `070e254c`                                                                                               | **9 failed / 2 passed** (exit 1) — the 2 passers are the GUARD cases            |
| `raw/20-typecheck.log`                                   | `./node_modules/.bin/tsc -b --verbose`                                                                                                                                                                              | `TSC_EXIT=0`; `apps/editor-web` rebuilt                                         |
| `raw/21-lint-format.log`                                 | `eslint` + `prettier --check` (then `--write` on 2 test files, re-checked)                                                                                                                                          | `ESLINT_RECHECK_EXIT=0`, `PRETTIER_RECHECK_EXIT=0`                              |
| `raw/22-GREEN-suites.log`                                | `vitest run apps/editor-web/src/joy-agent  editor-session-look-instances  LivingLooksPanel  agent-panel-intents  agent-panel-resilience` ; then `project-schema` look tests ; then `project-package-look-instances` | **62 files / 437 pass**, then **2 / 24 pass**, then **1 / 5 pass** — all exit 0 |
| `raw/30-diff-stat.txt`, `raw/31-full.diff`               | `git diff --stat` / `git diff`                                                                                                                                                                                      | 4 files, +625 / -103; `git diff --check` clean                                  |
| `raw/32-source-hashes-postfix.txt`                       | post-fix pre-commit `sha256sum`                                                                                                                                                                                     | see SHA256SUMS                                                                  |
| `before-after/read_project_context-after.json`           | capture helper, P1-R1 code                                                                                                                                                                                          | empty vs one-Look vs incomplete (40 bindings)                                   |
| `before-after/read_project_context-before-070e254c.json` | same helper, base code                                                                                                                                                                                              | `incompleteProjection` shows `omitted: []` — silent                             |
| `helpers/capture-cold-session-look-responses.test.ts`    | the capture helper (retained, not committed)                                                                                                                                                                        | reproduction steps in its header                                                |

`SHA256SUMS` in the evidence root covers every file above. Self-hash recorded in
the return report.

## 6. Scoped diff, concurrency preservation, task-created resources

- **Staged / committed (scoped):** `context-snapshot.ts`, `tool-bridge.ts`,
  `cold-session-look-discovery.test.ts`, `cold-session-look-omission.test.ts`
  (new), and this addendum. Nothing else. `git diff --cached --check` clean.
- **Not changed** despite being in the allowed set: `context-input.ts`,
  `bounded-tool-loop.ts` — no correction needed them.
- **Task-created:** the P1-R1 evidence root; the temporary in-worktree copy of
  the capture helper (run, then deleted — worktree returned to a clean 4-file
  delta before commit).
- **Preserved:** every path the prompt named; the lock bytes; no other
  worktree's `node_modules`/`dist`; no `git fetch/merge/reset/stash-of-others'-work`
  (the only `git stash` was of _this task's own_ two edits, to capture the RED
  baseline, and was popped immediately); no push, CI, migration, deployment,
  Gbrain write, or credential/config change.

## 7. Four-axis status

| Axis                   | Status                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implementation         | R2 reported complete at `d01770b1`. P1 closed the cold-session Look discoverability gap; P1-R1 makes that domain's omission reporting truthful and hardens its input handling. No GAP-1a/2/3/5 source audit performed here. |
| Technical acceptance   | PARTIAL / PENDING — unchanged. P1-R1 adds assertion-level evidence for the `looks` domain boundary only. P2 typography, P3 baked-audio media acceptance, P3 verifier + 21 ms offset, `font-assets` timeout remain open.     |
| Subjective review      | PENDING (owner-only) — unaffected.                                                                                                                                                                                          |
| Release infrastructure | BLOCKED — unaffected. Artifact uploads, CI-v2 independent acceptance, ci-opt fold, final R2 release gate still owed. Candidate lock `c9e147f8…` ≠ frozen-CI `36426937…`.                                                    |

## 8. STOP

P1-R1 is complete. Return for Codex review; **do not begin P2.** No push. Astra
`APPROVE_FOR_DEPLOY <sha> <tree> <lock-sha256>` + owner deploy go-ahead remain
mandatory and unmet.
