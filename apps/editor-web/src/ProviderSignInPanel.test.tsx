// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderSignInPanel } from './ProviderSignInPanel.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RISK_NOTICE =
  'Signing in uses a third-party public app, and the provider may disable it in the future. An API key is the better, more dependable way to connect.';

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
    vi.restoreAllMocks();
  });

  function installDesktopBridge() {
    const invoke = vi
      .fn()
      .mockImplementation(async (channel: string, request?: { provider?: string }) => {
        if (channel === 'desktop.provider-profile.sign-in') {
          return {
            id: 'profile-' + (request?.provider ?? 'unknown'),
            provider: request?.provider ?? 'xai',
            baseUrl: 'https://api.x.ai/v1',
            modelId: 'grok-model',
          };
        }
        if (channel === 'desktop.provider-profile.save') {
          return {
            id: 'profile-saved',
            provider: request?.provider ?? 'xai',
            baseUrl: 'https://api.x.ai/v1',
            modelId: 'grok-model',
          };
        }
        return undefined;
      });
    global.window = {
      joyDesktop: {
        channels: ['desktop.provider-profile.sign-in', 'desktop.provider-profile.save'],
        invoke,
      },
    };
    return invoke;
  }

  async function mount(onSignedIn = vi.fn(), onSaved = vi.fn()): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root?.render(<ProviderSignInPanel onSignedIn={onSignedIn} onSaved={onSaved} />);
    });
  }

  async function openAccordion(provider: string): Promise<void> {
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle ' + provider + ' connection routes"]',
    );
    if (button === null) throw new Error('Expected ' + provider + ' route accordion');
    await act(async () => button.click());
  }

  function route(provider: string, name: 'API-key' | 'OAuth'): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      'section[aria-label="' + provider + ' ' + name + ' route"]',
    );
    if (element === null) throw new Error('Expected ' + provider + ' ' + name + ' route');
    return element;
  }

  function setInputValue(input: HTMLInputElement, value: string): void {
    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    nativeValueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('renders nothing outside the desktop app', () => {
    global.window = undefined;
    expect(renderToStaticMarkup(<ProviderSignInPanel onSignedIn={() => undefined} />)).toBe('');
  });

  it('shows only the three OAuth provider accordions and no API-key-only provider', () => {
    global.window = { joyDesktop: {} };
    const markup = renderToStaticMarkup(<ProviderSignInPanel onSignedIn={() => undefined} />);
    const headers = [
      'Toggle ChatGPT connection routes',
      'Toggle Kimi connection routes',
      'Toggle xAI connection routes',
    ];
    const positions = headers.map((header) => markup.indexOf(header));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((first, second) => first - second));
    expect(markup).not.toContain('MiniMax');
    expect(markup).not.toContain('OpenRouter');
    expect(markup).not.toContain('DeepSeek');
  });

  it('connects every provider accordion trigger to its route content', async () => {
    global.window = { joyDesktop: {} };
    await mount();

    const triggers = [...container.querySelectorAll<HTMLButtonElement>('.joy-accordion-trigger')];
    expect(triggers).toHaveLength(3);

    for (const trigger of triggers) await act(async () => trigger.click());

    for (const trigger of triggers) {
      const contentId = trigger.getAttribute('aria-controls');
      expect(contentId).not.toBeNull();
      expect(contentId === null ? null : document.getElementById(contentId)).not.toBeNull();
    }
  });

  it('shows OAuth sign-in as the primary route for every provider, with the API key second as secondary', async () => {
    installDesktopBridge();
    await mount();

    for (const provider of ['ChatGPT', 'Kimi', 'xAI']) {
      await openAccordion(provider);
      const signInRoute = route(provider, 'OAuth');
      expect(signInRoute.querySelector('h4')?.textContent).toBe('Sign-in route (Primary)');
      expect(signInRoute.querySelector('button')?.textContent?.trim()).toBe(
        'Sign in with ' + provider,
      );
      expect(route(provider, 'API-key').querySelector('h4')?.textContent).toBe(
        'API key route (Secondary)',
      );

      const card = container
        .querySelector('button[aria-label="Toggle ' + provider + ' connection routes"]')
        ?.closest('.joy-accordion-item');
      expect(
        [...(card?.querySelectorAll('section[aria-label$="route"]') ?? [])].map((section) =>
          section.getAttribute('aria-label'),
        ),
      ).toEqual([provider + ' OAuth route', provider + ' API-key route']);
      expect(
        container.querySelector('button[aria-label="Toggle ' + provider + ' sign-in route"]'),
      ).toBeNull();
    }
  });

  it('shows the risk notice only under the xAI sign-in button', async () => {
    installDesktopBridge();
    await mount();

    for (const provider of ['ChatGPT', 'Kimi', 'xAI']) await openAccordion(provider);

    const xaiButton = route('xAI', 'OAuth').querySelector('button');
    expect(xaiButton?.nextElementSibling?.tagName).toBe('P');
    expect(xaiButton?.nextElementSibling?.textContent).toBe(RISK_NOTICE);
    expect(route('ChatGPT', 'OAuth').textContent).not.toContain(RISK_NOTICE);
    expect(route('Kimi', 'OAuth').textContent).not.toContain(RISK_NOTICE);
    expect(
      [...container.querySelectorAll('p')].filter(
        (paragraph) => paragraph.textContent === RISK_NOTICE,
      ),
    ).toHaveLength(1);
  });

  it('uses only API-key regions for the primary route and keeps OAuth-only bases out of it', async () => {
    installDesktopBridge();
    await mount();

    for (const provider of ['ChatGPT', 'Kimi', 'xAI']) await openAccordion(provider);

    const expectedBases = [
      ['Kimi', 'https://api.moonshot.ai/v1'],
      ['xAI', 'https://api.x.ai/v1'],
    ] as const;
    const expectedKeyUrls = {
      Kimi: 'https://platform.kimi.ai/console/api-keys',
      xAI: 'https://console.x.ai',
    };
    for (const [provider, baseUrl] of expectedBases) {
      expect(
        route(provider, 'API-key').querySelector<HTMLInputElement>('input[readonly]')?.value,
      ).toBe(baseUrl);
      const keyLink = route(provider, 'API-key').querySelector<HTMLAnchorElement>('a');
      expect(keyLink?.getAttribute('href')).toBe(expectedKeyUrls[provider]);
      expect(keyLink?.target).toBe('_blank');
    }

    const chatGptKeyRoute = route('ChatGPT', 'API-key');
    expect(chatGptKeyRoute.querySelector('input[type="password"]')).toBeNull();

    const kimiKeyRoute = route('Kimi', 'API-key');
    expect(kimiKeyRoute.textContent).not.toContain('https://api.kimi.ai/coding/v1');
    const kimiRegionSelect = kimiKeyRoute.querySelector<HTMLSelectElement>(
      'select[aria-label="Kimi API key region"]',
    );
    expect([...(kimiRegionSelect?.options ?? [])].map((option) => option.value)).toEqual([
      'international',
      'china',
    ]);

    const xaiKeyRoute = route('xAI', 'API-key');
    expect(xaiKeyRoute.textContent).not.toContain('https://cli-chat-proxy.grok.com/v1');
    expect(xaiKeyRoute.querySelector('select')).toBeNull();
    expect(xaiKeyRoute.querySelectorAll('input[readonly]')).toHaveLength(1);
  });

  it('saves the selected provider and region through the desktop bridge without logging the key', async () => {
    const invoke = installDesktopBridge();
    const onSaved = vi.fn();
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await mount(vi.fn(), onSaved);
    const cases: readonly {
      readonly provider: string;
      readonly id: string;
      readonly region?: string;
      readonly baseUrl: string;
      readonly modelId: string;
    }[] = [
      {
        provider: 'Kimi',
        id: 'kimi',
        baseUrl: 'https://api.moonshot.ai/v1',
        modelId: 'moonshot-v1-8k',
      },
      {
        provider: 'xAI',
        id: 'xai',
        baseUrl: 'https://api.x.ai/v1',
        modelId: 'grok-model',
      },
    ];

    for (let index = 0; index < cases.length; index += 1) {
      const item = cases[index]!;
      await openAccordion(item.provider);
      if (item.region !== undefined) {
        const region = route(item.provider, 'API-key').querySelector<HTMLSelectElement>(
          'select[aria-label="' + item.provider + ' API key region"]',
        );
        if (region === null) throw new Error('Expected ' + item.provider + ' API key region');
        region.value = item.region;
        await act(async () => region.dispatchEvent(new Event('change', { bubbles: true })));
      }

      const key = route(item.provider, 'API-key').querySelector<HTMLInputElement>(
        'input[aria-label="' + item.provider + ' API key"]',
      );
      const model = route(item.provider, 'API-key').querySelector<HTMLInputElement>(
        'input[aria-label="' + item.provider + ' Model ID"]',
      );
      const save = [...route(item.provider, 'API-key').querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Save API key',
      );
      if (key === null || model === null || save === undefined)
        throw new Error('Expected ' + item.provider + ' API key form');
      await act(async () => {
        setInputValue(key, 'secret-test-key');
        setInputValue(model, item.modelId);
      });
      await act(async () => {
        save.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(invoke).toHaveBeenNthCalledWith(index + 1, 'desktop.provider-profile.save', {
        provider: item.id,
        baseUrl: item.baseUrl,
        modelId: item.modelId,
        apiKey: 'secret-test-key',
      });
      expect(key.value).toBe('');
    }

    expect(onSaved).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('secret-test-key');
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it('refuses to save an API key until a model ID is entered', async () => {
    const invoke = installDesktopBridge();
    await mount();
    await openAccordion('Kimi');

    const key = route('Kimi', 'API-key').querySelector<HTMLInputElement>(
      'input[aria-label="Kimi API key"]',
    );
    const save = [...route('Kimi', 'API-key').querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Save API key',
    );
    if (key === null || save === undefined) throw new Error('Expected Kimi key form');
    await act(async () => setInputValue(key, 'key-without-model'));

    await act(async () => save.click());

    expect(route('Kimi', 'API-key').textContent).toContain('Enter a model ID before saving.');
    expect(invoke).not.toHaveBeenCalledWith('desktop.provider-profile.save', expect.anything());
  });
});
