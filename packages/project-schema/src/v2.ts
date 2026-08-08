/**
 * Schema v2 — the v1 creative document plus the Dual Lens durable slices.
 *
 * v2 is deliberately *additive*. Every v1 field keeps its meaning and position,
 * and the three new containers (`artifacts`, `artifactVersions`, `workflow`)
 * are optional. A v1 document is therefore a valid v2 document with the graph
 * empty, which is what lets Phase 1 land the schema without touching a single
 * editing surface: nothing reads these fields until Phase 3 does.
 *
 * The alternative — reshaping `JoyProjectV1` in place — would have forced every
 * consumer to move at once, for a feature none of them use yet.
 */

import type { ProjectDiagnostic } from './model.js';
import type { JoyProjectV1 } from './v1.js';
import { validateJoyProjectV1 } from './v1.js';
import type { ArtifactVersionV2, CreativeArtifactV2, WorkflowGraphV2 } from './creative.js';
import { validateCreativeArtifact, validateWorkflowGraph } from './creative.js';

export const LATEST_PROJECT_SCHEMA_VERSION = 2;

export interface JoyProjectV2 extends Omit<JoyProjectV1, 'schemaVersion'> {
  readonly schemaVersion: 2;
  /** Durable identity for scripts, prompts, analyses, change sets, and media. */
  readonly artifacts?: Readonly<Record<string, CreativeArtifactV2>>;
  /** Retained earlier artifact states, for compare / pin / promote / fork. */
  readonly artifactVersions?: Readonly<Record<string, readonly ArtifactVersionV2[]>>;
  /** The persisted workflow DAG. Absent means the project has no graph. */
  readonly workflow?: WorkflowGraphV2;
}

export type AnyJoyProject = JoyProjectV1 | JoyProjectV2;

export function isJoyProjectV2(project: AnyJoyProject): project is JoyProjectV2 {
  return project.schemaVersion === 2;
}

export function validateJoyProjectV2(value: unknown): ProjectDiagnostic[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [
      { code: 'PROJECT_SCHEMA_V2_NOT_OBJECT', message: 'project must be an object', path: '' },
    ];
  }
  const candidate = value as Record<string, unknown>;
  const diagnostics: ProjectDiagnostic[] = [];

  if (candidate.schemaVersion !== 2) {
    diagnostics.push({
      code: 'PROJECT_SCHEMA_V2_VERSION',
      message: 'schemaVersion must be 2',
      path: 'schemaVersion',
    });
  }

  // The v1 body is validated by the v1 validator rather than a reimplementation,
  // so the two can never disagree about what a composition or a clip is. Its
  // version check is the one rule that does not apply here.
  diagnostics.push(
    ...validateJoyProjectV1({ ...candidate, schemaVersion: 1 }).filter(
      (entry) => entry.code !== 'PROJECT_SCHEMA_V1_VERSION',
    ),
  );

  const artifacts = candidate.artifacts;
  const artifactIds = new Set<string>();
  if (artifacts !== undefined) {
    if (artifacts === null || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
      diagnostics.push({
        code: 'PROJECT_SCHEMA_V2_ARTIFACTS',
        message: 'artifacts must be an object keyed by artifact id',
        path: 'artifacts',
      });
    } else {
      for (const [key, artifact] of Object.entries(artifacts as Record<string, unknown>)) {
        artifactIds.add(key);
        diagnostics.push(...validateCreativeArtifact(artifact, `artifacts.${key}`));
        // A record whose key disagrees with the artifact's own id makes every
        // lookup ambiguous depending on which one the caller happened to use.
        if (
          artifact !== null &&
          typeof artifact === 'object' &&
          (artifact as Record<string, unknown>).id !== key
        ) {
          diagnostics.push({
            code: 'PROJECT_SCHEMA_V2_ARTIFACT_KEY',
            message: `artifacts key "${key}" does not match the artifact's id`,
            path: `artifacts.${key}.id`,
          });
        }
      }
    }
  }

  const versions = candidate.artifactVersions;
  if (versions !== undefined) {
    if (versions === null || typeof versions !== 'object' || Array.isArray(versions)) {
      diagnostics.push({
        code: 'PROJECT_SCHEMA_V2_VERSIONS',
        message: 'artifactVersions must be an object keyed by artifact id',
        path: 'artifactVersions',
      });
    } else {
      for (const [key, list] of Object.entries(versions as Record<string, unknown>)) {
        if (!Array.isArray(list)) {
          diagnostics.push({
            code: 'PROJECT_SCHEMA_V2_VERSION_LIST',
            message: 'artifactVersions entries must be arrays',
            path: `artifactVersions.${key}`,
          });
          continue;
        }
        // Versions of an artifact that no longer exists are unreachable history
        // that would keep its media alive forever with nothing able to show it.
        if (artifacts !== undefined && !artifactIds.has(key)) {
          diagnostics.push({
            code: 'PROJECT_SCHEMA_V2_VERSION_ORPHAN',
            message: `artifactVersions references unknown artifact "${key}"`,
            path: `artifactVersions.${key}`,
          });
        }
      }
    }
  }

  if (candidate.workflow !== undefined) {
    diagnostics.push(...validateWorkflowGraph(candidate.workflow, 'workflow'));
  }

  return diagnostics;
}
