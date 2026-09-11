/**
 * P3 export download + terminal-error observer.
 *
 * Arms BEFORE the click so a fast export that fires synchronously with the
 * click cannot be missed. Settles exactly once on the first terminal event
 * (download, page close, timeout) and exposes a `settle()` the caller MUST
 * invoke on every code path (success, click failure, cancellation) so
 * listeners and timers are always disposed.
 *
 * Designed to be unit-tested with a stub emitter (see
 * tests/e2e/helpers/p3-export-observer.test.mjs). The harness code in
 * r2-p3-shipping-export-acceptance.spec.ts passes the real `page.on` /
 * `page.off` pair as `subscribe` / `unsubscribe` — Playwright pages emit
 * events on a node EventEmitter so the same shape works.
 */

export const EXPORT_OBSERVER_KINDS = Object.freeze([
  'download',
  'page-closed',
  'timeout',
  'click-error',
]);

/**
 * Minimal event-emitter contract used by the observer. The Playwright
 * `Page` exposes `on(event, handler)` / `off(event, handler)` matching this
 * shape, so we can unit-test with a plain node EventEmitter.
 *
 * @typedef {{
 *   on: (event: string, handler: (...args: any[]) => void) => void,
 *   off: (event: string, handler: (...args: any[]) => void) => void,
 * }} ObserverEmitter
 */

const DEFAULT_ERROR_EVENTS = Object.freeze(['pageerror', 'console']);

/**
 * Arm download + terminal-error observers. The returned `settle()` is
 * idempotent; calling it more than once is a no-op so the test can put it
 * in a finally block without double-disposing.
 *
 * @param {ObserverEmitter} emitter — Playwright `page` or a stub.
 * @param {number} timeoutMs — wall-clock budget. Use 0 to disable.
 * @param {{
 *   downloadEvent?: string,
 *   closeEvent?: string,
 *   errorEvents?: readonly string[],
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} [opts]
 */
export function armExportObserver(emitter, timeoutMs, opts = {}) {
  const downloadEvent = opts.downloadEvent ?? 'download';
  const closeEvent = opts.closeEvent ?? 'close';
  const errorEvents = opts.errorEvents ?? DEFAULT_ERROR_EVENTS;
  const setTimeoutFn = opts.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn ?? globalThis.clearTimeout;

  let settled = false;
  let firstError = null;
  let resolveOuter;
  const promise = new Promise((resolve) => {
    resolveOuter = resolve;
  });

  const onDownload = (download) => settle({ kind: 'download', download });
  const onClose = () => settle({ kind: 'page-closed' });

  const onError = (eventName) => (payload) => {
    if (firstError !== null) return;
    if (eventName === 'console') {
      const msg = payload;
      const type = typeof msg?.type === 'function' ? msg.type() : msg?.type;
      const text = typeof msg?.text === 'function' ? msg.text() : msg?.text;
      if (type !== 'error') return;
      firstError = `console.error: ${String(text ?? '')}`;
    } else if (eventName === 'pageerror') {
      const err = payload;
      firstError = `pageerror: ${err?.message ?? String(err)}`;
    } else {
      firstError = `${eventName}: ${String(payload)}`;
    }
  };

  const errorHandlers = errorEvents.map((eventName) => {
    const handler = onError(eventName);
    emitter.on(eventName, handler);
    return { eventName, handler };
  });

  emitter.on(downloadEvent, onDownload);
  emitter.on(closeEvent, onClose);

  let timer;
  if (timeoutMs > 0) {
    timer = setTimeoutFn(() => settle({ kind: 'timeout' }), timeoutMs);
  }

  function settle(observation) {
    if (settled) return;
    settled = true;
    if (timer !== undefined) {
      clearTimeoutFn(timer);
      timer = undefined;
    }
    emitter.off(downloadEvent, onDownload);
    emitter.off(closeEvent, onClose);
    for (const { eventName, handler } of errorHandlers) {
      emitter.off(eventName, handler);
    }
    if (observation.kind === 'timeout') {
      resolveOuter({ kind: 'timeout', firstError });
    } else {
      resolveOuter(observation);
    }
  }

  return {
    promise,
    settle,
    isSettled: () => settled,
  };
}
