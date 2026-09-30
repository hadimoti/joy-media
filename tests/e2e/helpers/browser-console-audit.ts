import { expect, type Page, type TestInfo } from '@playwright/test';

export type CountRange = { min: number; max: number };

const SANDBOX_STORAGE_ERROR =
  "Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.";
const HTTP_STATUS_CONSOLE_ERROR =
  /^Failed to load resource: the server responded with a status of \d{3} \([^)]+\)$/;

interface ExpectedHttpResponse {
  status: number;
  pathname: string | RegExp;
  code?: string;
  expectedCount: number | CountRange;
  matchedCount: number;
}

interface AuditedHttpError {
  status: number;
  pathname: string;
  code?: string;
}

interface AuditState {
  consoleErrors: string[];
  pageErrors: string[];
  httpErrors: AuditedHttpError[];
  expectedHttpResponses: ExpectedHttpResponse[];
  pendingBodyReads: Promise<void>[];
}

const stateByPage = new WeakMap<Page, AuditState>();

export function setupBrowserAudit(page: Page): void {
  const state: AuditState = {
    consoleErrors: [],
    pageErrors: [],
    httpErrors: [],
    expectedHttpResponses: [],
    pendingBodyReads: [],
  };
  stateByPage.set(page, state);

  page.on('console', (message) => {
    if (message.type() === 'error') state.consoleErrors.push(message.text());
  });

  page.on('pageerror', (error) => state.pageErrors.push(error.message));

  page.on('response', (response) => {
    if (response.status() < 400) return;

    const error: AuditedHttpError = {
      status: response.status(),
      pathname: new URL(response.url()).pathname,
    };
    state.httpErrors.push(error);

    if (error.status === 409) {
      const read = (async () => {
        try {
          const body = (await response.json()) as { error?: { code?: unknown } };
          error.code = typeof body?.error?.code === 'string' ? body.error.code : 'code-missing';
        } catch {
          // An unreadable conflict response remains an unexpected HTTP error.
          error.code = 'body-unreadable';
        }
      })();
      state.pendingBodyReads.push(read);
    }
  });
}

export function allowExpectedHttpResponse(
  page: Page,
  expected: {
    status: number;
    pathname: string | RegExp;
    code?: string;
    count?: number | CountRange;
  },
): void {
  const state = stateByPage.get(page);
  if (!state) throw new Error('setupBrowserAudit was not called for this page');
  const count = expected.count ?? 1;
  if (typeof count === 'number') {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error('Expected HTTP response count must be a positive integer');
    }
  } else {
    if (
      !Number.isInteger(count.min) ||
      !Number.isInteger(count.max) ||
      count.min < 1 ||
      count.max < 1
    ) {
      throw new Error('Expected HTTP response count range bounds must be positive integers');
    }
    if (count.max < count.min) {
      throw new Error('Expected HTTP response count range max must be >= min');
    }
  }
  if (expected.status === 409 && (!expected.code || expected.code.trim() === '')) {
    throw new Error('A 409 response expectation must include a non-empty error code');
  }
  state.expectedHttpResponses.push({ ...expected, expectedCount: count, matchedCount: 0 });
}

export function allowExpectedAssetFixtureMisses(
  page: Page,
  original: number | CountRange,
  cloud?: number | CountRange,
): void {
  allowExpectedHttpResponse(page, {
    status: 409,
    pathname: /^\/api\/v1\/projects\/[^/]+\/assets$/,
    code: 'PROJECT_NOT_FOUND',
    count: 6,
  });
  allowExpectedHttpResponse(page, {
    status: 409,
    pathname: /^\/api\/v1\/projects\/[^/]+\/assets\/[^/]+\/original$/,
    code: 'ASSET_NOT_FOUND',
    count: original,
  });
  allowExpectedHttpResponse(page, {
    status: 409,
    pathname: /^\/api\/v1\/library\/cloud-assets\/[^/]+\/content$/,
    code: 'ASSET_NOT_FOUND',
    count: cloud ?? original,
  });
}

export async function assertBrowserAudit(page: Page, testInfo: TestInfo): Promise<void> {
  const state = stateByPage.get(page);
  if (!state) throw new Error('setupBrowserAudit was not called for this page');

  await page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => undefined);
  let previousResponseState = '';
  let quietIntervals = 0;
  for (let attempt = 0; attempt < 20 && quietIntervals < 2; attempt += 1) {
    await Promise.all(state.pendingBodyReads);
    await page.waitForTimeout(50);
    const responseState = `${state.httpErrors.length}:${state.pendingBodyReads.length}`;
    quietIntervals = responseState === previousResponseState ? quietIntervals + 1 : 0;
    previousResponseState = responseState;
  }

  const unexpectedHttpErrors: string[] = [];
  for (const error of state.httpErrors) {
    const expected = state.expectedHttpResponses.find((candidate) => {
      const pathMatches =
        typeof candidate.pathname === 'string'
          ? candidate.pathname === error.pathname
          : candidate.pathname.test(error.pathname);
      const codeMatches = candidate.code == null || candidate.code === error.code;
      const countCap =
        typeof candidate.expectedCount === 'number'
          ? candidate.expectedCount
          : candidate.expectedCount.max;
      return (
        candidate.status === error.status &&
        pathMatches &&
        codeMatches &&
        candidate.matchedCount < countCap
      );
    });

    if (expected) expected.matchedCount += 1;
    else {
      const code = error.code ? ` code="${error.code}"` : '';
      unexpectedHttpErrors.push(`${error.status} ${error.pathname}${code}`);
    }
  }

  const unmetExpectedHttpErrors = state.expectedHttpResponses
    .filter((expected) => {
      if (typeof expected.expectedCount === 'number') {
        return expected.matchedCount !== expected.expectedCount;
      }
      return expected.matchedCount < expected.expectedCount.min;
    })
    .map(
      (expected) =>
        `${expected.status} ${expected.pathname.toString()}: expected ${JSON.stringify(expected.expectedCount)}, observed ${expected.matchedCount}`,
    );

  const nonSandboxPageErrors = state.pageErrors.filter((e) => e !== SANDBOX_STORAGE_ERROR);
  const actionableConsoleErrors = state.consoleErrors.filter(
    (message) => !HTTP_STATUS_CONSOLE_ERROR.test(message),
  );

  expect(unexpectedHttpErrors, `Unexpected HTTP errors during ${testInfo.title}`).toEqual([]);
  expect(unmetExpectedHttpErrors, `Expected HTTP errors missing during ${testInfo.title}`).toEqual(
    [],
  );
  expect(actionableConsoleErrors, `Browser console errors during ${testInfo.title}`).toEqual([]);
  expect(nonSandboxPageErrors, `Browser page errors during ${testInfo.title}`).toEqual([]);
}
