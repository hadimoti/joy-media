// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findRegistryProvider } from '@joy-media/provider-sdk';
import { DEFAULT_AGENT_POLICY } from './agent-policy-settings.js';
import { JoyAgentSettingsDialog } from './JoyAgentSettingsDialog.js';
import type { JoyAgentEngineClient } from './joy-agent/engine-client.js';
import type { ByokSessionStatus, JoyAgentMediaCapabilityReport } from './joy-agent/protocol.js';
import { resetCustomEndpointAcknowledgementsForTests } from './custom-endpoint-acknowledgement.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const readyStatus: ByokSessionStatus = {
  provider: 'openrouter',
  modelId: 'openrouter/verified-model',
  capability: 'tool-loop',
};

const mediaReport: JoyAgentMediaCapabilityReport = {
  modelId: 'openrouter/verified-model',
  image: 'supported',
  audio: 'unavailable',
  video: 'supported',
  modalities: ['image', 'video'],
};

function client(overrides: Partial<JoyAgentEngineClient> = {}): JoyAgentEngineClient {
  return {
    configure: vi.fn().mockResolvedValue(readyStatus),
    testConnection: vi.fn().mockResolvedValue(readyStatus),
    probeMediaCapabilities: vi.fn().mockResolvedValue(mediaReport),
    startRun: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn(),
    dispose: vi.fn(),
    getStatus: vi.fn(() => undefined),
    getMediaCapabilities: vi.fn(() => undefined),
    ...overrides,
  } as JoyAgentEngineClient;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function render(
  engineClient: JoyAgentEngineClient,
  status?: ByokSessionStatus,
  onStatusChange?: (status: ByokSessionStatus | undefined) => void,
): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <JoyAgentSettingsDialog
        policy={DEFAULT_AGENT_POLICY}
        onPolicyChange={vi.fn()}
        engineClient={engineClient}
        {...(onStatusChange === undefined ? {} : { onStatusChange })}
        {...(status === undefined ? {} : { status })}
        onClose={vi.fn()}
      />,
    );
  });
  return container;
}

function buttonByText(rendered: HTMLElement, text: string): HTMLButtonElement {
  const button = [...rendered.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) =>
      candidate.textContent?.trim() === text ||
      candidate.querySelector('strong')?.textContent?.trim() === text,
  );
  if (button === undefined) throw new Error(`Expected button "${text}"`);
  return button;
}

async function selectCustomPreset(rendered: HTMLElement): Promise<void> {
  const customPreset = buttonByText(rendered, 'Custom BYOK');
  await act(async () => {
    customPreset.click();
    await Promise.resolve();
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const nativeValueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  nativeValueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
  resetCustomEndpointAcknowledgementsForTests();
  delete (window as { joyDesktop?: unknown }).joyDesktop;
});

function countLeafTextMatches(rendered: HTMLElement, expression: RegExp): number {
  return [...rendered.querySelectorAll<HTMLElement>('*')].filter(
    (element) =>
      expression.test(element.textContent ?? '') &&
      ![...element.children].some((child) => expression.test(child.textContent ?? '')),
  ).length;
}

/** The desktop host, as the connection tests need it: a save returns the profile id. */
function installDesktopBridge(): void {
  window.joyDesktop = {
    channels: ['desktop.provider-profile.list', 'desktop.provider-profile.save'],
    invoke: vi.fn().mockImplementation(async (channel: string, payload?: unknown) => {
      if (channel === 'desktop.provider-profile.list') return [];
      if (channel === 'desktop.provider-profile.save') {
        return {
          id: 'prof-test',
          ...(payload as Record<string, unknown>),
          createdAt: '2026-10-28T00:00:00.000Z',
          updatedAt: '2026-10-28T00:00:00.000Z',
        };
      }
      return undefined;
    }),
  } as unknown as NonNullable<typeof window.joyDesktop>;
}

describe('JOY Agent Settings connection status', () => {
  beforeEach(() => {
    installDesktopBridge();
  });
  afterEach(() => {
    delete (window as { joyDesktop?: unknown }).joyDesktop;
  });

  async function connectWithKey(rendered: HTMLElement): Promise<HTMLInputElement> {
    const key = rendered.querySelector<HTMLInputElement>('input[type="password"]');
    if (key === null) throw new Error('Expected API key field');
    await act(async () => {
      setInputValue(key, 'connection-test-key');
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });
    return key;
  }

  it('offers API-key providers without retired provider or account-plan prompts', async () => {
    const rendered = await render(client());
    await selectCustomPreset(rendered);

    const providerSelect = [...rendered.querySelectorAll<HTMLSelectElement>('select')].find(
      (select) => [...select.options].some((option) => option.value === 'openrouter'),
    );
    expect(providerSelect).toBeTruthy();
    const options = [...(providerSelect?.options ?? [])].map((option) => option.value);
    expect(options).toEqual(expect.arrayContaining(['openrouter', 'openai-compatible']));
    expect(options).toEqual(
      expect.arrayContaining(['openai', 'grok', 'claude', 'minimax', 'gemini', 'kimi']),
    );
    expect(options).not.toContain('kilo');
    expect(options).not.toContain('joy-hosted');
    expect(rendered.textContent).not.toMatch(/Joy Pro|Sign In with JOY Account|quota|plan limits/i);
  });

  it('shows tool-loop readiness and the connection notice in the dialog', async () => {
    const rendered = await render(client(), undefined);

    await selectCustomPreset(rendered);
    await connectWithKey(rendered);

    expect(rendered.querySelector('[role="status"]')?.textContent).toContain('Tool loop ready');
    expect(countLeafTextMatches(rendered, /Tool loop ready/)).toBe(1);
    expect(rendered.textContent).toContain(
      'Connected successfully. JOY is ready to edit in this session.',
    );
  });

  it('shows plan-only readiness in the dialog', async () => {
    const planOnlyStatus: ByokSessionStatus = {
      provider: 'openrouter',
      modelId: 'openrouter/verified-model',
      capability: 'plan-only',
    };
    const rendered = await render(
      client({ testConnection: vi.fn().mockResolvedValue(planOnlyStatus) }),
      undefined,
    );

    await selectCustomPreset(rendered);
    await connectWithKey(rendered);

    expect(rendered.querySelector('[role="status"]')?.textContent).toContain('Plan-only ready');
    expect(countLeafTextMatches(rendered, /Plan-only/)).toBe(1);
    expect(rendered.textContent).toContain('Connected successfully in plan-only mode.');
  });

  it('shows a resolved provider failure with one redacted error in the dialog', async () => {
    const privateKey = 'connection-test-key';
    const incompatibleStatus: ByokSessionStatus = {
      provider: 'openrouter',
      modelId: 'openrouter/verified-model',
      capability: 'incompatible',
      message: `Provider authentication failed for ${privateKey}`,
    };
    const rendered = await render(
      client({ testConnection: vi.fn().mockResolvedValue(incompatibleStatus) }),
      undefined,
    );

    await selectCustomPreset(rendered);
    const key = await connectWithKey(rendered);
    const dialog = rendered.querySelector('[role="dialog"]');
    if (dialog === null) throw new Error('Expected settings dialog');

    expect(dialog.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(countLeafTextMatches(dialog as HTMLElement, /authentication failed/i)).toBe(1);
    expect(dialog.textContent).not.toContain(privateKey);
    expect(key.value).toBe('');
  });

  it('shows the provider failure message in the dialog without rendering the API key', async () => {
    const rendered = await render(
      client({
        testConnection: vi
          .fn()
          .mockRejectedValue(new Error('authentication failed for connection-test-key')),
      }),
      undefined,
    );

    await selectCustomPreset(rendered);
    const key = await connectWithKey(rendered);

    expect(rendered.querySelector('[role="alert"]')?.textContent).toContain(
      'authentication failed',
    );
    expect(rendered.textContent).not.toContain('connection-test-key');
    expect(key.value).toBe('');
  });

  it('refuses model discovery in the browser build without sending the key', async () => {
    delete (window as { joyDesktop?: unknown }).joyDesktop;
    const privateKey = 'browser-discovery-key';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const rendered = await render(client(), undefined);
    const key = rendered.querySelector<HTMLInputElement>('input[type="password"]');
    const openDrawer = rendered.querySelector<HTMLButtonElement>('.joy-settings-text-btn');
    if (key === null || openDrawer === null) {
      throw new Error('Expected key and model drawer controls');
    }
    setInputValue(key, privateKey);

    await act(async () => {
      openDrawer.click();
      await Promise.resolve();
    });

    expect(rendered.textContent).toContain('Live model discovery requires Joy Media Desktop.');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rendered.textContent).not.toContain(privateKey);
  });

  it('redacts the API key from desktop model discovery errors', async () => {
    const privateKey = 'discovery-test-key';
    const invoke = vi.fn((channel: string) =>
      channel === 'desktop.provider.models'
        ? Promise.reject(new Error(`Provider rejected key ${privateKey}`))
        : Promise.resolve([]),
    );
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list', 'desktop.provider.models'],
      invoke,
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const rendered = await render(client(), undefined);
    await selectCustomPreset(rendered);
    const key = rendered.querySelector<HTMLInputElement>('input[type="password"]');
    const openDrawer = rendered.querySelector<HTMLButtonElement>('.joy-settings-text-btn');
    if (key === null || openDrawer === null) {
      throw new Error('Expected key and model drawer controls');
    }
    setInputValue(key, privateKey);

    await act(async () => {
      openDrawer.click();
      await Promise.resolve();
    });

    expect(rendered.textContent).toContain('Provider rejected key [redacted]');
    expect(rendered.textContent).not.toContain(privateKey);
  });
});

describe('JOY Agent Settings media capability probe', () => {
  beforeEach(() => {
    installDesktopBridge();
  });
  afterEach(() => {
    delete (window as { joyDesktop?: unknown }).joyDesktop;
  });

  it('does not probe on mount or connection test, then explicitly sends the check and preserves the connection success notice', async () => {
    const engineClient = client();
    const rendered = await render(engineClient, undefined);
    await selectCustomPreset(rendered);
    const probe = vi.mocked(engineClient.probeMediaCapabilities);
    const configure = vi.mocked(engineClient.configure);
    const testConnection = vi.mocked(engineClient.testConnection);

    expect(probe).not.toHaveBeenCalled();
    expect(rendered.textContent).toContain('three tiny product-owned synthetic samples');
    expect(rendered.textContent).toContain('never sends your project, owner, or uploaded media');
    expect(rendered.textContent).toContain('may charge or log these requests');

    const key = rendered.querySelector<HTMLInputElement>('input[type="password"]');
    if (key === null) throw new Error('Expected API key field');
    await act(async () => {
      setInputValue(key, 'session-only-test-key');
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });

    expect(configure).toHaveBeenCalledTimes(1);
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(probe).not.toHaveBeenCalled();
    expect(rendered.textContent).toContain(
      'Connected successfully. JOY is ready to edit in this session.',
    );
    expect(key.value).toBe('');

    await act(async () => {
      buttonByText(rendered, 'Check media support').click();
      await Promise.resolve();
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(rendered.textContent).toContain(
      'Media capability check complete for openrouter/verified-model.',
    );
    const mediaResult = rendered.querySelector('.agent-media-capability-result');
    expect(mediaResult?.textContent).toContain('ImageSupported');
    expect(mediaResult?.textContent).toContain('AudioUnavailable');
    expect(mediaResult?.textContent).toContain('VideoSupported');
    expect(rendered.textContent).toContain(
      'Connected successfully. JOY is ready to edit in this session.',
    );
    expect(rendered.textContent).not.toContain('session-only-test-key');
  });

  it('uses a redacted failure message and never renders a provider error, endpoint, or session key', async () => {
    const privateKey = 'sk-never-render-this';
    const privateEndpoint = 'https://private.example/v1/chat/completions';
    const engineClient = client({
      probeMediaCapabilities: vi
        .fn()
        .mockRejectedValue(new Error(`provider said ${privateKey} at ${privateEndpoint}`)),
    });
    const rendered = await render(engineClient, readyStatus);

    await act(async () => {
      buttonByText(rendered, 'Check media support').click();
      await Promise.resolve();
    });

    expect(rendered.textContent).toContain(
      'Media capability check could not be completed. Reconnect the model and try again.',
    );
    expect(rendered.textContent).not.toContain(privateKey);
    expect(rendered.textContent).not.toContain(privateEndpoint);
    expect(rendered.textContent).not.toContain('provider said');
  });

  it('renders only a validated redacted session report and never probes to obtain it', async () => {
    const privateValue = 'api-key-should-not-render';
    const engineClient = client({
      getMediaCapabilities: vi.fn(
        () =>
          ({ ...mediaReport, apiKey: privateValue }) as unknown as JoyAgentMediaCapabilityReport,
      ),
    });
    const rendered = await render(engineClient, readyStatus);

    expect(engineClient.probeMediaCapabilities).not.toHaveBeenCalled();
    expect(rendered.textContent).not.toContain(privateValue);
    // The unvalidated report must not render at all, not merely omit a string
    // that never appears (the component renders "ImageSupported", no space).
    expect(rendered.querySelector('.agent-media-capability-result')).toBeNull();
  });

  it('renders a matching cached session report without a provider request', async () => {
    const engineClient = client({ getMediaCapabilities: vi.fn(() => mediaReport) });
    const rendered = await render(engineClient, readyStatus);

    expect(engineClient.probeMediaCapabilities).not.toHaveBeenCalled();
    const mediaResult = rendered.querySelector('.agent-media-capability-result');
    expect(mediaResult?.textContent).toContain('Configured model: openrouter/verified-model');
    expect(mediaResult?.textContent).toContain('ImageSupported');
  });

  it('rejects a cached report for a different configured model without probing', async () => {
    const engineClient = client({
      getMediaCapabilities: vi.fn(() => ({ ...mediaReport, modelId: 'openrouter/other-model' })),
    });
    const rendered = await render(engineClient, readyStatus);

    expect(engineClient.probeMediaCapabilities).not.toHaveBeenCalled();
    expect(rendered.querySelector('.agent-media-capability-result')).toBeNull();
  });

  it('ignores a late probe result after the user clears the configured session', async () => {
    let resolveReport: (report: JoyAgentMediaCapabilityReport) => void = () => undefined;
    const pendingReport = new Promise<JoyAgentMediaCapabilityReport>((resolve) => {
      resolveReport = resolve;
    });
    const engineClient = client({ probeMediaCapabilities: vi.fn(() => pendingReport) });
    const rendered = await render(engineClient, readyStatus);

    await act(async () => {
      buttonByText(rendered, 'Check media support').click();
      await Promise.resolve();
    });

    const clear = buttonByText(rendered, 'Clear connection');
    expect(clear.disabled).toBe(false);
    await act(async () => {
      clear.click();
    });

    await act(async () => {
      resolveReport(mediaReport);
      await pendingReport;
    });

    expect(engineClient.clear).toHaveBeenCalledTimes(1);
    expect(rendered.querySelector('.agent-media-capability-result')).toBeNull();
    expect(rendered.textContent).not.toContain('Media capability check complete');
    expect(rendered.textContent).toContain(
      'Connection cleared. Your API key was removed from this page session.',
    );
  });
});

describe('JOY Agent Settings custom provider acknowledgement', () => {
  const disclosureText =
    'I understand that custom endpoints may log requests according to their own policy.';

  function providerSelect(rendered: HTMLElement): HTMLSelectElement {
    const select = rendered.querySelector<HTMLSelectElement>('select');
    if (select === null) throw new Error('Expected provider select dropdown');
    return select;
  }

  async function changeProvider(rendered: HTMLElement, provider: string): Promise<void> {
    await act(async () => {
      const select = providerSelect(rendered);
      select.value = provider;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('shows the acknowledgement checkbox only for an OpenAI-compatible provider', async () => {
    const rendered = await render(client(), readyStatus);

    await selectCustomPreset(rendered);
    expect(rendered.textContent).not.toContain(disclosureText);
    await changeProvider(rendered, 'openai-compatible');
    expect(rendered.textContent).toContain(disclosureText);
    expect(rendered.querySelector('input[type="checkbox"]')).not.toBeNull();

    await changeProvider(rendered, 'openrouter');
    expect(rendered.textContent).not.toContain(disclosureText);
  });

  it('blocks custom provider connection until the acknowledgement is checked', async () => {
    const engineClient = client();
    const rendered = await render(engineClient, readyStatus);
    await selectCustomPreset(rendered);
    await changeProvider(rendered, 'openai-compatible');

    const key = rendered.querySelector<HTMLInputElement>('input[type="password"]');
    if (key === null) throw new Error('Expected API key field');
    const baseUrl = rendered.querySelector<HTMLInputElement>('input[placeholder="https://..."]');
    if (baseUrl === null) throw new Error('Expected base URL field');
    await act(async () => {
      setInputValue(key, 'custom-provider-test-key');
      setInputValue(baseUrl, 'https://custom.example/v1');
      buttonByText(rendered, 'Connect model').click();
    });

    expect(engineClient.configure).not.toHaveBeenCalled();
    expect(rendered.textContent).toContain(
      'Enter the custom-provider acknowledgement before connecting.',
    );
    expect(rendered.querySelector<HTMLInputElement>('input[type="checkbox"]')).not.toBeNull();
  });

  it('requires consent for an OpenRouter label with a custom destination before connect', async () => {
    const engineClient = client();
    const rendered = await render(engineClient, readyStatus);
    await selectCustomPreset(rendered);
    await changeProvider(rendered, 'openrouter');
    const key = rendered.querySelector<HTMLInputElement>('input[type="password"]');
    const baseUrl = rendered.querySelector<HTMLInputElement>('input[placeholder="https://..."]');
    if (!key || !baseUrl) throw new Error('Expected provider connection fields');
    setInputValue(baseUrl, 'https://openrouter.ai.evil.example/api/v1');
    setInputValue(key, 'openrouter-label-custom-destination-key');
    await act(async () => {
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });
    expect(engineClient.configure).not.toHaveBeenCalled();
    expect(rendered.textContent).toContain('custom-provider acknowledgement');
    expect(rendered.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  it('does not reuse an OpenRouter vault key for an acknowledged custom endpoint', async () => {
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.provider-profile.list')
        return [
          {
            id: 'openrouter-1',
            provider: 'openrouter',
            name: 'Saved OpenRouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            modelId: 'openrouter/auto',
            createdAt: '2026-09-15T00:00:00.000Z',
            updatedAt: '2026-09-15T00:00:00.000Z',
          },
        ];
      if (channel === 'desktop.provider-profile.begin-session')
        return { apiKey: 'vault-openrouter-secret' };
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list', 'desktop.provider-profile.begin-session'],
      invoke,
    };
    const engineClient = client();
    const rendered = await render(engineClient, undefined);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await selectCustomPreset(rendered);
    await changeProvider(rendered, 'openai-compatible');
    const baseUrl = rendered.querySelector<HTMLInputElement>('input[placeholder="https://..."]');
    if (!baseUrl) throw new Error('Expected base URL field');
    setInputValue(baseUrl, 'https://custom.example/v1');
    const consent = rendered.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!consent) throw new Error('Expected endpoint acknowledgement');
    await act(async () => {
      consent.click();
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });
    expect(engineClient.configure).not.toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'vault-openrouter-secret' }),
    );
    expect(rendered.textContent).toContain(
      'a new API key because the saved key belongs to a different provider or endpoint',
    );
  });

  it('blocks OpenRouter-labeled custom model discovery before sending an entered key', async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list', 'desktop.provider.models'],
      invoke,
    };
    const rendered = await render(client(), undefined);
    await selectCustomPreset(rendered);
    await changeProvider(rendered, 'openrouter');
    const key = rendered.querySelector<HTMLInputElement>('input[type="password"]');
    const baseUrl = rendered.querySelector<HTMLInputElement>('input[placeholder="https://..."]');
    if (key === null || baseUrl === null) throw new Error('Expected custom endpoint fields');
    setInputValue(key, 'openrouter-custom-discovery-secret');
    setInputValue(baseUrl, 'https://other.example/api/v1');

    await act(async () => {
      const drawer = [...rendered.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Discovered Models Drawer'),
      );
      drawer?.click();
      await Promise.resolve();
    });

    await act(async () => {
      const discover = [...rendered.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Discover Models'),
      );
      discover?.click();
      await Promise.resolve();
    });

    expect(invoke).not.toHaveBeenCalledWith('desktop.provider.models', expect.anything());
    expect(rendered.textContent).toContain(
      'Enter the custom-provider acknowledgement before discovering models.',
    );
  });

  it('requires acknowledgement before connecting a custom endpoint', async () => {
    const engineClient = client();
    const rendered = await render(engineClient, undefined);
    await selectCustomPreset(rendered);
    await changeProvider(rendered, 'openai-compatible');
    expect(buttonByText(rendered, 'Custom BYOK').className).toContain('is-active');

    const key = rendered.querySelector<HTMLInputElement>('input[type="password"]');
    if (key === null) throw new Error('Expected API key field');
    const baseUrl = rendered.querySelector<HTMLInputElement>('input[placeholder="https://..."]');
    if (baseUrl === null) throw new Error('Expected base URL field');
    await act(async () => {
      setInputValue(key, 'custom-provider-test-key');
      setInputValue(baseUrl, 'https://custom.example/v1');
      buttonByText(rendered, 'Connect model').click();
    });

    expect(engineClient.configure).not.toHaveBeenCalled();
    expect(rendered.textContent).toContain(
      'Enter the custom-provider acknowledgement before connecting.',
    );
  });

  it('resets the acknowledgement whenever the provider changes', async () => {
    const rendered = await render(client(), readyStatus);
    await selectCustomPreset(rendered);
    await changeProvider(rendered, 'openai-compatible');

    const checkbox = rendered.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (checkbox === null) throw new Error('Expected custom provider acknowledgement checkbox');
    await act(async () => {
      checkbox.click();
    });
    expect(checkbox.checked).toBe(true);

    await changeProvider(rendered, 'openrouter');
    await changeProvider(rendered, 'openai-compatible');
    expect(rendered.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  });

  it('reconnects a keyed local profile with its key field empty, without saving a second profile', async () => {
    const savedLocal = {
      id: 'prof-local',
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:1234/v1',
      modelId: 'llama3',
      createdAt: '2026-10-28T00:00:00.000Z',
      updatedAt: '2026-10-28T00:00:00.000Z',
      bound: true,
    };
    // The list reflects what was saved, as the desktop host reports it.
    let stored: readonly unknown[] = [];
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.provider-profile.list') return stored;
      if (channel === 'desktop.provider-profile.save') {
        stored = [savedLocal];
        return savedLocal;
      }
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list', 'desktop.provider-profile.save'],
      invoke,
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const engineClient = client();
    const rendered = await render(engineClient, undefined);
    await selectCustomPreset(rendered);
    await changeProvider(rendered, 'openai-compatible');
    const baseUrl = rendered.querySelector<HTMLInputElement>('input[placeholder="https://..."]');
    const model = rendered.querySelector<HTMLInputElement>('input[placeholder="provider/model"]');
    const key = rendered.querySelector<HTMLInputElement>('input[type="password"]');
    const consent = rendered.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!baseUrl || !model || !key || !consent)
      throw new Error('Expected the custom endpoint fields');
    await act(async () => {
      setInputValue(baseUrl, 'http://127.0.0.1:1234/v1');
      setInputValue(model, 'llama3');
      setInputValue(key, 'local-key');
      consent.click();
    });
    await act(async () => {
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });
    const saves = () =>
      invoke.mock.calls.filter(([channel]) => channel === 'desktop.provider-profile.save');
    expect(saves()).toHaveLength(1);

    // Connect again with the key field empty: the saved profile is used, and nothing else is saved.
    const keyAgain = rendered.querySelector<HTMLInputElement>('input[type="password"]');
    await act(async () => {
      if (keyAgain) setInputValue(keyAgain, '');
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });

    expect(saves()).toHaveLength(1);
    expect(engineClient.configure).toHaveBeenLastCalledWith(
      expect.objectContaining({ profileId: 'prof-local' }),
    );
  });

  it('clears a key typed for one provider when the provider changes', async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list', 'desktop.provider.models'],
      invoke,
    };
    const rendered = await render(client(), undefined);
    const key = rendered.querySelector<HTMLInputElement>('input[type="password"]');
    if (key === null) throw new Error('Expected API key field');
    await act(async () => {
      setInputValue(key, 'sk-or-typed-for-openrouter');
    });

    await changeProvider(rendered, 'openai-compatible');

    expect(rendered.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('');
  });

  it('does not send a key typed for one endpoint to another endpoint', async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list', 'desktop.provider.models'],
      invoke,
    };
    const rendered = await render(client(), undefined);
    // MiniMax has two registry regions, so the second one is a registry endpoint that needs no acknowledgement.
    const otherRegion = findRegistryProvider('minimax')?.regions[1]?.baseUrl;
    if (otherRegion === undefined) throw new Error('Expected a second MiniMax region');
    await changeProvider(rendered, 'minimax');
    const key = rendered.querySelector<HTMLInputElement>('input[type="password"]');
    const baseUrl = rendered.querySelector<HTMLInputElement>('input[placeholder="https://..."]');
    if (key === null || baseUrl === null) throw new Error('Expected key and endpoint fields');
    await act(async () => {
      setInputValue(key, 'minimax-key-for-the-first-region');
      setInputValue(baseUrl, otherRegion);
    });

    await act(async () => {
      const drawer = [...rendered.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Discovered Models Drawer'),
      );
      drawer?.click();
      await Promise.resolve();
    });
    await act(async () => {
      const discover = [...rendered.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Discover Models'),
      );
      discover?.click();
      await Promise.resolve();
    });

    expect(invoke).not.toHaveBeenCalledWith('desktop.provider.models', expect.anything());
    expect(rendered.textContent).toContain(
      'The key was entered for a different provider or endpoint. Enter it again.',
    );
  });

  it('discovers models with the stored key of the bound profile for this endpoint, by its id', async () => {
    const saved = {
      id: 'prof-or-saved',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openrouter/free',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      bound: true,
    };
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.provider-profile.list') return [saved];
      if (channel === 'desktop.provider.models') return [];
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list', 'desktop.provider.models'],
      invoke,
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const rendered = await render(client(), undefined);

    await act(async () => {
      const drawer = [...rendered.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Discovered Models Drawer'),
      );
      drawer?.click();
      await Promise.resolve();
    });
    await act(async () => {
      const discover = [...rendered.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Discover Models'),
      );
      discover?.click();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith('desktop.provider.models', { id: 'prof-or-saved' });
  });

  it('asks for the key again before discovering with an endpoint whose key is not confirmed', async () => {
    const saved = {
      id: 'prof-or-unbound',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openrouter/free',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      bound: false,
    };
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.provider-profile.list') return [saved];
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list', 'desktop.provider.models'],
      invoke,
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const rendered = await render(client(), undefined);

    await act(async () => {
      const drawer = [...rendered.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Discovered Models Drawer'),
      );
      drawer?.click();
      await Promise.resolve();
    });
    await act(async () => {
      const discover = [...rendered.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Discover Models'),
      );
      discover?.click();
      await Promise.resolve();
    });

    expect(invoke).not.toHaveBeenCalledWith('desktop.provider.models', expect.anything());
    expect(rendered.textContent).toContain('Enter the API key again to confirm this endpoint.');
  });

  it('shows an unconfirmed custom profile in the form, and a key entered there updates that profile', async () => {
    const legacy = {
      id: 'prof-custom',
      provider: 'custom',
      name: 'Local model',
      baseUrl: 'http://127.0.0.1:1234/v1',
      modelId: 'llama3',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      bound: false,
    };
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.provider-profile.list') return [legacy];
      if (channel === 'desktop.provider-profile.save') return { ...legacy, bound: true };
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list', 'desktop.provider-profile.save'],
      invoke,
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const engineClient = client();
    const rendered = await render(engineClient, undefined);

    await act(async () => {
      buttonByText(rendered, 'Use').click();
      await Promise.resolve();
    });

    expect(
      rendered.querySelector<HTMLInputElement>('input[placeholder="https://..."]')?.value,
    ).toBe('http://127.0.0.1:1234/v1');
    const key = rendered.querySelector<HTMLInputElement>('input[type="password"]');
    const consent = rendered.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (key === null || consent === null) throw new Error('Expected key and endpoint fields');
    await act(async () => {
      setInputValue(key, 'local-key');
      consent.click();
    });
    await act(async () => {
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith(
      'desktop.provider-profile.save',
      expect.objectContaining({ id: 'prof-custom', apiKey: 'local-key' }),
    );
  });
});

describe('JOY Agent Settings saved profile connect', () => {
  it('connects a saved profile by its id, and the dialog never reads its key', async () => {
    const savedProfile = {
      id: 'prof-or-saved',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openrouter/free',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      bound: true,
    };
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.provider-profile.list') return [savedProfile];
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list'],
      invoke,
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const engineClient = client();
    const rendered = await render(engineClient, undefined);

    await act(async () => {
      buttonByText(rendered, 'Use').click();
      await Promise.resolve();
    });

    expect(engineClient.configure).toHaveBeenCalledWith({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openrouter/free',
      profileId: 'prof-or-saved',
    });
    expect(invoke).not.toHaveBeenCalledWith(
      'desktop.provider-profile.begin-session',
      expect.anything(),
    );
    expect(JSON.stringify(vi.mocked(engineClient.configure).mock.calls)).not.toContain('apiKey');
  });

  it('records the consent a card confirms for the profile that card names, not another on the same endpoint', async () => {
    const endpoint = 'http://127.0.0.1:1234/v1';
    const shared = {
      provider: 'custom',
      baseUrl: endpoint,
      modelId: 'llama3',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      bound: true,
    };
    const first = { ...shared, id: 'prof-first', name: 'First' };
    const second = { ...shared, id: 'prof-second', name: 'Second', modelId: 'qwen3' };
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.provider-profile.list') return [first, second];
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list'],
      invoke,
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const engineClient = client();
    const rendered = await render(engineClient, undefined);
    const useButtonFor = (name: string): HTMLButtonElement => {
      const card = [...rendered.querySelectorAll<HTMLElement>('.joy-settings-provider-card')].find(
        (candidate) => candidate.querySelector('strong')?.textContent?.trim() === name,
      );
      const use = [...(card?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (button) => button.textContent?.trim() === 'Use',
      );
      if (use === undefined) throw new Error(`Expected a Use button on ${name}`);
      return use;
    };

    await act(async () => {
      useButtonFor('Second').click();
      await Promise.resolve();
    });
    expect(engineClient.configure).not.toHaveBeenCalled();
    expect(rendered.textContent).toContain('Acknowledge this custom endpoint before connecting.');
    const consent = rendered.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (consent === null) throw new Error('Expected the endpoint consent');
    await act(async () => {
      consent.click();
    });
    await act(async () => {
      useButtonFor('Second').click();
      await Promise.resolve();
    });

    expect(engineClient.configure).toHaveBeenCalledTimes(1);
    expect(engineClient.configure).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: endpoint, modelId: 'qwen3', profileId: 'prof-second' }),
    );
  });

  it('saves a new profile when the endpoint is edited away from the chosen one, and leaves the other profile alone', async () => {
    const [international, china] = findRegistryProvider('minimax')?.regions ?? [];
    if (international === undefined || china === undefined) throw new Error('Expected two regions');
    const base = {
      provider: 'minimax',
      modelId: 'MiniMax-M2',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      bound: true,
    };
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.provider-profile.list') {
        return [
          { ...base, id: 'prof-intl', name: 'International', baseUrl: international.baseUrl },
          { ...base, id: 'prof-china', name: 'China', baseUrl: china.baseUrl },
        ];
      }
      if (channel === 'desktop.provider-profile.save') {
        return { ...base, id: 'prof-new', name: 'New', baseUrl: china.baseUrl };
      }
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list', 'desktop.provider-profile.save'],
      invoke,
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const engineClient = client();
    const rendered = await render(engineClient, undefined);
    const useFor = (name: string): HTMLButtonElement => {
      const card = [...rendered.querySelectorAll<HTMLElement>('.joy-settings-provider-card')].find(
        (candidate) => candidate.querySelector('strong')?.textContent?.trim() === name,
      );
      const use = [...(card?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (button) => button.textContent?.trim() === 'Use',
      );
      if (use === undefined) throw new Error(`Expected a Use button on ${name}`);
      return use;
    };

    await act(async () => {
      useFor('International').click();
      await Promise.resolve();
    });
    expect(engineClient.configure).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'prof-intl' }),
    );
    const regionSelect = [...rendered.querySelectorAll('label')]
      .find((label) => label.textContent?.includes('Region'))
      ?.querySelector('select');
    if (regionSelect === undefined || regionSelect === null) {
      throw new Error('Expected the region select');
    }
    await act(async () => {
      regionSelect.value = china.id;
      regionSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const key = rendered.querySelector<HTMLInputElement>('input[type="password"]');
    if (key === null) throw new Error('Expected API key field');
    await act(async () => {
      setInputValue(key, 'sk-typed-for-china');
    });
    await act(async () => {
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });

    const saves = invoke.mock.calls.filter(
      ([channel]) => channel === 'desktop.provider-profile.save',
    );
    expect(saves).toHaveLength(1);
    expect(saves[0]?.[1]).toEqual(
      expect.objectContaining({ provider: 'minimax', apiKey: 'sk-typed-for-china' }),
    );
    expect(saves[0]?.[1]).not.toHaveProperty('id', 'prof-china');
  });

  it('refuses to connect a typed key until the saved profiles have been read, so it cannot save beside them', async () => {
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.provider-profile.list') throw new Error('profile store unavailable');
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list'],
      invoke,
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const engineClient = client();
    const rendered = await render(engineClient, undefined);
    const key = rendered.querySelector<HTMLInputElement>('input[type="password"]');
    if (key === null) throw new Error('Expected API key field');
    await act(async () => {
      setInputValue(key, 'sk-typed-while-unread');
    });

    await act(async () => {
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });

    expect(engineClient.configure).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('desktop.provider-profile.save', expect.anything());
    expect(rendered.textContent).toContain('The saved profiles could not be read.');
  });

  it('does not pick one of several saved profiles on the same endpoint when the dialog opens', async () => {
    const shared = {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openrouter/free',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      bound: true,
    };
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.provider-profile.list') {
        return [
          { ...shared, id: 'prof-work', name: 'Work' },
          { ...shared, id: 'prof-personal', name: 'Personal' },
        ];
      }
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list'],
      invoke,
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const engineClient = client();
    const rendered = await render(engineClient, undefined);

    expect(rendered.querySelectorAll('.joy-settings-provider-card.is-active')).toHaveLength(0);
    await act(async () => {
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });

    expect(engineClient.configure).not.toHaveBeenCalled();
    expect(rendered.textContent).toContain('Choose one in the list first.');
  });

  it('asks for the key again, and does not connect, when its key is not confirmed for the endpoint', async () => {
    const savedProfile = {
      id: 'prof-or-unbound',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openrouter/free',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      bound: false,
    };
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.provider-profile.list') return [savedProfile];
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list'],
      invoke,
    } as unknown as NonNullable<typeof window.joyDesktop>;
    const engineClient = client();
    const rendered = await render(engineClient, undefined);

    expect(rendered.textContent).toContain('Enter the key again to confirm this endpoint.');
    await act(async () => {
      buttonByText(rendered, 'Use').click();
      await Promise.resolve();
    });

    expect(engineClient.configure).not.toHaveBeenCalled();
    expect(rendered.textContent).toContain(
      'Enter the API key again to confirm this endpoint, then connect.',
    );
  });
});

describe('JOY Agent Settings desktop profile persistence', () => {
  it('loads saved profile on mount when isDesktopHost is true', async () => {
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.provider-profile.list') {
        return [
          {
            id: 'prof-or-1',
            provider: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            modelId: 'anthropic/claude-3.5-sonnet',
            createdAt: '2026-09-15T00:00:00.000Z',
            updatedAt: '2026-09-15T00:00:00.000Z',
          },
        ];
      }
      return undefined;
    });
    window.joyDesktop = { channels: ['desktop.provider-profile.list'], invoke };
    const engineClient = client();
    const rendered = await render(engineClient, undefined);

    expect(invoke).toHaveBeenCalledWith('desktop.provider-profile.list');
    const modelInput = rendered.querySelector<HTMLInputElement>(
      'input[placeholder="provider/model"]',
    );
    expect(modelInput?.value).toBe('anthropic/claude-3.5-sonnet');
    expect(rendered.textContent).toContain('(Saved in desktop vault)');
  });

  it('asks for the key again when a saved profile key cannot be read', async () => {
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.provider-profile.list') {
        return [
          {
            id: 'prof-or-unreadable',
            provider: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            modelId: 'anthropic/claude-3.5-sonnet',
            createdAt: '2026-09-15T00:00:00.000Z',
            updatedAt: '2026-09-15T00:00:00.000Z',
            state: 'credential-unavailable',
          },
        ];
      }
      return undefined;
    });
    window.joyDesktop = { channels: ['desktop.provider-profile.list'], invoke };
    const engineClient = client();
    const rendered = await render(engineClient, undefined);

    expect(rendered.textContent).toContain('Saved key could not be read. Enter it again.');
    expect(rendered.textContent).not.toContain('(Saved in desktop vault)');
  });

  it('saves profile to desktop DPAPI when user connects with a key', async () => {
    const savedProfile = {
      id: 'prof-or-1',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'anthropic/claude-3.5-sonnet',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
    };
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.provider-profile.list') return [];
      if (channel === 'desktop.provider-profile.save') return savedProfile;
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list', 'desktop.provider-profile.save'],
      invoke,
    };
    const engineClient = client();
    const rendered = await render(engineClient, undefined);
    await selectCustomPreset(rendered);

    const key = rendered.querySelector<HTMLInputElement>('input[type="password"]');
    if (key === null) throw new Error('Expected API key field');
    await act(async () => {
      setInputValue(key, 'sk-or-new-key');
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith('desktop.provider-profile.save', {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openrouter/auto',
      apiKey: 'sk-or-new-key',
    });
  });

  it('shows legacy profiles as disabled and defers them without provider operations', async () => {
    let decision: 'later' | undefined;
    const legacyProfile = {
      id: 'legacy-kilo-profile',
      provider: 'kilo',
      name: 'Old Kilo profile',
      baseUrl: 'https://api.kilo.ai/v1',
      modelId: 'retired-model',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      state: 'disabled-legacy',
    };
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.provider-profile.list') {
        return [{ ...legacyProfile, ...(decision === undefined ? {} : { decision }) }];
      }
      if (channel === 'desktop.provider-profile.later') {
        decision = 'later';
        return { ok: true };
      }
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list', 'desktop.provider-profile.later'],
      invoke,
    };
    const engineClient = client();
    const rendered = await render(engineClient);
    await act(async () => {
      await Promise.resolve();
    });

    const card = [...rendered.querySelectorAll<HTMLElement>('.joy-settings-provider-card')].find(
      (candidate) => candidate.textContent?.includes('Old Kilo profile'),
    );
    expect(card?.textContent).toContain('Disabled legacy profile');
    expect(
      [...(card?.querySelectorAll('button') ?? [])].map((button) => button.textContent?.trim()),
    ).toEqual(['Later']);

    await act(async () => {
      [...(card?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === 'Later')
        ?.click();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith('desktop.provider-profile.later', {
      id: 'legacy-kilo-profile',
    });
    expect(engineClient.configure).not.toHaveBeenCalled();
    expect(engineClient.testConnection).not.toHaveBeenCalled();
    for (const channel of [
      'desktop.provider-profile.begin-session',
      'desktop.provider.test',
      'desktop.provider.models',
      'desktop.provider-profile.save',
    ]) {
      expect(invoke).not.toHaveBeenCalledWith(channel, expect.anything());
    }
  });
});
