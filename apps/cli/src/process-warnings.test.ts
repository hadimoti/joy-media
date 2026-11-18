import { describe, expect, it } from 'vitest';
import { isSqliteExperimentalWarning } from './process-warnings.js';

function warning(name: string, message: string): Error {
  const result = new Error(message);
  result.name = name;
  return result;
}

describe('isSqliteExperimentalWarning', () => {
  it.each([
    'SQLite is an experimental feature and might change at any time',
    'node:sqlite is an experimental feature and might change at any time',
  ])('recognizes SQLite experimental warning wording: %s', (message) => {
    expect(isSqliteExperimentalWarning(warning('ExperimentalWarning', message))).toBe(true);
  });

  it('leaves other experimental warnings visible', () => {
    expect(
      isSqliteExperimentalWarning(warning('ExperimentalWarning', 'Canary is experimental')),
    ).toBe(false);
  });

  it('does not suppress SQLite warnings of another type', () => {
    expect(
      isSqliteExperimentalWarning(warning('DeprecationWarning', 'node:sqlite is deprecated')),
    ).toBe(false);
  });
});
