import { describe, expect, it } from 'vitest';
import { joyStudioOtpHtml } from './media-mailer.js';

describe('JOY Studio OTP email', () => {
  it('uses a neutral email-safe stack without retired font families', () => {
    const html = joyStudioOtpHtml('123456');

    expect(html).toContain('font-family:Tahoma,Arial,system-ui,sans-serif');
    expect(html).not.toMatch(/fontiran|rooyinfree|modam\s*pro/i);
  });
});
