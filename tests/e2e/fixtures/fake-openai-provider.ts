import { expect, type Locator, type Page } from '@playwright/test';

/** HTTPS-only origin intercepted by Playwright; production never allowlists it. */
export const FAKE_PROVIDER_BASE_URL = 'https://joy-agent-fixture.example/v1';
export const FAKE_PROVIDER_MODEL = 'fixture/joy-agent';
const MEDIA_CAPABILITY_PROBE_ACK = 'JOY_MEDIA_CAPABILITY_PROBE_OK_V1';

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
  /**
   * Keep the old context -> validate sequence for negative evidence-gate
   * coverage. The default fixture follows the real observation contract when
   * the recipe allow-list exposes media_observe.
   */
  readonly skipObservation?: boolean;
  /**
   * When set, an advisory tool-loop request answers with plain content after
   * the first `read_project_context` call instead of proposing an edit. Used
   * by recipes whose allow-list has no `validate_proposal` (find-moment,
   * watch-and-map, verify-deliverable).
   */
  readonly advisoryAnswer?: string;
}

export interface FakeOpenAIProviderContext {
  readonly assetIds: readonly string[];
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

function isMediaCapabilityProbe(requestBody: Readonly<Record<string, unknown>>): boolean {
  const messages = messagesOf(requestBody);
  const content = messages[0]?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) =>
      part !== null &&
      typeof part === 'object' &&
      !Array.isArray(part) &&
      typeof (part as Readonly<Record<string, unknown>>).text === 'string' &&
      /This is JOY's synthetic (?:image|audio|video) capability test\./.test(
        (part as Readonly<Record<string, unknown>>).text as string,
      ),
  );
}

function toolMessageCount(requestBody: Readonly<Record<string, unknown>>): number {
  return messagesOf(requestBody).filter((message) => message.role === 'tool').length;
}

type FixtureToolName =
  'read_project_context' | 'media_observe' | 'evidence_coverage' | 'validate_proposal';

function toolCallsOf(requestBody: Readonly<Record<string, unknown>>): readonly ProviderMessage[] {
  return messagesOf(requestBody).filter((message) => message.role === 'tool');
}

function latestToolResult(requestBody: Readonly<Record<string, unknown>>): unknown {
  const result = toolCallsOf(requestBody).at(-1)?.content;
  if (typeof result !== 'string') return undefined;
  try {
    return JSON.parse(result);
  } catch {
    return undefined;
  }
}

function observationEnabled(
  requestBody: Readonly<Record<string, unknown>>,
  options: FakeOpenAIProviderOptions,
): boolean {
  if (options.skipObservation === true || !Array.isArray(requestBody.tools)) return false;
  return requestBody.tools.some((tool) => {
    if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) return false;
    const fn = (tool as Readonly<Record<string, unknown>>).function;
    return (
      fn !== null &&
      typeof fn === 'object' &&
      !Array.isArray(fn) &&
      (fn as Readonly<Record<string, unknown>>).name === 'media_observe'
    );
  });
}

/**
 * Read only the closed vocabulary of opaque entity IDs from the real host
 * context tool result. Test telemetry deliberately avoids user/model text,
 * provider keys, raw prompts, project names, and URLs.
 */
function contextFromRequest(
  requestBody: Readonly<Record<string, unknown>>,
): FakeOpenAIProviderContext {
  const results = toolCallsOf(requestBody)
    .map((message) => {
      if (typeof message.content !== 'string') return undefined;
      try {
        return JSON.parse(message.content) as { context?: unknown };
      } catch {
        return undefined;
      }
    })
    .filter((value): value is { context?: unknown } => value !== undefined);
  const contexts = results
    .map((value) => value.context)
    .filter(
      (value): value is Record<string, unknown> =>
        value !== null && typeof value === 'object' && !Array.isArray(value),
    );
  const assetIds = contexts.flatMap((context) => {
    const items = context.items;
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
      const id = (item as Readonly<Record<string, unknown>>).id;
      return typeof id === 'string' ? [id] : [];
    });
  });
  const references = contexts.flatMap((context) => {
    const value = context.recentEntityReferences;
    if (!Array.isArray(value)) return [];
    return value.flatMap((reference) => {
      if (reference === null || typeof reference !== 'object' || Array.isArray(reference))
        return [];
      const candidate = reference as { entityId?: unknown; entityKind?: unknown };
      return typeof candidate.entityId === 'string' && typeof candidate.entityKind === 'string'
        ? [{ entityId: candidate.entityId, entityKind: candidate.entityKind }]
        : [];
    });
  });
  return { assetIds: [...new Set(assetIds)], recentEntityReferences: references };
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

function toolCall(name: FixtureToolName, id: string, args: unknown) {
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
  if (isMediaCapabilityProbe(requestBody))
    return JSON.stringify({
      choices: [{ message: { role: 'assistant', content: MEDIA_CAPABILITY_PROBE_ACK } }],
    });
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
    if (options.advisoryAnswer !== undefined && toolMessages >= 1)
      return JSON.stringify({
        choices: [{ message: { role: 'assistant', content: options.advisoryAnswer } }],
      });
    if (toolMessages === 1 && observationEnabled(requestBody, options))
      return JSON.stringify(toolCall('read_project_context', 'read-2', { domain: 'assets' }));
    if (toolMessages === 2 && observationEnabled(requestBody, options)) {
      const assetId = contextFromRequest(requestBody).assetIds[0];
      if (assetId === undefined)
        return JSON.stringify({
          choices: [{ message: { content: 'No source asset was available.' } }],
        });
      return JSON.stringify(
        toolCall('media_observe', 'observe-1', {
          assetId,
          // The committed video.mp4 fixture is three seconds long; keep the
          // request inside the real imported descriptor's bounded duration.
          range: { startUs: 0, endUs: 3_000_000 },
          mode: 'overview',
          maxFrames: 4,
          maxMetadataBytes: 4096,
        }),
      );
    }
    if (toolMessages === 3 && observationEnabled(requestBody, options)) {
      const observation = latestToolResult(requestBody) as
        { evidence?: { observationId?: unknown; manifestId?: unknown } } | undefined;
      if (
        typeof observation?.evidence?.observationId !== 'string' ||
        typeof observation.evidence.manifestId !== 'string'
      )
        return JSON.stringify({
          choices: [{ message: { content: 'Observation did not produce a manifest.' } }],
        });
      return JSON.stringify(
        toolCall(
          'validate_proposal',
          'validate-1',
          options.proposalForContext?.(contextFromRequest(requestBody)) ??
            options.proposal ??
            DEFAULT_PROPOSAL,
        ),
      );
    }
    if (toolMessages === 1 && !observationEnabled(requestBody, options))
      return JSON.stringify(
        toolCall(
          'validate_proposal',
          'validate-1',
          options.proposalForContext?.(contextFromRequest(requestBody)) ??
            options.proposal ??
            DEFAULT_PROPOSAL,
        ),
      );
    if (
      ((toolMessages === 2 && !observationEnabled(requestBody, options)) ||
        (toolMessages === 5 && observationEnabled(requestBody, options))) &&
      options.repairProposal !== undefined
    )
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
  const dialog = page.getByRole('dialog', { name: 'Joy Code Settings' });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('combobox', { name: 'Provider Platform' })
    .selectOption('openai-compatible');
  await dialog.getByRole('textbox', { name: 'Base URL / Endpoint' }).fill(FAKE_PROVIDER_BASE_URL);
  await dialog
    .getByRole('textbox', { name: /Model ID/ })
    .fill(options.modelId ?? FAKE_PROVIDER_MODEL);
  await dialog
    .getByRole('checkbox', {
      name: 'I understand that custom endpoints may log requests according to their own policy.',
    })
    .check();
  await dialog.getByLabel('API Secret Key').fill(apiKey);
  await dialog.getByRole('button', { name: /Connect model|Test & use/ }).click();
  await expect(
    dialog.getByText(
      options.allowFailure
        ? /Tool loop ready|Plan-only|authentication failed|CORS or network error|response too large|Connection timed out/
        : /Tool loop ready|Plan-only/,
    ),
  ).toBeVisible({ timeout: 20_000 });
  if (!options.allowFailure) await expect(dialog.getByText(/Connected successfully/)).toBeVisible();
  await expect(dialog.getByLabel('API Secret Key')).toHaveValue('');
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
