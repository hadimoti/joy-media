/**
 * The first three specialists (plan §16, Phase 5): captions, audio cleanup, and
 * colour review.
 *
 * Their analyses are deterministic. That is a decision, not a placeholder: a
 * specialist is "a capability and policy bundle" (§8.1), and the bundle is what
 * this phase is proving — scoping, permission, budget, parallelism, conflict
 * detection, and a single transaction authority. Swapping a deterministic
 * analysis for a provider-backed one later changes the body of `analyse` and
 * nothing around it, whereas building the orchestration against a
 * non-reproducible analysis would have made every one of those properties
 * untestable.
 *
 * All three propose `parameters` edits rather than flattened media, per §5.1: a
 * colour result is an editable parameter change set, not a rendered video.
 */

import type { CaptionClipV1, ClipV1 } from '@joy-media/project-schema';
import type {
  ChangeSetProposal,
  ProposedEdit,
  SpecialistContext,
  SpecialistDefinition,
} from './specialists.js';

const LOCAL_ONLY = { localOnly: true } as const;

/** Caption lines below this read as clipped rather than deliberate. */
const MIN_CAPTION_DURATION_US = 400_000;

function inScope(context: SpecialistContext, id: string): boolean {
  return context.scope.clipIds.length === 0 || context.scope.clipIds.includes(id);
}

function captionClips(context: SpecialistContext): readonly CaptionClipV1[] {
  const composition = context.creative.compositions[context.creative.rootCompositionId];
  return (composition?.tracks ?? [])
    .filter((track) => track.kind === 'caption')
    .flatMap((track) => track.clips)
    .filter((clip): clip is CaptionClipV1 => clip.kind === 'caption');
}

export const CAPTION_AGENT: SpecialistDefinition = {
  roleId: 'caption-agent',
  capability: 'captions.review',
  label: 'Caption review',
  // Read-only: proposing a caption change needs no write authority.
  requiredCapabilities: ['timeline.read'],
  analyse(context): ChangeSetProposal {
    const composition = context.creative.compositions[context.creative.rootCompositionId];
    const durationUs = composition?.durationUs ?? 0;
    const clips = captionClips(context).filter((clip) => inScope(context, clip.id));
    const findings: string[] = [];
    const edits: ProposedEdit[] = [];
    const warnings: string[] = [];

    const sorted = [...clips].sort((left, right) => left.startUs - right.startUs);
    sorted.forEach((clip, index) => {
      const endUs = clip.startUs + clip.durationUs;
      if (durationUs > 0 && endUs > durationUs) {
        findings.push(`"${clip.id}" runs ${formatUs(endUs - durationUs)} past the sequence end.`);
        edits.push({
          targetId: clip.id,
          summary: `Trim caption to the sequence end`,
          domain: 'parameters',
          parameters: { durationUs: Math.max(MIN_CAPTION_DURATION_US, durationUs - clip.startUs) },
        });
      }
      const next = sorted[index + 1];
      if (next !== undefined && endUs > next.startUs) {
        findings.push(`"${clip.id}" overlaps "${next.id}" by ${formatUs(endUs - next.startUs)}.`);
        edits.push({
          targetId: clip.id,
          summary: `End caption before "${next.id}" begins`,
          domain: 'parameters',
          parameters: {
            durationUs: Math.max(MIN_CAPTION_DURATION_US, next.startUs - clip.startUs),
          },
        });
      }
      if (clip.durationUs < MIN_CAPTION_DURATION_US) {
        warnings.push(`"${clip.id}" is only ${formatUs(clip.durationUs)} — likely unreadable.`);
      }
      const document = context.creative.captionDocuments[clip.captionDocumentId];
      if (document !== undefined && Object.keys(document.words).length === 0) {
        warnings.push(`"${clip.captionDocumentId}" has no words yet.`);
      }
    });

    if (findings.length === 0) {
      findings.push(`${clips.length} caption clip(s) checked; timing looks clean.`);
    }

    return {
      roleId: CAPTION_AGENT.roleId,
      capability: CAPTION_AGENT.capability,
      title: 'Caption review',
      findings,
      edits,
      estimatedCost: LOCAL_ONLY,
      warnings,
    };
  },
};

export const AUDIO_CLEANUP_AGENT: SpecialistDefinition = {
  roleId: 'audio-cleanup-agent',
  capability: 'audio.cleanup.propose',
  label: 'Audio cleanup',
  requiredCapabilities: ['timeline.read'],
  analyse(context): ChangeSetProposal {
    const composition = context.timeline.compositions[context.scope.compositionId];
    const clips = (composition?.tracks ?? [])
      .flatMap((track) => track.clips)
      .filter((clip) => inScope(context, clip.id));
    const audio = context.creative.audio?.clips ?? {};
    const findings: string[] = [];
    const edits: ProposedEdit[] = [];
    const warnings: string[] = [];

    for (const clip of clips) {
      const config = audio[clip.id];
      if (config === undefined) {
        findings.push(`"${clip.id}" has no audio settings; it plays at raw source level.`);
        edits.push({
          targetId: clip.id,
          summary: 'Normalize to unity gain, centred',
          domain: 'parameters',
          parameters: { gain: 1, pan: 0 },
        });
        continue;
      }
      if (config.mute) {
        warnings.push(`"${clip.id}" is muted; cleanup would have no audible effect.`);
        continue;
      }
      // A clip well above unity is the usual cause of a mix that clips on export.
      if (config.gain > 1.5) {
        findings.push(`"${clip.id}" is ${config.gain.toFixed(2)}× — likely to clip on export.`);
        edits.push({
          targetId: clip.id,
          summary: `Reduce gain from ${config.gain.toFixed(2)}× to 1.00×`,
          domain: 'parameters',
          parameters: { gain: 1 },
        });
      }
      if (Math.abs(config.pan) > 0.8) {
        warnings.push(`"${clip.id}" is panned hard (${config.pan.toFixed(2)}).`);
      }
    }

    if (findings.length === 0) {
      findings.push(`${clips.length} clip(s) checked; levels look consistent.`);
    }

    return {
      roleId: AUDIO_CLEANUP_AGENT.roleId,
      capability: AUDIO_CLEANUP_AGENT.capability,
      title: 'Audio cleanup',
      findings,
      edits,
      estimatedCost: LOCAL_ONLY,
      warnings,
    };
  },
};

export const COLOR_REVIEW_AGENT: SpecialistDefinition = {
  roleId: 'color-review-agent',
  capability: 'video.color.review',
  label: 'Color review',
  requiredCapabilities: ['timeline.read'],
  analyse(context): ChangeSetProposal {
    const grade = context.creative.colorGrade;
    const composition = context.timeline.compositions[context.scope.compositionId];
    const videoClips = (composition?.tracks ?? [])
      .flatMap((track) => track.clips)
      .filter((clip): clip is Extract<ClipV1, { kind: 'video' }> => clip.kind === 'video')
      .filter((clip) => inScope(context, clip.id));
    const sources = new Set(videoClips.map((clip) => clip.assetId));
    const findings: string[] = [];
    const edits: ProposedEdit[] = [];
    const warnings: string[] = [];

    if (grade === undefined) {
      findings.push('No master grade is set; the sequence renders flat.');
      edits.push({
        targetId: 'colorGrade',
        summary: 'Apply a neutral Rec.709 base grade',
        domain: 'parameters',
        parameters: { lift: 0, gamma: 1, gain: 1, saturation: 1.05, lutId: 'rec709' },
      });
    } else if (grade.saturation > 1.6) {
      findings.push(`Saturation is ${grade.saturation.toFixed(2)} — beyond broadcast-safe.`);
      edits.push({
        targetId: 'colorGrade',
        summary: `Reduce saturation from ${grade.saturation.toFixed(2)} to 1.20`,
        domain: 'parameters',
        parameters: { saturation: 1.2 },
      });
    } else {
      findings.push('Master grade is within a sane range.');
    }

    if (sources.size > 1) {
      // A shared master grade cannot fix per-source differences, so this is
      // reported rather than "fixed" with an edit that would not work.
      warnings.push(
        `${sources.size} distinct sources in scope; a single master grade will not match them.`,
      );
    }

    return {
      roleId: COLOR_REVIEW_AGENT.roleId,
      capability: COLOR_REVIEW_AGENT.capability,
      title: 'Color review',
      findings,
      edits,
      estimatedCost: LOCAL_ONLY,
      warnings,
    };
  },
};

/**
 * A hole this long between two shots reads as dead air rather than a beat.
 * Below it, a gap is usually deliberate pacing and closing it would be wrong.
 */
const MIN_REPORTABLE_GAP_US = 500_000;

/**
 * The first specialist that proposes in the `timeline` domain.
 *
 * Where a clip sits is a timeline command, not a document parameter, so this
 * proposal reaches the project through the timeline bus while the other three
 * go through the document — one approval, one transaction, one undo.
 *
 * It only closes gaps *between* clips. A hole before the first shot is usually
 * a deliberate beat at the top of the sequence, and proposing to delete it
 * would be a guess about intent rather than a finding.
 */
export const PACING_AGENT: SpecialistDefinition = {
  roleId: 'pacing-agent',
  capability: 'timeline.pacing.review',
  label: 'Pacing review',
  requiredCapabilities: ['timeline.read'],
  analyse(context): ChangeSetProposal {
    const composition = context.timeline.compositions[context.scope.compositionId];
    const findings: string[] = [];
    const edits: ProposedEdit[] = [];
    const warnings: string[] = [];
    let checked = 0;

    for (const track of composition?.tracks ?? []) {
      const sorted = [...track.clips].sort((left, right) => left.startUs - right.startUs);
      checked += sorted.length;
      const first = sorted[0];
      if (first === undefined) continue;
      // The cursor is where the previous clip ends *after* any move proposed for
      // it, so a run of gaps closes up rather than each proposal contradicting
      // the one before it.
      let cursorUs = first.startUs + first.durationUs;
      for (const clip of sorted.slice(1)) {
        const gapUs = clip.startUs - cursorUs;
        if (gapUs < MIN_REPORTABLE_GAP_US) {
          cursorUs = clip.startUs + clip.durationUs;
          continue;
        }
        if (!inScope(context, clip.id)) {
          warnings.push(`"${clip.id}" opens a ${formatUs(gapUs)} gap but is outside the scope.`);
          cursorUs = clip.startUs + clip.durationUs;
          continue;
        }
        findings.push(`${formatUs(gapUs)} of dead air before "${clip.id}".`);
        edits.push({
          targetId: clip.id,
          summary: `Pull "${clip.id}" ${formatUs(gapUs)} earlier to close the gap`,
          domain: 'timeline',
          parameters: { startUs: cursorUs },
        });
        cursorUs += clip.durationUs;
      }
    }

    if (findings.length === 0) {
      findings.push(`${checked} clip(s) checked; no gap over ${formatUs(MIN_REPORTABLE_GAP_US)}.`);
    }

    return {
      roleId: PACING_AGENT.roleId,
      capability: PACING_AGENT.capability,
      title: 'Pacing review',
      findings,
      edits,
      estimatedCost: LOCAL_ONLY,
      warnings,
    };
  },
};

export const BUILT_IN_SPECIALISTS: readonly SpecialistDefinition[] = [
  CAPTION_AGENT,
  AUDIO_CLEANUP_AGENT,
  COLOR_REVIEW_AGENT,
  PACING_AGENT,
];

function formatUs(valueUs: number): string {
  return `${(valueUs / 1_000_000).toFixed(2)}s`;
}
