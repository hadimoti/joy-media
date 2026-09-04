import type {
  JoyAgentToolBridge,
  JoyDocumentOperation,
  JoyTimelineOperation,
} from '@joy-media/joy-agent-engine';
import type { JoyAgentContextSnapshot } from './context-snapshot.js';

/** Main-thread bridge: read frozen context and stage proposals without commit access. */
export function createJoyAgentToolBridge(
  snapshot: JoyAgentContextSnapshot,
  onPreview?: (kind: 'timeline' | 'document', count: number) => void,
): JoyAgentToolBridge {
  return {
    readProjectSummary: async () => ({
      projectId: snapshot.projectId,
      revision: snapshot.revision,
      clipCount: snapshot.clips.length,
      assetCount: snapshot.assets.length,
      omitted: snapshot.omitted,
    }),
    readSelection: async () => ({
      selectedClipIds: snapshot.selectedClipIds,
      playheadUs: snapshot.playheadUs,
    }),
    readTimelineWindow: async ({ startUs, endUs }) => ({
      clips: snapshot.clips.filter(
        (clip) => clip.startUs < endUs && clip.startUs + clip.durationUs > startUs,
      ),
    }),
    readAssetMetadata: async ({ assetIds }) => ({
      assets: snapshot.assets.filter((asset) => assetIds.includes(asset.id)),
    }),
    readStyleCatalog: async () => ({ styles: [] }),
    proposeTimelineOperations: async ({
      operations,
    }: {
      readonly operations: readonly JoyTimelineOperation[];
    }) => {
      onPreview?.('timeline', operations.length);
      return { staged: true, operationCount: operations.length, revision: snapshot.revision };
    },
    proposeDocumentOperations: async ({
      operations,
    }: {
      readonly operations: readonly JoyDocumentOperation[];
    }) => {
      onPreview?.('document', operations.length);
      return { staged: true, operationCount: operations.length, revision: snapshot.revision };
    },
    submitPlan: async () => ({ awaitingApproval: true, revision: snapshot.revision }),
  };
}
