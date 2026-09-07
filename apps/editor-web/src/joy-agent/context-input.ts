/**
 * Builds one `JoyAgentContextSnapshotInput` from a live editor session and the
 * current selection. Shared by the direct Joy Code composer and the V1 recipe
 * path so both surfaces send the model the same bounded, project-object-free
 * context shape.
 */

import type { CreativeBriefV1 } from '@joy-media/agent-tools';
import type { EditorSession } from '../editor-session.js';
import { resolveObjectIdForSelection } from '../sticker-bindings.js';
import type { JoyAgentContextSnapshotInput } from './context-snapshot.js';
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
    ...(input.creativeBrief === undefined ? {} : { creativeBrief: input.creativeBrief }),
  };
}
