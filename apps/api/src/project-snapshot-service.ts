/**
 * Project Snapshot Service - WP-37 S4 Phase 2-A
 * Pure API-internal service that converts JoyProjectV1 documents to SemanticProjectSnapshotV1.
 * Delegates to canonical projector from @joy-media/project-schema.
 */

import type { JoyProjectV1, ProjectRevisionId, SemanticProjectSnapshotV1, SnapshotOptions } from '@joy-media/project-schema';
import { projectToSemanticSnapshot } from '@joy-media/project-schema';

/**
 * Service options for creating semantic snapshots.
 * Provides clock injection for deterministic capturedAt timestamps.
 */
export interface ProjectSnapshotServiceOptions {
  /** Clock function to generate deterministic capturedAt timestamps */
  readonly clock?: () => string;
  /** Maximum number of scenes (delegated to projector) */
  readonly maxScenes?: number;
  /** Maximum number of assets (delegated to projector) */
  readonly maxAssets?: number;
  /** Maximum clips per scene (delegated to projector) */
  readonly maxClipsPerScene?: number;
}

/**
 * Pure service for creating semantic project snapshots.
 * API-internal only - no ControlPlane access, persistence, routes, or network calls.
 * Input immutability: the input project is never mutated.
 */
export class ProjectSnapshotService {
  private readonly options: ProjectSnapshotServiceOptions | undefined;

  constructor(options?: ProjectSnapshotServiceOptions) {
    this.options = options;
  }

  /**
   * Convert a JoyProjectV1 document to SemanticProjectSnapshotV1.
   * Delegates to canonical projector `projectToSemanticSnapshot` from @joy-media/project-schema.
   *
   * @param project - The canonical JoyProjectV1 document
   * @param revisionId - The ProjectRevisionId for this snapshot
   * @returns SemanticProjectSnapshotV1 with deterministic capturedAt when clock is provided
   */
  createSnapshot(
    project: JoyProjectV1,
    revisionId: ProjectRevisionId,
  ): SemanticProjectSnapshotV1 {
    if (this.options === undefined) {
      return projectToSemanticSnapshot(project, revisionId);
    }

    const snapshotOptions: SnapshotOptions = {
      ...(this.options.clock !== undefined ? { clock: this.options.clock } : {}),
      ...(this.options.maxScenes !== undefined ? { maxScenes: this.options.maxScenes } : {}),
      ...(this.options.maxAssets !== undefined ? { maxAssets: this.options.maxAssets } : {}),
      ...(this.options.maxClipsPerScene !== undefined ? { maxClipsPerScene: this.options.maxClipsPerScene } : {}),
    };

    return projectToSemanticSnapshot(project, revisionId, snapshotOptions);
  }
}

/**
 * Standalone function for creating snapshots without instantiating the service.
 * Useful for one-off conversions in API handlers.
 *
 * @param project - The canonical JoyProjectV1 document
 * @param revisionId - The ProjectRevisionId for this snapshot
 * @param options - Optional clock injection for deterministic capturedAt
 * @returns SemanticProjectSnapshotV1
 */
export function createProjectSnapshot(
  project: JoyProjectV1,
  revisionId: ProjectRevisionId,
  options?: ProjectSnapshotServiceOptions,
): SemanticProjectSnapshotV1 {
  if (options === undefined) {
    return projectToSemanticSnapshot(project, revisionId);
  }

  const snapshotOptions: SnapshotOptions = {
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.maxScenes !== undefined ? { maxScenes: options.maxScenes } : {}),
    ...(options.maxAssets !== undefined ? { maxAssets: options.maxAssets } : {}),
    ...(options.maxClipsPerScene !== undefined ? { maxClipsPerScene: options.maxClipsPerScene } : {}),
  };

  return projectToSemanticSnapshot(project, revisionId, snapshotOptions);
}
