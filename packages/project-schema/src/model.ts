/**
 * P00 spike subset of the project model (master plan §10.2–§10.5, §36-P0-1).
 *
 * Deliberately minimal: video clips with source ranges and nested composition
 * clips — just enough for exact frame evaluation tests. Schema v1 with the full
 * clip taxonomy, migrations, and generated validators lands in P01 (WP-01.1).
 * `schemaVersion: 0` marks documents produced by this spike.
 */

import type { Rational, TimeUs } from './time.js';
import { clipTimeRange, rational } from './time.js';

export type ProjectId = string;
export type CompositionId = string;
export type TrackId = string;
export type ClipId = string;
export type AssetId = string;

export interface SpikeProject {
  readonly schemaVersion: 0;
  readonly id: ProjectId;
  readonly rootCompositionId: CompositionId;
  readonly compositions: Readonly<Record<CompositionId, Composition>>;
}

export interface Composition {
  readonly id: CompositionId;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly frameRate: Rational;
  readonly durationUs: number;
  readonly tracks: readonly Track[];
}

export interface Track {
  readonly id: TrackId;
  readonly kind: 'video';
  /** Draw order: ascending = bottom to top. */
  readonly order: number;
  readonly enabled: boolean;
  readonly clips: readonly Clip[];
}

interface ClipBase {
  readonly id: ClipId;
  readonly startUs: TimeUs;
  readonly durationUs: number;
}

export interface VideoClip extends ClipBase {
  readonly kind: 'video';
  readonly assetId: AssetId;
  /** Source in-point: composition time t maps to sourceInUs + (t - startUs). */
  readonly sourceInUs: TimeUs;
}

export interface CompositionClip extends ClipBase {
  readonly kind: 'composition';
  readonly compositionId: CompositionId;
  /** Child-composition time at the clip's start (0 = child plays from its beginning). */
  readonly childOffsetUs: TimeUs;
}

export type Clip = VideoClip | CompositionClip;

export interface ProjectDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

/**
 * Structural validation for the spike model. Returns diagnostics instead of
 * throwing so callers can report all problems at once (§28.3 spirit).
 */
export function validateSpikeProject(project: SpikeProject): ProjectDiagnostic[] {
  const diagnostics: ProjectDiagnostic[] = [];

  const root = project.compositions[project.rootCompositionId];
  if (root === undefined) {
    diagnostics.push({
      code: 'PROJECT_SCHEMA_MISSING_ROOT',
      message: `rootCompositionId "${project.rootCompositionId}" is not in compositions`,
      path: 'rootCompositionId',
    });
  }

  for (const [compId, comp] of Object.entries(project.compositions)) {
    try {
      rational(comp.frameRate.num, comp.frameRate.den);
    } catch (error) {
      diagnostics.push({
        code: 'PROJECT_SCHEMA_BAD_FRAME_RATE',
        message: (error as Error).message,
        path: `compositions.${compId}.frameRate`,
      });
    }
    for (const track of comp.tracks) {
      for (const clip of track.clips) {
        const path = `compositions.${compId}.tracks.${track.id}.clips.${clip.id}`;
        try {
          clipTimeRange(clip.startUs, clip.durationUs);
        } catch (error) {
          diagnostics.push({
            code: 'PROJECT_SCHEMA_BAD_CLIP_RANGE',
            message: (error as Error).message,
            path,
          });
        }
        if (clip.kind === 'composition' && project.compositions[clip.compositionId] === undefined) {
          diagnostics.push({
            code: 'PROJECT_SCHEMA_MISSING_COMPOSITION',
            message: `clip references unknown composition "${clip.compositionId}"`,
            path,
          });
        }
      }
    }
  }

  diagnostics.push(...detectCompositionCycles(project));
  return diagnostics;
}

/** Nested compositions must not recurse (§19.6). */
function detectCompositionCycles(project: SpikeProject): ProjectDiagnostic[] {
  const diagnostics: ProjectDiagnostic[] = [];
  const visiting = new Set<CompositionId>();
  const done = new Set<CompositionId>();

  const visit = (compId: CompositionId, path: readonly CompositionId[]): void => {
    if (done.has(compId)) return;
    if (visiting.has(compId)) {
      diagnostics.push({
        code: 'PROJECT_SCHEMA_COMPOSITION_CYCLE',
        message: `composition cycle: ${[...path, compId].join(' -> ')}`,
        path: `compositions.${compId}`,
      });
      return;
    }
    const comp = project.compositions[compId];
    if (comp === undefined) return;
    visiting.add(compId);
    for (const track of comp.tracks) {
      for (const clip of track.clips) {
        if (clip.kind === 'composition') {
          visit(clip.compositionId, [...path, compId]);
        }
      }
    }
    visiting.delete(compId);
    done.add(compId);
  };

  for (const compId of Object.keys(project.compositions)) {
    visit(compId, []);
  }
  return diagnostics;
}
