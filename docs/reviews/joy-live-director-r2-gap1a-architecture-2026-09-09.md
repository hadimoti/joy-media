# GAP 1a — plan amendment + compound-journal architecture check

**2026-09-09, session `joy-media-62`.** Branch `codex/joy-live-director` @ `88c1d925`.

The reconciliation's GAP 1a text ("`validateJoyProjectV3` replaces `validateJoyProjectV1`
at the document boundary; persist `lookInstances[id]` on the visual document") was
investigated and found to imply a whole-editor type widening: `JoyProjectV1` is the
visual-document type across **~60 files in `apps/editor-web` + ~6 in
`packages/property-system`**, `JoyProjectV3` is not assignable to it
(`schemaVersion` `3` vs `1` literal), and `packages/project-persistence` has a
stored-snapshot `schemaVersion` integrity check (`persistence.ts:249`) that
resists in-place migration.

## Amendment — approach B (owner-approved 2026-09-09)

**One canonical Look Instances document per project, in its own persistence log,
joined to the visual document through the existing compound-write journal.** The
visual-document type is unchanged. This mirrors how the editor already carries its
other "second schema slice" documents — `WORKFLOW_GRAPH_LOG_KEY`,
`CREATIVE_ARTIFACT_LOG_KEY` — each its own `BrowserProjectStore` log, joined at
commit/undo/recovery time by `EditorSession.#commitPersistencePlans`.

### Required design (owner)

1. **One authoritative copy.** The Look Instances live only in the new
   `joy-media.look-instances-log.v1` store. The visual document never carries a
   `lookInstances` field — no second authoritative copy, no reconciliation rule.
2. **Own schema + validator.** New `packages/project-schema/src/look-instances-document.ts`:
   `LookInstancesDocument` = `{ id, schemaVersion: 1, instances: LookInstancesV3 }`
   with its own `validateLookInstancesDocument`. It _reuses the `LookInstance` /
   `LookInstancesV3` types_ from `living-look.ts` but is **not** "v3-validated" —
   it is a first-class document with `schemaVersion: 1` and its own version rule.
3. **Commit / recover / undo-redo together** with the visual edit through the
   compound journal (evidence below).
4. **In the canonical session revision, save/reopen, and package export/import.**
   `projectRevisionId` folds in `#lookInstancesRevision`; the package bundle gains
   a `lookInstances` document; import validates and threads it.
5. **Explicit compatibility:**
   - legacy project (no log key) → loads as an **empty** document
     (`{ instances: {} }`), never an error;
   - a present log with `schemaVersion` ≠ 1, or malformed bytes → **fails clearly**
     at open (`PersistenceError`), same as the other logs; never silently reset;
   - export always writes the `lookInstances` document (even when empty) so an
     older reader that drops it is doing so visibly, not silently — and import on
     a build that predates the field simply ignores an unknown bundle key, which
     is why **a populated document must never be represented only by omission**.
6. **Every project path audited** (not just the main package path) — see
   "Path audit" below.
7. **Dangling-reference handling** for deleted/replaced visual objects — see
   "Entity-reference integrity" below.

## Compound-write journal — does it give real atomicity? YES.

Read from `apps/editor-web/src/editor-session.ts` @ `88c1d925`.

### The commit path — `#commitPersistencePlans(plans)` (lines 1037–1096)

- **1 plan** → `persist()` then `commit()`, no journal. (Only one store; nothing
  to be atomic _with_.)
- **≥2 plans** (the Look-apply case: visual snapshot + instances + agent receipt):
  1. dedupe targets by `storageKind\0storageKey\0projectId`;
  2. write a `prepared` journal capturing the **pre-image bytes of every target**
     (`storedPersistenceBytes`) to `#compoundJournalKey` **before any mutation**;
  3. `for (plan of plans) plan.persist()` — every durable append;
  4. flip the journal to `state:'committed'`;
  5. **only now** `for (plan of plans) plan.commit()` — in-memory history advances;
  6. `bestEffortRemove` the journal marker.
- **Any throw in step 3–4** → `restoreCompoundWrite` writes every captured
  pre-image back, `resolveCompoundWriteJournal` clears the journal, the original
  error rethrows. In-memory state was never advanced (step 5 not reached).
- **If the rollback itself throws** → `#persistenceRecoveryRequired = true` +
  `PERSISTENCE_ATOMIC_ROLLBACK_PENDING`; the session refuses all further writes
  until reload; the prepared journal on disk is the recovery authority.

### The recovery path — `recoverPreparedCompoundWrite(storage, scope)` (lines 1139–1163)

Runs **in the `EditorSession` constructor, before the session is writable**
(`#assertWriterActive` + this call precede every log open).

| On-disk journal state      | Meaning                                                  | Action                                                                                                                |
| -------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| absent                     | no compound write in flight                              | nothing                                                                                                               |
| `prepared`                 | crash between "journal written" and "committed"          | `restoreCompoundWrite` → every target back to its pre-image → clean **pre-commit** state                              |
| `committed`                | crash after all appends succeeded, before marker cleared | `bestEffortRemove` → **all** appends kept                                                                             |
| unparseable / out-of-scope | ambiguous                                                | `PERSISTENCE_ATOMIC_JOURNAL_CORRUPT` — **refuses to open a writable session**; never silently accepts a mixed project |

`restoreCompoundWrite` → `prepareCompoundRollbackWrites` **pre-flights every
rollback byte through the real persistence adapter** (`assertRecoverableRollbackProjectRecord`
→ `assertRecordRecoversWithAdapter`, an isolated in-memory reader that runs
`LocalProjectPersistence.recover` with the domain's real adapter, checksums and
validator) **before mutating any storage**. A lazy half-rollback cannot leave a
mixed project.

### Undo / redo (lines 768–882)

`undo()` maps each `EditorOperation` in the history entry to one
`CompoundPersistencePlan` (`#undoPlan`) — in **reverse order** — and runs them
through the **same `#commitPersistencePlans`**. Same journal, same all-or-nothing.
`redo()` is symmetric. So "undo the Look apply" reverts the visual snapshot **and**
the instances write together, or neither.

### Existing proof in the tree

`apps/editor-web/src/editor-session-compound-domains.test.ts` already runs a
**failure-point matrix** — `journal-prepare | timeline | document | graph |
artifact | receipt | journal-commit` — injecting a `setItem` throw at each point
of a five-domain `commitAgentCompound` and asserting **every** domain is back to
its exact pre-commit state and the agent receipt is absent. GAP 1a extends this
matrix with a `look-instance` point and adds a dedicated
"only-visual-or-only-instance never survives" assertion.

### Conclusion

**The journal provides genuine all-or-nothing across N project-log participants,
with crash recovery, without approximation.** No limitation forces us to fake
atomicity. The Look Instances log is added as a first-class compound participant
via these **bounded, enumerable** integration points:

- `LOOK_INSTANCES_LOG_KEY` + `lookInstancesAdapter` (own validator);
- `#prepareCompound` gains a `lookInstances?` part → 4th/5th `persistencePlan`
  - a `'look-instance'` `EditorOperation`;
- `#undoPlan` / `#redoPlan` gain a `'look-instance'` branch;
- `assertRecoverableRollbackProjectRecord`'s `switch` gains
  `case LOOK_INSTANCES_LOG_KEY`;
- the constructor opens + recovers the log unconditionally (Looks are not behind
  the Dual Lens flag);
- `PreparedCompoundDispatch` / `dispatchCompound` / `commitAgentCompound` thread
  `lookInstances`;
- `#projectRevisionId` folds in `#lookInstancesRevision`.

## Path audit — every project path that must handle the new document

| Path                          | File(s)                                                                                                                | Handling                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local open / recovery         | `editor-session.ts` ctor, `recoverOrInitialize`                                                                        | open the log; absent → empty document; malformed → `PersistenceError`                                                                                                                                                                                                                                                                                                                  |
| Compound commit               | `editor-session.ts` `#prepareCompound` / `#commitPersistencePlans`                                                     | instances write is a compound participant                                                                                                                                                                                                                                                                                                                                              |
| Undo / redo                   | `editor-session.ts` `#undoPlan` / `#redoPlan`                                                                          | `'look-instance'` op reverts with its visual half                                                                                                                                                                                                                                                                                                                                      |
| Crash recovery                | `editor-session.ts` `recoverPreparedCompoundWrite` + rollback preflight switch                                         | `case LOOK_INSTANCES_LOG_KEY`                                                                                                                                                                                                                                                                                                                                                          |
| Autosave / control-plane sync | `project-document-autosync.ts`, `project-document-sync.ts`, `project-document-hydration.ts`, `control-plane-client.ts` | **audit**: today these sync only the visual `document`. Decision: the Look Instances document is **local-first, not control-plane-synced in GAP 1a** (the server has no `lookInstances` column; R1 shipped visual-doc-only sync). Documented follow-up: server-side Look Instances sync. Hydration must **not** clobber the local Look Instances doc when it pulls a newer visual doc. |
| Package export                | `project-package.ts` `createProjectPackage` → `readProjectBundle` (`project-lifecycle.ts`)                             | bundle gains `lookInstances` (always written, even empty)                                                                                                                                                                                                                                                                                                                              |
| Package import                | `project-package.ts` `importProjectPackage` + `assertImportedDocumentsValid`                                           | validate + `remapJson` the instance entity ids + persist via `EditorSession` seed                                                                                                                                                                                                                                                                                                      |
| Project duplication           | `project-lifecycle.ts` / wherever "duplicate project" copies logs                                                      | **audit**: must copy the Look Instances log with id-remap, same as timeline/visual                                                                                                                                                                                                                                                                                                     |
| Agent readback                | `joy-agent/*-readback.ts`, `conversation-entity-references.ts`                                                         | read-only; GAP 1b/5 add `updateLook`/`detachLook` readbacks. These read `session.lookInstances`, never a visual-doc field                                                                                                                                                                                                                                                              |
| Blank project creation        | `project-factory.ts`, `editor-project.ts`                                                                              | seed an **empty** instances document (no migration needed)                                                                                                                                                                                                                                                                                                                             |
| Export/render pipeline        | `release-observer-timeline.ts`, render layers                                                                          | unaffected — they consume compiled keyframes on the visual doc, not instances                                                                                                                                                                                                                                                                                                          |

`readProjectBundle` / `ProjectDocumentBundle` (`project-lifecycle.ts`) and
`assertImportedDocumentsValid` (`project-package.ts`) are the concrete
export/import edit points; `project-lifecycle.ts` duplication is the third.

## Entity-reference integrity (deleted / replaced visual objects)

A `LookInstance` holds `entityBindings` (slot → visual-object id) and
`createdEntityIds`. If the user deletes a bound visual object:

- **The instances document is NOT cascade-edited by the deletion.** Cascading
  would either (a) break the atomic undo of the deletion (the instance edit would
  need to ride the same compound, across an unrelated user action), or (b) leave
  a window where the deletion is undone but the binding isn't restored.
- **`validateLookInstancesDocument` does NOT fail on a dangling id.** Recovery and
  open must always succeed; a dangling binding is a _content_ condition, not a
  _corruption_.
- **Resolution is at use:** the Look compiler (L2) already treats a binding whose
  target is absent as "skip that binding" (fail-closed, zero ops). GAP 1c's panel
  surfaces a dangling binding as "target removed — rebind or remove"; `detach`
  and `resetOverrides` always work regardless.
- **Replace (id changes):** `remapJson` on import already rewrites ids inside the
  instances document. In-editor "replace object" keeps the id, so no dangling ref.

This is the same posture the editor already takes for e.g. a caption clip that
references a deleted caption document — resolve-at-use, never fail-load.

## Test plan (all under `pnpm --filter` scopes; project-schema + property-system + editor-web + typecheck)

1. **project-schema**: `validateLookInstancesDocument` — accepts empty, accepts a
   populated instance, rejects `schemaVersion` ≠ 1, rejects non-object `instances`,
   rejects a malformed `LookInstance`; **keeps a genuine v1 fixture** — this is a
   _new_ document, not a migration of an existing one.
2. **editor-session — round-trip**: apply a compound with a `lookInstances` part →
   reopen a fresh `EditorSession` on the same storage → the instance is present;
   `projectRevisionId` advanced; visual doc byte-identical to what was written.
3. **editor-session — idempotent reopen**: reopen twice with no edits → no
   `setItem` to any log, `projectRevisionId` stable, no recovery warning.
4. **editor-session — undo/redo**: apply (visual + instance) → `undo()` → both
   gone → `redo()` → both back; interleave with a plain visual edit and confirm
   the stacks stay in step.
5. **editor-session — failure matrix**: extend the compound-domains matrix with a
   `look-instance` failure point; add an explicit assertion that there is **no
   run** where `session.visualProject` shows the edit but `session.lookInstances`
   does not, or vice versa, at **every** injected point.
6. **editor-session — crash recovery**: write a `prepared` journal by hand (as the
   existing recovery tests do) that spans the visual + instances logs, then
   construct a new `EditorSession` → both roll back to pre-image; a `committed`
   journal → both kept.
7. **package**: export a project with one instance → import into fresh storage →
   instance + `overriddenBindingIds` survive, entity ids remapped; export a
   project with **no** Looks → bundle still carries an empty `lookInstances`
   document; import a bundle whose `lookInstances` is malformed → clear failure,
   nothing half-imported.
8. **compatibility**: open storage that has visual + timeline logs but **no**
   look-instances key → session loads, `session.lookInstances` is `{}`, first
   Look apply creates the log.
9. **entity integrity**: instance bound to `obj-x`; delete `obj-x` via a normal
   visual edit; `session.lookInstances` still has the binding; compiler skips it;
   `detach` still succeeds.

## Not in GAP 1a (tracked)

- Server-side Look Instances sync (control-plane column + hydration merge).
- The `updateLook` / `detachLook` agent capabilities + panel reopen UI — GAP 1b / 1c / 5.
- `living-looks-audio-motion.spec.ts`, `living-looks-render.spec.ts` — GAP 2 / 4.
