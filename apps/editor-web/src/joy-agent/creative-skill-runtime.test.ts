import { describe, expect, it } from 'vitest';
import { resolveCreativeSkillAvailability } from '@joy-media/agent-tools';
import {
  R1_EDITOR_CREATIVE_SKILL_SEAMS,
  computeCreativeSkillCapabilities,
  createEditorCreativeSkillRuntime,
} from './creative-skill-runtime.js';

describe('creative skill runtime capability computation', () => {
  it('maps only verified seams to capabilities', () => {
    expect(
      computeCreativeSkillCapabilities({
        projectContext: true,
        canonicalPrepare: true,
        preview: true,
        approval: true,
        observationBridge: false,
        transcriptEvidence: false,
        audioAnalysis: false,
        compositionCapture: false,
        encodedOutputVerification: false,
        audioMix: false,
        rtlTextReadback: false,
      }),
    ).toEqual(['project-context', 'canonical-prepare', 'preview', 'approval']);
  });

  it('adds observation, transcript, audio, composition and encoded-output when their seams are present', () => {
    const capabilities = computeCreativeSkillCapabilities({
      ...R1_EDITOR_CREATIVE_SKILL_SEAMS,
    });
    expect(capabilities).toEqual(
      expect.arrayContaining([
        'source-observation',
        'evidence-coverage',
        'transcript-evidence',
        'audio-analysis',
        'composition-capture',
        'encoded-output-verification',
      ]),
    );
  });

  it('keeps audio-mix and rtl-text out of the R1 capability set', () => {
    const capabilities = computeCreativeSkillCapabilities(R1_EDITOR_CREATIVE_SKILL_SEAMS);
    expect(capabilities).not.toContain('audio-mix');
    expect(capabilities).not.toContain('rtl-text');
  });

  it('produces a runtime whose availability leaves audio-balance and title-and-caption-polish visible-unavailable', () => {
    const runtime = createEditorCreativeSkillRuntime(R1_EDITOR_CREATIVE_SKILL_SEAMS);
    const availability = resolveCreativeSkillAvailability(runtime);
    const byId = new Map(availability.map((entry) => [entry.skill.id, entry]));

    expect(byId.get('creative-brief')?.available).toBe(true);
    expect(byId.get('watch-and-map')?.available).toBe(true);
    expect(byId.get('find-moment')?.available).toBe(true);
    expect(byId.get('build-rough-cut')?.available).toBe(true);
    expect(byId.get('motion-and-transition-polish')?.available).toBe(true);
    expect(byId.get('verify-deliverable')?.available).toBe(true);

    expect(byId.get('audio-balance')?.available).toBe(false);
    expect(byId.get('audio-balance')?.missingCapabilities).toContain('audio-mix');
    expect(byId.get('title-and-caption-polish')?.available).toBe(false);
    expect(byId.get('title-and-caption-polish')?.missingCapabilities).toContain('rtl-text');
  });

  it('withholds observation-dependent recipes when the observation bridge is absent', () => {
    const runtime = createEditorCreativeSkillRuntime({
      ...R1_EDITOR_CREATIVE_SKILL_SEAMS,
      observationBridge: false,
      transcriptEvidence: false,
      audioAnalysis: false,
    });
    const byId = new Map(
      resolveCreativeSkillAvailability(runtime).map((entry) => [entry.skill.id, entry]),
    );
    expect(byId.get('watch-and-map')?.available).toBe(false);
    expect(byId.get('watch-and-map')?.missingCapabilities).toContain('source-observation');
    expect(byId.get('creative-brief')?.available).toBe(true);
  });
});
