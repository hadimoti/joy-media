import { describe, expect, it, vi } from 'vitest';
import { MediaTelegramSender } from './media-telegram.js';

const okResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

describe('MediaTelegramSender OTP deadlines', () => {
  it('continues to the OTP message when the sticker request times out', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (String(_input).endsWith('/sendSticker')) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }
      return okResponse();
    });
    const sender = new MediaTelegramSender({
      botToken: 'fake-token',
      fetchImpl: fetchImpl as typeof fetch,
      stickerTimeoutMs: 15,
      messageTimeoutMs: 100,
    });

    await sender.sendOtp('12345', '123456');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain('/sendMessage');
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect((fetchImpl.mock.calls[1]?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('fails a message send when fetch stays pending until its deadline aborts', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => okResponse());
    fetchImpl.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (String(_input).endsWith('/sendSticker')) return Promise.resolve(okResponse());
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const sender = new MediaTelegramSender({
      botToken: 'fake-token',
      fetchImpl: fetchImpl as typeof fetch,
      stickerTimeoutMs: 25,
      messageTimeoutMs: 20,
    });

    await expect(sender.sendOtp('12345', '123456')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('classifies an explicit Telegram API rejection as definite', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: false }), { status: 200 }),
    );
    const sender = new MediaTelegramSender({
      botToken: 'fake-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(sender.sendOtp('12345', '123456')).rejects.toMatchObject({
      code: 'ETELEGRAM_REJECTED',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
