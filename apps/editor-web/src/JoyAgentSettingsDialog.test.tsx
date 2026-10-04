// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  window.localStorage.clear();
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

describe('JOY Agent Settings connection status', () => {
  it('degrades to the one provided brain and requests the missing key', async () => {
    const engineClient = client();
    const rendered = await render(engineClient);
    const fields = [...rendered.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    setInputValue(fields[0]!, 'openrouter-key');
    await act(async () => {
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });

    expect(engineClient.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openrouter',
        modelId: 'openrouter/free',
      }),
    );
    expect(engineClient.configure).toHaveBeenCalledTimes(1);
    expect(rendered.textContent).toContain(
      'Dual-Brain needs both keys; running single-brain on openrouter. Add a Kilo key to enable Dual-Brain.',
    );
  });

  it('does not configure either brain when no keys are available', async () => {
    const engineClient = client();
    const rendered = await render(engineClient);
    await act(async () => {
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });
    expect(engineClient.configure).not.toHaveBeenCalled();
    expect(rendered.querySelector('[role="alert"]')?.textContent).toContain(
      'Enter at least one provider key',
    );
  });

  it('saves typed keys to desktop profiles after both brains pass their test', async () => {
    const existingProfiles = [
      {
        id: 'profile-openrouter',
        provider: 'openrouter',
        name: 'old workhorse',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'openrouter/free',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
      {
        id: 'profile-kilo',
        provider: 'kilo',
        name: 'old creative',
        baseUrl: 'https://api.kilo.ai/v1',
        modelId: 'byteplus-coding/dola-seed-2.0-pro',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    ];
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === 'desktop.provider-profile.list') return existingProfiles;
      if (channel === 'desktop.provider-profile.save')
        return { id: 'saved-profile', ...(payload as object) };
      return undefined;
    });
    window.joyDesktop = { channels: [], invoke };
    const engineClient = client({
      testConnection: vi.fn().mockResolvedValue({
        provider: 'dual-brain',
        modelId: 'openrouter/free + byteplus-coding/dola-seed-2.0-pro',
        capability: 'tool-loop',
        dualBrain: {
          workhorse: {
            provider: 'openrouter',
            modelId: 'openrouter/free',
            capability: 'tool-loop',
          },
          creative: {
            provider: 'kilo',
            modelId: 'byteplus-coding/dola-seed-2.0-pro',
            capability: 'tool-loop',
          },
        },
      }),
    });
    const rendered = await render(engineClient);
    await act(async () => {
      buttonByText(rendered, 'Dual-Brain Studio').click();
      await Promise.resolve();
    });
    await act(async () => {
      let fields = [...rendered.querySelectorAll<HTMLInputElement>('input[type="password"]')];
      setInputValue(fields[0]!, 'sk-test-openrouter');
      fields = [...rendered.querySelectorAll<HTMLInputElement>('input[type="password"]')];
      setInputValue(fields[1]!, 'sk-test-kilo');
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const saves = invoke.mock.calls.filter(
      ([channel]) => channel === 'desktop.provider-profile.save',
    );
    expect(saves).toHaveLength(2);
    expect(saves.map(([, payload]) => payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'profile-openrouter',
          provider: 'openrouter',
          name: 'Dual-Brain Workhorse',
          apiKey: 'sk-test-openrouter',
        }),
        expect.objectContaining({
          id: 'profile-kilo',
          provider: 'kilo',
          name: 'Dual-Brain Creative',
          apiKey: 'sk-test-kilo',
        }),
      ]),
    );
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

  it('sends separate Dual-Brain credentials only to their matching provider', async () => {
    const engineClient = client();
    const rendered = await render(engineClient, undefined);
    const fields = [...rendered.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    expect(fields).toHaveLength(2);
    expect(rendered.textContent).toContain('OpenRouter API key');
    expect(rendered.textContent).toContain('Kilo API key');
    setInputValue(fields[0]!, 'openrouter-only-key');
    setInputValue(fields[1]!, 'kilo-only-key');

    await act(async () => {
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });

    const config = vi.mocked(engineClient.configure).mock.calls[0]?.[0];
    expect(config).toMatchObject({
      mode: 'dual-brain',
      workhorse: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'openrouter/free',
        apiKey: 'openrouter-only-key',
      },
      creative: {
        provider: 'kilo',
        baseUrl: 'https://api.kilo.ai/api/gateway',
        modelId: 'byteplus-coding/dola-seed-2.0-pro',
        apiKey: 'kilo-only-key',
      },
    });
    expect(config && 'workhorse' in config ? config.workhorse.apiKey : '').not.toBe(
      'kilo-only-key',
    );
    expect(config && 'creative' in config ? config.creative.apiKey : '').not.toBe(
      'openrouter-only-key',
    );
    expect(fields.map((field) => field.value)).toEqual(['', '']);
  });

  it('degrades to a saved Kilo profile with a legacy URL after canonicalizing it', async () => {
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.provider-profile.list') {
        return [
          {
            id: 'legacy-kilo',
            provider: 'kilo',
            name: 'Kilo legacy URL',
            baseUrl: 'https://api.kilo.ai/v1',
            modelId: 'byteplus-coding/dola-seed-2.0-lite',
            createdAt: '2026-09-15T00:00:00.000Z',
            updatedAt: '2026-09-15T00:00:00.000Z',
          },
        ];
      }
      if (channel === 'desktop.provider-profile.begin-session') {
        return { apiKey: 'sk-test-REDACTED-0000' };
      }
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
    await act(async () => {
      buttonByText(rendered, 'Dual-Brain Studio').click();
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledWith('desktop.provider-profile.begin-session', {
      id: 'legacy-kilo',
    });
    expect(engineClient.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'kilo',
        baseUrl: 'https://api.kilo.ai/api/gateway',
        modelId: 'byteplus-coding/dola-seed-2.0-lite',
        apiKey: 'sk-test-REDACTED-0000',
      }),
    );
  });

  it.each(['openrouter', 'kilo'] as const)(
    'never uses the saved key of a %s profile bound to a non-trusted URL in Dual-Brain',
    async (untrustedProvider) => {
      const openRouterBaseUrl =
        untrustedProvider === 'openrouter'
          ? 'https://openrouter.ai.evil.example/api/v1'
          : 'https://openrouter.ai/api/v1';
      const kiloBaseUrl =
        untrustedProvider === 'kilo'
          ? 'https://custom-kilo.example/v1'
          : 'https://api.kilo.ai/api/gateway';
      const invoke = vi.fn().mockImplementation(async (channel: string, args?: { id?: string }) => {
        if (channel === 'desktop.provider-profile.list') {
          return [
            {
              id: 'dual-openrouter',
              provider: 'openrouter',
              name: 'OpenRouter',
              baseUrl: openRouterBaseUrl,
              modelId: 'openrouter/free',
              createdAt: '2026-09-15T00:00:00.000Z',
              updatedAt: '2026-09-15T00:00:00.000Z',
            },
            {
              id: 'dual-kilo',
              provider: 'kilo',
              name: 'Kilo',
              baseUrl: kiloBaseUrl,
              modelId: 'byteplus-coding/dola-seed-2.0-pro',
              createdAt: '2026-09-15T00:00:00.000Z',
              updatedAt: '2026-09-15T00:00:00.000Z',
            },
          ];
        }
        if (channel === 'desktop.provider-profile.begin-session') {
          return { apiKey: `saved-${args?.id}-key` };
        }
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
      await act(async () => {
        buttonByText(rendered, 'Dual-Brain Studio').click();
      });
      await act(async () => {
        buttonByText(rendered, 'Connect model').click();
        await Promise.resolve();
      });
      const untrustedId = untrustedProvider === 'openrouter' ? 'dual-openrouter' : 'dual-kilo';
      // The vault is never asked for the key of a profile bound to another URL,
      // and that key never reaches the fixed trusted Dual-Brain endpoint.
      expect(invoke).not.toHaveBeenCalledWith('desktop.provider-profile.begin-session', {
        id: untrustedId,
      });
      for (const [config] of vi.mocked(engineClient.configure).mock.calls) {
        expect(JSON.stringify(config)).not.toContain(`saved-${untrustedId}-key`);
      }
    },
  );

  it('reports a partial Dual-Brain connection as an error and names the unusable brain', async () => {
    const engineClient = client({
      testConnection: vi.fn().mockResolvedValue({
        provider: 'dual-brain',
        modelId: 'openrouter/free + byteplus-coding/dola-seed-2.0-pro',
        capability: 'incompatible',
        dualBrain: {
          workhorse: {
            provider: 'openrouter',
            modelId: 'openrouter/free',
            capability: 'tool-loop',
          },
          creative: {
            provider: 'kilo',
            modelId: 'byteplus-coding/dola-seed-2.0-pro',
            capability: 'incompatible',
            message: 'Kilo refused partial-status-key',
          },
        },
      }),
    });
    const rendered = await render(engineClient, undefined);
    const fields = [...rendered.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    setInputValue(fields[0]!, 'openrouter-partial-key');
    setInputValue(fields[1]!, 'partial-status-key');

    await act(async () => {
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });

    expect(rendered.querySelector('[role="alert"]')?.textContent).toContain(
      'Dual-Brain partially connected. OpenRouter: tool-loop; Kilo: incompatible (Kilo refused [redacted]). Tool-loop readiness requires both brains.',
    );
    expect(rendered.textContent).not.toContain('are live.');
    expect(rendered.textContent).not.toContain('partial-status-key');
  });

  it('replaces the connected status when Dual-Brain configuration throws', async () => {
    const onStatusChange = vi.fn();
    const engineClient = client({
      configure: vi.fn().mockRejectedValue(new Error('setup failed')),
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <JoyAgentSettingsDialog
          policy={DEFAULT_AGENT_POLICY}
          onPolicyChange={vi.fn()}
          engineClient={engineClient}
          status={readyStatus}
          onStatusChange={onStatusChange}
          onClose={vi.fn()}
        />,
      );
    });
    const rendered = container;
    const fields = [...rendered.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    await act(async () => {
      setInputValue(fields[0]!, 'or-key');
      setInputValue(fields[1]!, 'kilo-key');
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });
    expect(onStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'dual-brain',
        capability: 'incompatible',
        message: 'setup failed',
      }),
    );
    expect(rendered.querySelector('[role="status"]')?.textContent).toContain('Connection failed');
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
    const dialog = [...rendered.querySelectorAll('[role="dialog"]')].at(-1);
    if (!dialog) throw new Error('Expected settings dialog');

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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/agent/models');
    expect(rendered.textContent).not.toContain(privateKey);
  });

  it('redacts the API key from desktop model discovery errors', async () => {
    const privateKey = 'discovery-test-key';
    const invoke = vi.fn((channel: string) =>
      channel === 'desktop.provider-profile.fetch-models'
        ? Promise.reject(new Error(`Provider rejected key ${privateKey}`))
        : Promise.resolve([]),
    );
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list', 'desktop.provider-profile.fetch-models'],
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

  it('selects the canonical Kilo URL and BytePlus default model', async () => {
    const rendered = await render(client(), readyStatus);
    await selectCustomPreset(rendered);
    await changeProvider(rendered, 'kilo');
    expect(
      rendered.querySelector<HTMLInputElement>('input[placeholder="https://..."]')?.value,
    ).toBe('https://api.kilo.ai/api/gateway');
    expect(rendered.querySelector<HTMLInputElement>('input[aria-label="Model ID"]')?.value).toBe(
      'byteplus-coding/dola-seed-2.0-pro',
    );
  });

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
      channels: ['desktop.provider-profile.list', 'desktop.provider-profile.fetch-models'],
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

    expect(invoke).not.toHaveBeenCalledWith(
      'desktop.provider-profile.fetch-models',
      expect.anything(),
    );
    expect(rendered.textContent).toContain(
      'Enter the custom-provider acknowledgement before discovering models.',
    );
  });

  it('blocks a saved custom profile before retrieving its key until acknowledged', async () => {
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.provider-profile.list') {
        return [
          {
            id: 'custom-prof-1',
            provider: 'openrouter',
            name: 'OpenRouter custom endpoint',
            baseUrl: 'https://other.example/api/v1',
            modelId: 'private-model',
            createdAt: '2026-09-15T00:00:00.000Z',
            updatedAt: '2026-09-15T00:00:00.000Z',
          },
        ];
      }
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
    });

    await act(async () => {
      buttonByText(rendered, 'Use').click();
      await Promise.resolve();
    });

    expect(invoke).not.toHaveBeenCalledWith(
      'desktop.provider-profile.begin-session',
      expect.anything(),
    );
    expect(engineClient.configure).not.toHaveBeenCalled();
    expect(rendered.textContent).toContain(
      'Enter the custom-provider acknowledgement before connecting.',
    );
    expect(rendered.querySelector<HTMLInputElement>('input[type="checkbox"]')).not.toBeNull();
  });

  it('publishes a failed status when configuring a saved profile throws', async () => {
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.provider-profile.list')
        return [
          {
            id: 'openrouter-trusted',
            provider: 'openrouter',
            name: 'OpenRouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            modelId: 'openrouter/auto',
            createdAt: '2026-09-15T00:00:00.000Z',
            updatedAt: '2026-09-15T00:00:00.000Z',
          },
        ];
      if (channel === 'desktop.provider-profile.begin-session') return { apiKey: 'saved-secret' };
      return undefined;
    });
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list', 'desktop.provider-profile.begin-session'],
      invoke,
    };
    const onStatusChange = vi.fn();
    const engineClient = client({
      configure: vi.fn().mockRejectedValue(new Error('configure failed')),
    });
    const rendered = await render(engineClient, readyStatus, onStatusChange);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      buttonByText(rendered, 'Use').click();
      await Promise.resolve();
    });
    expect(onStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openrouter',
        capability: 'incompatible',
      }),
    );
  });

  it('requires acknowledgement when a custom provider is selected from the dual-brain default', async () => {
    const engineClient = client();
    const rendered = await render(engineClient, undefined);
    const dualBrainPreset = buttonByText(rendered, 'Dual-Brain Studio');
    expect(dualBrainPreset.className).toContain('is-active');

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
});

describe('JOY Agent Settings desktop profile persistence', () => {
  it('keeps the explicit Joy Hosted preset when an OpenRouter profile is present', async () => {
    window.localStorage.setItem('joy-agent-last-preset', 'joy-hosted');
    window.localStorage.setItem('joy-media-session-token', 'session-test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: string) => {
        if (input.endsWith('/v1/agent/models'))
          return new Response(
            JSON.stringify({ models: [{ id: 'bytedance-seed/seed-2.0-lite', isDefault: true }] }),
            { status: 200 },
          );
        return new Response(JSON.stringify({ data: { status: 'active' } }), { status: 200 });
      }),
    );
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list'],
      invoke: vi.fn().mockResolvedValue([
        {
          id: 'prof-or-1',
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          modelId: 'openrouter/free',
          createdAt: '2026-09-15T00:00:00.000Z',
          updatedAt: '2026-09-15T00:00:00.000Z',
        },
      ]),
    };
    const rendered = await render(client());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(rendered.querySelector<HTMLSelectElement>('select')?.value).toBe('joy-hosted');
    expect(rendered.textContent).toContain('Active JOY Pro subscription');
  });

  it('shows the live unsubscribed state returned by the JOY account API', async () => {
    window.localStorage.setItem('joy-media-session-token', 'session-test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: string) => {
        if (input.endsWith('/v1/agent/models'))
          return new Response(
            JSON.stringify({ models: [{ id: 'bytedance-seed/seed-2.0-lite', isDefault: true }] }),
            { status: 200 },
          );
        return new Response(JSON.stringify({ data: { status: 'none' } }), { status: 200 });
      }),
    );
    const rendered = await render(client());
    await act(async () => {
      buttonByText(rendered, 'Joy Hosted Pro Gateway').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rendered.textContent).toContain('Not subscribed — Upgrade or use BYOK');
  });

  it('maps hosted gateway error codes to actionable notices', async () => {
    window.localStorage.setItem('joy-media-session-token', 'session-test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: string) => {
        if (input.endsWith('/v1/agent/models'))
          return new Response(
            JSON.stringify({ models: [{ id: 'bytedance-seed/seed-2.0-lite', isDefault: true }] }),
            { status: 200 },
          );
        return new Response(JSON.stringify({ data: { status: 'active' } }), { status: 200 });
      }),
    );
    const engineClient = client({
      configure: vi.fn().mockRejectedValue(new Error('JOY_SUBSCRIPTION_REQUIRED')),
    });
    const rendered = await render(engineClient);
    await act(async () => {
      buttonByText(rendered, 'Joy Hosted Pro Gateway').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });
    expect(rendered.textContent).toContain(
      'Joy Model needs an active JOY Pro subscription. Switch to Dual-Brain/BYOK.',
    );
    expect(engineClient.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'joy-hosted',
        modelId: 'bytedance-seed/seed-2.0-lite',
        apiKey: 'session-test',
      }),
    );
  });

  it('shows the server configuration notice when Joy Model is not configured', async () => {
    window.localStorage.setItem('joy-media-session-token', 'session-test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: string) => {
        if (input.endsWith('/v1/agent/models'))
          return new Response(
            JSON.stringify({
              models: [{ id: 'bytedance-seed/seed-2.0-lite', isDefault: true }],
            }),
            { status: 200 },
          );
        return new Response(JSON.stringify({ data: { status: 'active' } }), { status: 200 });
      }),
    );
    const rendered = await render(
      client({ configure: vi.fn().mockRejectedValue(new Error('JOY_AGENT_UNCONFIGURED')) }),
    );
    await act(async () => {
      buttonByText(rendered, 'Joy Hosted Pro Gateway').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });
    expect(rendered.textContent).toContain(
      'Joy Model is temporarily unavailable on the server (not configured).',
    );
  });

  it('configures the catalog default model after successful JOY account sign-in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: string) => {
        if (input.endsWith('/v1/agent/models'))
          return new Response(
            JSON.stringify({ models: [{ id: 'bytedance-seed/seed-2.0-lite', isDefault: true }] }),
            { status: 200 },
          );
        if (input.endsWith('/v1/auth/request-otp'))
          return new Response(JSON.stringify({ data: { message: 'Code sent' } }), { status: 200 });
        if (input.endsWith('/v1/auth/verify-otp'))
          return new Response(JSON.stringify({ data: { token: 'session-after-login' } }), {
            status: 200,
          });
        if (input.endsWith('/v1/account/subscription'))
          return new Response(JSON.stringify({ data: { status: 'active' } }), { status: 200 });
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }),
    );
    const engineClient = client();
    const rendered = await render(engineClient);
    await act(async () => {
      buttonByText(rendered, 'Joy Hosted Pro Gateway').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByText(rendered, '🔑 Sign In with JOY Account to Activate').click();
    });
    const dialog = [...rendered.querySelectorAll('[role="dialog"]')].at(-1);
    if (!dialog) throw new Error('Expected JOY account dialog');
    const contact = dialog.querySelector<HTMLInputElement>('.desktop-auth-input');
    if (contact === null) throw new Error('Expected account email input');
    await act(async () => {
      setInputValue(contact, 'studio@example.test');
      contact
        .closest('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    const otpInputs = [...dialog.querySelectorAll<HTMLInputElement>('.desktop-auth-otp-box')];
    expect(otpInputs).toHaveLength(6);
    await act(async () => {
      for (const [index, input] of otpInputs.entries()) setInputValue(input, String(index + 1));
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    expect(engineClient.configure).toHaveBeenCalledWith({
      provider: 'joy-hosted',
      baseUrl: 'https://joyst.ir/api/v1/agent',
      modelId: 'bytedance-seed/seed-2.0-lite',
      apiKey: 'session-after-login',
    });
  });

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
      setInputValue(key, 'sk-test-REDACTED-0000');
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith('desktop.provider-profile.save', {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openrouter/free',
      apiKey: 'sk-test-REDACTED-0000',
    });
  });

  it('uses saved profile key when connecting with blank key field', async () => {
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
      if (channel === 'desktop.provider-profile.begin-session') {
        return {
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          modelId: 'anthropic/claude-3.5-sonnet',
          apiKey: 'sk-test-REDACTED-0000',
        };
      }
      if (channel === 'desktop.provider-profile.save') {
        return {
          id: 'prof-or-1',
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          modelId: 'anthropic/claude-3.5-sonnet',
          createdAt: '2026-09-15T00:00:00.000Z',
          updatedAt: '2026-09-15T00:00:00.000Z',
        };
      }
      return undefined;
    });
    window.joyDesktop = {
      channels: [
        'desktop.provider-profile.list',
        'desktop.provider-profile.begin-session',
        'desktop.provider-profile.save',
      ],
      invoke,
    };
    const engineClient = client();
    const rendered = await render(engineClient, undefined);
    await selectCustomPreset(rendered);

    await act(async () => {
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith('desktop.provider-profile.begin-session', {
      id: 'prof-or-1',
    });
    expect(engineClient.configure).toHaveBeenCalledWith({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'anthropic/claude-3.5-sonnet',
      apiKey: 'sk-test-REDACTED-0000',
    });
  });

  it('does not configure Joy Model without a JOY session and offers sign-in', async () => {
    const engineClient = client();
    const rendered = await render(engineClient, undefined);
    const joyHostedPreset = buttonByText(rendered, 'Joy Hosted Pro Gateway');
    await act(async () => {
      joyHostedPreset.click();
      await Promise.resolve();
    });

    const select = rendered.querySelector<HTMLSelectElement>('select');
    if (select === null) throw new Error('Expected provider select dropdown');
    await act(async () => {
      select.value = 'joy-hosted';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(rendered.textContent).toContain('Joy Model (Built-in Pro AI)');
    expect(rendered.textContent).toContain('Signed out');
    expect(rendered.querySelector('input[type="password"]')).toBeNull();

    await act(async () => {
      buttonByText(rendered, 'Connect model').click();
      await Promise.resolve();
    });

    expect(engineClient.configure).not.toHaveBeenCalled();
    expect(rendered.textContent).toContain('Sign in to your JOY account to use Joy Model');
    expect(window.localStorage.getItem('joy-agent-last-preset')).toBe('joy-hosted');
    await act(async () => {
      buttonByText(rendered, '🔑 Sign In with JOY Account to Activate').click();
      await Promise.resolve();
    });
    expect(rendered.textContent).toContain('Connect JOY Account');
  });
});
