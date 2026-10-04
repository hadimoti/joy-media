export interface MediaTelegramSenderOptions {
  readonly botToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly stickerTimeoutMs?: number;
  readonly messageTimeoutMs?: number;
}

export interface MediaTelegramSenderLike {
  sendOtp(telegramId: string, code: string): Promise<void>;
  /** Best-effort profile JPEG bytes; undefined when unavailable or user has no photo. */
  fetchProfilePhoto?(telegramId: string): Promise<Buffer | undefined>;
}

/** Logo sticker from owner; file_id is per-bot — failures are non-fatal. */
const OTP_LOGO_STICKER_FILE_ID = 'CAACAgQAAxkBAAFQhQ1qawkzrgwBMqsn8vR8GSLNjwJpugACKR8AAmEkWFM';
const OTP_PREMIUM_EMOJI_ID = '6003380332865262018';

export class TelegramOtpRejectedError extends Error {
  readonly code = 'ETELEGRAM_REJECTED';

  constructor() {
    super('Telegram rejected the OTP message');
    this.name = 'TelegramOtpRejectedError';
  }
}

export function isDefiniteTelegramRejection(error: unknown): boolean {
  return error instanceof TelegramOtpRejectedError;
}

/**
 * Minimal Telegram Bot API sender for one-way OTP delivery. The recipient must
 * have already started a chat with this bot at least once (Telegram requires a
 * numeric chat_id), which is why the allow-list stores a numeric telegram_id.
 */
export class MediaTelegramSender implements MediaTelegramSenderLike {
  private readonly botToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly stickerTimeoutMs: number;
  private readonly messageTimeoutMs: number;

  constructor(options: MediaTelegramSenderOptions) {
    this.botToken = options.botToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.stickerTimeoutMs = Math.max(1, options.stickerTimeoutMs ?? 5_000);
    this.messageTimeoutMs = Math.max(1, options.messageTimeoutMs ?? 10_000);
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

    const deadlineAt = Date.now() + this.messageTimeoutMs;
    const tryMessage = async (
      text: string,
      markup?: { readonly inline_keyboard: ReadonlyArray<ReadonlyArray<object>> },
    ) => this.sendMessage(telegramId, text, markup, deadlineAt);

    try {
      await tryMessage(withEmoji, replyMarkup);
      return;
    } catch (error) {
      if (!isDefiniteTelegramRejection(error)) throw error;
    }

    try {
      await tryMessage(fallback, replyMarkup);
      return;
    } catch (error) {
      if (!isDefiniteTelegramRejection(error)) throw error;
    }

    await tryMessage(fallback);
  }

  async fetchProfilePhoto(telegramId: string): Promise<Buffer | undefined> {
    try {
      const listResponse = await this.fetchImpl(
        `https://api.telegram.org/bot${this.botToken}/getUserProfilePhotos`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user_id: Number(telegramId), limit: 1 }),
        },
      );
      if (!listResponse.ok) return undefined;
      const listBody = (await listResponse.json()) as {
        readonly ok?: boolean;
        readonly result?: {
          readonly total_count?: number;
          readonly photos?: ReadonlyArray<ReadonlyArray<{ readonly file_id: string }>>;
        };
      };
      const sizes = listBody.result?.photos?.[0];
      const fileId = sizes?.[sizes.length - 1]?.file_id;
      if (fileId === undefined) return undefined;

      const fileResponse = await this.fetchImpl(
        `https://api.telegram.org/bot${this.botToken}/getFile`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file_id: fileId }),
        },
      );
      if (!fileResponse.ok) return undefined;
      const fileBody = (await fileResponse.json()) as {
        readonly result?: { readonly file_path?: string };
      };
      const filePath = fileBody.result?.file_path;
      if (filePath === undefined || filePath.length === 0) return undefined;

      const bytesResponse = await this.fetchImpl(
        `https://api.telegram.org/file/bot${this.botToken}/${filePath}`,
      );
      if (!bytesResponse.ok) return undefined;
      const bytes = Buffer.from(await bytesResponse.arrayBuffer());
      return bytes.length === 0 ? undefined : bytes;
    } catch {
      return undefined;
    }
  }

  private async sendStickerBestEffort(telegramId: string): Promise<void> {
    try {
      await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendSticker`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(this.stickerTimeoutMs),
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
    deadlineAt = Date.now() + this.messageTimeoutMs,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: telegramId,
      text,
      parse_mode: 'HTML',
    };
    if (replyMarkup !== undefined) body.reply_markup = replyMarkup;

    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new DOMException('Telegram OTP send timed out', 'TimeoutError');
    const response = await this.fetchImpl(
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(remainingMs),
      },
    );
    const result = (await response.json().catch(() => undefined)) as
      { readonly ok?: boolean } | undefined;
    if (!response.ok || result?.ok === false) throw new TelegramOtpRejectedError();
  }
}
