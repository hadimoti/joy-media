import { expect, type Locator, type Page } from '@playwright/test';

/** HTTPS-only origin intercepted by Playwright; production never allowlists it. */
export const FAKE_PROVIDER_BASE_URL = 'https://joy-agent-fixture.example/v1';
export const FAKE_PROVIDER_MODEL = 'fixture/joy-agent';

export type FakeProviderMode =
  'tool-loop' | 'plan-only' | 'malformed' | 'oversize' | 'slow' | 'redirect' | 'auth' | 'network';

export interface FakeOpenAIProviderOptions {
  readonly mode?: FakeProviderMode;
  readonly delayMs?: number;
  readonly proposal?: Readonly<Record<string, unknown>>;
}

export interface FakeOpenAIProviderProbe {
  readonly requests: number;
  readonly authorizationSeen: boolean;
  readonly requestUrls: readonly string[];
}

const DEFAULT_PROPOSAL: Readonly<Record<string, unknown>> = {
  summary: 'Fixture staged caption update',
  operations: [
    {
      id: 'caption-style',
      dependsOn: [],
      kind: 'caption.setTemplate',
      captionClipId: 'caption-clip-1',
      templateId: 'joy-rtl-classic',
    },
  ],
};

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
  'cache-control': 'no-store',
};

function responseBody(
  requestBody: Readonly<Record<string, unknown>>,
  options: FakeOpenAIProviderOptions,
): string {
  const isProbe = Array.isArray(requestBody.tools);
  if (options.mode === 'malformed' && !isProbe) return '{not-json';
  if (isProbe && options.mode !== 'plan-only')
    return JSON.stringify({
      choices: [{ message: { tool_calls: [{ id: 'probe', type: 'function' }] } }],
    });
  if (options.mode === 'plan-only' && isProbe)
    return JSON.stringify({ choices: [{ message: { content: '' } }] });
  return JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify(options.proposal ?? DEFAULT_PROPOSAL),
        },
      },
    ],
  });
}

/** Install a deterministic OpenAI-compatible route without recording secret values. */
export async function installFakeOpenAIProvider(
  page: Page,
  options: FakeOpenAIProviderOptions = {},
): Promise<FakeOpenAIProviderProbe> {
  let requests = 0;
  let authorizationSeen = false;
  const requestUrls: string[] = [];
  await page.route('https://joy-agent-fixture.example/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    requests += 1;
    requestUrls.push(request.url());
    authorizationSeen ||= request.headers().authorization !== undefined;
    if (options.mode === 'network') {
      await route.abort('failed');
      return;
    }
    if (options.mode === 'auth') {
      await route.fulfill({
        status: 401,
        headers: CORS_HEADERS,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'fixture auth failure' } }),
      });
      return;
    }
    if (options.mode === 'redirect') {
      await route.fulfill({
        status: 302,
        headers: { ...CORS_HEADERS, location: 'https://redirected.example.invalid/v1' },
      });
      return;
    }
    if (options.mode === 'slow')
      await new Promise<void>((resolve) => setTimeout(resolve, options.delayMs ?? 65_000));
    let body: string;
    if (options.mode === 'oversize') {
      body = JSON.stringify({
        choices: [{ message: { content: 'x'.repeat(2 * 1024 * 1024 + 32) } }],
      });
    } else {
      let requestBody: Readonly<Record<string, unknown>> = {};
      try {
        requestBody = (request.postDataJSON() ?? {}) as Readonly<Record<string, unknown>>;
      } catch {
        /* malformed request bodies are answered with an invalid provider result */
      }
      body = responseBody(requestBody, options);
    }
    await route.fulfill({
      status: 200,
      headers: CORS_HEADERS,
      contentType: 'application/json',
      body,
    });
  });
  return {
    get requests() {
      return requests;
    },
    get authorizationSeen() {
      return authorizationSeen;
    },
    requestUrls,
  };
}

/** Open the product-owned settings dialog and configure only the page session. */
export async function configureJoyAgent(
  page: Page,
  apiKey: string,
  options: { readonly modelId?: string; readonly allowFailure?: boolean } = {},
): Promise<Locator> {
  await page.locator('.app-menu-trigger').filter({ hasText: 'Joy Code' }).click();
  await page.getByRole('menuitem', { name: 'Joy Code Settings…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'JOY Agent Engine' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Provider').selectOption('openai-compatible');
  await dialog.getByLabel('Base URL').fill(FAKE_PROVIDER_BASE_URL);
  await dialog.getByLabel('Model ID').fill(options.modelId ?? FAKE_PROVIDER_MODEL);
  await dialog.getByLabel(/I understand the custom provider receives/).check();
  await dialog.getByLabel('API key').fill(apiKey);
  await dialog.getByRole('button', { name: 'Test & use' }).click();
  await expect(
    dialog.getByText(
      options.allowFailure
        ? /Tool loop ready|Plan-only|authentication failed|CORS or network error|response too large|Connection timed out/
        : /Tool loop ready|Plan-only/,
    ),
  ).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByLabel('API key')).toHaveValue('');
  return dialog;
}

/** Scan browser-owned stores and rendered/runtime surfaces for a sentinel secret. */
export async function scanForSentinel(page: Page, sentinel: string): Promise<readonly string[]> {
  return page.evaluate(async (needle) => {
    const hits: string[] = [];
    const inspect = (surface: string, value: unknown) => {
      if (typeof value === 'string' && value.includes(needle)) hits.push(surface);
    };
    for (const [surface, storage] of [
      ['localStorage', window.localStorage],
      ['sessionStorage', window.sessionStorage],
    ] as const) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        inspect(`${surface}:key`, key);
        if (key !== null) inspect(`${surface}:value`, storage.getItem(key));
      }
    }
    inspect('cookie', document.cookie);
    inspect('dom', document.documentElement.outerHTML);
    for (const entry of performance.getEntriesByType('resource')) inspect('resource', entry.name);
    if (typeof indexedDB.databases === 'function') {
      for (const database of await indexedDB.databases()) inspect('indexeddb', database.name);
    }
    if (typeof caches !== 'undefined') {
      for (const key of await caches.keys()) inspect('cache:key', key);
    }
    try {
      const storage = navigator.storage as StorageManager & {
        getDirectory?: () => Promise<FileSystemDirectoryHandle>;
      };
      if (storage.getDirectory !== undefined) {
        const walk = async (directory: FileSystemDirectoryHandle, depth: number): Promise<void> => {
          if (depth > 3) return;
          const entries = (
            directory as FileSystemDirectoryHandle & {
              entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
            }
          ).entries();
          for await (const [name, handle] of entries) {
            inspect('opfs:name', name);
            if (handle.kind === 'file') {
              try {
                inspect(
                  'opfs:file',
                  await (handle as FileSystemFileHandle).getFile().then((file) => file.text()),
                );
              } catch {
                /* binary media is not decoded as a secret-bearing text surface */
              }
            } else await walk(handle as FileSystemDirectoryHandle, depth + 1);
          }
        };
        await walk(await storage.getDirectory(), 0);
      }
    } catch {
      /* OPFS is optional in the test browser. */
    }
    return hits;
  }, sentinel);
}
