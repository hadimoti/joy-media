import { expect, type Locator, type Page } from '@playwright/test';

/** HTTPS-only origin intercepted by Playwright; production never allowlists it. */
export const FAKE_PROVIDER_BASE_URL = 'https://joy-agent-fixture.example/v1';
export const FAKE_PROVIDER_MODEL = 'fixture/joy-agent';

export type FakeProviderMode =
  'tool-loop' | 'plan-only' | 'malformed' | 'oversize' | 'slow' | 'redirect' | 'auth' | 'network';

/** A redacted request classification for assertions; it never includes request data or credentials. */
export type FakeProviderRequestStage =
  | 'forced-probe'
  | 'probe-continuation'
  | 'plan-only-probe'
  | 'structured-read'
  | 'structured-validate'
  | 'structured-repair'
  | 'other';

export interface FakeOpenAIProviderOptions {
  readonly mode?: FakeProviderMode;
  readonly delayMs?: number;
  /** Delay only a post-capability structured run, never the connection handshake. */
  readonly runDelayMs?: number;
  /**
   * When supplied, the fixture deliberately sends `proposal` first, waits for
   * the host's bounded repair diagnostic, then sends this retry proposal.
   * This makes the browser test exercise the real Worker/host RPC repair path
   * instead of simulating a successful preview in the UI.
   */
  readonly repairProposal?: Readonly<Record<string, unknown>>;
  readonly proposal?: Readonly<Record<string, unknown>>;
  /**
   * Builds one deterministic proposal from the redacted host context returned
   * by the real Worker tool loop. It is test-only and exposes no prompt,
   * credential, project text, URL, or request body.
   */
  readonly proposalForContext?: (
    context: FakeOpenAIProviderContext,
  ) => Readonly<Record<string, unknown>>;
}

export interface FakeOpenAIProviderContext {
  readonly recentEntityReferences: readonly {
    readonly entityId: string;
    readonly entityKind: string;
  }[];
}

export interface FakeOpenAIProviderProbe {
  readonly requests: number;
  readonly authorizationSeen: boolean;
  readonly requestUrls: readonly string[];
  readonly stages: readonly FakeProviderRequestStage[];
  readonly contexts: readonly FakeOpenAIProviderContext[];
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

type ProviderMessage = Readonly<Record<string, unknown>>;

function messagesOf(requestBody: Readonly<Record<string, unknown>>): readonly ProviderMessage[] {
  const messages = requestBody.messages;
  return Array.isArray(messages)
    ? messages.filter(
        (message): message is ProviderMessage =>
          message !== null && typeof message === 'object' && !Array.isArray(message),
      )
    : [];
}

function isForcedProbe(requestBody: Readonly<Record<string, unknown>>): boolean {
  const choice = requestBody.tool_choice;
  if (choice === null || typeof choice !== 'object' || Array.isArray(choice)) return false;
  const functionValue = (choice as Readonly<Record<string, unknown>>).function;
  return (
    functionValue !== null &&
    typeof functionValue === 'object' &&
    !Array.isArray(functionValue) &&
    (functionValue as Readonly<Record<string, unknown>>).name === 'joy_probe'
  );
}

function isProbeContinuation(requestBody: Readonly<Record<string, unknown>>): boolean {
  if (requestBody.tool_choice !== 'none') return false;
  const messages = messagesOf(requestBody);
  const last = messages.at(-1);
  if (last?.role !== 'tool' || last.content !== '{"ok":true,"probe":"joy-provider-capability-v1"}')
    return false;
  return messages.some((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return false;
    return message.tool_calls.some((call) => {
      if (call === null || typeof call !== 'object' || Array.isArray(call)) return false;
      const functionValue = (call as Readonly<Record<string, unknown>>).function;
      return (
        functionValue !== null &&
        typeof functionValue === 'object' &&
        !Array.isArray(functionValue) &&
        (functionValue as Readonly<Record<string, unknown>>).name === 'joy_probe'
      );
    });
  });
}

function isPlanOnlyProbe(requestBody: Readonly<Record<string, unknown>>): boolean {
  if (Array.isArray(requestBody.tools)) return false;
  return messagesOf(requestBody).some(
    (message) =>
      typeof message.content === 'string' &&
      message.content.includes(
        'Reply with one brief confirmation that plan-only text mode is available.',
      ),
  );
}

function toolMessageCount(requestBody: Readonly<Record<string, unknown>>): number {
  return messagesOf(requestBody).filter((message) => message.role === 'tool').length;
}

/**
 * Read only the closed vocabulary of opaque entity IDs from the real host
 * context tool result. Test telemetry deliberately avoids user/model text,
 * provider keys, raw prompts, project names, and URLs.
 */
function contextFromRequest(
  requestBody: Readonly<Record<string, unknown>>,
): FakeOpenAIProviderContext {
  const toolResult = [...messagesOf(requestBody)]
    .reverse()
    .find((message) => message.role === 'tool' && typeof message.content === 'string');
  if (toolResult === undefined || typeof toolResult.content !== 'string')
    return { recentEntityReferences: [] };
  try {
    const parsed = JSON.parse(toolResult.content) as { context?: unknown };
    const context = parsed.context;
    if (context === null || typeof context !== 'object' || Array.isArray(context))
      return { recentEntityReferences: [] };
    const references = (context as { recentEntityReferences?: unknown }).recentEntityReferences;
    if (!Array.isArray(references)) return { recentEntityReferences: [] };
    return {
      recentEntityReferences: references.flatMap((reference) => {
        if (reference === null || typeof reference !== 'object' || Array.isArray(reference))
          return [];
        const candidate = reference as { entityId?: unknown; entityKind?: unknown };
        return typeof candidate.entityId === 'string' && typeof candidate.entityKind === 'string'
          ? [{ entityId: candidate.entityId, entityKind: candidate.entityKind }]
          : [];
      }),
    };
  } catch {
    return { recentEntityReferences: [] };
  }
}

function requestStage(requestBody: Readonly<Record<string, unknown>>): FakeProviderRequestStage {
  if (isForcedProbe(requestBody)) return 'forced-probe';
  if (isProbeContinuation(requestBody)) return 'probe-continuation';
  if (isPlanOnlyProbe(requestBody)) return 'plan-only-probe';
  if (!Array.isArray(requestBody.tools)) return 'other';
  const toolMessages = toolMessageCount(requestBody);
  if (toolMessages === 0) return 'structured-read';
  if (toolMessages === 1) return 'structured-validate';
  if (toolMessages === 2) return 'structured-repair';
  return 'other';
}

function toolCall(name: 'read_project_context' | 'validate_proposal', id: string, args: unknown) {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              id,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  };
}

function responseBody(
  requestBody: Readonly<Record<string, unknown>>,
  options: FakeOpenAIProviderOptions,
): string {
  const mode = options.mode ?? 'tool-loop';
  const forcedProbe = isForcedProbe(requestBody);
  const probeContinuation = isProbeContinuation(requestBody);
  const planOnlyProbe = isPlanOnlyProbe(requestBody);
  if (forcedProbe && mode !== 'plan-only')
    return JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'probe',
                type: 'function',
                function: { name: 'joy_probe', arguments: '{}' },
              },
            ],
          },
        },
      ],
    });
  if (probeContinuation && mode !== 'plan-only')
    return JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'JOY_PROVIDER_PROBE_CONTINUED_V1' } }],
    });
  if (mode === 'plan-only' && forcedProbe)
    return JSON.stringify({ choices: [{ message: { content: '' } }] });
  if (planOnlyProbe)
    return JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Plan-only capability confirmed.' } }],
    });
  if (mode === 'malformed') return '{not-json';
  const toolMessages = toolMessageCount(requestBody);
  if (Array.isArray(requestBody.tools) && mode === 'tool-loop') {
    if (toolMessages === 0)
      return JSON.stringify(toolCall('read_project_context', 'read-1', { domain: 'overview' }));
    if (toolMessages === 1)
      return JSON.stringify(
        toolCall(
          'validate_proposal',
          'validate-1',
          options.proposalForContext?.(contextFromRequest(requestBody)) ??
            options.proposal ??
            DEFAULT_PROPOSAL,
        ),
      );
    if (toolMessages === 2 && options.repairProposal !== undefined)
      return JSON.stringify(toolCall('validate_proposal', 'validate-2', options.repairProposal));
  }
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
  const stages: FakeProviderRequestStage[] = [];
  const contexts: FakeOpenAIProviderContext[] = [];
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
    let requestBody: Readonly<Record<string, unknown>> = {};
    try {
      requestBody = (request.postDataJSON() ?? {}) as Readonly<Record<string, unknown>>;
    } catch {
      /* malformed request bodies are answered with an invalid provider result */
    }
    const stage = requestStage(requestBody);
    stages.push(stage);
    if (stage === 'structured-validate') contexts.push(contextFromRequest(requestBody));
    if (
      options.runDelayMs !== undefined &&
      (stage === 'structured-read' ||
        stage === 'structured-validate' ||
        stage === 'structured-repair')
    )
      await new Promise<void>((resolve) => setTimeout(resolve, options.runDelayMs));
    let body: string;
    if (options.mode === 'oversize') {
      body = JSON.stringify({
        choices: [{ message: { content: 'x'.repeat(2 * 1024 * 1024 + 32) } }],
      });
    } else {
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
    get stages() {
      return stages;
    },
    get contexts() {
      return contexts;
    },
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
  // The settings dialog has several descendant labels containing the word
  // "provider" (budget and capability controls). The first select is the
  // model-connection provider selector; keep this locator tied to the UI
  // structure rather than relying on ambiguous accessible-name matching.
  await dialog.locator('select').first().selectOption('openai-compatible');
  await dialog.getByLabel('Base URL').fill(FAKE_PROVIDER_BASE_URL);
  await dialog.getByLabel('Model ID').fill(options.modelId ?? FAKE_PROVIDER_MODEL);
  await dialog.getByLabel(/I understand the custom provider receives/).check();
  await dialog.getByLabel('API key').fill(apiKey);
  await dialog.getByRole('button', { name: /Connect model|Test & use/ }).click();
  await expect(
    dialog.getByText(
      options.allowFailure
        ? /Tool loop ready|Plan-only|authentication failed|CORS or network error|response too large|Connection timed out/
        : /Tool loop ready|Plan-only/,
    ),
  ).toBeVisible({ timeout: 20_000 });
  if (!options.allowFailure) await expect(dialog.getByText(/Connected successfully/)).toBeVisible();
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
    for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input, textarea',
    ))
      inspect('form-value', input.value);
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
