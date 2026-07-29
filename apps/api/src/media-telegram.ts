export interface MediaTelegramSenderOptions {
  readonly botToken: string;
}

export interface MediaTelegramSenderLike {
  sendOtp(telegramId: string, code: string): Promise<void>;
}

/**
 * Minimal Telegram Bot API sender (single sendMessage call) — no bot-framework
 * dependency needed for one-way OTP delivery. The recipient must have already
 * started a chat with this bot at least once (Telegram requires a numeric
 * chat_id), which is why the allow-list stores a numeric telegram_id.
 */
export class MediaTelegramSender implements MediaTelegramSenderLike {
  private readonly botToken: string;

  constructor(options: MediaTelegramSenderOptions) {
    this.botToken = options.botToken;
  }

  async sendOtp(telegramId: string, code: string): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramId,
        text: `Your JOY Media login code is *${code}*. It expires in 5 minutes.`,
        parse_mode: 'Markdown',
      }),
    });
    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed: ${response.status}`);
    }
  }
}
