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
    });
    this.from = options.from;
  }

  async sendOtp(gmail: string, code: string): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: gmail,
      subject: 'Your JOY Media login code',
      text: `Your JOY Media login code is ${code}. It expires in 5 minutes.`,
    });
  }
}
