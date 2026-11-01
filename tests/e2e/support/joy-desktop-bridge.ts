import type { Page } from '@playwright/test';

/**
 * A test-only stand-in for the Electron preload bridge, `window.joyDesktop`.
 *
 * The browser harness has no desktop app, so `isDesktopHost()` is false. The editor then refuses to
 * save a provider profile (the JOY Code connect path needs one) and media import refuses to run.
 * A spec that needs the desktop path installs this bridge BEFORE it navigates, and only that spec.
 *
 * The page calls into Node through `page.exposeFunction`, so each handler is ordinary test code
 * with ordinary closures. Call `installJoyDesktopBridge` at most once per page.
 */

/** Returned by a handler that does not own a channel. The next handler is then asked. */
export const UNHANDLED: unique symbol = Symbol('unhandled');

export type ChannelAnswer = unknown;

export type ChannelHandler = (
  channel: string,
  payload: unknown,
) => ChannelAnswer | typeof UNHANDLED | Promise<ChannelAnswer | typeof UNHANDLED>;

export interface BridgeCall {
  readonly channel: string;
  readonly payload: unknown;
}

export interface InstalledJoyDesktopBridge {
  /** Every call the page made through `window.joyDesktop.invoke`, in order. */
  readonly calls: readonly BridgeCall[];
}

export interface JoyDesktopBridgeOptions {
  /** The channel names the bridge advertises on `window.joyDesktop.channels`. */
  readonly channels?: readonly string[];
}

function encodeBridgeAnswer(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __joyBytesBase64: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) return value.map(encodeBridgeAnswer);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, encodeBridgeAnswer(nested)]),
    );
  }
  return value;
}

export async function installJoyDesktopBridge(
  page: Page,
  handlers: readonly ChannelHandler[],
  options: JoyDesktopBridgeOptions = {},
): Promise<InstalledJoyDesktopBridge> {
  const calls: BridgeCall[] = [];
  const channels = [...(options.channels ?? [])];

  await page.exposeFunction('__joyDesktopInvoke', async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    for (const handler of handlers) {
      const answer = await handler(channel, payload);
      if (answer !== UNHANDLED) return encodeBridgeAnswer(answer);
    }
    throw new Error(`joyDesktop e2e bridge has no handler for channel ${channel}`);
  });

  await page.addInitScript((advertised: string[]) => {
    const host = window as unknown as {
      __joyDesktopInvoke: (channel: string, payload?: unknown) => Promise<unknown>;
      joyDesktop?: unknown;
    };
    function decodeBridgeAnswer(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(decodeBridgeAnswer);
      if (value !== null && typeof value === 'object') {
        const encodedBytes = (value as { __joyBytesBase64?: unknown }).__joyBytesBase64;
        if (typeof encodedBytes === 'string') {
          const binary = atob(encodedBytes);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
          }
          return bytes;
        }
        return Object.fromEntries(
          Object.entries(value).map(([key, nested]) => [key, decodeBridgeAnswer(nested)]),
        );
      }
      return value;
    }
    host.joyDesktop = {
      channels: advertised,
      invoke: async (channel: string, payload?: unknown) =>
        decodeBridgeAnswer(await host.__joyDesktopInvoke(channel, payload)),
    };
  }, channels);

  return { calls };
}
