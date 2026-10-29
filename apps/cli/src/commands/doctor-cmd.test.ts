import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleDoctorCommand } from './doctor-cmd.js';

describe('joy doctor (no network calls)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('makes no network call while it checks the system', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleDoctorCommand();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
