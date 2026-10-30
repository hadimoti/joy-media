// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderSignInPanel } from './ProviderSignInPanel.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ProviderSignInPanel', () => {
  const global = globalThis as { window?: unknown };
  const originalWindow = global.window;
  let root: Root | undefined;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(() => {
    if (root !== undefined) act(() => root?.unmount());
    root = undefined;
    container.remove();
    global.window = originalWindow;
  });

  it('renders nothing outside the desktop app', () => {
    global.window = undefined;
    expect(renderToStaticMarkup(<ProviderSignInPanel onSignedIn={() => undefined} />)).toBe('');
  });

  it('offers ChatGPT, Kimi, and MiniMax as previews in the desktop app', () => {
    global.window = { joyDesktop: {} };
    const markup = renderToStaticMarkup(<ProviderSignInPanel onSignedIn={() => undefined} />);
    expect(markup).toContain('Sign in with ChatGPT');
    expect(markup).toContain('Sign in with Kimi');
    expect(markup).toContain('Sign in with MiniMax');
    expect(markup.match(/\(Preview\)/g)).toHaveLength(3);
  });

  it('never offers OpenRouter, which is set up with an API key under D20', () => {
    global.window = { joyDesktop: {} };
    const markup = renderToStaticMarkup(<ProviderSignInPanel onSignedIn={() => undefined} />);
    expect(markup).not.toContain('OpenRouter');
  });

  it('sends region only for MiniMax and leaves ChatGPT and Kimi sign-in requests unchanged', async () => {
    const invoke = vi.fn().mockResolvedValue({
      id: 'profile-1',
      provider: 'minimax',
      baseUrl: 'https://api.minimaxi.com/v1',
      modelId: 'MiniMax-M2',
    });
    global.window = { joyDesktop: { invoke } };
    root = createRoot(container);
    await act(async () => {
      root?.render(<ProviderSignInPanel onSignedIn={() => undefined} />);
    });

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="MiniMax account region"]',
    );
    expect(select?.value).toBe('global');
    expect(select).not.toBeNull();
    if (select === null) throw new Error('MiniMax region selector is missing');

    await act(async () => {
      select.value = 'cn';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const minimaxButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Sign in with MiniMax'),
    );
    expect(minimaxButton).toBeDefined();
    await act(async () => {
      minimaxButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(invoke).toHaveBeenCalledWith('desktop.provider-profile.sign-in', {
      provider: 'minimax',
      region: 'cn',
    });

    const chatGptButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Sign in with ChatGPT'),
    );
    expect(chatGptButton).toBeDefined();
    await act(async () => {
      chatGptButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(invoke).toHaveBeenLastCalledWith('desktop.provider-profile.sign-in', {
      provider: 'chatgpt',
    });

    const kimiButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Sign in with Kimi'),
    );
    expect(kimiButton).toBeDefined();
    await act(async () => {
      kimiButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(invoke).toHaveBeenLastCalledWith('desktop.provider-profile.sign-in', {
      provider: 'kimi',
    });
  });
});
