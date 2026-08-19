/**
 * Project Intelligence Service - WP-37 S4 Phase 3-A
 * Pure API-internal service that converts SemanticProjectSnapshotV1 to S2 intelligence result.
 * Delegates to canonical computeSemanticIntelligence from @joy-media/project-schema.
 */

import type { SemanticProjectSnapshotV1 } from '@joy-media/project-schema';
import type {
  BrandReadinessV1,
  SceneCoverageV1,
  ProjectReadinessV1,
  IntelligenceRuleV1,
} from '@joy-media/project-schema';
import { computeSemanticIntelligence } from '@joy-media/project-schema';

/**
 * The S2 intelligence result - canonical output of semantic intelligence computation.
 */
export interface S2IntelligenceResult {
  readonly brandReadiness: BrandReadinessV1;
  readonly sceneCoverages: readonly SceneCoverageV1[];
  readonly projectReadiness: ProjectReadinessV1;
  readonly allRules: readonly IntelligenceRuleV1[];
}

/**
 * Pure service for computing semantic intelligence from a snapshot.
 * API-internal only - no ControlPlane access, persistence, routes, or network calls.
 * Input immutability: the input snapshot is never mutated.
 */
export class ProjectIntelligenceService {
  /**
   * Compute S2 intelligence from a semantic project snapshot.
   * Delegates directly to canonical computeSemanticIntelligence from @joy-media/project-schema.
   *
   * @param snapshot - The SemanticProjectSnapshotV1 to analyze
   * @returns S2IntelligenceResult with brand readiness, scene coverages, project readiness, and all rules
   */
  computeIntelligence(snapshot: SemanticProjectSnapshotV1): S2IntelligenceResult {
    return computeSemanticIntelligence(snapshot);
  }
}

/**
 * Standalone function for computing intelligence without instantiating the service.
 * Useful for one-off conversions in API handlers.
 *
 * @param snapshot - The SemanticProjectSnapshotV1 to analyze
 * @returns S2IntelligenceResult with brand readiness, scene coverages, project readiness, and all rules
 */
export function computeProjectIntelligence(
  snapshot: SemanticProjectSnapshotV1,
): S2IntelligenceResult {
  return computeSemanticIntelligence(snapshot);
}
