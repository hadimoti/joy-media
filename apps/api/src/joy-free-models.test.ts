import { describe, expect, it } from 'vitest';
import {
  JOY_AGENT_FREE_MODELS,
  assertFreeCatalog,
  type JoyModelCatalogEntry,
} from './joy-free-models.js';

const entry = (id: string, extra: Partial<JoyModelCatalogEntry> = {}): JoyModelCatalogEntry => ({
  id,
  displayName: id,
  description: id,
  contextLength: 1000,
  vision: false,
  inputUsdPerMillion: 0,
  outputUsdPerMillion: 0,
  ...extra,
});

describe('assertFreeCatalog', () => {
  it('accepts the shipped catalog', () => {
    expect(() => assertFreeCatalog(JOY_AGENT_FREE_MODELS)).not.toThrow();
  });

  it('rejects an id without the :free suffix', () => {
    expect(() =>
      assertFreeCatalog([entry('a/one:free', { isDefault: true }), entry('a/two')]),
    ).toThrow(/a\/two is not an OpenRouter ":free" id/);
  });

  it('rejects a non-zero input or output price', () => {
    expect(() =>
      assertFreeCatalog([entry('a/one:free', { isDefault: true, inputUsdPerMillion: 0.1 })]),
    ).toThrow(/a\/one:free has a non-zero price/);
    expect(() =>
      assertFreeCatalog([entry('a/one:free', { isDefault: true, outputUsdPerMillion: 2 })]),
    ).toThrow(/non-zero price/);
  });

  it('rejects zero or several defaults', () => {
    expect(() => assertFreeCatalog([entry('a/one:free'), entry('a/two:free')])).toThrow(
      /exactly one default model, found 0/,
    );
    expect(() =>
      assertFreeCatalog([
        entry('a/one:free', { isDefault: true }),
        entry('a/two:free', { isDefault: true }),
      ]),
    ).toThrow(/exactly one default model, found 2/);
  });

  it('rejects duplicate ids and an empty catalog', () => {
    expect(() =>
      assertFreeCatalog([entry('a/one:free', { isDefault: true }), entry('a/one:free')]),
    ).toThrow(/a\/one:free is listed twice/);
    expect(() => assertFreeCatalog([])).toThrow(/no models/);
  });
});
