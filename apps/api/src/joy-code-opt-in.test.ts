import { describe, expect, it } from 'vitest';
import { LocalControlPlane, type Actor } from './control-plane.js';
import { JOY_CODE_CONSENT_VERSION } from './joy-code-runtime-config.js';

const owner: Actor = { id: 'owner-1' };

describe('Joy Code versioned opt-in', () => {
  it('defaults disabled and requires the current disclosure version to enable', () => {
    const plane = new LocalControlPlane();
    plane.createProject(owner, 'project-1', 'Test');
    expect(plane.getJoyCodeOptIn(owner, 'project-1')).toEqual({
      enabled: false,
      consentVersion: undefined,
      revision: 0,
    });
    try {
      plane.setJoyCodeOptIn(owner, 'project-1', true, 'old-version', 0);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'JOY_CODE_CONSENT_VERSION_REQUIRED' });
    }
    const enabled = plane.setJoyCodeOptIn(owner, 'project-1', true, JOY_CODE_CONSENT_VERSION, 0);
    expect(enabled.revision).toBe(1);
    expect(plane.getJoyCodeOptIn(owner, 'project-1')).toEqual({
      enabled: true,
      consentVersion: JOY_CODE_CONSENT_VERSION,
      revision: 1,
    });
  });
  it('revokes consent with compare-and-swap and isolates owners', () => {
    const plane = new LocalControlPlane();
    plane.createProject(owner, 'project-1', 'Test');
    try {
      plane.getJoyCodeOptIn({ id: 'other' }, 'project-1');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    }
    plane.setJoyCodeOptIn(owner, 'project-1', true, JOY_CODE_CONSENT_VERSION, 0);
    try {
      plane.setJoyCodeOptIn(owner, 'project-1', false, undefined, 0);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'REVISION_CONFLICT' });
    }
    plane.setJoyCodeOptIn(owner, 'project-1', false, undefined, 1);
    expect(plane.getJoyCodeOptIn(owner, 'project-1')).toEqual({
      enabled: false,
      consentVersion: undefined,
      revision: 2,
    });
  });
});
