import { describe, expect, it } from 'vitest';
import { joyStudioOtpHtml, sanitizeOtpDeliveryError } from './media-mailer.js';

describe('JOY Studio OTP email', () => {
  it('uses a neutral email-safe stack without retired font families', () => {
    const html = joyStudioOtpHtml('123456');

    expect(html).toContain('font-family:Tahoma,Arial,system-ui,sans-serif');
    expect(html).not.toMatch(/fontiran|rooyinfree|modam\s*pro/i);
  });
});

describe('sanitizeOtpDeliveryError', () => {
  it('keeps only allowlisted SMTP diagnostic metadata', () => {
    const error = Object.assign(
      new Error('SMTP failed for alice@example.com with OTP 123456 and password provider-secret', {
        cause: new Error('authorization: provider-secret'),
      }),
      {
        code: 'EAUTH',
        responseCode: 535,
        command: 'AUTH PLAIN alice@example.com provider-secret',
        address: 'alice@example.com',
        headers: { authorization: 'provider-secret' },
      },
    );

    const metadata = sanitizeOtpDeliveryError(error);

    expect(metadata).toEqual({ code: 'EAUTH', responseCode: 535, command: 'AUTH' });
    expect(JSON.stringify(metadata)).not.toMatch(
      /alice@example\.com|123456|provider-secret|authorization/i,
    );
  });
});
