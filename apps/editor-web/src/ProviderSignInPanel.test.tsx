import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderSignInPanel } from './ProviderSignInPanel.js';

describe('ProviderSignInPanel', () => {
  const global = globalThis as { window?: unknown };
  const originalWindow = global.window;

  afterEach(() => {
    global.window = originalWindow;
  });

  it('renders nothing outside the desktop app', () => {
    global.window = undefined;
    expect(renderToStaticMarkup(<ProviderSignInPanel onSignedIn={() => undefined} />)).toBe('');
  });

  it('offers only ChatGPT, labelled as a preview, in the desktop app', () => {
    global.window = { joyDesktop: {} };
    const markup = renderToStaticMarkup(<ProviderSignInPanel onSignedIn={() => undefined} />);
    expect(markup).toContain('Sign in with ChatGPT');
    expect(markup).toContain('(Preview)');
  });

  it('never offers OpenRouter, which is set up with an API key under D20', () => {
    global.window = { joyDesktop: {} };
    const markup = renderToStaticMarkup(<ProviderSignInPanel onSignedIn={() => undefined} />);
    expect(markup).not.toContain('OpenRouter');
  });
});
