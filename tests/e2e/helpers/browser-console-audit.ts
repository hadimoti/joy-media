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

/**
 * Page-side fetch ledger. Playwright's `response` events can omit a response the page has already
 * received: in the failing runs, a media read answered 409 was logged by the browser, yet no request or
 * response event reached the audit. The ledger records each media read the page settles with an error
 * status, and counts the media reads still in flight, so the audit can wait for them to settle and
 * reconcile against what the page actually received.
 */
const FETCH_LEDGER_INIT_SCRIPT = `(() => {
  const MEDIA_READ = /^\\/api\\/v1\\/(?:projects\\/[^/]+\\/assets(?:\\/|$)|library\\/cloud-assets\\/)/;
  // The errors live in sessionStorage, so a reload (a new document) keeps the errors of earlier documents.
  const STORE = 'joy-e2e-fetch-errors';
  const persisted = (() => {
    try {
      return JSON.parse(sessionStorage.getItem(STORE) ?? '[]');
    } catch {
      return [];
    }
  })();
  const ledger = (window.__joyFetchLedger = { pending: 0, started: 0, errors: persisted });
  const record = (entry) => {
    ledger.errors.push(entry);
    try {
      sessionStorage.setItem(STORE, JSON.stringify(ledger.errors));
    } catch {
      // Storage unavailable: this document's errors are still in the ledger.
    }
  };
  const codeOf = (text) => {
    try {
      const body = JSON.parse(text);
      return typeof body?.error?.code === 'string' ? body.error.code : 'code-missing';
    } catch {
      return 'body-unreadable';
    }
  };
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    let pathname = '';
    try {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      pathname = new URL(href, location.href).pathname;
    } catch {
      pathname = '';
    }
    const relevant = MEDIA_READ.test(pathname);
    if (relevant) {
      ledger.started += 1;
      ledger.pending += 1;
    }
    let request;
    try {
      request = originalFetch.call(this, input, init);
    } catch (error) {
      if (relevant) ledger.pending -= 1;
      throw error;
    }
    return request.then(
      (response) => {
        if (relevant) ledger.pending -= 1;
        if (relevant && response.status >= 400) {
          ledger.pending += 1;
          const is409 = response.status === 409;
          let reading;
          try {
            reading = response.clone().text();
          } catch (error) {
            reading = Promise.reject(error);
          }
          reading
            .then(
              (text) => {
                record({
                  pathname,
                  status: response.status,
                  ...(is409 ? { code: codeOf(text) } : {}),
                });
              },
              () => {
                record({
                  pathname,
                  status: response.status,
                  ...(is409 ? { code: 'body-unreadable' } : {}),
                });
              },
            )
            .finally(() => {
              ledger.pending -= 1;
            });
        }
        return response;
      },
      (error) => {
        if (relevant) ledger.pending -= 1;
        throw error;
      },
    );
  };
})();`;

type FetchLedger = {
  readonly pending: number;
  readonly started: number;
  readonly errors: readonly { pathname: string; status: number; code?: string }[];
};

const MEDIA_READ_SETTLE_TIMEOUT_MS = 5_000;

/**
 * Waits inside the page until no media read is in flight, and none has started across two consecutive
 * 50 ms samples. It is one round trip to the page, so a busy renderer does not stretch each sample.
 * A document that never ran the ledger (such as about:blank) has no media read to wait for. Returns
 * false only if the page does not settle before the deadline, or cannot be read.
 */
async function waitForMediaReadsToSettle(page: Page): Promise<boolean> {
  return page
    .evaluate(async (timeoutMs) => {
      const ledger = (
        window as unknown as { __joyFetchLedger?: { pending: number; started: number } }
      ).__joyFetchLedger;
      if (ledger === undefined) return true;
      const deadline = Date.now() + timeoutMs;
      let lastStarted = -1;
      let quietSamples = 0;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (ledger.pending === 0 && ledger.started === lastStarted) {
          quietSamples += 1;
          if (quietSamples >= 2) return true;
        } else {
          quietSamples = 0;
        }
        lastStarted = ledger.started;
      }
      return false;
    }, MEDIA_READ_SETTLE_TIMEOUT_MS)
    .catch(() => false);
}

/**
 * Waits until every 409 body that Playwright has seen is read, including bodies of responses that
 * arrive while the loop runs. The audit cannot match a 409 until its code is known.
 */
async function settleResponseBodies(page: Page, state: AuditState): Promise<void> {
  let previousResponseState = '';
  let quietIntervals = 0;
  for (let attempt = 0; attempt < 20 && quietIntervals < 2; attempt += 1) {
    await Promise.all(state.pendingBodyReads);
    await page.waitForTimeout(50);
    const responseState = `${state.httpErrors.length}:${state.pendingBodyReads.length}`;
    quietIntervals = responseState === previousResponseState ? quietIntervals + 1 : 0;
    previousResponseState = responseState;
  }
}

/**
 * Adds to the audited HTTP errors each media-read error the page received that Playwright did not
 * report. Each ledger error matches at most one audited error, and an unreadable Playwright body
 * takes the page's code so that a response is not counted twice. Run it only after every 409 body
 * has been read.
 */
async function reconcileWithFetchLedger(page: Page, state: AuditState): Promise<void> {
  const ledgerErrors = await page
    .evaluate(
      () =>
        (window as unknown as { __joyFetchLedger?: FetchLedger }).__joyFetchLedger?.errors ?? [],
    )
    .catch(() => []);
  const keyOf = (error: { status: number; pathname: string; code?: string }) =>
    `${error.status} ${error.pathname} ${error.code ?? ''}`;
  const observed = new Map<string, number>();
  for (const error of state.httpErrors) {
    const key = keyOf(error);
    observed.set(key, (observed.get(key) ?? 0) + 1);
  }
  const matched = new Set<AuditedHttpError>();
  for (const entry of ledgerErrors) {
    const key = keyOf(entry);
    const count = observed.get(key) ?? 0;
    if (count > 0) {
      observed.set(key, count - 1);
      if (entry.code === 'body-unreadable') {
        const error = state.httpErrors.find(
          (e) =>
            e.status === entry.status &&
            e.pathname === entry.pathname &&
            e.code === 'body-unreadable' &&
            !matched.has(e),
        );
        if (error) matched.add(error);
      }
      continue;
    }
    const unreadable = state.httpErrors.find(
      (e) =>
        e.code === 'body-unreadable' &&
        e.status === entry.status &&
        e.pathname === entry.pathname &&
        !matched.has(e),
    );
    if (unreadable) {
      const unreadableKey = keyOf(unreadable);
      observed.set(unreadableKey, Math.max(0, (observed.get(unreadableKey) ?? 0) - 1));
      unreadable.code = entry.code;
      matched.add(unreadable);
      continue;
    }
    state.httpErrors.push({
      status: entry.status,
      pathname: entry.pathname,
      ...(entry.code === undefined ? {} : { code: entry.code }),
    });
  }
}

export function setupBrowserAudit(page: Page): void {
  void page.addInitScript(FETCH_LEDGER_INIT_SCRIPT);
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
      count.min < 0 ||
      count.max < 1
    ) {
      throw new Error(
        'Expected HTTP response count range min must be a nonnegative integer and max must be a positive integer',
      );
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

/**
 * Narrow form of {@link allowExpectedAssetFixtureMisses} for a fixture whose reference assets are
 * declared without uploaded bytes. Only the named asset IDs may answer 409 ASSET_NOT_FOUND, on the
 * project original route and the cloud content route. The count is a bounded range, because the
 * number of reads depends on when a user action lands relative to the background reference reads
 * (an async, layout-dependent request). Any other asset ID still fails the audit.
 */
export function allowReferenceFixtureMisses(
  page: Page,
  assetIds: readonly string[],
  count: number | CountRange,
  cloud: number | CountRange = count,
): void {
  allowExpectedHttpResponse(page, {
    status: 409,
    pathname: /^\/api\/v1\/projects\/[^/]+\/assets$/,
    code: 'PROJECT_NOT_FOUND',
    count: 6,
  });
  const ids = assetIds.join('|');
  allowExpectedHttpResponse(page, {
    status: 409,
    pathname: new RegExp(`^/api/v1/projects/[^/]+/assets/(?:${ids})/original$`),
    code: 'ASSET_NOT_FOUND',
    count,
  });
  allowExpectedHttpResponse(page, {
    status: 409,
    pathname: new RegExp(`^/api/v1/library/cloud-assets/(?:${ids})/content$`),
    code: 'ASSET_NOT_FOUND',
    count: cloud,
  });
}

export async function assertBrowserAudit(page: Page, testInfo: TestInfo): Promise<void> {
  const state = stateByPage.get(page);
  if (!state) throw new Error('setupBrowserAudit was not called for this page');

  await page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => undefined);
  const mediaReadsSettled = await waitForMediaReadsToSettle(page);
  await settleResponseBodies(page, state);
  await reconcileWithFetchLedger(page, state);

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

  expect(mediaReadsSettled, `Media reads did not settle during ${testInfo.title}`).toBe(true);
  expect(unexpectedHttpErrors, `Unexpected HTTP errors during ${testInfo.title}`).toEqual([]);
  expect(unmetExpectedHttpErrors, `Expected HTTP errors missing during ${testInfo.title}`).toEqual(
    [],
  );
  expect(actionableConsoleErrors, `Browser console errors during ${testInfo.title}`).toEqual([]);
  expect(nonSandboxPageErrors, `Browser page errors during ${testInfo.title}`).toEqual([]);
}
