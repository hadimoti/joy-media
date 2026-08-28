import { type JoyProjectV1, type SpikeProject, type WorkflowGraphV2 } from '@joy-media/project-schema';
import type { ArtifactStore, AudioState } from '@joy-media/commands';
export interface ProjectDocumentHydrationPlan {
    readonly visualProject: JoyProjectV1;
    readonly timelineProject: SpikeProject;
    readonly workflowGraph?: WorkflowGraphV2;
    readonly artifacts?: ArtifactStore;
    /** Distinguishes an authoritative empty audio domain from omission. */
    readonly audioStatePresent: boolean;
    readonly audioState?: AudioState;
}
export type ProjectDocumentHydrationResult = {
    readonly ok: true;
    readonly plan: ProjectDocumentHydrationPlan;
} | {
    readonly ok: false;
    readonly warnings: readonly string[];
};
/**
 * Validate and normalize an untrusted V2 transport document before it reaches
 * the mutable editor. No caller should cast a journal or remote response
 * directly into an EditorSession.
 */
export declare function planProjectDocumentHydration(value: unknown, expectedProjectId: string, options: {
    readonly graphEnabled: boolean;
    readonly sessionProjectId?: string;
}): ProjectDocumentHydrationResult;
//# sourceMappingURL=project-document-hydration.d.ts.map