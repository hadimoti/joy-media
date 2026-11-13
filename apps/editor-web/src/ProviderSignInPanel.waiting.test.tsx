// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderSignInPanel, formatSignInCountdown } from './ProviderSignInPanel.js';
import { SETTINGS_PROVIDER_SIGN_IN } from './settings-wording.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * T-J03 item 3: while a sign-in waits for the browser, the settings show a countdown, "Open the sign-in
 * page again" and "Cancel". Cancel reaches the main process; the sign-in then reports it as cancelled.
 * A fake bridge only: no sign-in is started and no provider is called.
 */

describe('ProviderSignInPanel while a sign-in waits for the browser (T-J03)', () => {
  const global = globalThis as { window?: unknown };
  const originalWindow = global.window;
  let root: Root | undefined;
  let container: HTMLDivElement;
  let invoke: ReturnType<typeof vi.fn>;
  let rejectSignIn: ((error: Error) => void) | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    invoke = vi.fn(async (channel: string) => {
      if (channel === 'desktop.provider-profile.sign-in') {
        // The fake sign-in waits until it is cancelled, as the real one waits for its callback.
        return new Promise((_resolve, reject) => {
          rejectSignIn = reject;
        });
      }
      if (channel === 'desktop.provider-profile.sign-in-cancel') {
        rejectSignIn?.(new Error('The sign-in was cancelled.'));
        return { cancelled: true };
      }
      if (channel === 'desktop.provider-profile.sign-in-reopen') return { reopened: true };
      return undefined;
    });
    global.window = {
      joyDesktop: {
        channels: [
          'desktop.provider-profile.sign-in',
          'desktop.provider-profile.sign-in-cancel',
          'desktop.provider-profile.sign-in-reopen',
        ],
        invoke,
      },
    };
  });

  afterEach(() => {
    if (root !== undefined) act(() => root?.unmount());
    root = undefined;
    container.remove();
    global.window = originalWindow;
    vi.restoreAllMocks();
  });

  async function openChatGptSignIn(): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root?.render(<ProviderSignInPanel onSignedIn={() => undefined} />);
    });
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle ChatGPT connection routes"]',
    );
    if (toggle === null) throw new Error('Expected the ChatGPT route accordion');
    await act(async () => toggle.click());
    const signIn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.startsWith('Sign in with'),
    );
    if (signIn === undefined) throw new Error('Expected the ChatGPT sign-in button');
    await act(async () => signIn.click());
  }

  function buttonNamed(text: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === text,
    );
  }

  it('shows the countdown and the two controls while the sign-in waits', async () => {
    await openChatGptSignIn();

    const waiting = container.querySelector('.joy-provider-sign-in-waiting');
    expect(waiting).not.toBeNull();
    expect(waiting?.textContent).toContain('Waiting for the browser. 5:00 left.');
    expect(buttonNamed(SETTINGS_PROVIDER_SIGN_IN.openSignInPageAgain)).toBeDefined();
    expect(buttonNamed(SETTINGS_PROVIDER_SIGN_IN.cancelSignIn)).toBeDefined();
  });

  it('Cancel reaches the main process and the sign-in reports it as cancelled', async () => {
    await openChatGptSignIn();

    await act(async () => buttonNamed(SETTINGS_PROVIDER_SIGN_IN.cancelSignIn)!.click());

    expect(invoke).toHaveBeenCalledWith('desktop.provider-profile.sign-in-cancel', {
      provider: 'chatgpt',
    });
    expect(container.textContent).toContain(SETTINGS_PROVIDER_SIGN_IN.signInCancelled);
    expect(container.querySelector('.joy-provider-sign-in-waiting')).toBeNull();
  });

  it('Open the sign-in page again asks the main process to reopen the running page', async () => {
    await openChatGptSignIn();

    await act(async () => buttonNamed(SETTINGS_PROVIDER_SIGN_IN.openSignInPageAgain)!.click());

    expect(invoke).toHaveBeenCalledWith('desktop.provider-profile.sign-in-reopen', {
      provider: 'chatgpt',
    });
  });

  it('formats the countdown as minutes and seconds', () => {
    expect(formatSignInCountdown(5 * 60_000)).toBe('5:00');
    expect(formatSignInCountdown(61_000)).toBe('1:01');
    expect(formatSignInCountdown(-5)).toBe('0:00');
  });
});
