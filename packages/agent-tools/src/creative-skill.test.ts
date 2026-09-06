import { describe, expect, it } from 'vitest';
import {
  resolveCreativeSkillAvailability,
  validateCreativeSkillManifest,
} from './creative-skill.js';
import { CREATIVE_SKILLS, getCreativeSkill } from './creative-skills.js';
import { JOY_EDITOR_OPERATION_DEFINITIONS } from './editor-operation-registry.js';

describe('creative skill manifests', () => {
  const fullRuntime = {
    capabilities: [
      'project-context',
      'canonical-prepare',
      'preview',
      'approval',
      'source-observation',
      'evidence-coverage',
      'transcript-evidence',
      'audio-analysis',
      'audio-mix',
      'rtl-text',
      'composition-capture',
      'encoded-output-verification',
    ] as const,
    operationDefinitions: JOY_EDITOR_OPERATION_DEFINITIONS,
  };

  it('ships a bounded recipe for every R1 creative procedure', () => {
    expect(CREATIVE_SKILLS.map((skill) => skill.id)).toEqual([
      'creative-brief',
      'watch-and-map',
      'find-moment',
      'build-rough-cut',
      'title-and-caption-polish',
      'motion-and-transition-polish',
      'audio-balance',
      'verify-deliverable',
    ]);
    for (const skill of CREATIVE_SKILLS) {
      expect(validateCreativeSkillManifest(skill)).toEqual({ valid: true, errors: [] });
      expect(skill.procedure.length).toBeGreaterThan(0);
      expect(skill.postconditions.length).toBeGreaterThan(0);
      expect(skill.fixtureIds.length).toBeGreaterThan(0);
    }
  });

  it('only advertises a recipe after its source-backed operations and runtime capabilities exist', () => {
    const title = getCreativeSkill('title-and-caption-polish');
    expect(title).toBeDefined();
    const available = resolveCreativeSkillAvailability(fullRuntime);
    expect(available.find((item) => item.skill.id === 'title-and-caption-polish')).toMatchObject({
      available: true,
      missingOperations: [],
      missingCapabilities: [],
    });

    const withoutCaptionOperation = resolveCreativeSkillAvailability({
      ...fullRuntime,
      operationDefinitions: JOY_EDITOR_OPERATION_DEFINITIONS.map((definition) =>
        definition.kind === 'caption.setSegmentText'
          ? { ...definition, evidence: { ...definition.evidence, status: 'unsupported' as const } }
          : definition,
      ),
    });
    expect(
      withoutCaptionOperation.find((item) => item.skill.id === 'title-and-caption-polish'),
    ).toMatchObject({
      available: false,
      missingOperations: ['caption.setSegmentText'],
    });
  });

  it('keeps audio balance unavailable until a real audio-mix adapter is present', () => {
    const unavailable = resolveCreativeSkillAvailability({
      ...fullRuntime,
      capabilities: fullRuntime.capabilities.filter((capability) => capability !== 'audio-mix'),
    });
    expect(unavailable.find((item) => item.skill.id === 'audio-balance')).toMatchObject({
      available: false,
      missingCapabilities: ['audio-mix'],
    });
  });

  it('rejects a manifest that tries to hide an unsupported operation or unsafe remote capability', () => {
    const base = getCreativeSkill('build-rough-cut');
    if (base === undefined) throw new Error('missing fixture skill');
    expect(
      validateCreativeSkillManifest({
        ...base,
        requiredOperationKinds: ['audio.fakeMix' as never],
      }),
    ).toMatchObject({ valid: false });
    expect(
      validateCreativeSkillManifest({
        ...base,
        title: 'Upload raw video to https://example.invalid',
      }),
    ).toMatchObject({ valid: false });
  });
});
