import { applyTransaction, type CommandTransaction, type SpikeCommand } from '@joy-media/commands';
import {
  canonicalBindingKey,
  type JoyProjectV1,
  type PropertyBindingV2,
  type SpikeProject,
} from '@joy-media/project-schema';
import type { JoyCodePlanOperationV1 } from '@joy-media/agent-tools';
import {
  VISUAL_INSPECTOR,
  applyPropertyAnimationCommand,
  readLegacyPropertyAnimation,
} from '@joy-media/property-system';
import { compileJoyCodeTimelineOperations } from './joy-code-timeline-compiler.js';
import { compileJoyCodeTextOperation } from './joy-code-text-operations.js';
import { compileJoyCodeCaptionOperation } from './joy-code-caption-operations.js';
import { compileJoyCodeTransitionOperation } from './joy-code-transition-operations.js';
import { resolveJoyCodeOperationReferences } from './joy-code-operation-references.js';
import { audioStateFromProject } from './timeline-presentation.js';
import { prepareTimelinePresentation } from './timeline-presentation.js';

export interface JoyCodeCompoundCompilerInput {
  readonly planId: string;
  readonly baseRevision: string;
  readonly timeline: SpikeProject;
  readonly visualProject: JoyProjectV1;
  readonly registeredAssetIds: readonly string[];
  readonly operations: readonly JoyCodePlanOperationV1[];
}

export interface JoyCodeCompoundGroup {
  readonly kind: 'timeline' | 'text' | 'caption' | 'transition' | 'motion';
  readonly operationId: string;
  readonly summary: string;
  readonly affectedIds: readonly string[];
}

export interface JoyCodeCompoundDraft {
  readonly planId: string;
  readonly baseRevision: string;
  readonly proposalHash: string;
  readonly timeline: CommandTransaction | undefined;
  readonly document: JoyProjectV1;
  readonly groups: readonly JoyCodeCompoundGroup[];
  readonly warnings: readonly string[];
  readonly requiresManualApproval: true;
}

export type JoyCodeCompoundCompileResult =
  | ({ readonly ok: true } & JoyCodeCompoundDraft)
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly operationId?: string;
      };
    };

const ANIMATABLE_VISUAL_PROPERTIES = new Set([
  'x',
  'y',
  'scaleX',
  'scaleY',
  'rotationDeg',
  'opacity',
]);

function assertSupportedMotionBinding(document: JoyProjectV1, binding: PropertyBindingV2): void {
  if (binding.ownerKind !== 'visual-object')
    throw new RangeError(`motion owner kind "${binding.ownerKind}" is not implemented`);
  if (binding.timeDomain !== 'composition')
    throw new RangeError(`motion time domain "${binding.timeDomain}" is not implemented`);
  if (document.visualObjects[binding.ownerId] === undefined)
    throw new RangeError(`visual object "${binding.ownerId}" does not exist`);
  if (!ANIMATABLE_VISUAL_PROPERTIES.has(binding.propertyId))
    throw new RangeError(`visual property "${binding.propertyId}" is not animatable`);
  const descriptor = VISUAL_INSPECTOR.find((candidate) => candidate.key === binding.propertyId);
  if (descriptor?.kind !== 'number')
    throw new RangeError(`visual property "${binding.propertyId}" is not animatable`);
}

export function compileJoyCodeCompoundDraft(
  input: JoyCodeCompoundCompilerInput,
): JoyCodeCompoundCompileResult {
  if (input.operations.length === 0)
    return {
      ok: false,
      error: { code: 'JOY_CODE_COMPOUND_EMPTY', message: 'Joy Code plan contains no operations' },
    };
  const resolvedReferences = resolveJoyCodeOperationReferences(input.planId, input.operations);
  if (!resolvedReferences.ok) return { ok: false, error: resolvedReferences.error };
  const operations = resolvedReferences.operations;
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: JoyCodePlanOperationV1[] = [];
  const visit = (id: string): string | undefined => {
    if (visiting.has(id)) return 'JOY_CODE_COMPOUND_DEPENDENCY_CYCLE';
    if (visited.has(id)) return undefined;
    const operation = byId.get(id);
    if (operation === undefined) return `JOY_CODE_COMPOUND_DEPENDENCY_MISSING:${id}`;
    visiting.add(id);
    for (const dependency of operation.dependsOn) {
      const error = visit(dependency);
      if (error !== undefined) return error;
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(operation);
    return undefined;
  };
  for (const operation of operations) {
    const error = visit(operation.id);
    if (error !== undefined)
      return {
        ok: false,
        error: {
          code: error.split(':')[0]!,
          message: error.includes(':')
            ? error.slice(error.indexOf(':') + 1)
            : 'operation dependencies are invalid',
          operationId: operation.id,
        },
      };
  }

  let timeline = input.timeline;
  let document = input.visualProject;
  let audio = audioStateFromProject(document);
  const commands: SpikeCommand[] = [];
  const groups: JoyCodeCompoundGroup[] = [];
  for (const operation of ordered) {
    const operationIndex = operations.findIndex((candidate) => candidate.id === operation.id);
    if (operation.kind.startsWith('timeline.')) {
      const result = compileJoyCodeTimelineOperations({
        planId: input.planId,
        project: timeline,
        operations: [operation],
        registeredAssetIds: input.registeredAssetIds,
        operationIndex,
      });
      if (!result.ok) return { ok: false, error: result.error };
      try {
        const transaction = {
          label: `Joy Code ${operation.kind}`,
          commands: result.commands,
        };
        const beforeTimeline = timeline;
        timeline = applyTransaction(timeline, transaction).project;
        const prepared = prepareTimelinePresentation(document, audio, beforeTimeline, transaction);
        document = prepared.project;
        audio = prepared.audio;
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'JOY_CODE_COMPOUND_TIMELINE_REJECTED',
            message: error instanceof Error ? error.message : 'timeline command rejected',
            operationId: operation.id,
          },
        };
      }
      commands.push(...result.commands);
      groups.push({
        kind: 'timeline',
        operationId: operation.id,
        summary: result.diffs[0]?.summary ?? operation.kind,
        affectedIds: result.affectedIds,
      });
      continue;
    }
    if (operation.kind.startsWith('text.')) {
      const result = compileJoyCodeTextOperation({
        planId: input.planId,
        operationIndex,
        timeline,
        visualProject: document,
        operation: operation as Extract<
          JoyCodePlanOperationV1,
          { kind: 'text.insertTemplate' | 'text.setContent' | 'text.setTemplate' }
        >,
      });
      if (!result.ok) return { ok: false, error: result.error };
      document = result.document;
      if (result.timeline.commands.length > 0) {
        try {
          timeline = applyTransaction(timeline, result.timeline).project;
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'JOY_CODE_COMPOUND_TIMELINE_REJECTED',
              message: error instanceof Error ? error.message : 'text timeline command rejected',
              operationId: operation.id,
            },
          };
        }
        commands.push(...result.timeline.commands);
      }
      groups.push({
        kind: 'text',
        operationId: operation.id,
        summary: result.label,
        affectedIds: result.affectedIds,
      });
      continue;
    }
    if (operation.kind === 'motion.setKeyframe') {
      try {
        const binding = operation.binding as PropertyBindingV2;
        assertSupportedMotionBinding(document, binding);
        if (
          (binding.propertyId === 'rotationDeg' && operation.key.kind !== 'angle') ||
          (binding.propertyId !== 'rotationDeg' && operation.key.kind !== 'scalar')
        )
          throw new RangeError(
            `key kind "${operation.key.kind}" does not match ${binding.propertyId}`,
          );
        const keyframe = {
          timeUs: operation.key.timeUs,
          value: operation.key.value,
          interpolation: operation.key.interpolation,
          ...(operation.key.bezier === undefined ? {} : { bezier: operation.key.bezier }),
        } as const;
        const hasExistingAnimation =
          document.propertyAnimations?.[canonicalBindingKey(binding)] !== undefined ||
          readLegacyPropertyAnimation(document, binding) !== undefined;
        const result = !hasExistingAnimation
          ? applyPropertyAnimationCommand(document, {
              type: 'propertyAnimation.replace',
              payload: {
                binding,
                value: { kind: operation.key.kind, curve: { keyframes: [keyframe] } },
              },
            })
          : applyPropertyAnimationCommand(document, {
              type: 'propertyAnimation.setKey',
              payload: {
                binding,
                key: { kind: operation.key.kind, keyframe },
              },
            });
        document = result.project;
        groups.push({
          kind: 'motion',
          operationId: operation.id,
          summary: `Set ${operation.binding.propertyId} keyframe at ${operation.key.timeUs}µs`,
          affectedIds: [binding.ownerId, binding.propertyId],
        });
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'JOY_CODE_MOTION_KEYFRAME_REJECTED',
            message: error instanceof Error ? error.message : 'keyframe rejected',
            operationId: operation.id,
          },
        };
      }
      continue;
    }
    if (operation.kind === 'motion.removeKeyframe') {
      try {
        const binding = operation.binding as PropertyBindingV2;
        assertSupportedMotionBinding(document, binding);
        const result = applyPropertyAnimationCommand(document, {
          type: 'propertyAnimation.removeKey',
          payload: { binding, timeUs: operation.timeUs },
        });
        document = result.project;
        groups.push({
          kind: 'motion',
          operationId: operation.id,
          summary: `Remove ${operation.binding.propertyId} keyframe at ${operation.timeUs}µs`,
          affectedIds: [binding.ownerId, binding.propertyId],
        });
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'JOY_CODE_MOTION_KEYFRAME_REJECTED',
            message: error instanceof Error ? error.message : 'keyframe removal rejected',
            operationId: operation.id,
          },
        };
      }
      continue;
    }
    if (operation.kind.startsWith('caption.')) {
      const result = compileJoyCodeCaptionOperation({
        project: document,
        operation: operation as Extract<JoyCodePlanOperationV1, { kind: `caption.${string}` }>,
      });
      if (!result.ok) return { ok: false, error: result.error };
      document = result.project;
      groups.push({
        kind: 'caption',
        operationId: operation.id,
        summary: result.summary,
        affectedIds: result.affectedIds,
      });
      continue;
    }
    const result = compileJoyCodeTransitionOperation({
      project: document,
      planId: input.planId,
      operationIndex,
      operation: operation as Extract<
        JoyCodePlanOperationV1,
        { kind: 'transition.addAtJunction' | 'transition.remove' }
      >,
    });
    if (!result.ok) return { ok: false, error: result.error };
    document = result.project;
    groups.push({
      kind: 'transition',
      operationId: operation.id,
      summary: result.summary,
      affectedIds: result.affectedIds,
    });
  }
  const draft: JoyCodeCompoundDraft = {
    planId: input.planId,
    baseRevision: input.baseRevision,
    proposalHash: `joy-code-proposal-${stableHash(JSON.stringify(input.operations))}`,
    timeline:
      commands.length === 0 ? undefined : { label: `Joy Code plan ${input.planId}`, commands },
    document,
    groups,
    warnings: [],
    requiresManualApproval: true,
  };
  return { ok: true, ...draft };
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
