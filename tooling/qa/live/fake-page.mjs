/**
 * A recording fake of the Playwright page, for the unit tests of the step files (T-A07, T-A08).
 * The tests never launch the app: they run the real step code against this fake and a scripted app.
 *
 * Every call is recorded in `page.calls` as `<locator path>.<method>(<args>)`. A read (`isVisible`, `count`,
 * `innerText`, `getAttribute`, `evaluate`, ...) asks `answers` first: `answers({ path, method, args, fn })`
 * returns the value, or `undefined` to take the default. `evaluate(fn)` is answered by the function's name
 * (`fn.name`), so a step file names its page-side readers, and a test answers each one by name:
 * `answers: ({ method, fn }) => method === 'evaluate' && fn === 'readOpenMenu' ? {...} : undefined`.
 *
 * Defaults: visible, enabled, not checked, count 1, empty text, no attribute, a 100 x 30 box.
 */

const DEFAULTS = {
  isVisible: true,
  isEnabled: true,
  isDisabled: false,
  isChecked: false,
  count: 1,
  innerText: '',
  textContent: '',
  inputValue: '',
  getAttribute: null,
  boundingBox: { x: 10, y: 10, width: 100, height: 30 },
  evaluate: undefined,
  evaluateAll: [],
  waitFor: undefined,
};

function show(value) {
  if (value instanceof RegExp) return value.toString();
  if (typeof value === 'function') return `fn:${value.name || 'anonymous'}`;
  if (value === undefined) return 'undefined';
  if (value !== null && typeof value === 'object' && typeof value.path === 'string')
    return `locator:${value.path}`;
  // A regex nested in an option object (`{ hasText: /^File$/u }`) keeps its text, not `{}`.
  return JSON.stringify(value, (_key, inner) =>
    inner instanceof RegExp ? inner.toString() : inner,
  );
}

const args = (list) => list.map(show).join(',');

/**
 * A selector must be a string. A misspelled key of a selector table (`LEFT_SEL.textAddButon`) reads as undefined,
 * and a real page would reject it, so the fake throws here and the row body fails in the unit test.
 */
export function assertSelector(selector, method) {
  if (typeof selector !== 'string') {
    throw new TypeError(`${method} needs a string (selector or role), got ${show(selector)}`);
  }
}

export function createFakePage({
  answers = () => undefined,
  urlValue = 'app://joy/',
  titleValue = 'JOY Media',
} = {}) {
  const calls = [];

  function ask(path, method, argList, fn) {
    const entry = `${path}.${method}(${args(argList)})`;
    calls.push(entry);
    const answer = answers({ path, method, args: argList, fn, entry });
    if (answer !== undefined) return answer;
    return DEFAULTS[method];
  }

  function locatorAt(path) {
    const locator = { path };
    const reads = [
      'isVisible',
      'isEnabled',
      'isDisabled',
      'isChecked',
      'count',
      'innerText',
      'textContent',
      'inputValue',
      'getAttribute',
      'boundingBox',
      'waitFor',
    ];
    for (const method of reads) {
      locator[method] = async (...argList) => ask(path, method, argList);
    }
    for (const method of [
      'click',
      'dblclick',
      'hover',
      'fill',
      'press',
      'type',
      'check',
      'uncheck',
      'selectOption',
      'setInputFiles',
      'focus',
      'blur',
      'scrollIntoViewIfNeeded',
      'dragTo',
      'screenshot',
    ]) {
      locator[method] = async (...argList) => {
        ask(path, method, argList);
      };
    }
    locator.evaluate = async (fn, arg) =>
      ask(path, 'evaluate', arg === undefined ? [] : [arg], fn.name);
    locator.evaluateAll = async (fn, arg) =>
      ask(path, 'evaluateAll', arg === undefined ? [] : [arg], fn.name);
    locator.first = () => locatorAt(`${path}.first()`);
    locator.last = () => locatorAt(`${path}.last()`);
    locator.nth = (index) => locatorAt(`${path}.nth(${index})`);
    locator.filter = (options) => locatorAt(`${path}.filter(${args([options])})`);
    locator.locator = (selector, options) => {
      assertSelector(selector, `${path}.locator`);
      return locatorAt(
        `${path}.locator(${args(options === undefined ? [selector] : [selector, options])})`,
      );
    };
    locator.getByRole = (role, options) =>
      locatorAt(`${path}.getByRole(${args(options === undefined ? [role] : [role, options])})`);
    locator.getByText = (text, options) =>
      locatorAt(`${path}.getByText(${args(options === undefined ? [text] : [text, options])})`);
    locator.getByLabel = (text, options) =>
      locatorAt(`${path}.getByLabel(${args(options === undefined ? [text] : [text, options])})`);
    locator.getByPlaceholder = (text, options) =>
      locatorAt(
        `${path}.getByPlaceholder(${args(options === undefined ? [text] : [text, options])})`,
      );
    locator.all = async () => {
      const total = Number(ask(path, 'count', []));
      return Array.from({ length: total }, (_, index) => locatorAt(`${path}.nth(${index})`));
    };
    return locator;
  }

  const root = locatorAt('page');
  const page = {
    calls,
    locator: (selector, options) => {
      assertSelector(selector, 'page.locator');
      return locatorAt(
        `locator(${args(options === undefined ? [selector] : [selector, options])})`,
      );
    },
    getByRole: (role, options) => {
      assertSelector(role, 'page.getByRole');
      return locatorAt(`getByRole(${args(options === undefined ? [role] : [role, options])})`);
    },
    getByText: (text, options) =>
      locatorAt(`getByText(${args(options === undefined ? [text] : [text, options])})`),
    getByLabel: (text, options) =>
      locatorAt(`getByLabel(${args(options === undefined ? [text] : [text, options])})`),
    getByPlaceholder: (text, options) =>
      locatorAt(`getByPlaceholder(${args(options === undefined ? [text] : [text, options])})`),
    keyboard: {
      press: async (key) => void ask('keyboard', 'press', [key]),
      down: async (key) => void ask('keyboard', 'down', [key]),
      up: async (key) => void ask('keyboard', 'up', [key]),
      type: async (text) => void ask('keyboard', 'type', [text]),
    },
    mouse: {
      move: async (x, y) => void ask('mouse', 'move', [x, y]),
      click: async (x, y) => void ask('mouse', 'click', [x, y]),
      wheel: async (x, y) => void ask('mouse', 'wheel', [x, y]),
    },
    evaluate: async (fn, arg) => ask('page', 'evaluate', arg === undefined ? [] : [arg], fn.name),
    waitForFunction: async (fn, arg) => {
      const answer = ask('page', 'waitForFunction', arg === undefined ? [] : [arg], fn.name);
      return answer === undefined ? true : answer;
    },
    waitForEvent: async (name) => ask('page', 'waitForEvent', [name]),
    waitForTimeout: async (ms) => void ask('page', 'waitForTimeout', [ms]),
    screenshot: async (options) => void ask('page', 'screenshot', [options]),
    reload: async () => void ask('page', 'reload', []),
    url: () => urlValue,
    title: async () => titleValue,
    context: () => ({
      newCDPSession: async () => ({ send: async () => undefined, detach: async () => undefined }),
    }),
    root,
  };
  return page;
}

/** True when some recorded call contains the text. */
export function called(page, text) {
  return page.calls.some((entry) => entry.includes(text));
}
