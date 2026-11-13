// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetLibrarySettingsDialog } from './AssetLibrarySettingsDialog.js';
import type { DesktopAssetLibrarySettings } from './desktop-client.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEFAULT_DIRECTORY = 'fixture-assets/asset-library';

function settings(
  overrides: Partial<DesktopAssetLibrarySettings> = {},
): DesktopAssetLibrarySettings {
  return {
    directory: DEFAULT_DIRECTORY,
    exists: true,
    hasCatalog: true,
    isDefault: true,
    counts: { total: 12, video: 4, image: 3, audio: 5, other: 0 },
    driveType: 'fixed',
    ...overrides,
  };
}

function installDesktopBridge(
  implementation: (channel: string, args?: unknown) => unknown | Promise<unknown>,
) {
  const invoke = vi.fn(implementation);
  window.joyDesktop = {
    channels: [
      'desktop.asset-library.get-settings',
      'desktop.asset-library.set-directory',
      'desktop.asset-library.select-directory',
      'desktop.asset-library.reset-directory',
      'desktop.asset-library.open-directory',
    ],
    invoke,
  } as NonNullable<typeof window.joyDesktop>;
  return invoke;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function renderDialog(onDirectoryChanged: () => void = vi.fn()): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <AssetLibrarySettingsDialog open onClose={vi.fn()} onDirectoryChanged={onDirectoryChanged} />,
    );
    await Promise.resolve();
    await Promise.resolve();
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

function statValue(rendered: HTMLElement, label: string): string | null {
  const labelNode = [...rendered.querySelectorAll<HTMLElement>('div')].find(
    (element) => element.textContent?.trim() === label,
  );
  return labelNode?.previousElementSibling?.textContent?.trim() ?? null;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  delete (window as { joyDesktop?: unknown }).joyDesktop;
  vi.restoreAllMocks();
});

describe('AssetLibrarySettingsDialog', () => {
  it('shows the current default path, connection status, and inspection counts', async () => {
    installDesktopBridge((channel) =>
      channel === 'desktop.asset-library.get-settings' ? settings() : undefined,
    );

    const rendered = await renderDialog();

    expect(rendered.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe(
      DEFAULT_DIRECTORY,
    );
    expect(rendered.textContent).toContain('Default Path');
    expect(rendered.textContent).toContain('Connected & Ready');
    expect(statValue(rendered, 'Video')).toBe('4');
    expect(statValue(rendered, 'Images')).toBe('3');
    expect(statValue(rendered, 'Audio')).toBe('5');
    expect(statValue(rendered, 'Total')).toBe('12');
  });

  it('adds the counts up: the kinds shown together make the total', async () => {
    installDesktopBridge((channel) =>
      channel === 'desktop.asset-library.get-settings'
        ? settings({ counts: { total: 9, video: 4, image: 2, audio: 2, other: 1 } })
        : undefined,
    );

    const rendered = await renderDialog();

    expect(statValue(rendered, 'Video')).toBe('4');
    expect(statValue(rendered, 'Images')).toBe('2');
    expect(statValue(rendered, 'Audio')).toBe('2');
    expect(statValue(rendered, 'Other')).toBe('1');
    expect(statValue(rendered, 'Total')).toBe('9');
  });

  it('leaves out the "Other" count when there is nothing else in the library', async () => {
    installDesktopBridge((channel) =>
      channel === 'desktop.asset-library.get-settings' ? settings() : undefined,
    );

    const rendered = await renderDialog();

    expect(statValue(rendered, 'Other')).toBeNull();
  });

  it('says the folder holds the imported media', async () => {
    installDesktopBridge((channel) =>
      channel === 'desktop.asset-library.get-settings' ? settings() : undefined,
    );

    const rendered = await renderDialog();

    expect(rendered.textContent).toContain(
      'Choose the folder where JOY Media keeps your imported media.',
    );
  });

  it('warns calmly when the library sits on a drive that is not always there', async () => {
    installDesktopBridge((channel) =>
      channel === 'desktop.asset-library.get-settings'
        ? settings({ driveType: 'removable' })
        : undefined,
    );

    const rendered = await renderDialog();

    expect(rendered.textContent).toContain(
      'This drive is not always connected. Your media will show as missing when it is unplugged.',
    );
  });

  it('does not warn about a drive that is always there', async () => {
    installDesktopBridge((channel) =>
      channel === 'desktop.asset-library.get-settings'
        ? settings({ driveType: 'fixed' })
        : undefined,
    );

    const rendered = await renderDialog();

    expect(rendered.textContent).not.toContain('This drive is not always connected.');
  });

  it('does not warn about a drive it could not identify', async () => {
    installDesktopBridge((channel) =>
      channel === 'desktop.asset-library.get-settings'
        ? settings({ driveType: 'unknown' })
        : undefined,
    );

    const rendered = await renderDialog();

    expect(rendered.textContent).not.toContain('This drive is not always connected.');
  });

  it('opens the library folder without naming a path', async () => {
    const invoke = installDesktopBridge((channel) =>
      channel === 'desktop.asset-library.get-settings' ? settings() : undefined,
    );
    const rendered = await renderDialog();

    await act(async () => {
      buttonByText(rendered, 'Open folder').click();
      await Promise.resolve();
    });

    const call = invoke.mock.calls.find(
      ([channel]) => channel === 'desktop.asset-library.open-directory',
    );
    expect(call).toBeDefined();
    expect(call?.[1]).toBeUndefined();
  });

  it('explains how to reconnect a previous library when the default catalog is missing', async () => {
    installDesktopBridge((channel) =>
      channel === 'desktop.asset-library.get-settings'
        ? settings({
            hasCatalog: false,
            counts: { total: 0, video: 0, image: 0, audio: 0, other: 0 },
          })
        : undefined,
    );

    const rendered = await renderDialog();
    const note = rendered.querySelector<HTMLElement>('[role="note"]');

    expect(note?.textContent).toContain(
      'If you upgraded and your previous Asset Library is missing',
    );
    expect(note?.textContent).toContain('Change Folder…');
    expect(note?.textContent).toContain('files are not moved or deleted');
  });

  it('does not show the previous-default migration note for a custom location', async () => {
    installDesktopBridge((channel) =>
      channel === 'desktop.asset-library.get-settings'
        ? settings({
            directory: 'fixture-assets/custom-folder',
            isDefault: false,
            hasCatalog: false,
          })
        : undefined,
    );

    const rendered = await renderDialog();

    expect(rendered.querySelector('[role="note"]')).toBeNull();
  });

  it('applies a trimmed custom path and notifies the caller', async () => {
    const initial = settings();
    const updated = settings({ directory: 'fixture-assets/custom-folder', isDefault: false });
    const invoke = installDesktopBridge((channel) => {
      if (channel === 'desktop.asset-library.get-settings') return initial;
      if (channel === 'desktop.asset-library.set-directory') return updated;
      return undefined;
    });
    const onDirectoryChanged = vi.fn();
    const rendered = await renderDialog(onDirectoryChanged);
    const input = rendered.querySelector<HTMLInputElement>('input[type="text"]');
    if (input === null) throw new Error('Expected asset folder path input');

    await act(async () => {
      setInputValue(input, '  fixture-assets/custom-folder  ');
    });
    await act(async () => {
      buttonByText(rendered, 'Apply Path').click();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith('desktop.asset-library.set-directory', {
      directory: 'fixture-assets/custom-folder',
    });
    expect(input.value).toBe(updated.directory);
    expect(rendered.textContent).toContain(
      'Asset library folder updated to: fixture-assets/custom-folder',
    );
    expect(onDirectoryChanged).toHaveBeenCalledOnce();
  });

  it('resets the folder to the runtime default path', async () => {
    const initial = settings({ directory: 'fixture-assets/custom-folder', isDefault: false });
    const updated = settings();
    const invoke = installDesktopBridge((channel) => {
      if (channel === 'desktop.asset-library.get-settings') return initial;
      if (channel === 'desktop.asset-library.reset-directory') return updated;
      return undefined;
    });
    const onDirectoryChanged = vi.fn();
    const rendered = await renderDialog(onDirectoryChanged);

    await act(async () => {
      buttonByText(rendered, 'Reset to Default').click();
      await Promise.resolve();
    });

    const resetCall = invoke.mock.calls.find(
      ([channel]) => channel === 'desktop.asset-library.reset-directory',
    );
    expect(resetCall).toBeDefined();
    expect(resetCall?.[1]).toBeUndefined();
    expect(rendered.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe(
      DEFAULT_DIRECTORY,
    );
    expect(rendered.textContent).toContain('Reset asset library folder to default location.');
    expect(onDirectoryChanged).toHaveBeenCalledOnce();
  });

  it('uses the folder picker result and leaves the path unchanged when selection is cancelled', async () => {
    const initial = settings();
    const selected = settings({ directory: 'fixture-assets/selected-folder', isDefault: false });
    let selection: DesktopAssetLibrarySettings | null = selected;
    const invoke = installDesktopBridge((channel) => {
      if (channel === 'desktop.asset-library.get-settings') return initial;
      if (channel === 'desktop.asset-library.select-directory') return selection;
      return undefined;
    });
    const onDirectoryChanged = vi.fn();
    const rendered = await renderDialog(onDirectoryChanged);
    const input = rendered.querySelector<HTMLInputElement>('input[type="text"]');
    if (input === null) throw new Error('Expected asset folder path input');

    await act(async () => {
      buttonByText(rendered, 'Change Folder…').click();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith('desktop.asset-library.select-directory');
    expect(input.value).toBe(selected.directory);
    expect(rendered.textContent).toContain(
      `Asset library folder updated to: ${selected.directory}`,
    );
    expect(onDirectoryChanged).toHaveBeenCalledOnce();

    selection = null;
    await act(async () => {
      buttonByText(rendered, 'Change Folder…').click();
      await Promise.resolve();
    });

    expect(input.value).toBe(selected.directory);
    expect(onDirectoryChanged).toHaveBeenCalledOnce();
  });

  it('shows empty, missing-directory and missing-catalog inspection states', async () => {
    let current = settings({
      exists: false,
      hasCatalog: false,
      counts: { total: 0, video: 0, image: 0, audio: 0, other: 0 },
    });
    installDesktopBridge((channel) =>
      channel === 'desktop.asset-library.get-settings' ? current : undefined,
    );
    const rendered = await renderDialog();

    expect(rendered.textContent).toContain('Directory not found on this system.');
    expect(statValue(rendered, 'Total')).toBe('0');

    current = settings({ hasCatalog: false });
    await act(async () => {
      rendered.querySelector<HTMLButtonElement>('[title="Refresh folder status"]')?.click();
      await Promise.resolve();
    });

    expect(rendered.textContent).toContain(
      'Directory exists, but no catalog.json was found. Make sure catalog.json is present.',
    );
    expect(rendered.textContent).not.toContain('Directory not found on this system.');
  });

  it('disables folder actions while loading and announces refresh errors', async () => {
    let resolveInitial: ((value: DesktopAssetLibrarySettings) => void) | undefined;
    const initialLoad = new Promise<DesktopAssetLibrarySettings>((resolve) => {
      resolveInitial = resolve;
    });
    let getSettingsCalls = 0;
    const invoke = installDesktopBridge((channel) => {
      if (channel === 'desktop.asset-library.get-settings') {
        getSettingsCalls += 1;
        if (getSettingsCalls === 1) return initialLoad;
        if (getSettingsCalls === 2) return Promise.reject(new Error('Connection lost'));
        return settings();
      }
      return undefined;
    });
    const rendered = await renderDialog();

    expect(buttonByText(rendered, 'Change Folder…').disabled).toBe(true);
    expect(
      rendered.querySelector<HTMLButtonElement>('[title="Refresh folder status"]')?.disabled,
    ).toBe(true);

    await act(async () => {
      resolveInitial?.(settings());
      await initialLoad;
      await Promise.resolve();
    });
    await act(async () => {
      rendered.querySelector<HTMLButtonElement>('[title="Refresh folder status"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(rendered.querySelector('[role="status"]')?.textContent).toContain('Connection lost');
    expect(rendered.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
  });

  it('explains that local storage configuration needs the desktop application', async () => {
    const rendered = await renderDialog();

    expect(rendered.textContent).toContain(
      'Local asset storage configuration is available when running inside the JOY Media Desktop application.',
    );
    expect(rendered.querySelector('input[type="text"]')).toBeNull();
  });
});
