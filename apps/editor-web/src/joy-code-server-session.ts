import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { JoyProjectV1, ProjectRevisionId } from '@joy-media/project-schema';
import type { ControlPlaneProjectBinding } from './project-control-plane.js';
import type { SyncProjectDocument } from './project-document-sync.js';
import type { BrowserJoyCodePlanRequest } from './control-plane-client.js';
import { coordinateJoyCodePlan, type JoyCodeCoordinationResult, type JoyCodePlanTransport } from './joy-code-request-coordinator.js';

export type JoyCodeServerSessionResult = JoyCodeCoordinationResult | { readonly kind: 'cancelled' };
export interface JoyCodeServerSessionOptions {
  readonly binding: ControlPlaneProjectBinding;
  readonly document: JoyProjectV1;
  readonly revisionId: ProjectRevisionId;
  readonly storage: BrowserKeyValueStore;
  readonly syncProjectDocument: SyncProjectDocument;
  readonly joyCodeTransport: JoyCodePlanTransport;
  readonly ownerKey?: string;
}

export class JoyCodeServerSession {
  constructor(private readonly options: JoyCodeServerSessionOptions) {}
  async plan(prompt: string, selection: BrowserJoyCodePlanRequest['selection'], projectId = this.options.document.id, signal?: AbortSignal): Promise<JoyCodeServerSessionResult> {
    if (signal?.aborted) return { kind: 'cancelled' };
    const request: BrowserJoyCodePlanRequest = { projectId, snapshotRevisionId: this.options.revisionId, prompt, selection };
    try {
      const coordinationOptions = this.options.ownerKey === undefined ? {} : { ownerKey: this.options.ownerKey };
      return await coordinateJoyCodePlan(this.options.binding, this.options.document, this.options.revisionId, request, this.options.storage, this.options.syncProjectDocument, this.options.joyCodeTransport, coordinationOptions, signal);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) return { kind: 'cancelled' };
      throw error;
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
