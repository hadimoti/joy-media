import type { Page } from '@playwright/test';

/** A provider profile as `desktop.provider-profile.list` returns it, with its state and decision. */
export interface DesktopProfileFixture {
  readonly id: string;
  readonly name?: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly cachedModels?: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state?: 'active' | 'disabled-legacy' | 'credential-unavailable';
  readonly decision?: 'later';
}

export interface DesktopBridgeFixture {
  readonly profiles?: readonly DesktopProfileFixture[];
}

/** One call the editor made through `window.joyDesktop.invoke`. */
export interface DesktopBridgeCall {
  readonly channel: string;
  readonly payload: unknown;
}

/**
 * Installs `window.joyDesktop` before any page script runs. The editor then takes its desktop path
 * (`isDesktopHost()` is true), and every channel answers from this fixture, so the specs need no
 * Electron process. Each call is recorded on `window.__joyDesktopCalls`.
 */
export async function installDesktopBridge(
  page: Page,
  fixture: DesktopBridgeFixture = {},
): Promise<void> {
  await page.addInitScript((seed: DesktopBridgeFixture) => {
    const calls: { channel: string; payload: unknown }[] = [];
    const profiles = (seed.profiles ?? []).map((profile) => ({ ...profile }));
    const host = window as unknown as Record<string, unknown>;
    host.__joyDesktopCalls = calls;

    const answer = (channel: string, payload: unknown): unknown => {
      switch (channel) {
        case 'desktop.provider-profile.list':
          return profiles.map((profile) => ({ ...profile }));
        case 'desktop.provider-profile.later': {
          const id = (payload as { id?: string } | undefined)?.id;
          const target = profiles.find((profile) => profile.id === id);
          if (target !== undefined) target.decision = 'later';
          return undefined;
        }
        case 'desktop.worker-status':
          return { connection: 'offline', capabilities: [] };
        case 'desktop.asset-library.get-settings':
          return {
            directory: '',
            exists: false,
            hasCatalog: false,
            isDefault: true,
            counts: { total: 0, audio: 0, image: 0 },
          };
        case 'desktop.asset-library.get-catalog':
          return { version: 1, counts: { total: 0, audio: 0, image: 0 }, assets: [] };
        case 'desktop.media.workers.list':
          return [];
        case 'desktop.media.project.document.get':
          return null;
        case 'desktop.media.project.document.put': {
          const write = payload as { projectId: string; revisionId: string };
          return { kind: 'saved', projectId: write.projectId, revisionId: write.revisionId };
        }
        case 'desktop.window-is-maximized':
          return false;
        default:
          return undefined;
      }
    };

    host.joyDesktop = {
      channels: [],
      invoke: async (channel: string, payload?: unknown) => {
        calls.push({ channel, payload });
        return answer(channel, payload);
      },
    };
  }, fixture);
}

/** The calls the page has made so far, in order. */
export async function desktopBridgeCalls(page: Page): Promise<DesktopBridgeCall[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __joyDesktopCalls?: DesktopBridgeCall[] }).__joyDesktopCalls ?? [],
  );
}
