import type { AgentEditPlan } from './plan.js';
import type { ExecutionResult } from './execution.js';
import type { EditorContext } from './context.js';

export interface VerificationResult {
  readonly planId: string;
  readonly verified: boolean;
  readonly checks: readonly VerificationCheck[];
  readonly warnings: readonly string[];
  readonly summary: string;
}

export interface VerificationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info';
}

export function verifyAgentRun(
  plan: AgentEditPlan,
  executionResult: ExecutionResult,
  context: EditorContext,
  projectState: unknown,
): VerificationResult {
  const checks: VerificationCheck[] = [
    verifyEntitiesExist(plan, projectState),
    verifyNoInvalidOverlaps(plan, projectState),
    verifyGeneratedAssetsDecode(executionResult),
    verifyCaptionsWithinBounds(plan, projectState),
    verifyAudioNotClipped(plan, projectState),
    verifyNoMissingAssets(plan, projectState),
    verifyUserIntentChecks(plan, executionResult),
  ];

  const warnings = checks
    .filter((c) => c.severity === 'warning' && !c.passed)
    .map((c) => c.message);

  const hasErrors = checks.some((c) => c.severity === 'error' && !c.passed);
  const verified = !hasErrors && executionResult.success;

  const summary = verified
    ? `Plan ${plan.planId} applied successfully. All checks passed.`
    : `Plan ${plan.planId} applied with issues. ${checks.filter((c) => !c.passed).length} check(s) failed.`;

  return {
    planId: plan.planId,
    verified,
    checks,
    warnings,
    summary,
  };
}

export function verifyEntitiesExist(plan: AgentEditPlan, projectState: unknown): VerificationCheck {
  const state = projectState as Record<string, unknown> | null;
  if (!state || typeof state !== 'object') {
    return {
      name: 'entities-exist',
      passed: false,
      message: 'Project state is not available',
      severity: 'error',
    };
  }

  const expectedEntities = plan.steps
    .filter((step) => step.mode === 'command')
    .map((step) => {
      const args = step.arguments as Record<string, unknown>;
      return args.clip?.id ?? args.entityId ?? args.trackId;
    })
    .filter((id): id is string => typeof id === 'string');

  const compositions = (state.compositions as Record<string, unknown>) ?? {};
  const allClips = new Set<string>();

  for (const comp of Object.values(compositions)) {
    const c = comp as { tracks?: Array<{ clips?: Array<{ id?: string }> }> };
    for (const track of c.tracks ?? []) {
      for (const clip of track.clips ?? []) {
        if (clip.id) allClips.add(clip.id);
      }
    }
  }

  const missingEntities = expectedEntities.filter((id) => !allClips.has(id));

  if (missingEntities.length === 0) {
    return {
      name: 'entities-exist',
      passed: true,
      message: `All ${expectedEntities.length} expected entities exist`,
      severity: 'info',
    };
  }

  return {
    name: 'entities-exist',
    passed: false,
    message: `${missingEntities.length} expected entities missing: ${missingEntities.slice(0, 3).join(', ')}`,
    severity: 'error',
  };
}

export function verifyNoInvalidOverlaps(
  plan: AgentEditPlan,
  projectState: unknown,
): VerificationCheck {
  const state = projectState as Record<string, unknown> | null;
  if (!state || typeof state !== 'object') {
    return {
      name: 'no-invalid-overlaps',
      passed: true,
      message: 'Cannot verify overlaps without project state',
      severity: 'warning',
    };
  }

  const compositions = (state.compositions as Record<string, unknown>) ?? {};
  let overlapCount = 0;

  for (const comp of Object.values(compositions)) {
    const c = comp as {
      tracks?: Array<{ clips?: Array<{ startUs?: number; durationUs?: number }> }>;
    };
    for (const track of c.tracks ?? []) {
      const clips = (track.clips ?? []).sort((a, b) => (a.startUs ?? 0) - (b.startUs ?? 0));
      for (let i = 0; i < clips.length - 1; i++) {
        const current = clips[i];
        const next = clips[i + 1];
        const currentEnd = (current.startUs ?? 0) + (current.durationUs ?? 0);
        const nextStart = next.startUs ?? 0;
        if (currentEnd > nextStart) {
          overlapCount++;
        }
      }
    }
  }

  if (overlapCount === 0) {
    return {
      name: 'no-invalid-overlaps',
      passed: true,
      message: 'No invalid overlaps detected',
      severity: 'info',
    };
  }

  return {
    name: 'no-invalid-overlaps',
    passed: false,
    message: `${overlapCount} invalid overlap(s) detected`,
    severity: 'error',
  };
}

export function verifyGeneratedAssetsDecode(executionResult: ExecutionResult): VerificationCheck {
  const failedAssets = executionResult.stepResults.filter(
    (step) => step.status === 'failed' && step.error?.includes('decode'),
  );

  if (failedAssets.length === 0) {
    return {
      name: 'generated-assets-decode',
      passed: true,
      message: 'All generated assets decode successfully',
      severity: 'info',
    };
  }

  return {
    name: 'generated-assets-decode',
    passed: false,
    message: `${failedAssets.length} generated asset(s) failed to decode`,
    severity: 'error',
  };
}

export function verifyCaptionsWithinBounds(
  plan: AgentEditPlan,
  projectState: unknown,
): VerificationCheck {
  const state = projectState as Record<string, unknown> | null;
  if (!state || typeof state !== 'object') {
    return {
      name: 'captions-within-bounds',
      passed: true,
      message: 'No captions to verify',
      severity: 'info',
    };
  }

  const captionSteps = plan.steps.filter((step) => step.tool.toLowerCase().includes('caption'));

  if (captionSteps.length === 0) {
    return {
      name: 'captions-within-bounds',
      passed: true,
      message: 'No caption operations to verify',
      severity: 'info',
    };
  }

  const compositions = (state.compositions as Record<string, unknown>) ?? {};
  const rootComp = compositions[state.rootCompositionId as string] as
    { durationUs?: number } | undefined;
  const projectDuration = rootComp?.durationUs ?? 0;

  let outOfBoundsCount = 0;

  for (const comp of Object.values(compositions)) {
    const c = comp as {
      tracks?: Array<{
        kind?: string;
        clips?: Array<{ startUs?: number; durationUs?: number }>;
      }>;
    };
    for (const track of c.tracks ?? []) {
      if (track.kind !== 'caption') continue;
      for (const clip of track.clips ?? []) {
        const end = (clip.startUs ?? 0) + (clip.durationUs ?? 0);
        if (end > projectDuration) {
          outOfBoundsCount++;
        }
      }
    }
  }

  if (outOfBoundsCount === 0) {
    return {
      name: 'captions-within-bounds',
      passed: true,
      message: 'All captions within project bounds',
      severity: 'info',
    };
  }

  return {
    name: 'captions-within-bounds',
    passed: false,
    message: `${outOfBoundsCount} caption(s) exceed project bounds`,
    severity: 'error',
  };
}

export function verifyAudioNotClipped(
  plan: AgentEditPlan,
  projectState: unknown,
): VerificationCheck {
  const state = projectState as Record<string, unknown> | null;
  if (!state || typeof state !== 'object') {
    return {
      name: 'audio-not-clipped',
      passed: true,
      message: 'No audio to verify',
      severity: 'info',
    };
  }

  const audioSteps = plan.steps.filter(
    (step) => step.tool.toLowerCase().includes('gain') || step.tool.toLowerCase().includes('audio'),
  );

  if (audioSteps.length === 0) {
    return {
      name: 'audio-not-clipped',
      passed: true,
      message: 'No audio operations to verify',
      severity: 'info',
    };
  }

  const audioState = state.audio as { peakLevelDb?: number } | undefined;
  const peakLevel = audioState?.peakLevelDb ?? 0;

  if (peakLevel < 0) {
    return {
      name: 'audio-not-clipped',
      passed: true,
      message: `Audio peak at ${peakLevel.toFixed(1)} dB (below clipping threshold)`,
      severity: 'info',
    };
  }

  return {
    name: 'audio-not-clipped',
    passed: false,
    message: `Audio peak at ${peakLevel.toFixed(1)} dB (clipping detected)`,
    severity: 'warning',
  };
}

export function verifyNoMissingAssets(
  plan: AgentEditPlan,
  projectState: unknown,
): VerificationCheck {
  const state = projectState as Record<string, unknown> | null;
  if (!state || typeof state !== 'object') {
    return {
      name: 'no-missing-assets',
      passed: true,
      message: 'Cannot verify assets without project state',
      severity: 'warning',
    };
  }

  const compositions = (state.compositions as Record<string, unknown>) ?? {};
  const declaredAssets = new Set(Object.keys((state.assets as Record<string, unknown>) ?? {}));
  const referencedAssets = new Set<string>();

  for (const comp of Object.values(compositions)) {
    const c = comp as {
      tracks?: Array<{ clips?: Array<{ kind?: string; assetId?: string }> }>;
    };
    for (const track of c.tracks ?? []) {
      for (const clip of track.clips ?? []) {
        if (clip.kind === 'video' && clip.assetId) {
          referencedAssets.add(clip.assetId);
        }
      }
    }
  }

  const missingAssets = [...referencedAssets].filter((id) => !declaredAssets.has(id));

  if (missingAssets.length === 0) {
    return {
      name: 'no-missing-assets',
      passed: true,
      message: `All ${referencedAssets.size} referenced assets present`,
      severity: 'info',
    };
  }

  return {
    name: 'no-missing-assets',
    passed: false,
    message: `${missingAssets.length} required asset(s) missing`,
    severity: 'error',
  };
}

export function verifyUserIntentChecks(
  plan: AgentEditPlan,
  executionResult: ExecutionResult,
): VerificationCheck {
  const failedSteps = executionResult.stepResults.filter(
    (step) => step.status === 'failed' || step.status === 'blocked-by-policy',
  );

  if (failedSteps.length === 0) {
    return {
      name: 'user-intent-checks',
      passed: true,
      message: `All ${plan.steps.length} steps executed as intended`,
      severity: 'info',
    };
  }

  return {
    name: 'user-intent-checks',
    passed: false,
    message: `${failedSteps.length} of ${plan.steps.length} steps did not complete as intended`,
    severity: 'warning',
  };
}
