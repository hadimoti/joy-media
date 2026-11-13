import { describe, expect, it } from 'vitest';
import {
  LEGACY_TRANSITION_ALIASES,
  getTransitionShader,
  isKnownTransitionType,
  listTransitionShaders,
  listTransitionUniformDescriptors,
  mergeTransitionParams,
  resolveTransitionShaderId,
} from './index.js';

/** T-V08: the three doubles of LIBRARY-AUDIT.md Table 2 are gone, and old ids still open. */
const REMOVED_TO_KEPT = {
  dissolve: 'gl:fade',
  wipe: 'gl:wipeLeft',
  slide: 'gl:Directional',
} as const;

describe('old transition id mapping', () => {
  it('maps exactly the three removed ids onto their kept partners', () => {
    expect(LEGACY_TRANSITION_ALIASES).toEqual(REMOVED_TO_KEPT);
  });

  it.each(Object.entries(REMOVED_TO_KEPT))('%s opens as %s', (oldId, keptId) => {
    const ids = listTransitionShaders().map((entry) => entry.id);
    expect(ids).not.toContain(oldId);
    expect(ids).toContain(keptId);
    expect(resolveTransitionShaderId(oldId)).toBe(keptId);
    expect(isKnownTransitionType(oldId)).toBe(true);
    expect(getTransitionShader(oldId)).toBe(getTransitionShader(keptId));
    expect(mergeTransitionParams(oldId, undefined)).toEqual(
      mergeTransitionParams(keptId, undefined),
    );
    expect(listTransitionUniformDescriptors(oldId)).toEqual(
      listTransitionUniformDescriptors(keptId),
    );
  });

  it('keeps the audit labels for the kept partners', () => {
    expect(getTransitionShader('gl:fade')?.label).toBe('Dissolve');
    expect(getTransitionShader('gl:wipeLeft')?.label).toBe('Wipe Left');
    expect(getTransitionShader('gl:Directional')?.label).toBe('Slide');
  });

  it('leaves current ids and unknown ids alone', () => {
    expect(resolveTransitionShaderId('gl:CrossZoom')).toBe('gl:CrossZoom');
    expect(resolveTransitionShaderId('gl:nope')).toBe('gl:nope');
    expect(resolveTransitionShaderId('toString')).toBe('toString');
    expect(isKnownTransitionType('toString')).toBe(false);
  });
});
