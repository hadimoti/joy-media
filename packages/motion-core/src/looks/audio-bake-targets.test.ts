import { describe, expect, it } from 'vitest';
import { musicPulse } from './packs/index.js';
import { editorialClean } from './packs/editorial-clean.js';
import { resolveLookAudioBakeTargets } from './audio-bake-targets.js';

const defaults = (definition: typeof musicPulse) =>
  Object.fromEntries(definition.controls.map((c) => [c.id, c.default]));

describe('resolveLookAudioBakeTargets', () => {
  it('returns Music Pulse subject-scale bindings with their rest/peak pair', () => {
    const targets = resolveLookAudioBakeTargets(musicPulse, defaults(musicPulse));
    const byId = new Map(targets.map((t) => [t.bindingId, t]));
    expect(byId.get('subject-scale-x')).toMatchObject({
      propertyId: 'scaleX',
      restValue: 1,
      peakValue: 1.12,
    });
    expect(byId.get('subject-scale-y')).toMatchObject({ restValue: 1, peakValue: 1.12 });
    // Template-swap bindings are never bake targets.
    expect(byId.has('subject-treatment')).toBe(false);
    expect(byId.has('caption-treatment')).toBe(false);
  });

  it('omits a boolean drive that is currently off', () => {
    const off = resolveLookAudioBakeTargets(musicPulse, {
      ...defaults(musicPulse),
      accent: false,
    });
    expect(off.some((t) => t.bindingId === 'accent-opacity')).toBe(false);

    const on = resolveLookAudioBakeTargets(musicPulse, {
      ...defaults(musicPulse),
      accent: true,
    });
    expect(on.some((t) => t.bindingId === 'accent-opacity')).toBe(true);
  });

  it('resolves a scalar drive against the operator control value', () => {
    const targets = resolveLookAudioBakeTargets(editorialClean, {
      ...defaults(editorialClean),
      energy: 1,
    });
    // energy drives keyframe bindings between their min and the mapped max.
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.peakValue).not.toBe(target.restValue);
    }
  });

  it('returns nothing for a definition whose controls only drive template swaps', () => {
    const templateOnly = {
      ...musicPulse,
      bindingTargets: musicPulse.bindingTargets.filter((t) => t.channel !== 'keyframe'),
      controls: musicPulse.controls.filter((c) => c.kind === 'color'),
    } as typeof musicPulse;
    expect(resolveLookAudioBakeTargets(templateOnly, defaults(musicPulse))).toEqual([]);
  });
});
