import type { CreativeBriefV1 } from '@joy-media/agent-tools';

export interface CreativeBriefMetric {
  readonly id: 'duration' | 'aspect-ratio' | 'scenes' | 'destination' | 'brand';
  readonly label: string;
  readonly value: string;
}

/** Format a non-negative microsecond duration without locale-dependent output. */
export function formatBriefDurationUs(durationUs: number): string {
  const safeDurationUs =
    Number.isFinite(durationUs) && durationUs >= 0 ? Math.floor(durationUs) : 0;
  const totalSeconds = Math.floor(safeDurationUs / 1_000_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`;
}

function formatClockDurationUs(durationUs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationUs / 1_000_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export interface CreativeBriefEvidence {
  readonly startUs?: number;
  readonly endUs?: number;
  readonly sceneIds?: readonly string[];
  readonly elementIds?: readonly string[];
  readonly detail?: string;
}

export function formatBriefEvidence(evidence: readonly CreativeBriefEvidence[]): string {
  if (evidence.length === 0) return 'No evidence';

  const parts: string[] = [];
  for (const reference of evidence) {
    if (reference.sceneIds !== undefined && reference.sceneIds.length > 0) {
      parts.push(`scenes: ${reference.sceneIds.join(', ')}`);
    }
    if (reference.elementIds !== undefined && reference.elementIds.length > 0) {
      parts.push(`elements: ${reference.elementIds.join(', ')}`);
    }
    if (reference.startUs !== undefined && reference.endUs !== undefined) {
      parts.push(
        `range: ${formatClockDurationUs(reference.startUs)}–${formatClockDurationUs(reference.endUs)}`,
      );
    }
    if (reference.detail !== undefined && reference.detail.length > 0) {
      parts.push(reference.detail);
    }
  }
  return parts.length > 0 ? parts.join('; ') : 'Evidence available';
}

function createProjectMetrics(
  project: CreativeBriefV1['intelligence']['project'],
  sceneCount: number,
): CreativeBriefMetric[] {
  const metrics: CreativeBriefMetric[] = [];
  const durationUs = project.durationTargetUs ?? project.compositionDurationUs;
  if (durationUs > 0) {
    metrics.push({ id: 'duration', label: 'Duration', value: formatBriefDurationUs(durationUs) });
  }
  if (
    project.aspectRatio !== undefined &&
    project.aspectRatio !== '' &&
    project.aspectRatio !== '0:0'
  ) {
    metrics.push({ id: 'aspect-ratio', label: 'Format', value: project.aspectRatio });
  }
  if (sceneCount >= 0) {
    metrics.push({ id: 'scenes', label: 'Scenes', value: String(sceneCount) });
  }
  if (project.destination !== undefined && project.destination.length > 0) {
    metrics.push({ id: 'destination', label: 'Destination', value: project.destination });
  }
  return metrics;
}

export function createCreativeBriefMetrics(brief: CreativeBriefV1): readonly CreativeBriefMetric[] {
  const metrics = createProjectMetrics(
    brief.intelligence.project,
    brief.intelligence.scenes.length,
  );
  const brandCompleteness = brief.intelligence.brand.brandCompleteness;
  if (brandCompleteness !== undefined && brandCompleteness !== 'none') {
    metrics.push({ id: 'brand', label: 'Brand readiness', value: brandCompleteness });
  }
  return metrics;
}
