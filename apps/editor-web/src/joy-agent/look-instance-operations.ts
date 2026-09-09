/**
 * Living Look instance host operations (R2 / GAP 1b + 5).
 *
 * Pure helpers that turn an operator's (or a user-directed agent's) intent —
 * apply / update / reset-overrides / detach / mark-override — into:
 *   - the next `LookInstancesDocument` to persist, and
 *   - where a recompile is needed, the `LookCompileInput` to feed the SAME
 *     `prepareLookPlan` the first apply uses.
 *
 * There is one code path for manual and agent callers (GAP 5). The panel and an
 * agent capability call these functions with identical inputs and get an
 * identical `LookInstancesDocument` + plan; the write itself rides the same
 * compound-journal commit either way (`EditorSession#prepareCompound`'s
 * `lookInstances` part).
 *
 * These functions never touch the visual document. The compiler protects a
 * hand-edited binding (`overriddenBindingIds`); `resetBindingIds` is the
 * operator's explicit "put this back under Look control".
 */

import type { LookDefinition, LookCompileInput } from '@joy-media/motion-core';
import type { LookInstance, LookInstancesDocument } from '@joy-media/project-schema';

function uniqueSorted(ids: Iterable<string>): readonly string[] {
  return [...new Set(ids)].sort();
}

/**
 * The `LookInstance` record for a compiled apply / reapply / update. `id` is the
 * instance identity (a fresh token on a first apply, the existing id on an
 * update). `overriddenBindingIds` is carried forward from `input`, minus any the
 * same compile explicitly reset — the compiler just re-wrote those, so they are
 * back under Look control.
 *
 * `createdEntityIds` stays `[]`: none of the shipping packs author an entity
 * (every operation targets a slot-bound existing object). `text.insertTemplate`
 * object creation is a compiler follow-up; when it lands, its created ids flow
 * in here.
 */
export function buildLookInstanceRecord(id: string, input: LookCompileInput): LookInstance {
  const reset = new Set(input.resetBindingIds ?? []);
  return {
    id,
    definitionId: input.definition.id,
    definitionVersion: input.definitionVersion,
    compositionId: input.compositionId,
    entityBindings: { ...input.entityBindings },
    controlValues: { ...input.controlValues },
    overriddenBindingIds: uniqueSorted(
      [...input.overriddenBindingIds].filter((bindingId) => !reset.has(bindingId)),
    ),
    createdEntityIds: [],
  };
}

/** `{ id -> instance }` map with `instance` upserted under its own id. */
export function upsertLookInstance(
  document: LookInstancesDocument,
  instance: LookInstance,
): LookInstancesDocument {
  return {
    ...document,
    instances: { ...document.instances, [instance.id]: instance },
  };
}

/** The document with `instanceId` removed. Detach leaves the authored keyframes. */
export function detachLookInstance(
  document: LookInstancesDocument,
  instanceId: string,
): LookInstancesDocument {
  if (document.instances[instanceId] === undefined) return document;
  const next = { ...document.instances };
  delete next[instanceId];
  return { ...document, instances: next };
}

/**
 * A `LookCompileInput` that recompiles an existing instance's pinned definition
 * with changed control values and/or a set of bindings the operator wants put
 * back under Look control. `overriddenBindingIds` comes from the stored instance
 * unchanged — the compiler still skips them unless named in `resetBindingIds`.
 *
 * `context` supplies the pieces a `LookInstance` does not store (they are
 * properties of the composition / runtime, not of the instance): the pinned
 * `definition` object, composition timing, format, resolved fonts, and any L4
 * audio bakes still in effect.
 */
export function lookInstanceUpdateCompileInput(
  instance: LookInstance,
  change: {
    readonly nextControlValues?: Readonly<Record<string, number | string | boolean>>;
    readonly nextEntityBindings?: Readonly<Record<string, string>>;
    readonly resetBindingIds?: readonly string[];
  },
  context: {
    readonly definition: LookDefinition;
    readonly compositionDurationUs: number;
    readonly format: 'portrait' | 'landscape';
    readonly resolvedFonts: Readonly<Record<string, string>>;
    readonly audioBakes?: LookCompileInput['audioBakes'];
  },
): LookCompileInput {
  return {
    definition: context.definition,
    definitionVersion: instance.definitionVersion,
    compositionId: instance.compositionId,
    compositionDurationUs: context.compositionDurationUs,
    format: context.format,
    entityBindings: { ...instance.entityBindings, ...(change.nextEntityBindings ?? {}) },
    controlValues: { ...instance.controlValues, ...(change.nextControlValues ?? {}) },
    overriddenBindingIds: instance.overriddenBindingIds,
    ...(change.resetBindingIds !== undefined && change.resetBindingIds.length > 0
      ? { resetBindingIds: uniqueSorted(change.resetBindingIds) }
      : {}),
    resolvedFonts: context.resolvedFonts,
    ...(context.audioBakes !== undefined ? { audioBakes: context.audioBakes } : {}),
  };
}

/**
 * Add `bindingId` to an instance's `overriddenBindingIds` — the canonical
 * "operator hand-edited a linked binding" write. Called identically whether the
 * edit came from the Inspector (manual) or a user-directed agent command
 * (GAP 5); reapplying the Look then leaves that binding alone until an explicit
 * reset. A no-op if the instance is unknown or the binding is already listed.
 */
export function markLookBindingOverridden(
  document: LookInstancesDocument,
  instanceId: string,
  bindingIds: readonly string[],
): LookInstancesDocument {
  const instance = document.instances[instanceId];
  if (instance === undefined) return document;
  const next = uniqueSorted([...instance.overriddenBindingIds, ...bindingIds]);
  if (
    next.length === instance.overriddenBindingIds.length &&
    next.every((id, index) => id === instance.overriddenBindingIds[index])
  ) {
    return document;
  }
  return upsertLookInstance(document, { ...instance, overriddenBindingIds: next });
}

/**
 * Instance ids in `document` whose `entityBindings` name a visual object that
 * `liveVisualObjectIds` does not contain — the panel and the agent surface
 * these for rebind-or-remove. Deliberately duplicated from
 * `EditorSession.orphanedLookInstanceIds` so a caller with a document but no
 * session (e.g. an import preview) can compute it too.
 */
export function orphanedLookInstanceIds(
  document: LookInstancesDocument,
  liveVisualObjectIds: ReadonlySet<string>,
): readonly string[] {
  return Object.values(document.instances)
    .filter((instance) =>
      Object.values(instance.entityBindings).some((target) => !liveVisualObjectIds.has(target)),
    )
    .map((instance) => instance.id)
    .sort();
}
