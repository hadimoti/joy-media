import nodemailer, { type Transporter } from 'nodemailer';
import { lookup as dnsLookup } from 'node:dns/promises';

export type SmtpAddressFamily = '4' | '6' | 'auto';
type SmtpAddress = { address: string; family: 4 | 6 };

export interface MediaMailerOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
  readonly family?: SmtpAddressFamily;
  readonly ehloName?: string;
  /** Test-tunable deadline; production sends are capped at 12 seconds. */
  readonly sendDeadlineMs?: number;
  readonly lookup?: (hostname: string) => Promise<readonly SmtpAddress[]>;
  readonly createTransport?: (options: Record<string, unknown>) => Transporter;
  readonly onOtpDeliveryFailure?: (metadata: OtpDeliveryErrorMetadata) => void;
}

export interface OtpDeliveryErrorMetadata {
  readonly code:
    'EAUTH' | 'ECONNECTION' | 'ETIMEDOUT' | 'ESOCKET' | 'EMESSAGE' | 'EENVELOPE' | 'OTHER';
  readonly responseCode?: number;
  readonly command: 'AUTH' | 'CONN' | 'MAIL' | 'RCPT' | 'DATA' | 'UNKNOWN';
}

/** Extract only fixed, non-sensitive SMTP fields from a provider error. */
export function sanitizeOtpDeliveryError(error: unknown): OtpDeliveryErrorMetadata {
  const value =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const code = value.code;
  const knownCodes = [
    'EAUTH',
    'ECONNECTION',
    'ETIMEDOUT',
    'ESOCKET',
    'EMESSAGE',
    'EENVELOPE',
  ] as const;
  const safeCode =
    typeof code === 'string' && (knownCodes as readonly string[]).includes(code)
      ? (code as OtpDeliveryErrorMetadata['code'])
      : 'OTHER';
  const responseCode = value.responseCode;
  const safeResponseCode =
    typeof responseCode === 'number' &&
    Number.isInteger(responseCode) &&
    responseCode >= 400 &&
    responseCode <= 599
      ? responseCode
      : undefined;
  const commandToken =
    typeof value.command === 'string' ? (value.command.split(/[\s:]/, 1)[0] ?? '') : '';
  const safeCommand = ['AUTH', 'CONN', 'MAIL', 'RCPT', 'DATA'].includes(commandToken)
    ? (commandToken as OtpDeliveryErrorMetadata['command'])
    : 'UNKNOWN';
  return {
    code: safeCode,
    ...(safeResponseCode === undefined ? {} : { responseCode: safeResponseCode }),
    command: safeCommand,
  };
}

export interface MediaMailerLike {
  sendOtp(gmail: string, code: string): Promise<void>;
}

export function isValidSmtpHostname(value: string): boolean {
  return (
    value.length <= 253 &&
    value
      .split('.')
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= 63 &&
          /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label),
      )
  );
}

const JOY_STUDIO_LOGO_URL = 'https://joyst.ir/assets/JoyCodeNew_256x256.png';

export function joyStudioOtpHtml(code: string): string {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#000000;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="background:#000000;padding:40px 16px;font-family:Tahoma,Arial,system-ui,sans-serif;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:420px;background:#252525;border:1px solid #3a3a3a;
                    border-radius:16px;overflow:hidden;">
        <tr><td style="height:3px;background:#f4b72f;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:36px 28px 40px;text-align:center;">
          <img src="${JOY_STUDIO_LOGO_URL}" width="72" height="72" alt="Joy Studio"
               style="display:block;margin:0 auto 18px;border:0;outline:none;text-decoration:none;" />
          <div style="font-size:22px;font-weight:700;letter-spacing:0.06em;color:#ececef;">Joy Studio</div>
          <p style="margin:10px 0 0;font-size:14px;color:#a8a8b0;">Your login code</p>
          <div style="margin:28px auto 12px;padding:28px 20px;max-width:280px;
                      background:#1a1a1a;border:1px solid #484848;border-radius:10px;">
            <div style="font-size:42px;font-weight:700;letter-spacing:0.28em;color:#f4b72f;
                        font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
                        direction:ltr;unicode-bidi:embed;user-select:all;-webkit-user-select:all;">
              ${code}
            </div>
          </div>
          <p style="margin:0;font-size:12px;color:#7e7e86;">Tap or click the code to select, then copy</p>
          <p style="margin:20px 0 0;font-size:13px;color:#a8a8b0;">Expires in 5 minutes</p>
          <p style="margin:8px 0 0;font-size:12px;color:#7e7e86;">Do not share this code with anyone.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/** Dedicated SMTP sender for JOY Media OTP email, independent of joy-vps's mailer. */
export class MediaMailer implements MediaMailerLike {
  private readonly host: string;
  private readonly port: number;
  private readonly user: string;
  private readonly pass: string;
  private readonly from: string;
  private readonly family: SmtpAddressFamily;
  private readonly ehloName: string;
  private readonly lookup: NonNullable<MediaMailerOptions['lookup']>;
  private readonly createTransport: NonNullable<MediaMailerOptions['createTransport']>;
  private readonly onOtpDeliveryFailure: MediaMailerOptions['onOtpDeliveryFailure'];
  private readonly sendDeadlineMs: number;

  constructor(options: MediaMailerOptions) {
    this.host = options.host;
    this.port = options.port;
    this.user = options.user;
    this.pass = options.pass;
    this.from = options.from;
    this.family = options.family ?? '4';
    this.ehloName = options.ehloName ?? 'joyst.ir';
    if (!isValidSmtpHostname(this.ehloName)) throw new Error('ehloName must be a valid hostname');
    this.lookup =
      options.lookup ??
      (async (hostname) =>
        (await dnsLookup(hostname, { all: true, verbatim: true })).map((address) => ({
          address: address.address,
          family: address.family === 6 ? 6 : 4,
        })));
    this.createTransport =
      options.createTransport ??
      ((config) =>
        nodemailer.createTransport(config as Parameters<typeof nodemailer.createTransport>[0]));
    this.onOtpDeliveryFailure = options.onOtpDeliveryFailure;
    this.sendDeadlineMs = Math.max(1, Math.min(12_000, options.sendDeadlineMs ?? 12_000));
  }

  async sendOtp(gmail: string, code: string): Promise<void> {
    try {
      const deadlineAt = Date.now() + this.sendDeadlineMs;
      const remainingMs = () => Math.max(0, deadlineAt - Date.now());
      const addresses = await withDeadline(this.lookup(this.host), remainingMs());
      const candidates = smtpCandidates(addresses, this.family);
      if (candidates.length === 0)
        throw Object.assign(new Error('SMTP host has no matching addresses'), {
          code: 'ECONNECTION',
          command: 'CONN',
        });
      let lastError: unknown;
      for (const address of candidates) {
        const remaining = remainingMs();
        if (remaining <= 0) throw smtpDeadlineError();
        const transporter = this.createTransport({
          host: address.address,
          name: this.ehloName,
          port: this.port,
          secure: this.port === 465,
          auth: { user: this.user, pass: this.pass },
          tls: { servername: this.host, rejectUnauthorized: true },
          connectionTimeout: remaining,
          greetingTimeout: remaining,
          socketTimeout: remaining,
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        let timeout: NodeJS.Timeout | undefined;
        let transportClosed = false;
        const closeTransport = () => {
          if (transportClosed) return;
          transportClosed = true;
          try {
            transporter.close();
          } catch {
            // A close error must not replace the delivery result or deadline.
          }
        };
        try {
          await Promise.race([
            transporter.sendMail({
              from: this.from,
              to: gmail,
              subject: 'Joy Studio — Login Code',
              text:
                `Your Joy Studio login code is ${code}.\n\n` +
                `Expires in 5 minutes.\n\n` +
                `Do not share this code with anyone.`,
              html: joyStudioOtpHtml(code),
              disableFileAccess: true,
              disableUrlAccess: true,
            }),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => {
                closeTransport();
                reject(smtpDeadlineError());
              }, remaining);
            }),
          ]);
          return;
        } catch (error) {
          lastError = error;
          if (remainingMs() <= 0) throw error;
          if (!shouldFallbackSmtp(error) || address === candidates.at(-1)) throw error;
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
          closeTransport();
        }
      }
      throw lastError;
    } catch (error) {
      try {
        this.onOtpDeliveryFailure?.(sanitizeOtpDeliveryError(error));
      } catch {
        // Diagnostics must never replace the delivery failure or expose its details.
      }
      throw error;
    }
  }
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return Promise.reject(smtpDeadlineError());
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(smtpDeadlineError()), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

function smtpDeadlineError(): Error {
  return Object.assign(new Error('SMTP OTP delivery deadline exceeded'), {
    code: 'ETIMEDOUT',
    command: 'CONN',
  });
}

export function smtpCandidates(
  addresses: readonly SmtpAddress[],
  family: SmtpAddressFamily,
): SmtpAddress[] {
  const ordered = [...addresses];
  if (family === '4') return ordered.filter((address) => address.family === 4);
  if (family === '6') return ordered.filter((address) => address.family === 6);
  return ordered;
}

function shouldFallbackSmtp(error: unknown): boolean {
  const value =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const code = value.code;
  const command = value.command;
  return (
    (command === 'CONN' || command === 'CONNECT' || command === undefined) &&
    ['ESOCKET', 'ETIMEDOUT', 'ECONNECTION', 'ECONNREFUSED', 'EOF'].includes(String(code))
  );
}
