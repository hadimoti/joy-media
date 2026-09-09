/**
 * One resolution path for a Living Look intent (R2 / GAP 1b + 5).
 *
 * `resolveLivingLookRun` turns a `LivingLooksRunInput` — from the panel (manual)
 * or from an agent `look_*` tool call — into the concrete pieces the staging
 * handler needs: the pinned `LookDefinition`, the instance id, the
 * `LookCompileInput`, and the full next `LookInstancesDocument` to persist
 * atomically with the compiled keyframes. Manual and agent callers pass the
 * identical `LivingLooksRunInput` and get the identical resolution, so an
 * `apply` / `update` / `reset` / `detach` reaches the same compound-journal
 * commit either way. This module never touches the visual document or React
 * state; it is a pure function of the session snapshot and the request.
 */

import type { JoyCodeOperationKind } from '@joy-media/agent-tools';
import {
  BUILT_IN_LOOK_PACKS,
  type LookCompileInput,
  type LookDefinition,
} from '@joy-media/motion-core';
import type { LookInstancesDocument } from '@joy-media/project-schema';
import type { EditorSession } from '../editor-session.js';
import type { LivingLooksRunInput } from '../LivingLooksPanel.js';
import { catalog as buildLookCatalog, type LookCatalogEntry } from './look-operations.js';
import {
  buildLookInstanceRecord,
  detachLookInstance,
  lookInstanceUpdateCompileInput,
  upsertLookInstance,
} from './look-instance-operations.js';

export interface LivingLookRunContext {
  /** Font-family display name -> resolved family. Passed to the Look compiler. */
  readonly resolvedFonts: Readonly<Record<string, string>>;
  /** Bundled font families available to the editor (availability gate). */
  readonly availableFonts: readonly string[];
  /** Operation kinds this runtime advertises; defaults to the full canonical set. */
  readonly availableOperationKinds?: readonly JoyCodeOperationKind[];
  /** Mints a fresh instance id for a first `apply`. */
  readonly makeInstanceId: () => string;
  /** objectId -> current text, so a template swap keeps the operator's copy. */
  readonly currentTextByObjectId?: Readonly<Record<string, string>>;
  /** L4 audio bakes still in effect for an `update` / `reset` recompile. */
  readonly audioBakes?: LookCompileInput['audioBakes'];
}

export type LivingLookResolution =
  | {
      readonly kind: 'run';
      readonly verb: 'Apply' | 'Adjust' | 'Reset overrides on';
      readonly definition: LookDefinition;
      readonly instanceId: string;
      readonly compileInput: LookCompileInput;
      /** The next document, with the compiled instance upserted under its id. */
      readonly lookInstancesWrite: LookInstancesDocument;
      readonly goal: string;
      readonly title: string;
    }
  | {
      readonly kind: 'detach';
      readonly definition: LookDefinition | undefined;
      readonly instanceId: string;
      /** The next document, with the instance removed; keyframes are left alone. */
      readonly lookInstancesWrite: LookInstancesDocument;
      readonly goal: string;
      readonly title: string;
    }
  | { readonly kind: 'blocked'; readonly reason: string };

function rootFormat(session: EditorSession): 'portrait' | 'landscape' | undefined {
  const visual = session.visualProject;
  const root = visual.compositions[visual.rootCompositionId];
  if (root === undefined) return undefined;
  return root.height >= root.width ? 'portrait' : 'landscape';
}

function availabilityFor(
  definitionId: string,
  context: LivingLookRunContext,
): { readonly entry: LookCatalogEntry | undefined; readonly available: boolean } {
  const entry = buildLookCatalog(BUILT_IN_LOOK_PACKS, {
    availableFonts: context.availableFonts,
    ...(context.availableOperationKinds === undefined
      ? {}
      : { availableOperationKinds: context.availableOperationKinds }),
  }).find((candidate) => candidate.definition.id === definitionId);
  return { entry, available: entry?.available === true };
}

export function resolveLivingLookRun(
  session: EditorSession,
  request: LivingLooksRunInput,
  context: LivingLookRunContext,
): LivingLookResolution {
  const visual = session.visualProject;
  const root = visual.compositions[visual.rootCompositionId];
  const format = rootFormat(session);
  if (root === undefined || format === undefined)
    return { kind: 'blocked', reason: 'no-root-composition' };

  if (request.kind === 'detach') {
    const instance = session.lookInstances.instances[request.instanceId];
    if (instance === undefined) return { kind: 'blocked', reason: 'unknown-instance' };
    const definition = BUILT_IN_LOOK_PACKS.find((pack) => pack.id === instance.definitionId);
    const title = definition?.title ?? instance.definitionId;
    return {
      kind: 'detach',
      definition,
      instanceId: request.instanceId,
      lookInstancesWrite: detachLookInstance(session.lookInstances, request.instanceId),
      goal: `Detach the "${title}" Look`,
      title,
    };
  }

  if (request.kind === 'apply') {
    const definition = BUILT_IN_LOOK_PACKS.find((pack) => pack.id === request.definitionId);
    const { available } = availabilityFor(request.definitionId, context);
    if (definition === undefined || !available)
      return { kind: 'blocked', reason: 'look-unavailable' };
    const instanceId = context.makeInstanceId();
    // A per-run `audioBakes` on the request (a fresh bake from the composition
    // audio, GAP 2) wins over any context default.
    const audioBakes = request.audioBakes ?? context.audioBakes;
    const compileInput: LookCompileInput = {
      definition,
      // The pinned version is the definition's own; a caller-supplied value is
      // only honoured when it matches (the panel passes the same number).
      definitionVersion:
        request.definitionVersion === definition.version
          ? request.definitionVersion
          : definition.version,
      compositionId: visual.rootCompositionId,
      compositionDurationUs: root.durationUs,
      format,
      entityBindings: request.entityBindings,
      controlValues: request.controlValues,
      overriddenBindingIds: [],
      resolvedFonts: context.resolvedFonts,
      ...(audioBakes === undefined ? {} : { audioBakes }),
    };
    return {
      kind: 'run',
      verb: 'Apply',
      definition,
      instanceId,
      compileInput,
      lookInstancesWrite: upsertLookInstance(
        session.lookInstances,
        buildLookInstanceRecord(instanceId, compileInput),
      ),
      goal: `Apply the "${definition.title}" Look`,
      title: definition.title,
    };
  }

  // update / reset — recompile a stored instance's pinned definition.
  const stored = session.lookInstances.instances[request.instanceId];
  if (stored === undefined) return { kind: 'blocked', reason: 'unknown-instance' };
  const definition = BUILT_IN_LOOK_PACKS.find((pack) => pack.id === stored.definitionId);
  const { available } = availabilityFor(stored.definitionId, context);
  if (definition === undefined || !available)
    return { kind: 'blocked', reason: 'look-unavailable' };
  const updateAudioBakes =
    request.kind === 'update' ? (request.audioBakes ?? context.audioBakes) : context.audioBakes;

  const compileInput = lookInstanceUpdateCompileInput(
    stored,
    request.kind === 'update'
      ? {
          ...(request.nextControlValues === undefined
            ? {}
            : { nextControlValues: request.nextControlValues }),
          ...(request.nextEntityBindings === undefined
            ? {}
            : { nextEntityBindings: request.nextEntityBindings }),
        }
      : { resetBindingIds: request.bindingIds },
    {
      definition,
      compositionDurationUs: root.durationUs,
      format,
      resolvedFonts: context.resolvedFonts,
      ...(updateAudioBakes === undefined ? {} : { audioBakes: updateAudioBakes }),
    },
  );
  const verb = request.kind === 'update' ? 'Adjust' : 'Reset overrides on';
  return {
    kind: 'run',
    verb,
    definition,
    instanceId: stored.id,
    compileInput,
    lookInstancesWrite: upsertLookInstance(
      session.lookInstances,
      buildLookInstanceRecord(stored.id, compileInput),
    ),
    goal: `${verb} the "${definition.title}" Look`,
    title: definition.title,
  };
}
