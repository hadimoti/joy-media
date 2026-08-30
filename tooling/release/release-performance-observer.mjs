#!/usr/bin/env node
/* global URL, process, console, setInterval, clearInterval, performance, window, document, PerformanceObserver */

/**
 * Bounded, machine-generated PROOF-01 observer.
 *
 * This command only accepts a loopback URL. It never contacts a live host and
 * never invents a metric: unavailable browser/app instrumentation is emitted
 * as null and makes the release gate fail closed. The default run is the
 * complete gate duration (60s polling warm-up + 30m effects soak).
 *
 * The app may expose an optional read-only timeline probe at
 * window.__JOY_RELEASE_TIMELINE_PROBE__. It must return the measured result;
 * the observer does not mutate application state to manufacture a result.
 */

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GENERATOR = 'joy-media-release-observer';
export const POLLING_WARMUP_MS = 60_000;
export const POLLING_DURATION_MS = 60_000;
export const EFFECTS_DURATION_MS = 30 * 60_000;
export const MAX_EFFECTS_DURATION_MS = EFFECTS_DURATION_MS;

const DEFAULT_OUTPUT = 'test-output/release-performance';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function git(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function sourceProvenance(root) {
  const lockfile = join(root, 'pnpm-lock.yaml');
  const status = git(root, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    '.',
    ':(exclude)test-output/**',
    ':(exclude)test-results/**',
    ':(exclude)playwright-report/**',
  ]);
  return {
    commitSha: git(root, ['rev-parse', 'HEAD']),
    treeHash: git(root, ['rev-parse', 'HEAD^{tree}']),
    lockfileSha256: existsSync(lockfile) ? sha256File(lockfile) : '',
    worktreeClean: status.length === 0,
  };
}

function parseArgs(argv) {
  const args = {
    url: undefined,
    output: DEFAULT_OUTPUT,
    phase: 'staging',
    warmupMs: POLLING_WARMUP_MS,
    durationMs: EFFECTS_DURATION_MS,
    categorySelector: '[data-release-observer-category]',
    searchSelector: '[data-release-observer-search]',
    favoriteSelector: '[data-release-observer-favorite]',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--help' || key === '-h') args.help = true;
    else if (key === '--url') {
      args.url = value;
      i += 1;
    } else if (key === '--output') {
      args.output = value;
      i += 1;
    } else if (key === '--phase') {
      args.phase = value;
      i += 1;
    } else if (key === '--warmup-ms') {
      args.warmupMs = Number(value);
      i += 1;
    } else if (key === '--duration-ms') {
      args.durationMs = Number(value);
      i += 1;
    } else if (key === '--category-selector') {
      args.categorySelector = value;
      i += 1;
    } else if (key === '--search-selector') {
      args.searchSelector = value;
      i += 1;
    } else if (key === '--favorite-selector') {
      args.favoriteSelector = value;
      i += 1;
    } else throw new Error(`unknown option: ${key}`);
  }
  return args;
}

function usage() {
  return [
    'Usage: node tooling/release/release-performance-observer.mjs [options]',
    '',
    '  --url URL                 loopback staging URL; omitted means browser evidence is unavailable',
    '  --output DIR              evidence directory (default: test-output/release-performance)',
    '  --phase staging|production evidence phase (default: staging)',
    '  --warmup-ms N             polling warm-up (default: 60000)',
    '  --duration-ms N           effects soak duration, max 1800000 (default: 1800000)',
    '  --category-selector CSS   opt-in category hook (default: data-release-observer-category)',
    '  --search-selector CSS     opt-in search hook (default: data-release-observer-search)',
    '  --favorite-selector CSS   opt-in favorite hook (default: data-release-observer-favorite)',
  ].join('\n');
}

function baseMetadata(runId, generatedAt, phase, provenance) {
  return {
    schemaVersion: 1,
    runId,
    generatedAt,
    generator: GENERATOR,
    phase,
    sourceProvenance: provenance,
  };
}

function failedMetrics() {
  return {
    polling: {
      artifactPath: 'test-output/release-performance/polling.json',
      warmupMs: null,
      durationMs: null,
      visibleRequestsPerMinute: null,
      hiddenRequestsPerMinute: null,
      duplicateInFlightRequests: null,
      queryRatePerMinute: null,
    },
    effectsSoak: {
      artifactPath: 'test-output/release-performance/effects-soak.json',
      durationMs: null,
      categoriesVisited: null,
      searchIterations: null,
      favoriteIterations: null,
      uncaughtExceptions: null,
      navigationFailures: null,
      maxMountedPreviews: null,
      maxPlayingPreviews: null,
      heapGrowthPercent: null,
    },
    timelineIntegrity: {
      artifactPath: 'test-output/release-performance/timeline-integrity.json',
      operations: null,
      countSequence: null,
      uniqueIds: null,
      orphanReferences: null,
      canonicalModelEqualAfterReload: null,
    },
    editor: {
      artifactPath: 'test-output/release-performance/editor.json',
      measuredWallTimeMs: null,
      longTaskPercent: null,
      initialEditorJsBytes: null,
    },
  };
}

// Keep the producer's final status at least as strict as gate.ts. Missing or
// non-finite values deliberately evaluate to false.
function hasPassingMetrics(metrics) {
  const p = metrics.polling;
  const e = metrics.effectsSoak;
  const t = metrics.timelineIntegrity;
  const d = metrics.editor;
  return Boolean(
    Number.isFinite(p.warmupMs) &&
    p.warmupMs >= POLLING_WARMUP_MS &&
    Number.isFinite(p.durationMs) &&
    p.durationMs >= POLLING_DURATION_MS &&
    Number.isFinite(p.visibleRequestsPerMinute) &&
    p.visibleRequestsPerMinute >= 0 &&
    p.visibleRequestsPerMinute <= 6 &&
    Number.isFinite(p.hiddenRequestsPerMinute) &&
    p.hiddenRequestsPerMinute >= 0 &&
    p.hiddenRequestsPerMinute <= 1 &&
    Number.isFinite(p.duplicateInFlightRequests) &&
    p.duplicateInFlightRequests === 0 &&
    Number.isFinite(p.queryRatePerMinute) &&
    p.queryRatePerMinute >= 0 &&
    Number.isFinite(e.durationMs) &&
    e.durationMs >= EFFECTS_DURATION_MS &&
    Number.isFinite(e.categoriesVisited) &&
    e.categoriesVisited >= 9 &&
    Number.isFinite(e.searchIterations) &&
    e.searchIterations > 0 &&
    Number.isFinite(e.favoriteIterations) &&
    e.favoriteIterations > 0 &&
    Number.isFinite(e.uncaughtExceptions) &&
    e.uncaughtExceptions === 0 &&
    Number.isFinite(e.navigationFailures) &&
    e.navigationFailures === 0 &&
    Number.isFinite(e.maxMountedPreviews) &&
    e.maxMountedPreviews <= 12 &&
    Number.isFinite(e.maxPlayingPreviews) &&
    e.maxPlayingPreviews <= 6 &&
    Number.isFinite(e.heapGrowthPercent) &&
    e.heapGrowthPercent >= 0 &&
    e.heapGrowthPercent <= 20 &&
    Number.isFinite(t.operations) &&
    t.operations >= 100 &&
    Array.isArray(t.countSequence) &&
    t.countSequence.length === 4 &&
    t.countSequence.every((count, index) => count === [2, 4, 3, 4][index]) &&
    t.uniqueIds === true &&
    Number.isFinite(t.orphanReferences) &&
    t.orphanReferences === 0 &&
    t.canonicalModelEqualAfterReload === true &&
    Number.isFinite(d.measuredWallTimeMs) &&
    d.measuredWallTimeMs > 0 &&
    Number.isFinite(d.longTaskPercent) &&
    d.longTaskPercent >= 0 &&
    d.longTaskPercent < 5 &&
    Number.isFinite(d.initialEditorJsBytes) &&
    d.initialEditorJsBytes >= 0 &&
    d.initialEditorJsBytes <= 500_000,
  );
}

function writeArtifacts(output, metadata, metrics, details) {
  mkdirSync(output, { recursive: true });
  const names = ['polling.json', 'effects-soak.json', 'timeline-integrity.json', 'editor.json'];
  const blocks = [metrics.polling, metrics.effectsSoak, metrics.timelineIntegrity, metrics.editor];
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    const payload = {
      ...metadata,
      status: details.status,
      measured: details.measured,
      unmeasured: details.unmeasured,
      notes: details.notes,
      metrics: blocks[i],
    };
    writeFileSync(join(output, name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function endpointKey(request) {
  try {
    const url = new URL(request.url());
    return `${request.method()} ${url.origin}${url.pathname}`;
  } catch {
    return `${request.method()} ${request.url()}`;
  }
}

function requestIsPollable(request) {
  return request.resourceType() === 'xhr' || request.resourceType() === 'fetch';
}

async function loadPlaywright() {
  try {
    return await import('@playwright/test');
  } catch (error) {
    throw new Error(
      `Playwright is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function probeTimeline(page, unmeasured) {
  try {
    const result = await page.evaluate(async () => {
      const probe = window.__JOY_RELEASE_TIMELINE_PROBE__;
      if (typeof probe !== 'function') return null;
      return await probe();
    });
    if (result === null) {
      unmeasured.push('timeline probe hook __JOY_RELEASE_TIMELINE_PROBE__ is not installed');
      return failedMetrics().timelineIntegrity;
    }
    if (!result || typeof result !== 'object')
      throw new Error('timeline probe returned a non-object');
    const value = result;
    const countSequence = Array.isArray(value.countSequence) ? value.countSequence : null;
    const operations = Number.isFinite(value.operations) ? value.operations : null;
    const uniqueIds = typeof value.uniqueIds === 'boolean' ? value.uniqueIds : null;
    const orphanReferences = Number.isFinite(value.orphanReferences)
      ? value.orphanReferences
      : null;
    const canonicalModelEqualAfterReload =
      typeof value.canonicalModelEqualAfterReload === 'boolean'
        ? value.canonicalModelEqualAfterReload
        : null;
    if (
      operations === null ||
      countSequence === null ||
      uniqueIds === null ||
      orphanReferences === null ||
      canonicalModelEqualAfterReload === null
    )
      unmeasured.push('timeline probe omitted one or more required invariants');
    return {
      artifactPath: 'test-output/release-performance/timeline-integrity.json',
      operations,
      countSequence,
      uniqueIds,
      orphanReferences,
      canonicalModelEqualAfterReload,
    };
  } catch (error) {
    unmeasured.push(
      `timeline probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return failedMetrics().timelineIntegrity;
  }
}

async function runBrowser(url, options, metrics, unmeasured, notes) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info'] });
  const context = await browser.newContext({ reducedMotion: 'no-preference' });
  const page = await context.newPage();
  let hiddenPage = null;
  const startedAt = Date.now();
  const pollStartedAt = { value: 0 };
  const endpointCounts = new Map();
  const hiddenEndpointCounts = new Map();
  const inflight = new Set();
  const hiddenInflight = new Set();
  const requestKeys = new WeakMap();
  const hiddenRequestKeys = new WeakMap();
  let duplicateInFlightRequests = 0;
  let uncaughtExceptions = 0;
  let navigationFailures = 0;
  let maxMountedPreviews = null;
  let maxPlayingPreviews = null;
  const heapSamples = [];
  let queryCount = 0;
  let pollResponses = 0;
  let queryHeaderResponses = 0;
  let hiddenStartedAt = 0;
  let hiddenVisibilityObserved = false;
  let initialEditorJsBytes = null;
  let longTaskDurations = null;

  await page.addInitScript(() => {
    window.__JOY_RELEASE_OBSERVER__ = true;
    window.__JOY_RELEASE_LONG_TASKS__ = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          window.__JOY_RELEASE_LONG_TASKS__.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      window.__JOY_RELEASE_LONG_TASKS_UNAVAILABLE__ = true;
    }
  });
  if (options.token !== undefined) {
    await page.addInitScript((token) => {
      window.localStorage.setItem('joy-media-session-token', token);
    }, options.token);
  } else {
    unmeasured.push(
      'authenticated observer token is missing; set JOY_MEDIA_RELEASE_OBSERVER_TOKEN in the isolated staging environment',
    );
  }
  page.on('pageerror', () => {
    uncaughtExceptions += 1;
  });
  page.on('console', (message) => {
    if (message.type() === 'error') uncaughtExceptions += 1;
  });
  page.on('requestfailed', (request) => {
    if (request.isNavigationRequest()) navigationFailures += 1;
  });
  page.on('request', (request) => {
    if (!requestIsPollable(request)) return;
    if (pollStartedAt.value <= 0) return;
    const key = endpointKey(request);
    requestKeys.set(request, key);
    if (inflight.has(key)) duplicateInFlightRequests += 1;
    inflight.add(key);
    endpointCounts.set(key, (endpointCounts.get(key) ?? 0) + 1);
  });
  const clearRequest = (request) => {
    const key = requestKeys.get(request);
    if (key !== undefined) inflight.delete(key);
  };
  page.on('requestfinished', clearRequest);
  page.on('requestfailed', clearRequest);
  page.on('response', (response) => {
    if (!requestKeys.has(response.request())) return;
    pollResponses += 1;
    const header = response.headers()['x-joy-db-query-count'];
    if (header !== undefined && /^\d+$/u.test(header)) {
      queryHeaderResponses += 1;
      queryCount += Number(header);
    }
  });

  const attachHiddenTelemetry = (target) => {
    target.on('pageerror', () => {
      uncaughtExceptions += 1;
    });
    target.on('console', (message) => {
      if (message.type() === 'error') uncaughtExceptions += 1;
    });
    target.on('requestfailed', (request) => {
      if (request.isNavigationRequest()) navigationFailures += 1;
      const key = hiddenRequestKeys.get(request);
      if (key !== undefined) hiddenInflight.delete(key);
    });
    target.on('request', (request) => {
      if (!requestIsPollable(request) || hiddenStartedAt <= 0) return;
      const key = endpointKey(request);
      hiddenRequestKeys.set(request, key);
      if (hiddenInflight.has(key)) duplicateInFlightRequests += 1;
      hiddenInflight.add(key);
      hiddenEndpointCounts.set(key, (hiddenEndpointCounts.get(key) ?? 0) + 1);
    });
    target.on('requestfinished', (request) => {
      const key = hiddenRequestKeys.get(request);
      if (key !== undefined) hiddenInflight.delete(key);
    });
    target.on('response', (response) => {
      if (!hiddenRequestKeys.has(response.request())) return;
      pollResponses += 1;
      const header = response.headers()['x-joy-db-query-count'];
      if (header !== undefined && /^\d+$/u.test(header)) {
        queryHeaderResponses += 1;
        queryCount += Number(header);
      }
    });
  };

  // Never let an accidentally embedded CDN or production asset turn this
  // local-only observer into live access. Loopback origins (including a
  // separate local API port) are allowed; every other origin is blocked.
  await context.route('**/*', async (route) => {
    try {
      if (isLoopbackUrl(route.request().url())) await route.continue();
      else await route.abort('blockedbyclient');
    } catch {
      await route.abort('blockedbyclient');
    }
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // The editor route intentionally opens at the project library. Enter a
    // disposable local project before collecting editor/effects/timeline
    // evidence; observing the library shell would otherwise produce a clean
    // but meaningless zero-control sample.
    const projectCard = page.locator('button.project-library-card').first();
    if (await projectCard.count()) {
      await projectCard.click({ timeout: 10_000 });
      await page.locator('[aria-label="Enhance"]').first().click({ timeout: 10_000 });
      await page.locator('.feature-hub--enhance').waitFor({ state: 'visible', timeout: 10_000 });
    }
    // Search is a compact toggle by design; open it before resolving the
    // input hook so the soak can exercise search terms without guessing a
    // panel-specific DOM shape.
    const searchToggle = page.getByRole('button', { name: 'Search Effects', exact: true });
    if (await searchToggle.count()) await searchToggle.click({ timeout: 5_000 });
    const resources = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .filter((entry) => entry.name.includes('.js'))
        .reduce((sum, entry) => sum + (entry.transferSize || entry.encodedBodySize || 0), 0),
    );
    initialEditorJsBytes = Number.isFinite(resources) ? resources : null;
    hiddenPage = await context.newPage();
    attachHiddenTelemetry(hiddenPage);
    await hiddenPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.bringToFront();
    hiddenVisibilityObserved =
      (await hiddenPage.evaluate(() => document.visibilityState)) === 'hidden';
    if (!hiddenVisibilityObserved)
      unmeasured.push('second local tab did not report document.visibilityState=hidden');
    await page.waitForTimeout(options.warmupMs);
    queryCount = 0;
    pollResponses = 0;
    queryHeaderResponses = 0;
    pollStartedAt.value = Date.now();
    hiddenStartedAt = hiddenVisibilityObserved ? pollStartedAt.value : 0;
    const soakStartedAt = Date.now();
    const longTaskBaselineDuration = await page.evaluate(() => {
      if (!Array.isArray(window.__JOY_RELEASE_LONG_TASKS__)) return null;
      return window.__JOY_RELEASE_LONG_TASKS__.reduce((sum, duration) => sum + duration, 0);
    });
    const sample = async () => {
      const value = await page.evaluate(() => {
        const mounted = document.querySelectorAll('[data-preview-mounted="true"]').length;
        const playing = document.querySelectorAll('[data-preview-playing="true"]').length;
        const memory = performance.memory?.usedJSHeapSize;
        return {
          mounted,
          playing,
          memory: Number.isFinite(memory) ? memory : null,
          longTasks: Array.isArray(window.__JOY_RELEASE_LONG_TASKS__)
            ? window.__JOY_RELEASE_LONG_TASKS__
            : null,
        };
      });
      maxMountedPreviews =
        maxMountedPreviews === null ? value.mounted : Math.max(maxMountedPreviews, value.mounted);
      maxPlayingPreviews =
        maxPlayingPreviews === null ? value.playing : Math.max(maxPlayingPreviews, value.playing);
      if (value.memory !== null)
        heapSamples.push({ at: Date.now() - soakStartedAt, bytes: value.memory });
      if (value.longTasks !== null) longTaskDurations = value.longTasks;
    };
    await sample();
    const interval = setInterval(() => {
      void sample().catch(() => {
        navigationFailures += 1;
      });
    }, 1_000);
    const categoryLocator = page.locator(options.categorySelector);
    const categoryCount = await categoryLocator.count();
    let categoriesVisited = 0;
    let searchIterations = 0;
    let favoriteIterations = 0;
    for (let index = 0; index < categoryCount; index += 1) {
      try {
        await categoryLocator.nth(index).click({ timeout: 3_000 });
        categoriesVisited += 1;
      } catch {
        navigationFailures += 1;
      }
    }
    const search = page.locator(options.searchSelector);
    if (await search.count()) {
      for (const term of ['joy', 'video', 'effects']) {
        try {
          await search.first().fill(term);
          searchIterations += 1;
        } catch {
          navigationFailures += 1;
        }
      }
    }
    const favorites = page.locator(options.favoriteSelector);
    if (await favorites.count()) {
      for (let index = 0; index < Math.min(3, await favorites.count()); index += 1) {
        try {
          await favorites.nth(index).click({ timeout: 3_000 });
          favoriteIterations += 1;
        } catch {
          navigationFailures += 1;
        }
      }
    }
    // Continue a bounded rotation during the soak instead of treating one
    // setup click as a 30-minute category/search/favorites measurement.
    let actionStep = 0;
    let actionBusy = false;
    const rotate = async () => {
      if (actionBusy) return;
      actionBusy = true;
      try {
        if (categoryCount > 0) {
          try {
            await categoryLocator.nth(actionStep % categoryCount).click({ timeout: 3_000 });
            categoriesVisited += 1;
          } catch {
            navigationFailures += 1;
          }
        }
        if (await search.count()) {
          try {
            await search.first().fill(['joy', 'video', 'effects'][actionStep % 3]);
            searchIterations += 1;
          } catch {
            navigationFailures += 1;
          }
        }
        if (await favorites.count()) {
          try {
            await favorites.nth(actionStep % (await favorites.count())).click({ timeout: 3_000 });
            favoriteIterations += 1;
          } catch {
            navigationFailures += 1;
          }
        }
        actionStep += 1;
      } finally {
        actionBusy = false;
      }
    };
    const actionInterval = setInterval(() => {
      void rotate().catch(() => {
        navigationFailures += 1;
      });
    }, 10_000);
    await page.waitForTimeout(options.durationMs);
    clearInterval(interval);
    clearInterval(actionInterval);
    await sample();
    const pollingDurationMs = Date.now() - pollStartedAt.value;
    const endpointRates = [...endpointCounts.values()].map(
      (count) => count / (pollingDurationMs / 60_000),
    );
    const visibleRequestsPerMinute = endpointRates.length ? Math.max(...endpointRates) : 0;
    const hiddenDurationMs = hiddenStartedAt > 0 ? Date.now() - hiddenStartedAt : 0;
    const hiddenEndpointRates = [...hiddenEndpointCounts.values()].map(
      (count) => count / (hiddenDurationMs / 60_000),
    );
    const hiddenRequestsPerMinute =
      hiddenVisibilityObserved && hiddenDurationMs >= 10_000
        ? hiddenEndpointRates.length
          ? Math.max(...hiddenEndpointRates)
          : 0
        : null;
    const baseline = heapSamples
      .filter((item) => item.at >= 0 && item.at < 5 * 60_000)
      .map((item) => item.bytes);
    const plateau = median(baseline);
    const peak = heapSamples.length ? Math.max(...heapSamples.map((item) => item.bytes)) : null;
    const heapGrowthPercent = plateau && peak !== null ? ((peak - plateau) / plateau) * 100 : null;
    const longTaskTotalDuration = Array.isArray(longTaskDurations)
      ? longTaskDurations.reduce((sum, item) => sum + item, 0)
      : null;
    const longTaskPercent =
      longTaskTotalDuration !== null && longTaskBaselineDuration !== null && options.durationMs > 0
        ? (Math.max(0, longTaskTotalDuration - longTaskBaselineDuration) / options.durationMs) * 100
        : null;
    if (maxMountedPreviews === 0) unmeasured.push('preview mount hook observed zero nodes');
    if (maxMountedPreviews === null || maxPlayingPreviews === null)
      unmeasured.push('preview mount/play metrics unavailable');
    if (heapGrowthPercent === null)
      unmeasured.push('performance.memory unavailable; heap budget not measured');
    if (longTaskPercent === null)
      unmeasured.push('Long Tasks API unavailable; editor responsiveness not measured');
    if (categoryCount === 0) unmeasured.push('category hook selector matched no controls');
    if (!(await search.count())) unmeasured.push('search hook selector matched no control');
    if (!(await favorites.count())) unmeasured.push('favorite hook selector matched no controls');
    // Hidden-tab and query-header measurements are release-contract metrics;
    // an uninstrumented run must remain failed instead of becoming a pass.
    if (hiddenRequestsPerMinute === null)
      unmeasured.push(
        'hidden-tab polling requires a second local tab reporting visibilityState=hidden for at least 10s',
      );
    const queryRatePerMinute =
      pollResponses > 0 && queryHeaderResponses === pollResponses
        ? queryCount / (pollingDurationMs / 60_000)
        : null;
    if (queryRatePerMinute === null)
      unmeasured.push(
        'PostgreSQL query rate requires x-joy-db-query-count on every measured local response',
      );
    metrics.polling = {
      artifactPath: 'test-output/release-performance/polling.json',
      warmupMs: options.warmupMs,
      durationMs: pollingDurationMs,
      visibleRequestsPerMinute,
      hiddenRequestsPerMinute,
      duplicateInFlightRequests,
      queryRatePerMinute,
    };
    metrics.effectsSoak = {
      artifactPath: 'test-output/release-performance/effects-soak.json',
      durationMs: Date.now() - soakStartedAt,
      categoriesVisited,
      searchIterations,
      favoriteIterations,
      uncaughtExceptions,
      navigationFailures,
      maxMountedPreviews,
      maxPlayingPreviews,
      heapGrowthPercent,
    };
    metrics.timelineIntegrity = await probeTimeline(page, unmeasured);
    metrics.editor = {
      artifactPath: 'test-output/release-performance/editor.json',
      measuredWallTimeMs: Date.now() - startedAt,
      longTaskPercent,
      initialEditorJsBytes,
    };
    notes.push(
      'browser metrics were collected from a loopback Playwright page; no live host was contacted',
    );
  } catch (error) {
    navigationFailures += 1;
    unmeasured.push(
      `local browser run failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    notes.push('browser run failed closed; partial values are not promoted to passing metrics');
  } finally {
    if (hiddenPage !== null) await hiddenPage.close().catch(() => undefined);
    await browser.close();
  }
}

export async function observe({
  // This module lives at tooling/release; two parents reach the repository
  // root (release -> tooling -> joy-media).
  root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..'),
  ...options
}) {
  const runId = `release-observer-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`;
  const generatedAt = new Date().toISOString();
  const provenance = sourceProvenance(root);
  const metadata = baseMetadata(runId, generatedAt, options.phase ?? 'staging', provenance);
  const metrics = failedMetrics();
  const unmeasured = [];
  const notes = [];
  let status = 'failed';
  let measured = false;
  const output = resolve(root, options.output ?? DEFAULT_OUTPUT);

  try {
    if (metadata.phase !== 'staging' && metadata.phase !== 'production')
      throw new Error('phase must be staging or production');
    // Validate the target before any repository or dependency work so an
    // unsafe URL is rejected deterministically and cannot trigger Playwright.
    if (options.url !== undefined && !isLoopbackUrl(options.url))
      throw new Error(
        'refusing non-loopback URL; live/public hosts are outside this observer scope',
      );
    if (!provenance.commitSha || !provenance.treeHash || !provenance.lockfileSha256)
      throw new Error('source provenance is incomplete');
    if (!provenance.worktreeClean)
      throw new Error('source worktree is dirty; observer refuses to produce release evidence');
    if (options.url === undefined) {
      unmeasured.push('no --url supplied; Playwright/browser behavior was not measured');
      notes.push('run against an explicitly local staging URL to collect browser evidence');
    } else if (!Number.isFinite(options.warmupMs) || options.warmupMs < POLLING_WARMUP_MS) {
      throw new Error(`warm-up must be at least ${POLLING_WARMUP_MS}ms`);
    } else if (
      !Number.isFinite(options.durationMs) ||
      options.durationMs < 0 ||
      options.durationMs > MAX_EFFECTS_DURATION_MS
    ) {
      throw new Error(`duration must be between 0 and ${MAX_EFFECTS_DURATION_MS}ms`);
    } else {
      measured = true;
      await runBrowser(
        options.url,
        {
          ...options,
          token:
            typeof process.env.JOY_MEDIA_RELEASE_OBSERVER_TOKEN === 'string' &&
            process.env.JOY_MEDIA_RELEASE_OBSERVER_TOKEN.trim().length > 0
              ? process.env.JOY_MEDIA_RELEASE_OBSERVER_TOKEN.trim()
              : undefined,
        },
        metrics,
        unmeasured,
        notes,
      );
    }
    status =
      measured && unmeasured.length === 0 && hasPassingMetrics(metrics) ? 'passed' : 'failed';
    writeArtifacts(output, metadata, metrics, { status, measured, unmeasured, notes });
  } catch (error) {
    unmeasured.push(error instanceof Error ? error.message : String(error));
    notes.push(
      'observer refused the run or could not measure it; artifacts are intentionally failed',
    );
    writeArtifacts(output, metadata, metrics, {
      status: 'failed',
      measured: false,
      unmeasured,
      notes,
    });
  }
  return { runId, output, status, measured, unmeasured, metrics };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    const result = await observe(options);
    console.log(
      JSON.stringify(
        {
          runId: result.runId,
          output: relative(process.cwd(), result.output),
          status: result.status,
          measured: result.measured,
          unmeasured: result.unmeasured,
        },
        null,
        2,
      ),
    );
    process.exit(result.status === 'passed' ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(2);
  }
}
