import { describe, expect, it } from 'vitest';
import { redactConfig, redactLogLine } from './redaction.js';

describe('desktop redaction', () => {
  it('removes secret values and bounds log lines', () => {
    expect(redactLogLine('Authorization: Bearer abc.def.ghi token=secret')).toContain('[REDACTED]');
    expect(redactLogLine('x'.repeat(2_000))).toHaveLength(1_001);
  });
  it('redacts secret-shaped config fields', () => {
    expect(redactConfig({ apiUrl: 'https://example.test', sessionToken: 'secret' })).toEqual({
      apiUrl: 'https://example.test',
      sessionToken: '[REDACTED]',
    });
  });
});
