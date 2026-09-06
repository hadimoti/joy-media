// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_POLICY } from './agent-policy-settings.js';
import { JoyAgentSettingsDialog } from './JoyAgentSettingsDialog.js';
import type { JoyAgentEngineClient } from './joy-agent/engine-client.js';
import type { ByokSessionStatus, JoyAgentMediaCapabilityReport } from './joy-agent/protocol.js';

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
        {...(status === undefined ? {} : { status })}
        onClose={vi.fn()}
      />,
    );
  });
  return container;
}

function buttonByText(rendered: HTMLElement, text: string): HTMLButtonElement {
  const button = [...rendered.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (button === undefined) throw new Error(`Expected button "${text}"`);
  return button;
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
});

describe('JOY Agent Settings media capability probe', () => {
  it('does not probe on mount or connection test, then explicitly sends the check and preserves the connection success notice', async () => {
    const engineClient = client();
    const rendered = await render(engineClient, undefined);
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
    expect(rendered.textContent).not.toContain('Image Supported');
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
