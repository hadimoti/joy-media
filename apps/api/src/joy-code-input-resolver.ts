import type { JoyCodePlannerInputV1 } from '@joy-media/agent-tools';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { validateJoyProjectV1 } from '@joy-media/project-schema';
import type { Actor, ControlPlane } from './control-plane.js';
import type { ProjectIntelligenceService } from './project-intelligence-service.js';
import type { ProjectSnapshotService } from './project-snapshot-service.js';

export interface JoyCodeInputResolverRequest {
  readonly projectId: string;
  readonly snapshotRevisionId: string;
  readonly prompt: string;
  readonly selection: JoyCodePlannerInputV1['selection'];
}
export type JoyCodeResolvedInput = JoyCodePlannerInputV1 & {
  readonly semanticSnapshot: unknown;
  readonly intelligenceSummary: unknown;
  readonly catalogs: JoyCodeCatalogs;
};
export interface JoyCodeInputResolverContext {
  readonly actor: Actor;
  readonly controlPlaneProjectId: string;
}
export type JoyCodeInputResolverResult =
  | { readonly status: 'resolved'; readonly input: JoyCodeResolvedInput }
  | {
      readonly status: 'stale-revision';
      readonly code: 'JOY_CODE_INPUT_STALE_REVISION';
      readonly message: string;
    }
  | {
      readonly status: 'unavailable';
      readonly code: 'JOY_CODE_INPUT_UNAVAILABLE';
      readonly message: string;
    };
export interface JoyCodeInputResolver {
  resolve(
    request: JoyCodeInputResolverRequest,
    context: JoyCodeInputResolverContext,
  ): JoyCodeInputResolverResult | Promise<JoyCodeInputResolverResult>;
}
export type JoyCodeControlPlaneReader = Pick<ControlPlane, 'readProjectDocument'>;
export interface JoyCodeCatalogs {
  readonly textTemplateIds: readonly string[];
  readonly captionTemplateIds: readonly string[];
  readonly transitionIds: readonly string[];
}
export interface CanonicalJoyCodeInputResolverOptions {
  readonly controlPlane: JoyCodeControlPlaneReader;
  readonly snapshotService: ProjectSnapshotService;
  readonly intelligenceService: ProjectIntelligenceService;
  readonly catalogs: JoyCodeCatalogs;
}

const STALE = 'The requested Joy Code revision is not current' as const;
const UNAVAILABLE = 'Joy Code canonical input is unavailable' as const;

export class CanonicalJoyCodeInputResolver implements JoyCodeInputResolver {
  constructor(private readonly options: CanonicalJoyCodeInputResolverOptions) {}
  async resolve(
    request: JoyCodeInputResolverRequest,
    context: JoyCodeInputResolverContext,
  ): Promise<JoyCodeInputResolverResult> {
    const read = await this.options.controlPlane.readProjectDocument(
      context.actor,
      context.controlPlaneProjectId,
      request.snapshotRevisionId,
    );
    if (read.kind === 'not-found' || read.kind === 'stale-revision')
      return { status: 'stale-revision', code: 'JOY_CODE_INPUT_STALE_REVISION', message: STALE };
    if (read.kind === 'unavailable')
      return { status: 'unavailable', code: 'JOY_CODE_INPUT_UNAVAILABLE', message: UNAVAILABLE };
    if (
      read.record.projectId !== context.controlPlaneProjectId ||
      read.record.revisionId !== request.snapshotRevisionId
    )
      return { status: 'stale-revision', code: 'JOY_CODE_INPUT_STALE_REVISION', message: STALE };
    if (!isJoyProjectV1(read.record.document) || read.record.document.id !== request.projectId)
      return { status: 'unavailable', code: 'JOY_CODE_INPUT_UNAVAILABLE', message: UNAVAILABLE };
    try {
      const semanticSnapshot = this.options.snapshotService.createSnapshot(
        read.record.document,
        request.snapshotRevisionId,
      );
      const intelligence = this.options.intelligenceService.computeIntelligence(semanticSnapshot);
      return {
        status: 'resolved',
        input: {
          projectId: request.projectId,
          snapshotRevisionId: request.snapshotRevisionId,
          prompt: request.prompt,
          selection: request.selection,
          contextSummary: 'Canonical semantic project context resolved for Joy Code planning',
          semanticSnapshot,
          intelligenceSummary: {
            brandReadiness: intelligence.brandReadiness,
            sceneCoverages: intelligence.sceneCoverages,
            projectReadiness: intelligence.projectReadiness,
            rules: intelligence.allRules,
          },
          catalogs: this.options.catalogs,
        },
      };
    } catch {
      return { status: 'unavailable', code: 'JOY_CODE_INPUT_UNAVAILABLE', message: UNAVAILABLE };
    }
  }
}

export const UnavailableJoyCodeInputResolver: JoyCodeInputResolver = {
  resolve: async () => ({
    status: 'unavailable',
    code: 'JOY_CODE_INPUT_UNAVAILABLE',
    message: UNAVAILABLE,
  }),
};

function isJoyProjectV1(value: unknown): value is JoyProjectV1 {
  return validateJoyProjectV1(value).length === 0;
}
