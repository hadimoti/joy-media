import { describe, expect, it, vi } from 'vitest';
import { createSignInAttempts, type SignInAttemptContext } from './sign-in-attempts.js';

/**
 * T-J03: one sign-in attempt per provider at a time. Fake runs only: no sign-in, no provider.
 */

/** A run the test finishes by hand, so the order of events is visible. */
function manualRun<T>() {
  let finish: (value: T) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  let context: SignInAttemptContext | undefined;
  const run = (ctx: SignInAttemptContext): Promise<T> => {
    context = ctx;
    return new Promise<T>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
  };
  return {
    run,
    finish: (value: T) => finish(value),
    fail: (error: Error) => fail(error),
    context: () => context,
  };
}

const WAIT_MS = 5 * 60_000;

function registry(openExternal = vi.fn()) {
  let clock = 1_000;
  const attempts = createSignInAttempts({
    now: () => clock,
    waitMs: WAIT_MS,
    openExternal,
  });
  return { attempts, openExternal, advance: (ms: number) => (clock += ms) };
}

describe('one sign-in attempt per provider (T-J03)', () => {
  it('a second start cancels the first and runs only after the first has finished', async () => {
    const { attempts } = registry();
    const order: string[] = [];

    const first = manualRun<string>();
    const firstDone = attempts.start('chatgpt', async (ctx) => {
      order.push('first started');
      return first.run(ctx).finally(() => order.push('first finished'));
    });
    await vi.waitFor(() => expect(first.context()).toBeDefined());

    const second = manualRun<string>();
    const secondDone = attempts.start('chatgpt', async (ctx) => {
      order.push('second started');
      return second.run(ctx);
    });

    // The first attempt is cancelled: its signal is aborted. A real run finishes once its listener has
    // closed; here the test finishes it, and the second attempt must not have started before that.
    expect(first.context()?.signal.aborted).toBe(true);
    expect(order).toEqual(['first started']);
    first.fail(new Error('CANCELLED'));
    await expect(firstDone).rejects.toThrow('CANCELLED');
    await vi.waitFor(() => expect(second.context()).toBeDefined());
    expect(order).toEqual(['first started', 'first finished', 'second started']);
    expect(second.context()?.signal.aborted).toBe(false);

    second.finish('ok');
    await expect(secondDone).resolves.toBe('ok');
  });

  it('the cancelled attempt is no longer the running one when the second starts', async () => {
    const { attempts } = registry();
    const first = manualRun<void>();
    const firstDone = attempts.start('chatgpt', first.run);
    await vi.waitFor(() => expect(attempts.running('chatgpt')).toBeDefined());

    const second = manualRun<void>();
    const secondDone = attempts.start('chatgpt', second.run);
    first.finish(undefined);
    await firstDone;
    await vi.waitFor(() => expect(second.context()).toBeDefined());
    expect(attempts.running('chatgpt')).toBeDefined();
    second.finish(undefined);
    await secondDone;
    expect(attempts.running('chatgpt')).toBeUndefined();
  });

  it('cancel aborts the running attempt and returns false when nothing runs', async () => {
    const { attempts } = registry();
    expect(attempts.cancel('chatgpt')).toBe(false);

    const run = manualRun<void>();
    const done = attempts.start('chatgpt', run.run);
    await vi.waitFor(() => expect(run.context()).toBeDefined());

    expect(attempts.cancel('chatgpt')).toBe(true);
    expect(run.context()?.signal.aborted).toBe(true);
    run.fail(new Error('CANCELLED'));
    await expect(done).rejects.toThrow('CANCELLED');
    expect(attempts.running('chatgpt')).toBeUndefined();
  });

  it('a failed attempt frees the slot at once, so the next start does not wait for anything', async () => {
    const { attempts } = registry();
    const failing = manualRun<void>();
    const failed = attempts.start('kimi', failing.run);
    await vi.waitFor(() => expect(failing.context()).toBeDefined());
    failing.fail(new Error('network'));
    await expect(failed).rejects.toThrow('network');

    const next = manualRun<void>();
    const nextDone = attempts.start('kimi', next.run);
    await vi.waitFor(() => expect(next.context()).toBeDefined());
    expect(next.context()?.signal.aborted).toBe(false);
    next.finish(undefined);
    await nextDone;
  });

  it('attempts for different providers do not cancel each other', async () => {
    const { attempts } = registry();
    const chatgpt = manualRun<void>();
    const kimi = manualRun<void>();
    const chatgptDone = attempts.start('chatgpt', chatgpt.run);
    const kimiDone = attempts.start('kimi', kimi.run);
    await vi.waitFor(() => {
      expect(chatgpt.context()).toBeDefined();
      expect(kimi.context()).toBeDefined();
    });
    expect(chatgpt.context()?.signal.aborted).toBe(false);
    expect(kimi.context()?.signal.aborted).toBe(false);
    chatgpt.finish(undefined);
    kimi.finish(undefined);
    await Promise.all([chatgptDone, kimiDone]);
  });
});

describe('the wait for the browser and the sign-in page (T-J03)', () => {
  it('reports when the wait began and when it ends, the same length as the callback timeout', async () => {
    const { attempts, advance } = registry();
    const run = manualRun<void>();
    const done = attempts.start('chatgpt', run.run);
    await vi.waitFor(() => expect(run.context()).toBeDefined());
    advance(20_000);

    const running = attempts.running('chatgpt');
    expect(running?.startedAt).toBe(1_000);
    expect(running?.waitEndsAt).toBe(1_000 + WAIT_MS);
    expect(running?.pageOpen).toBe(false);

    run.finish(undefined);
    await done;
  });

  it('reopens the sign-in page of the running attempt, and only when there is one', async () => {
    const openExternal = vi.fn();
    const { attempts } = registry(openExternal);
    const run = manualRun<void>();
    const done = attempts.start('chatgpt', async (ctx) => {
      ctx.setAuthorizationUrl('https://auth.example.test/authorize?state=fake');
      return run.run(ctx);
    });
    await vi.waitFor(() => expect(attempts.running('chatgpt')?.pageOpen).toBe(true));

    await expect(attempts.reopen('chatgpt')).resolves.toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://auth.example.test/authorize?state=fake');

    run.finish(undefined);
    await done;
    await expect(attempts.reopen('chatgpt')).resolves.toBe(false);
  });

  it('reopen is false while the running attempt has no page yet', async () => {
    const openExternal = vi.fn();
    const { attempts } = registry(openExternal);
    const run = manualRun<void>();
    const done = attempts.start('chatgpt', run.run);
    await vi.waitFor(() => expect(run.context()).toBeDefined());
    await expect(attempts.reopen('chatgpt')).resolves.toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
    run.finish(undefined);
    await done;
  });
});
