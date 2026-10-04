import { describe, expect, it, vi } from 'vitest';
import {
  isValidSmtpHostname,
  joyStudioOtpHtml,
  MediaMailer,
  sanitizeOtpDeliveryError,
} from './media-mailer.js';

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

describe('MediaMailer address selection', () => {
  const addresses = [
    { address: '2001:db8::25', family: 6 as const },
    { address: '192.0.2.25', family: 4 as const },
  ];
  const options = (family?: '4' | '6' | 'auto') => ({
    host: 'smtp.example.invalid',
    port: 587,
    user: 'fake-user',
    pass: 'fake-pass',
    from: 'no-reply@example.invalid',
    ...(family ? { family } : {}),
    lookup: async () => addresses,
  });

  it('defaults to IPv4 without trying an IPv6 address', async () => {
    const created: Record<string, unknown>[] = [];
    const createTransport = vi.fn((config: Record<string, unknown>) => {
      created.push(config);
      return { sendMail: async () => ({}), close: () => {} } as never;
    });
    await new MediaMailer({ ...options(), createTransport }).sendOtp(
      'person@example.invalid',
      '123456',
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      host: '192.0.2.25',
      name: 'joyst.ir',
      tls: { servername: 'smtp.example.invalid', rejectUnauthorized: true },
    });
  });

  it('auto falls back from an IPv6 connection failure to IPv4 with TLS hostname verification', async () => {
    const created: Record<string, unknown>[] = [];
    const createTransport = vi.fn((config: Record<string, unknown>) => {
      created.push(config);
      const sendMail =
        created.length === 1
          ? async () => {
              throw Object.assign(new Error('socket closed before greeting'), {
                code: 'ESOCKET',
                command: 'CONN',
              });
            }
          : async () => ({});
      return { sendMail, close: () => {} } as never;
    });
    await new MediaMailer({ ...options('auto'), createTransport }).sendOtp(
      'person@example.invalid',
      '123456',
    );
    expect(created.map((config) => config.host)).toEqual(['2001:db8::25', '192.0.2.25']);
    expect(created[1]).toMatchObject({
      host: '192.0.2.25',
      port: 587,
      secure: false,
      name: 'joyst.ir',
      tls: { servername: 'smtp.example.invalid', rejectUnauthorized: true },
    });
    expect(created[1]?.connectionTimeout).toBeLessThanOrEqual(12_000);
    expect(created[1]?.greetingTimeout).toBeLessThanOrEqual(12_000);
    expect(created[1]?.socketTimeout).toBeLessThanOrEqual(12_000);
  });

  it('uses verified implicit TLS for port 465 and does not retry authentication failures', async () => {
    const created: Record<string, unknown>[] = [];
    const createTransport = vi.fn((config: Record<string, unknown>) => {
      created.push(config);
      return {
        sendMail: async () => {
          throw Object.assign(new Error('authentication rejected'), {
            code: 'EAUTH',
            command: 'AUTH',
          });
        },
        close: () => {},
      } as never;
    });
    await expect(
      new MediaMailer({ ...options('auto'), port: 465, createTransport }).sendOtp(
        'person@example.invalid',
        '123456',
      ),
    ).rejects.toMatchObject({ code: 'EAUTH' });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      host: '2001:db8::25',
      secure: true,
      tls: { servername: 'smtp.example.invalid', rejectUnauthorized: true },
    });
  });

  it('uses a separately configured client EHLO hostname', async () => {
    const created: Record<string, unknown>[] = [];
    const createTransport = vi.fn((config: Record<string, unknown>) => {
      created.push(config);
      return { sendMail: async () => ({}), close: () => {} } as never;
    });
    await new MediaMailer({ ...options(), ehloName: 'mail.joyst.ir', createTransport }).sendOtp(
      'person@example.invalid',
      '123456',
    );
    expect(created[0]).toMatchObject({
      name: 'mail.joyst.ir',
      host: '192.0.2.25',
      tls: { servername: 'smtp.example.invalid' },
    });
  });

  it('aborts a hung later address attempt within one overall send deadline', async () => {
    const created: Record<string, unknown>[] = [];
    const close = vi.fn();
    const createTransport = vi.fn((config: Record<string, unknown>) => {
      created.push(config);
      return {
        sendMail:
          created.length === 1
            ? async () => {
                throw Object.assign(new Error('connection failed'), {
                  code: 'ESOCKET',
                  command: 'CONN',
                });
              }
            : () => new Promise<never>(() => {}),
        close,
      } as never;
    });
    const startedAt = Date.now();

    await expect(
      new MediaMailer({ ...options('auto'), sendDeadlineMs: 40, createTransport }).sendOtp(
        'person@example.invalid',
        '123456',
      ),
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(created).toHaveLength(2);
    expect(created[0]?.connectionTimeout).toBeLessThanOrEqual(40);
    expect(created[1]?.connectionTimeout).toBeLessThanOrEqual(40);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('applies the same overall deadline to a hung DNS lookup', async () => {
    const startedAt = Date.now();
    await expect(
      new MediaMailer({
        ...options(),
        sendDeadlineMs: 20,
        lookup: () => new Promise<never>(() => {}),
      }).sendOtp('person@example.invalid', '123456'),
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it('validates configured EHLO names as hostnames', () => {
    expect(isValidSmtpHostname('joyst.ir')).toBe(true);
    expect(isValidSmtpHostname('mail.joyst.ir')).toBe(true);
    expect(isValidSmtpHostname('smtp.gmail.com\r\nAUTH PLAIN')).toBe(false);
    expect(() => new MediaMailer({ ...options(), ehloName: 'bad name' })).toThrow(
      'ehloName must be a valid hostname',
    );
  });
});
