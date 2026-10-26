// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppSettingsDialog,
  describeUpdateDecision,
  hasUpdateAvailable,
  type UpdateCheckState,
} from './AppSettingsDialog.js';
import type { DesktopUpdateDecision } from './desktop-client.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHECK_CHANNEL = 'desktop.check-for-update';

function installDesktopBridge(decision: DesktopUpdateDecision | Error) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel !== CHECK_CHANNEL) throw new Error(`unexpected channel ${channel}`);
    if (decision instanceof Error) throw decision;
    return decision;
  });
  window.joyDesktop = {
    channels: [CHECK_CHANNEL],
    invoke,
  } as NonNullable<typeof window.joyDesktop>;
  return invoke;
}

function clearDesktopBridge() {
  delete (window as { joyDesktop?: unknown }).joyDesktop;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

/** Renders the dialog with its state held by a parent, as the app does, so the test sees the real flow. */
async function renderDialog(onClose: () => void = vi.fn()): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  function Harness() {
    const [state, setState] = useState<UpdateCheckState>({ status: 'idle' });
    return (
      <AppSettingsDialog
        open
        onClose={onClose}
        updateState={state}
        onUpdateStateChange={setState}
      />
    );
  }
  await act(async () => {
    root?.render(<Harness />);
  });
  return container;
}

async function press(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

function checkButton(host: HTMLElement): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>('button.app-settings-check-button');
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  container?.remove();
  container = undefined;
  clearDesktopBridge();
});

describe('Settings > Updates', () => {
  it('renders nothing while closed', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <AppSettingsDialog
          open={false}
          onClose={vi.fn()}
          updateState={{ status: 'idle' }}
          onUpdateStateChange={vi.fn()}
        />,
      );
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('outside the desktop app the check is unavailable and nothing is invoked', async () => {
    clearDesktopBridge();
    const host = await renderDialog();

    expect(checkButton(host)).toBeNull();
    expect(host.textContent).toContain(
      'Update checks are available in the JOY Media desktop application.',
    );
  });

  it('never checks on open, and checks once when the user presses the button', async () => {
    const invoke = installDesktopBridge({
      status: 'current',
      reason: 'not-newer',
      latestVersion: '1.0.3',
    });
    const host = await renderDialog();

    expect(invoke).not.toHaveBeenCalled();
    await press(checkButton(host) as HTMLButtonElement);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(CHECK_CHANNEL);
    expect(host.querySelector('[data-update-status="current"]')?.textContent).toBe(
      'You have the latest release (1.0.3).',
    );
    expect(host.querySelector('[aria-label="Update available"]')).toBeNull();
  });

  it('describes an available update with its release page, marks it quietly, and installs nothing', async () => {
    const releaseUrl = 'https://github.com/hadimoti/joy-media/releases/tag/v1.0.4';
    const invoke = installDesktopBridge({
      status: 'update',
      latestVersion: '1.0.4',
      forced: false,
      releaseUrl,
    });
    const host = await renderDialog();

    await press(checkButton(host) as HTMLButtonElement);

    expect(host.querySelector('[data-update-status="update"]')?.textContent).toBe(
      'Version 1.0.4 is available. It is not installed automatically.',
    );
    expect(host.textContent).toContain(releaseUrl);
    expect(host.querySelector('[aria-label="Update available"]')).not.toBeNull();
    expect(host.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([CHECK_CHANNEL]);
  });

  it('says why a build cannot verify an update, and that nothing was downloaded', async () => {
    installDesktopBridge({ status: 'blocked', reason: 'release-key-unconfigured' });
    const host = await renderDialog();

    await press(checkButton(host) as HTMLButtonElement);

    const status = host.querySelector('[data-update-status="blocked"]')?.textContent ?? '';
    expect(status).toContain('no release signing key');
    expect(status).toContain('Nothing was downloaded.');
  });

  it('reports a failed check as an alert and leaves the button usable again', async () => {
    installDesktopBridge(new Error('the update bridge is down'));
    const host = await renderDialog();

    await press(checkButton(host) as HTMLButtonElement);

    expect(host.querySelector('[role="alert"]')?.textContent).toBe('the update bridge is down');
    expect(checkButton(host)?.disabled).toBe(false);
  });

  it('closes on Escape', async () => {
    installDesktopBridge({ status: 'current', reason: 'not-newer', latestVersion: '1.0.3' });
    const onClose = vi.fn();
    await renderDialog(onClose);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('update decision wording', () => {
  it('states that a required update is required, and that nothing is installed automatically', () => {
    expect(
      describeUpdateDecision({
        status: 'update',
        latestVersion: '1.1.0',
        forced: true,
        releaseUrl: 'https://example.invalid/release',
      }),
    ).toBe(
      'Version 1.1.0 is available, and this update is required. It is not installed automatically.',
    );
  });

  it('shows the indication only for a completed check that found a newer release', () => {
    expect(hasUpdateAvailable({ status: 'idle' })).toBe(false);
    expect(hasUpdateAvailable({ status: 'checking' })).toBe(false);
    expect(
      hasUpdateAvailable({
        status: 'done',
        decision: { status: 'current', reason: 'not-newer', latestVersion: '1.0.3' },
      }),
    ).toBe(false);
    expect(hasUpdateAvailable({ status: 'failed', message: 'down' })).toBe(false);
    expect(
      hasUpdateAvailable({
        status: 'done',
        decision: {
          status: 'update',
          latestVersion: '1.0.4',
          forced: false,
          releaseUrl: 'https://example.invalid/release',
        },
      }),
    ).toBe(true);
  });
});
