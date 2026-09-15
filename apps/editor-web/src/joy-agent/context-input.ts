/**
 * Builds one `JoyAgentContextSnapshotInput` from a live editor session and the
 * current selection. Shared by the direct Joy Code composer and the V1 recipe
 * path so both surfaces send the model the same bounded, project-object-free
 * context shape.
 */

import type { CreativeBriefV1 } from '@joy-media/agent-tools';
import { BUILT_IN_LOOK_PACKS } from '@joy-media/motion-core';
import type { EditorSession } from '../editor-session.js';
import { resolveObjectIdForSelection } from '../sticker-bindings.js';
import type {
  JoyAgentContextSnapshotInput,
  JoyAgentLookInstanceContext,
} from './context-snapshot.js';
import type { JoyAgentConversationEntityReference } from './conversation-entity-references.js';

export interface BuildJoyAgentContextInput {
  readonly session: EditorSession;
  readonly selectedClipIds?: readonly string[];
  readonly playheadUs?: number;
  /** Last few conversation turns, already trimmed by the caller. */
  readonly conversationMessages?: readonly {
    readonly role: 'user' | 'assistant';
    readonly body: string;
  }[];
  /** Re-resolved, currently valid durable entity references. */
  readonly recentEntityReferences?: readonly JoyAgentConversationEntityReference[];
  /** A single conversation follow-up target, if the prompt named one. */
  readonly selectedEntityReference?: JoyAgentConversationEntityReference;
  readonly creativeBrief?: CreativeBriefV1;
}

export function buildJoyAgentContextInput(
  input: BuildJoyAgentContextInput,
): JoyAgentContextSnapshotInput {
  const { session } = input;
  const selectedClipIds = input.selectedClipIds ?? [];
  const composition =
    session.timelineProject.compositions[session.timelineProject.rootCompositionId];
  const selectedReferenceVisualObjectIds =
    input.selectedEntityReference?.entityKind.startsWith('visual-') === true
      ? [input.selectedEntityReference.entityId]
      : [];

  // Applied Look instances from the reopened canonical `LookInstancesDocument`.
  // This is the only path by which a fresh agent session — no prior chat, no
  // owner-supplied ids — can discover the instance ids, pinned pack + version,
  // bindings, orphan state and overrides it needs to reason about
  // `look_update` / `look_reset_overrides` / `look_detach`.
  const liveVisualObjectIds = new Set(Object.keys(session.visualProject.visualObjects));
  const orphanedInstanceIds = new Set(session.orphanedLookInstanceIds);
  const lookInstances: JoyAgentLookInstanceContext[] = Object.values(
    session.lookInstances.instances,
  ).map((instance) => {
    const pack = BUILT_IN_LOOK_PACKS.find((candidate) => candidate.id === instance.definitionId);
    const missingBindingIds = Object.entries(instance.entityBindings)
      .filter(([, target]) => !liveVisualObjectIds.has(target))
      .map(([bindingId]) => bindingId);
    return {
      instanceId: instance.id,
      definitionId: instance.definitionId,
      definitionVersion: instance.definitionVersion,
      compositionId: instance.compositionId,
      packStatus: pack === undefined ? ('unknown' as const) : ('known' as const),
      ...(pack === undefined ? {} : { packTitle: pack.title, packLatestVersion: pack.version }),
      entityBindings: instance.entityBindings,
      missingBindingIds,
      orphaned: missingBindingIds.length > 0 || orphanedInstanceIds.has(instance.id),
      overriddenBindingIds: instance.overriddenBindingIds,
      controlValues: instance.controlValues,
      createdEntityIds: instance.createdEntityIds,
    };
  });

  return {
    projectId: session.visualProject.id,
    entityReferenceProjectId: session.timelineProject.id,
    revision: session.projectRevisionId,
    compositionId: session.timelineProject.rootCompositionId,
    trackIds: composition?.tracks.map((track) => track.id) ?? [],
    selectedClipIds,
    selectedVisualObjectIds: [
      ...new Set([
        ...selectedClipIds
          .map((clipId) => resolveObjectIdForSelection(session.visualProject, [clipId]))
          .filter((id): id is string => id !== undefined),
        ...selectedReferenceVisualObjectIds,
      ]),
    ],
    ...(input.playheadUs === undefined ? {} : { playheadUs: input.playheadUs }),
    ...(composition === undefined
      ? {}
      : {
          clips: composition.tracks.flatMap((track) =>
            track.clips.map((clip) => ({
              id: clip.id,
              trackId: track.id,
              startUs: clip.startUs,
              durationUs: clip.durationUs,
            })),
          ),
        }),
    assets: Object.values(session.visualProject.assets).map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      displayName: asset.displayName,
    })),
    visualObjects: Object.values(session.visualProject.visualObjects).map((object) => ({
      id: object.id,
      kind: object.kind,
      ...(typeof object.text === 'string' ? { text: object.text } : {}),
      transform: {
        x: object.transform.x,
        y: object.transform.y,
        scaleX: object.transform.scaleX,
        scaleY: object.transform.scaleY,
        rotationDeg: object.transform.rotationDeg,
        opacity: object.transform.opacity,
      },
      animatedProperties: [
        ...Object.keys(object.animations ?? {}),
        ...Object.values(session.visualProject.propertyAnimations ?? {})
          .filter((animation) => animation.binding.ownerId === object.id)
          .map((animation) => animation.binding.propertyId),
      ],
    })),
    ...(input.conversationMessages === undefined
      ? {}
      : { conversation: input.conversationMessages }),
    ...(input.recentEntityReferences === undefined || input.recentEntityReferences.length === 0
      ? {}
      : { recentEntityReferences: input.recentEntityReferences }),
    ...(lookInstances.length === 0 ? {} : { lookInstances }),
    ...(input.creativeBrief === undefined ? {} : { creativeBrief: input.creativeBrief }),
  };
}
