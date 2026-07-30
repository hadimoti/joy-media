export interface MediaTelegramSenderOptions {
  readonly botToken: string;
}

export interface MediaTelegramSenderLike {
  sendOtp(telegramId: string, code: string): Promise<void>;
}

/** Logo sticker from owner; file_id is per-bot — failures are non-fatal. */
const OTP_LOGO_STICKER_FILE_ID =
  'CAACAgQAAxkBAAFQhQ1qawkzrgwBMqsn8vR8GSLNjwJpugACKR8AAmEkWFM';
const OTP_PREMIUM_EMOJI_ID = '6003380332865262018';

/**
 * Minimal Telegram Bot API sender for one-way OTP delivery. The recipient must
 * have already started a chat with this bot at least once (Telegram requires a
 * numeric chat_id), which is why the allow-list stores a numeric telegram_id.
 */
export class MediaTelegramSender implements MediaTelegramSenderLike {
  private readonly botToken: string;

  constructor(options: MediaTelegramSenderOptions) {
    this.botToken = options.botToken;
  }

  async sendOtp(telegramId: string, code: string): Promise<void> {
    await this.sendStickerBestEffort(telegramId);

    const withEmoji =
      `<tg-emoji emoji-id="${OTP_PREMIUM_EMOJI_ID}">✅</tg-emoji> ` +
      `<b>Joy Studio</b> login code\n\n` +
      `<code>${code}</code>\n\n` +
      `Expires in 5 minutes.\n` +
      `Do not share this code with anyone.`;

    const fallback =
      `✅ <b>Joy Studio</b> login code\n\n` +
      `<code>${code}</code>\n\n` +
      `Expires in 5 minutes.\n` +
      `Do not share this code with anyone.`;

    const replyMarkup = {
      inline_keyboard: [[{ text: 'Copy code', copy_text: { text: code } }]],
    };

    const ok = await this.sendMessage(telegramId, withEmoji, replyMarkup);
    if (ok) return;

    const okFallback = await this.sendMessage(telegramId, fallback, replyMarkup);
    if (okFallback) return;

    const plainOk = await this.sendMessage(telegramId, fallback);
    if (!plainOk) {
      throw new Error('Telegram sendMessage failed');
    }
  }

  private async sendStickerBestEffort(telegramId: string): Promise<void> {
    try {
      await fetch(`https://api.telegram.org/bot${this.botToken}/sendSticker`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegramId,
          sticker: OTP_LOGO_STICKER_FILE_ID,
        }),
      });
    } catch {
      // Sticker is decorative; OTP text still delivers.
    }
  }

  private async sendMessage(
    telegramId: string,
    text: string,
    replyMarkup?: { readonly inline_keyboard: ReadonlyArray<ReadonlyArray<object>> },
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      chat_id: telegramId,
      text,
      parse_mode: 'HTML',
    };
    if (replyMarkup !== undefined) body.reply_markup = replyMarkup;

    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.ok;
  }
}
