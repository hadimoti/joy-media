import { expect, type Page, type Request, type Response, type TestInfo } from '@playwright/test';

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

interface ProjectRequest {
  projectId: string;
  method: string;
  /** Position in the page's event order, compared with the ensure that created the project. */
  order: number;
}

interface AuditState {
  consoleErrors: string[];
  pageErrors: string[];
  httpErrors: AuditedHttpError[];
  expectedHttpResponses: ExpectedHttpResponse[];
  pendingBodyReads: Promise<void>[];
  projectRequests: ProjectRequest[];
  ensuredProjectIds: Set<string>;
  boundProjectReads: number;
  boundProjectOnly: boolean;
  /** The event order at which each project was first ensured by this page. */
  ensuredAt: Map<string, number>;
  eventOrder: number;
  /** The project ids named in the bodies of this page's ensure requests. */
  ensureRequestIds: string[];
  /** The project ids named by this page's create requests. No editor flow may create a project. */
  createRequestIds: string[];
  /** Projects the owner holds, as the owner's own asset list names them. */
  ownerHeldProjectIds: Set<string>;
}

const ENSURE_ROUTE = 'ensure';
/** The create route, which names its project in the body rather than the path. */
const PROJECTS_ROUTE = '/api/v1/projects';
/** Recorded for a create whose body names no readable project id, so the audit cannot pass it. */
const UNIDENTIFIED_PROJECT_REQUEST = '<unidentified project request>';
/** The owner the authenticated E2E session signs in as. */
const E2E_OWNER_KEY = 'e2e-owner@example.test';
/** The placeholder prefix of a project the session does not own. The client never sends it. */
const UNBOUND_PROJECT_PREFIX = 'unbound-';
const BINDINGS_STORAGE_KEY = 'joy-media.control-plane-project-bindings.v1';
/** The owner's asset list. Each asset names its project, which is how the owner's projects are known. */
const OWNER_ASSET_LIST_ROUTE = '/api/v1/library/my-assets';

/** Owner keys of every control-plane binding this page has stored. */
async function controlPlaneBindings(page: Page): Promise<Record<string, string[]>> {
  const raw = await page.evaluate((key) => window.localStorage.getItem(key), BINDINGS_STORAGE_KEY);
  if (raw === null) return {};
  const value = JSON.parse(raw) as {
    bindingsByOwner?: Record<string, Record<string, { controlPlaneProjectId?: unknown }>>;
  };
  return Object.fromEntries(
    Object.entries(value.bindingsByOwner ?? {}).map(([owner, bindings]) => [
      owner,
      Object.values(bindings).flatMap((binding) =>
        typeof binding?.controlPlaneProjectId === 'string' ? [binding.controlPlaneProjectId] : [],
      ),
    ]),
  );
}

/** The <id> of a /api/v1/projects/<id>… URL, or undefined for any other URL. */
function projectRouteId(url: string): string | undefined {
  return /^\/api\/v1\/projects\/([^/?#]+)/.exec(new URL(url).pathname)?.[1];
}

/** A project id as a body or query names it. An empty or blank id names no project. */
function namedProjectId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** The project id an ensure request names in its body, or undefined when the body names none. */
function requestedProjectId(request: Request): string | undefined {
  try {
    const body = request.postDataJSON() as { id?: unknown } | null;
    return namedProjectId(body?.id);
  } catch {
    return undefined;
  }
}

/** The project id a successful ensure request created, or undefined when the body names none. */
function ensuredProjectId(response: Response): string | undefined {
  try {
    const body = response.request().postDataJSON() as { id?: unknown } | null;
    return namedProjectId(body?.id);
  } catch {
    return undefined;
  }
}

/**
 * The project ids a request names outside its path: a `projectId` query parameter, or a `projectId`
 * field of a JSON body. The audit judges them as it judges a path name, so a request cannot pass by
 * naming an unbound project in its query or body.
 */
function projectIdsOutsidePath(request: Request): string[] {
  const named: string[] = [];
  const inQuery = namedProjectId(new URL(request.url()).searchParams.get('projectId') ?? undefined);
  if (inQuery !== undefined) named.push(inQuery);
  try {
    const body = request.postDataJSON() as { projectId?: unknown } | null;
    const inBody = namedProjectId(body?.projectId);
    if (inBody !== undefined) named.push(inBody);
  } catch {
    // Not a JSON body, so the request names no project in it.
  }
  return named;
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
    projectRequests: [],
    ensuredProjectIds: new Set(),
    boundProjectReads: 0,
    boundProjectOnly: false,
    ensuredAt: new Map(),
    eventOrder: 0,
    ensureRequestIds: [],
    createRequestIds: [],
    ownerHeldProjectIds: new Set(),
  };
  stateByPage.set(page, state);

  page.on('console', (message) => {
    if (message.type() === 'error') state.consoleErrors.push(message.text());
  });

  page.on('pageerror', (error) => state.pageErrors.push(error.message));

  page.on('request', (request) => {
    if (new URL(request.url()).pathname === PROJECTS_ROUTE && request.method() === 'POST') {
      const createdId = requestedProjectId(request) ?? UNIDENTIFIED_PROJECT_REQUEST;
      state.createRequestIds.push(createdId);
      state.projectRequests.push({
        projectId: createdId,
        method: 'POST',
        order: state.eventOrder++,
      });
      return;
    }
    const projectId = projectRouteId(request.url());
    if (projectId === ENSURE_ROUTE) {
      // An ensure whose body names no readable project is kept as unidentified, so the audit fails
      // it instead of dropping it unjudged.
      state.ensureRequestIds.push(requestedProjectId(request) ?? UNIDENTIFIED_PROJECT_REQUEST);
      return;
    }
    const named = [
      ...(projectId === undefined ? [] : [projectId]),
      ...projectIdsOutsidePath(request),
    ];
    for (const namedId of named) {
      state.projectRequests.push({
        projectId: namedId,
        method: request.method(),
        order: state.eventOrder++,
      });
    }
  });

  // The owner's own asset list names the projects the owner holds. A read of any other project
  // that this page did not ensure is not evidence of ownership.
  page.on('response', (response) => {
    if (response.status() >= 400 || new URL(response.url()).pathname !== OWNER_ASSET_LIST_ROUTE) {
      return;
    }
    const read = (async () => {
      try {
        const body = (await response.json()) as { data?: { projectId?: unknown }[] };
        for (const asset of body.data ?? []) {
          if (typeof asset.projectId === 'string') state.ownerHeldProjectIds.add(asset.projectId);
        }
      } catch {
        // An unreadable list holds no evidence, so a read it would have covered fails below.
      }
    })();
    state.pendingBodyReads.push(read);
  });

  page.on('response', (response) => {
    if (response.status() >= 400) return;
    const projectId = projectRouteId(response.url());
    if (projectId === ENSURE_ROUTE) {
      const created = ensuredProjectId(response);
      if (created !== undefined) {
        state.ensuredProjectIds.add(created);
        if (!state.ensuredAt.has(created)) state.ensuredAt.set(created, state.eventOrder++);
      }
    } else if (
      projectId !== undefined &&
      state.ensuredProjectIds.has(projectId) &&
      response.request().method() === 'GET'
    ) {
      state.boundProjectReads += 1;
    }
  });

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

/**
 * Declares the server's fixture-miss responses for reference assets that have no uploaded bytes. A
 * project-list 409 is not a fixture miss. It means a request reached the server before its project
 * was bound, which {@link expectBoundProjectOnly} forbids, so it is not allowed here.
 */
export function allowExpectedAssetFixtureMisses(
  page: Page,
  original: number | CountRange,
  cloud?: number | CountRange,
): void {
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
 * project original route and the cloud content route. Give the exact count that was measured. A
 * range is for a count that measurements show varies, and the reason should name that evidence.
 * Any other asset ID still fails the audit.
 */
export function allowReferenceFixtureMisses(
  page: Page,
  assetIds: readonly string[],
  count: number | CountRange,
  cloud: number | CountRange = count,
): void {
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

/**
 * Strict binding check for a page whose only project is created by its ready session. Every
 * project-scoped request must follow the successful ensure of its own project, exactly one project
 * may be created, a read of the bound project must succeed, and no PROJECT_NOT_FOUND may be shown.
 * This replaces the former count of project-list 409 responses. Those were requests the page sent
 * before its project was bound, so the check fails on any page that sends them.
 */
export function expectBoundProjectOnly(page: Page): void {
  const state = stateByPage.get(page);
  if (!state) throw new Error('setupBrowserAudit was not called for this page');
  state.boundProjectOnly = true;
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
  // The owner-binding invariants hold in every audited flow, not only in bound-project runs.
  const unboundRequests = [
    ...state.projectRequests
      .filter((request) => request.projectId.startsWith(UNBOUND_PROJECT_PREFIX))
      .map((request) => `${request.method} ${request.projectId}`),
    ...state.ensureRequestIds
      .filter((id) => id.startsWith(UNBOUND_PROJECT_PREFIX))
      .map((id) => `POST ensure ${id}`),
  ];
  expect(unboundRequests, `Unbound project requests during ${testInfo.title}`).toEqual([]);
  expect(
    state.ensureRequestIds.filter((id) => id === UNIDENTIFIED_PROJECT_REQUEST),
    `Project ensures whose body names no readable project during ${testInfo.title}`,
  ).toEqual([]);
  const unownedRequests = state.projectRequests
    .filter(
      (request) =>
        !state.ensuredProjectIds.has(request.projectId) &&
        !state.ownerHeldProjectIds.has(request.projectId),
    )
    .map((request) => `${request.method} ${request.projectId}`);
  expect(
    unownedRequests,
    `Project requests for a project this owner does not hold during ${testInfo.title}`,
  ).toEqual([]);
  expect(state.createRequestIds, `Project creates during ${testInfo.title}`).toEqual([]);
  if (state.boundProjectOnly) {
    const bindings = await controlPlaneBindings(page);
    expect(
      Object.keys(bindings).filter((owner) => owner !== E2E_OWNER_KEY),
      `Control-plane bindings for another owner during ${testInfo.title}`,
    ).toEqual([]);
    const storedProjectIds = new Set(bindings[E2E_OWNER_KEY] ?? []);
    expect(
      [...state.ensuredProjectIds].filter((id) => !storedProjectIds.has(id)),
      `Ensured projects without a binding under the E2E owner during ${testInfo.title}`,
    ).toEqual([]);
    const requestedBeforeEnsure = state.projectRequests
      .filter((request) => {
        const ensuredAt = state.ensuredAt.get(request.projectId);
        return ensuredAt !== undefined && request.order < ensuredAt;
      })
      .map((request) => `${request.method} ${request.projectId}`);
    expect(
      requestedBeforeEnsure,
      `Project requests preceded the ensure of their project during ${testInfo.title}`,
    ).toEqual([]);
    // A bound-project page writes only to the project it ensured. A write to another project the owner
    // holds is a request this page never bound, even though the owner may read that project.
    const writesToUnensuredProjects = state.projectRequests
      .filter(
        (request) =>
          !state.ensuredProjectIds.has(request.projectId) &&
          request.method !== 'GET' &&
          request.method !== 'OPTIONS',
      )
      .map((request) => `${request.method} ${request.projectId}`);
    expect(
      writesToUnensuredProjects,
      `Writes to a project this page never ensured during ${testInfo.title}`,
    ).toEqual([]);
    expect(
      state.ensuredProjectIds.size,
      `Expected one bound project during ${testInfo.title}`,
    ).toBe(1);
    expect(
      state.boundProjectReads,
      `No bound project read succeeded during ${testInfo.title}`,
    ).toBeGreaterThan(0);
    expect(
      await page.getByText('PROJECT_NOT_FOUND').count(),
      `PROJECT_NOT_FOUND was shown during ${testInfo.title}`,
    ).toBe(0);
  }
  expect(unexpectedHttpErrors, `Unexpected HTTP errors during ${testInfo.title}`).toEqual([]);
  expect(unmetExpectedHttpErrors, `Expected HTTP errors missing during ${testInfo.title}`).toEqual(
    [],
  );
  expect(actionableConsoleErrors, `Browser console errors during ${testInfo.title}`).toEqual([]);
  expect(nonSandboxPageErrors, `Browser page errors during ${testInfo.title}`).toEqual([]);
}
