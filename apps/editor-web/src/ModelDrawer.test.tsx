// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelDrawer } from './ModelDrawer.js';
import type { JoyAgentEngineClient } from './joy-agent/engine-client.js';
import type { ByokSessionStatus } from './joy-agent/protocol.js';
import * as desktopClient from './desktop-client.js';
import { resetCustomEndpointAcknowledgementsForTests } from './custom-endpoint-acknowledgement.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initialStatus: ByokSessionStatus = {
  provider: 'kilo',
  modelId: 'minimax/minimax-m3',
  capability: 'tool-loop',
};

function createMockEngineClient(
  overrides: Partial<JoyAgentEngineClient> = {},
): JoyAgentEngineClient {
  return {
    configure: vi.fn().mockImplementation(async (config) => ({
      provider: config.provider,
      modelId: config.modelId,
      capability: 'tool-loop',
    })),
    testConnection: vi.fn().mockResolvedValue(initialStatus),
    probeMediaCapabilities: vi.fn(),
    startRun: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn(),
    dispose: vi.fn(),
    getStatus: vi.fn(() => initialStatus),
    getMediaCapabilities: vi.fn(() => undefined),
    ...overrides,
  } as unknown as JoyAgentEngineClient;
}

describe('ModelDrawer', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    vi.spyOn(desktopClient, 'isDesktopHost').mockReturnValue(true);
    vi.spyOn(desktopClient, 'listDesktopProviderProfiles').mockResolvedValue([
      {
        id: 'kilo-profile-1',
        name: 'Kilo Gateway',
        provider: 'kilo',
        baseUrl: 'https://api.kilo.ai/api/gateway',
        modelId: 'byteplus-coding/dola-seed-2.0-pro',
        cachedModels: [
          'byteplus-coding/dola-seed-2.0-pro',
          'byteplus-coding/dola-seed-2.0-lite',
          'byteplus-coding/deepseek-v4-flash',
        ],
        createdAt: '2026-09-17T00:00:00Z',
        updatedAt: '2026-09-17T00:00:00Z',
      },
      {
        id: 'openrouter-profile-2',
        name: 'OpenRouter Primary',
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'openrouter/free',
        cachedModels: ['openrouter/free', 'openrouter/auto'],
        createdAt: '2026-09-17T00:00:00Z',
        updatedAt: '2026-09-17T00:00:00Z',
      },
    ]);
    vi.spyOn(desktopClient, 'beginDesktopProviderSession').mockResolvedValue({
      provider: 'kilo',
      baseUrl: 'https://api.kilo.ai/api/gateway',
      modelId: 'byteplus-coding/dola-seed-2.0-pro',
      apiKey: 'kilo-secret-key-123',
    });
    vi.spyOn(desktopClient, 'saveDesktopProviderProfile').mockImplementation(async (req) => ({
      id: req.id ?? 'new-profile-id',
      name: req.name ?? req.provider,
      provider: req.provider,
      baseUrl: req.baseUrl,
      modelId: req.modelId,
      cachedModels: req.cachedModels,
      createdAt: '2026-09-17T00:00:00Z',
      updatedAt: '2026-09-17T00:00:00Z',
    }));
    vi.spyOn(desktopClient, 'fetchDesktopProviderModels').mockResolvedValue([
      { id: 'byteplus-coding/dola-seed-2.0-pro', name: 'Dola Seed Pro' },
      { id: 'byteplus-coding/dola-seed-2.0-lite', name: 'Dola Seed Lite' },
      { id: 'byteplus-coding/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    ]);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
    resetCustomEndpointAcknowledgementsForTests();
  });

  it('renders active model badge and configured profiles when open', async () => {
    const client = createMockEngineClient();
    await act(async () => {
      root?.render(
        <ModelDrawer open={true} onClose={vi.fn()} engineClient={client} status={initialStatus} />,
      );
    });

    expect(container?.textContent).toContain('Model Drawer');
    expect(container?.textContent).toContain('kilo: byteplus-coding/dola-seed-2.0-pro');
    expect(container?.textContent).toContain('A saved model has been retired');
    expect(container?.textContent).toContain('Kilo Gateway');
    expect(container?.textContent).toContain('OpenRouter Primary');
    expect(container?.textContent).toContain('byteplus-coding/dola-seed-2.0-lite');
    expect(container?.textContent).toContain('byteplus-coding/deepseek-v4-flash');
    expect(container?.textContent).not.toContain('minimax/minimax-m3');
    expect(container?.textContent).not.toContain('kilo-auto/');
  });

  it('saves a corrected Kilo URL when a legacy profile is next updated', async () => {
    vi.mocked(desktopClient.listDesktopProviderProfiles).mockResolvedValue([
      {
        id: 'legacy-kilo-profile',
        name: 'Legacy Kilo',
        provider: 'kilo',
        baseUrl: 'https://api.kilo.ai/v1',
        modelId: 'byteplus-coding/dola-seed-2.0-pro',
        cachedModels: ['byteplus-coding/dola-seed-2.0-pro', 'byteplus-coding/deepseek-v4-flash'],
        createdAt: '2026-09-17T00:00:00Z',
        updatedAt: '2026-09-17T00:00:00Z',
      },
    ]);
    const client = createMockEngineClient();
    await act(async () => {
      root?.render(
        <ModelDrawer open={true} onClose={vi.fn()} engineClient={client} status={initialStatus} />,
      );
    });
    const deepseekItem = [
      ...(container?.querySelectorAll<HTMLElement>('.model-drawer-model-item') ?? []),
    ].find((item) => item.textContent?.includes('byteplus-coding/deepseek-v4-flash'));
    expect(deepseekItem).toBeTruthy();
    await act(async () => {
      deepseekItem?.click();
      await Promise.resolve();
    });
    expect(desktopClient.saveDesktopProviderProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'legacy-kilo-profile',
        baseUrl: 'https://api.kilo.ai/api/gateway',
        modelId: 'byteplus-coding/deepseek-v4-flash',
      }),
    );
  });

  it('does not render anything when open is false', async () => {
    const client = createMockEngineClient();
    await act(async () => {
      root?.render(
        <ModelDrawer open={false} onClose={vi.fn()} engineClient={client} status={initialStatus} />,
      );
    });

    expect(container?.innerHTML).toBe('');
  });

  it('filters models in real-time when user types in search input', async () => {
    const client = createMockEngineClient();
    await act(async () => {
      root?.render(
        <ModelDrawer open={true} onClose={vi.fn()} engineClient={client} status={initialStatus} />,
      );
    });

    const searchInput = container?.querySelector('.model-drawer-search-input') as HTMLInputElement;
    expect(searchInput).toBeTruthy();

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      nativeInputValueSetter?.call(searchInput, 'deepseek');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container?.textContent).toContain('byteplus-coding/deepseek-v4-flash');
    expect(container?.textContent).not.toContain('openrouter/free');
  });

  it('switches model immediately on click, updating engine configuration', async () => {
    const client = createMockEngineClient();
    const onStatusChange = vi.fn();
    const onNotice = vi.fn();

    await act(async () => {
      root?.render(
        <ModelDrawer
          open={true}
          onClose={vi.fn()}
          engineClient={client}
          status={initialStatus}
          onStatusChange={onStatusChange}
          onNotice={onNotice}
        />,
      );
    });

    const modelItems = container?.querySelectorAll('.model-drawer-model-item');
    const efficientItem = Array.from(modelItems ?? []).find((el) =>
      el.textContent?.includes('byteplus-coding/deepseek-v4-flash'),
    ) as HTMLElement;

    expect(efficientItem).toBeTruthy();

    await act(async () => {
      efficientItem.click();
    });

    expect(client.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'kilo',
        modelId: 'byteplus-coding/deepseek-v4-flash',
      }),
    );
    expect(onStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'byteplus-coding/deepseek-v4-flash',
      }),
    );
    expect(onNotice).toHaveBeenCalledWith(
      expect.stringContaining('Switched active model to byteplus-coding/deepseek-v4-flash'),
      'success',
    );
  });

  it('publishes an incompatible status when a saved-profile configuration fails', async () => {
    const client = createMockEngineClient({
      configure: vi.fn().mockRejectedValue(new Error('profile configuration failed')),
    });
    const onStatusChange = vi.fn();
    await act(async () => {
      root?.render(
        <ModelDrawer
          open={true}
          onClose={vi.fn()}
          engineClient={client}
          status={initialStatus}
          onStatusChange={onStatusChange}
        />,
      );
    });
    const modelItem = [
      ...(container?.querySelectorAll<HTMLElement>('.model-drawer-model-item') ?? []),
    ].find((el) => el.textContent?.includes('byteplus-coding/deepseek-v4-flash'));
    expect(modelItem).toBeTruthy();
    await act(async () => {
      modelItem?.click();
      await Promise.resolve();
    });
    expect(onStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'kilo',
        modelId: 'byteplus-coding/deepseek-v4-flash',
        capability: 'incompatible',
      }),
    );
  });

  it('discovers models dynamically when adding a new API endpoint', async () => {
    const client = createMockEngineClient();
    const onNotice = vi.fn();

    await act(async () => {
      root?.render(
        <ModelDrawer
          open={true}
          onClose={vi.fn()}
          engineClient={client}
          status={initialStatus}
          onNotice={onNotice}
        />,
      );
    });

    const addBtn = container?.querySelector('.model-drawer-add-btn') as HTMLButtonElement;
    expect(addBtn).toBeTruthy();

    await act(async () => {
      addBtn.click();
    });

    expect(container?.textContent).toContain('Connect New API Endpoint');

    const discoverBtn = Array.from(container?.querySelectorAll('button') ?? []).find((btn) =>
      btn.textContent?.includes('Discover Models Behind Link'),
    );
    expect(discoverBtn).toBeTruthy();

    await act(async () => {
      discoverBtn?.click();
    });

    expect(desktopClient.fetchDesktopProviderModels).toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith(
      expect.stringContaining('Discovered 3 models successfully!'),
      'success',
    );
  });

  it('blocks Model Drawer discovery and connection for custom URLs until acknowledged', async () => {
    const client = createMockEngineClient();
    await act(async () => {
      root?.render(
        <ModelDrawer open={true} onClose={vi.fn()} engineClient={client} status={initialStatus} />,
      );
    });
    await act(async () => {
      (container?.querySelector('.model-drawer-add-btn') as HTMLButtonElement).click();
    });
    const provider = container?.querySelector('#md-provider-type') as HTMLSelectElement | null;
    expect(provider).not.toBeNull();
    await act(async () => {
      if (provider) {
        provider.value = 'custom';
        provider.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    const base = container?.querySelector('#md-base-url') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(base, 'https://custom.example/v1');
      base.dispatchEvent(new Event('input', { bubbles: true }));
      const discover = [...(container?.querySelectorAll('button') ?? [])].find((button) =>
        button.textContent?.includes('Discover Models Behind Link'),
      );
      discover?.click();
      await Promise.resolve();
    });
    expect(desktopClient.fetchDesktopProviderModels).not.toHaveBeenCalled();
    expect(container?.textContent).toContain('Acknowledge this custom endpoint');
    await act(async () => {
      const connect = [...(container?.querySelectorAll('button') ?? [])].find((button) =>
        button.textContent?.includes('Save & Connect'),
      );
      connect?.click();
      await Promise.resolve();
    });
    expect(desktopClient.saveDesktopProviderProfile).not.toHaveBeenCalled();
    expect(client.configure).not.toHaveBeenCalled();
  });

  it('requires consent when the OpenRouter label points to a custom URL before discovery or connect', async () => {
    const client = createMockEngineClient();
    await act(async () => {
      root?.render(<ModelDrawer open={true} onClose={vi.fn()} engineClient={client} />);
    });
    await act(async () => {
      (container?.querySelector('.model-drawer-add-btn') as HTMLButtonElement).click();
    });
    const provider = container?.querySelector('#md-provider-type') as HTMLSelectElement;
    await act(async () => {
      provider.value = 'openrouter';
      provider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const base = container?.querySelector('#md-base-url') as HTMLInputElement;
    const key = container?.querySelector('#md-api-key') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(base, 'https://custom.example/api/v1');
      base.dispatchEvent(new Event('input', { bubbles: true }));
      setter?.call(key, 'openrouter-labeled-custom-secret');
      key.dispatchEvent(new Event('input', { bubbles: true }));
      [...(container?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.includes('Discover Models Behind Link'))
        ?.click();
      await Promise.resolve();
    });
    expect(desktopClient.fetchDesktopProviderModels).not.toHaveBeenCalled();
    const acknowledgement = container?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(acknowledgement).not.toBeNull();
    await act(async () => {
      [...(container?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.includes('Save & Connect'))
        ?.click();
      await Promise.resolve();
    });
    expect(desktopClient.saveDesktopProviderProfile).not.toHaveBeenCalled();
    expect(client.configure).not.toHaveBeenCalled();
  });

  it('cancels a pending Save & Connect when consent is withdrawn before the save resolves', async () => {
    let resolveSave: ((value: desktopClient.DesktopProviderProfile) => void) | undefined;
    vi.mocked(desktopClient.saveDesktopProviderProfile).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const client = createMockEngineClient();
    await act(async () => {
      root?.render(<ModelDrawer open={true} onClose={vi.fn()} engineClient={client} />);
    });
    await act(async () => {
      (container?.querySelector('.model-drawer-add-btn') as HTMLButtonElement).click();
    });
    const provider = container?.querySelector('#md-provider-type') as HTMLSelectElement;
    const base = container?.querySelector('#md-base-url') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      provider.value = 'custom';
      provider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      setter?.call(base, 'https://custom.example/v1');
      base.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const consent = () =>
      [...(container?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])].find(
        (input) => input.closest('label')?.textContent?.includes('custom endpoint may log'),
      );
    await act(async () => {
      consent()?.click();
    });
    await act(async () => {
      [...(container?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.includes('Save & Connect'))
        ?.click();
      await Promise.resolve();
    });
    // The checkbox is disabled while saving; withdraw consent directly, as a
    // second view or a stale handler could.
    resetCustomEndpointAcknowledgementsForTests();
    await act(async () => {
      resolveSave?.({
        id: 'saved',
        name: 'custom',
        provider: 'custom',
        baseUrl: 'https://custom.example/v1',
        modelId: 'm',
        createdAt: '2026-09-17T00:00:00Z',
        updatedAt: '2026-09-17T00:00:00Z',
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.configure).not.toHaveBeenCalled();
  });

  it('blocks a saved OpenRouter-labeled custom profile before retrieving its key', async () => {
    vi.mocked(desktopClient.listDesktopProviderProfiles).mockResolvedValue([
      {
        id: 'openrouter-custom-profile',
        name: 'OpenRouter custom endpoint',
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai.evil.example/api/v1',
        modelId: 'openrouter/free',
        cachedModels: ['openrouter/free'],
        createdAt: '2026-09-17T00:00:00Z',
        updatedAt: '2026-09-17T00:00:00Z',
      },
    ]);
    const client = createMockEngineClient();
    await act(async () => {
      root?.render(<ModelDrawer open={true} onClose={vi.fn()} engineClient={client} />);
    });
    const modelItem = [
      ...(container?.querySelectorAll<HTMLElement>('.model-drawer-model-item') ?? []),
    ].find((el) => el.textContent?.includes('openrouter/free'));
    expect(modelItem).toBeTruthy();
    await act(async () => {
      modelItem?.click();
      await Promise.resolve();
    });
    expect(desktopClient.beginDesktopProviderSession).not.toHaveBeenCalled();
    expect(client.configure).not.toHaveBeenCalled();
    expect(container?.textContent).toContain(
      'I acknowledge OpenRouter custom endpoint for this session.',
    );
  });
});
