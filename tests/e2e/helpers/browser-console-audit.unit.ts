import type { Page, Response, TestInfo } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import {
  allowExpectedAssetFixtureMisses,
  allowExpectedHttpResponse,
  assertBrowserAudit,
  type CountRange,
  expectBoundProjectOnly,
  setupBrowserAudit,
} from './browser-console-audit.js';

type EventHandler = (payload: unknown) => void;

function createAuditPage(
  ledgerErrors: { pathname: string; status: number; code?: string }[] = [],
  visibleText: readonly string[] = [],
  bindings: Readonly<Record<string, readonly string[]>> = {
    'e2e-owner@example.test': ['project-1'],
  },
): {
  readonly page: Page;
  readonly emit: (event: string, payload: unknown) => void;
} {
  const handlers = new Map<string, EventHandler[]>();
  const mock = {
    on(event: string, handler: EventHandler) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
      return mock;
    },
    addInitScript: async () => undefined,
    // The helper reads its page-side ledger through evaluate. The fake page has no document, so the
    // evaluated function runs against an empty window.
    evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
      const scope = globalThis as unknown as { window?: unknown };
      const previousWindow = scope.window;
      scope.window = {
        __joyFetchLedger: { pending: 0, started: 0, errors: ledgerErrors },
        localStorage: {
          getItem: () =>
            JSON.stringify({
              bindingsByOwner: Object.fromEntries(
                Object.entries(bindings).map(([owner, ids]) => [
                  owner,
                  Object.fromEntries(
                    ids.map((id) => [`editor-${id}`, { controlPlaneProjectId: id }]),
                  ),
                ]),
              ),
            }),
        },
      };
      try {
        return await fn(arg);
      } finally {
        scope.window = previousWindow;
      }
    },
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
    getByText: (text: string) => ({ count: async () => (visibleText.includes(text) ? 1 : 0) }),
  };
  return {
    page: mock as unknown as Page,
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
}

function conflict(pathname: string, code: string): Response {
  return {
    status: () => 409,
    url: () => `https://example.test${pathname}`,
    json: async () => ({ error: { code } }),
  } as Response;
}

function requestEvent(method: string, pathname: string, postBody?: unknown) {
  return {
    method: () => method,
    url: () => `https://example.test${pathname}`,
    postDataJSON: () => postBody ?? null,
  };
}

/** A request whose URL carries a query, as the audit reads it from the page. */
function requestEventAt(method: string, pathAndQuery: string, postBody?: unknown) {
  return {
    method: () => method,
    url: () => `https://example.test${pathAndQuery}`,
    postDataJSON: () => postBody ?? null,
  };
}

/** A successful owner asset list, which names the projects the owner holds. */
function ownerAssets(projectIds: readonly string[]): Response {
  return {
    status: () => 200,
    url: () => 'https://example.test/api/v1/library/my-assets',
    request: () => ({ method: () => 'GET', postDataJSON: () => null }),
    json: async () => ({ data: projectIds.map((projectId) => ({ projectId })) }),
  } as unknown as Response;
}

function succeeded(method: string, pathname: string, postBody?: unknown): Response {
  return {
    status: () => 200,
    url: () => `https://example.test${pathname}`,
    request: () => ({ method: () => method, postDataJSON: () => postBody ?? null }),
    json: async () => ({}),
  } as unknown as Response;
}

const testInfo = { title: 'browser console audit unit test' } as TestInfo;

describe('browser console HTTP conflict audit', () => {
  it('requires an error code when registering an expected 409', () => {
    const { page } = createAuditPage();
    setupBrowserAudit(page);

    expect(() =>
      allowExpectedHttpResponse(page, {
        status: 409,
        pathname: '/api/v1/projects/project-1',
        count: 1,
      }),
    ).toThrow(/409.*code/i);
  });

  it('allows a 409 only for the registered code, endpoint, and count', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);
    allowExpectedHttpResponse(page, {
      status: 409,
      pathname: '/api/v1/projects/project-1',
      code: 'PROJECT_NOT_FOUND',
      count: 1,
    });

    emit('response', conflict('/api/v1/projects/project-1', 'PROJECT_NOT_FOUND'));
    await expect(assertBrowserAudit(page, testInfo)).resolves.toBeUndefined();
  });

  describe('proposed count range API', () => {
    const range: CountRange = { min: 1, max: 2 };

    it('allows an optional expected miss with a zero lower bound and fixed maximum', async () => {
      const { page } = createAuditPage();
      setupBrowserAudit(page);
      allowExpectedHttpResponse(page, {
        status: 409,
        pathname: '/api/v1/library/cloud-assets/asset-1/content',
        code: 'ASSET_NOT_FOUND',
        count: { min: 0, max: 5 },
      });

      await expect(assertBrowserAudit(page, testInfo)).resolves.toBeUndefined();
    });

    it('passes when observed count is 1 (inside the closed interval [1,2])', async () => {
      const { page, emit } = createAuditPage();
      setupBrowserAudit(page);
      allowExpectedHttpResponse(page, {
        status: 409,
        pathname: '/api/v1/projects/project-1',
        code: 'PROJECT_NOT_FOUND',
        count: range,
      });

      emit('response', conflict('/api/v1/projects/project-1', 'PROJECT_NOT_FOUND'));
      await expect(assertBrowserAudit(page, testInfo)).resolves.toBeUndefined();
    });

    it('passes when observed count is 2 (inside the closed interval [1,2])', async () => {
      const { page, emit } = createAuditPage();
      setupBrowserAudit(page);
      allowExpectedHttpResponse(page, {
        status: 409,
        pathname: '/api/v1/projects/project-1',
        code: 'PROJECT_NOT_FOUND',
        count: range,
      });

      emit('response', conflict('/api/v1/projects/project-1', 'PROJECT_NOT_FOUND'));
      emit('response', conflict('/api/v1/projects/project-1', 'PROJECT_NOT_FOUND'));
      await expect(assertBrowserAudit(page, testInfo)).resolves.toBeUndefined();
    });

    it('fails with unmet-expected assertion when observed count is 0 (below the minimum)', async () => {
      const { page } = createAuditPage();
      setupBrowserAudit(page);
      allowExpectedHttpResponse(page, {
        status: 409,
        pathname: '/api/v1/projects/project-1',
        code: 'PROJECT_NOT_FOUND',
        count: range,
      });

      await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(
        /Expected HTTP errors missing/,
      );
    });

    it('fails as unexpected when observed count is 3 (above the maximum)', async () => {
      const { page, emit } = createAuditPage();
      setupBrowserAudit(page);
      allowExpectedHttpResponse(page, {
        status: 409,
        pathname: '/api/v1/projects/project-1',
        code: 'PROJECT_NOT_FOUND',
        count: range,
      });

      emit('response', conflict('/api/v1/projects/project-1', 'PROJECT_NOT_FOUND'));
      emit('response', conflict('/api/v1/projects/project-1', 'PROJECT_NOT_FOUND'));
      emit('response', conflict('/api/v1/projects/project-1', 'PROJECT_NOT_FOUND'));
      await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/Unexpected HTTP errors/);
    });
  });

  it('allowExpectedAssetFixtureMisses with range on original and exact on cloud rejects when cloud count is unmet', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);

    allowExpectedAssetFixtureMisses(page, { min: 1, max: 2 }, 2);

    // Emit one original ASSET_NOT_FOUND (within range [1,2])
    emit(
      'response',
      conflict('/api/v1/projects/project-1/assets/asset-1/original', 'ASSET_NOT_FOUND'),
    );

    // Emit only one cloud-content ASSET_NOT_FOUND — cloud expects exactly 2,
    // so a single hit must produce an unmet-expected failure.
    emit('response', conflict('/api/v1/library/cloud-assets/asset-1/content', 'ASSET_NOT_FOUND'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(
      /Expected HTTP errors missing/,
    );
  });

  it('no longer allows a project-list conflict as an asset fixture miss', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);

    allowExpectedAssetFixtureMisses(page, 1, 1);
    emit('response', conflict('/api/v1/projects/project-1/assets', 'PROJECT_NOT_FOUND'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/Unexpected HTTP errors/);
  });

  it('rejects a binding held by an owner other than the E2E owner', async () => {
    const { page, emit } = createAuditPage([], [], {
      'e2e-owner@example.test': ['project-1'],
      'signed-in': ['project-9'],
    });
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));
    emit('request', requestEvent('GET', '/api/v1/projects/project-1/assets'));
    emit('response', succeeded('GET', '/api/v1/projects/project-1/assets'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/another owner/);
  });

  it('rejects a request for a project before its ensure response', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit('request', requestEvent('GET', '/api/v1/projects/project-1/assets'));
    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));
    emit('response', succeeded('GET', '/api/v1/projects/project-1/assets'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/preceded the ensure/);
  });

  it('rejects a read of a project the owner does not hold', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));
    emit('request', requestEvent('GET', '/api/v1/projects/project-2/document'));
    emit('response', succeeded('GET', '/api/v1/projects/project-2/document'));
    emit('response', succeeded('GET', '/api/v1/projects/project-1/assets'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/does not hold/);
  });

  it('rejects an ensure whose body names an unbound project', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit('request', requestEvent('POST', '/api/v1/projects/ensure', { id: 'unbound-editor-1' }));
    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));
    emit('response', succeeded('GET', '/api/v1/projects/project-1/assets'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/Unbound project requests/);
  });

  it('rejects a request that names an unbound project in its query', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit('request', requestEventAt('GET', '/api/v1/library/my-assets?projectId=unbound-editor-1'));
    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));
    emit('response', succeeded('GET', '/api/v1/projects/project-1/assets'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/Unbound project requests/);
  });

  it('rejects a request that names an unbound project in its JSON body', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit(
      'request',
      requestEventAt('POST', '/api/v1/gpu-preview-frame', { projectId: 'unbound-editor-1' }),
    );
    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));
    emit('response', succeeded('GET', '/api/v1/projects/project-1/assets'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/Unbound project requests/);
  });

  it('rejects an ensure whose body names an empty project id', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit('request', requestEvent('POST', '/api/v1/projects/ensure', { id: '' }));
    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: '' }));
    emit('response', succeeded('GET', '/api/v1/projects/project-1/assets'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/names no readable project/);
  });

  it('rejects a create whose body names an unbound project', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit('request', requestEvent('POST', '/api/v1/projects', { id: 'unbound-editor-1' }));
    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));
    emit('response', succeeded('GET', '/api/v1/projects/project-1/assets'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/Unbound project requests/);
  });

  it('rejects a create for a project this owner does not hold', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit('request', requestEvent('POST', '/api/v1/projects', { id: 'project-foreign' }));
    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));
    emit('response', succeeded('GET', '/api/v1/projects/project-1/assets'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/does not hold/);
  });

  it('rejects a create whose body names no readable project', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit('request', requestEvent('POST', '/api/v1/projects'));
    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));
    emit('response', succeeded('GET', '/api/v1/projects/project-1/assets'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/does not hold/);
  });

  it('rejects an ensure whose body names no readable project', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit('request', requestEvent('POST', '/api/v1/projects/ensure'));
    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));
    emit('response', succeeded('GET', '/api/v1/projects/project-1/assets'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/names no readable project/);
  });

  it('rejects an unbound request in an audit that does not check bound projects', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);

    emit('request', requestEvent('GET', '/api/v1/projects/unbound-editor-1/assets'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/Unbound project requests/);
  });

  it('rejects a create even for a project this page ensured', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);

    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));
    emit('request', requestEvent('POST', '/api/v1/projects', { id: 'project-1' }));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/Project creates during/);
  });

  it('rejects a bound project audit with no binding stored for the E2E owner', async () => {
    const { page, emit } = createAuditPage([], [], {});
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));
    emit('request', requestEvent('GET', '/api/v1/projects/project-1/assets'));
    emit('response', succeeded('GET', '/api/v1/projects/project-1/assets'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(
      /Ensured projects without a binding under the E2E owner/,
    );
  });

  it('rejects a request for an unbound project', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));
    emit('request', requestEvent('GET', '/api/v1/projects/unbound-editor-1/assets'));
    emit('response', succeeded('GET', '/api/v1/projects/project-1/assets'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/Unbound project requests/);
  });

  it('accepts reads of other projects the owner holds', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));
    emit('response', ownerAssets(['project-2']));
    emit('request', requestEvent('GET', '/api/v1/projects/project-2/document'));
    emit('response', succeeded('GET', '/api/v1/projects/project-2/document'));
    emit('request', requestEvent('GET', '/api/v1/projects/project-1/assets'));
    emit('response', succeeded('GET', '/api/v1/projects/project-1/assets'));

    await expect(assertBrowserAudit(page, testInfo)).resolves.toBeUndefined();
  });

  it('accepts a bound project read that follows its ensure', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));
    emit('request', requestEvent('GET', '/api/v1/projects/project-1/assets'));
    emit('response', succeeded('GET', '/api/v1/projects/project-1/assets'));

    await expect(assertBrowserAudit(page, testInfo)).resolves.toBeUndefined();
  });

  it('rejects a second created project', async () => {
    const { page, emit } = createAuditPage([], [], {
      'e2e-owner@example.test': ['project-1', 'project-2'],
    });
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));
    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-2' }));
    emit('request', requestEvent('GET', '/api/v1/projects/project-1/assets'));
    emit('response', succeeded('GET', '/api/v1/projects/project-1/assets'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/Expected one bound project/);
  });

  it('rejects a bound project audit that never reads the bound project', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(
      /No bound project read succeeded/,
    );
  });

  it('rejects a bound project audit that still shows PROJECT_NOT_FOUND', async () => {
    const { page, emit } = createAuditPage([], ['PROJECT_NOT_FOUND']);
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));
    emit('request', requestEvent('GET', '/api/v1/projects/project-1/assets'));
    emit('response', succeeded('GET', '/api/v1/projects/project-1/assets'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/PROJECT_NOT_FOUND was shown/);
  });

  it('does not count a successful mutation as a bound project read', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);
    expectBoundProjectOnly(page);

    emit('response', succeeded('POST', '/api/v1/projects/ensure', { id: 'project-1' }));
    emit('request', requestEvent('POST', '/api/v1/projects/project-1/rename'));
    emit('response', succeeded('POST', '/api/v1/projects/project-1/rename'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(
      /No bound project read succeeded/,
    );
  });

  it('does not broadly ignore a known 409 code at an unregistered endpoint', async () => {
    const { page, emit } = createAuditPage();
    setupBrowserAudit(page);
    allowExpectedHttpResponse(page, {
      status: 409,
      pathname: '/api/v1/projects/project-1',
      code: 'PROJECT_NOT_FOUND',
      count: 1,
    });
    emit('response', conflict('/api/v1/assets/asset-1', 'PROJECT_NOT_FOUND'));

    await expect(assertBrowserAudit(page, testInfo)).rejects.toThrow(/Unexpected HTTP errors/);
  });

  it('counts a 409 once when Playwright cannot read its body', async () => {
    const pathname = '/api/v1/projects/project-1/assets/asset-1/original';
    const raw = new Response('not json', { status: 409 });
    const response = {
      status: () => raw.status,
      url: () => `https://example.test${pathname}`,
      json: () => raw.json(),
    } as unknown as Response;

    const { page, emit } = createAuditPage([{ status: 409, pathname, code: 'ASSET_NOT_FOUND' }]);
    setupBrowserAudit(page);
    allowExpectedHttpResponse(page, {
      status: 409,
      pathname: '/api/v1/projects/project-1/assets/asset-1/original',
      code: 'ASSET_NOT_FOUND',
      count: 1,
    });

    emit('response', response);
    await expect(assertBrowserAudit(page, testInfo)).resolves.toBeUndefined();
  });

  it('adds an error the page received but Playwright did not report, once', async () => {
    const pathname = '/api/v1/projects/project-1/assets';
    const { page } = createAuditPage([{ status: 409, pathname, code: 'PROJECT_NOT_FOUND' }]);
    setupBrowserAudit(page);
    allowExpectedHttpResponse(page, {
      status: 409,
      pathname: '/api/v1/projects/project-1/assets',
      code: 'PROJECT_NOT_FOUND',
      count: 1,
    });

    await expect(assertBrowserAudit(page, testInfo)).resolves.toBeUndefined();
  });

  it('counts a mixed pair once when Playwright cannot read one of two responses', async () => {
    const pathname = '/api/v1/projects/project-1/assets/asset-1/original';
    const raw = new Response('not json', { status: 409 });
    const response = {
      status: () => raw.status,
      url: () => `https://example.test${pathname}`,
      json: () => raw.json(),
    } as unknown as Response;

    const { page, emit } = createAuditPage([
      { status: 409, pathname, code: 'ASSET_NOT_FOUND' },
      { status: 409, pathname, code: 'body-unreadable' },
    ]);
    setupBrowserAudit(page);
    allowExpectedHttpResponse(page, {
      status: 409,
      pathname,
      code: 'ASSET_NOT_FOUND',
      count: 1,
    });
    allowExpectedHttpResponse(page, {
      status: 409,
      pathname,
      code: 'body-unreadable',
      count: 1,
    });

    emit('response', response);
    await expect(assertBrowserAudit(page, testInfo)).resolves.toBeUndefined();
  });
});
