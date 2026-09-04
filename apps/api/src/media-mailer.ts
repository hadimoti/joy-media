import nodemailer, { type Transporter } from 'nodemailer';

export interface MediaMailerOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
}

export interface MediaMailerLike {
  sendOtp(gmail: string, code: string): Promise<void>;
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
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(options: MediaMailerOptions) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.port === 465,
      auth: { user: options.user, pass: options.pass },
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    this.from = options.from;
  }

  async sendOtp(gmail: string, code: string): Promise<void> {
    await this.transporter.sendMail({
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
    });
  }
}
