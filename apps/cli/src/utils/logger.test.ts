import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatLocalTime } from './logger.js';

describe('formatLocalTime', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('formats human timestamps in the local timezone with its zone name', () => {
    vi.stubEnv('TZ', 'Asia/Tehran');
    expect(formatLocalTime('2026-10-04T00:00:00.000Z')).toMatch(/GMT\+3:30|IRST/);
  });
});
