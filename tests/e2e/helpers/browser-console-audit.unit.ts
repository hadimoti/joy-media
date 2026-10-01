import type { Page, Response, TestInfo } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import {
  allowExpectedAssetFixtureMisses,
  allowExpectedHttpResponse,
  assertBrowserAudit,
  type CountRange,
  setupBrowserAudit,
} from './browser-console-audit.js';

type EventHandler = (payload: unknown) => void;

function createAuditPage(): {
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
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
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

    // Emit the required six project-list conflicts
    for (let i = 0; i < 6; i++) {
      emit('response', conflict('/api/v1/projects/project-1/assets', 'PROJECT_NOT_FOUND'));
    }

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
});
