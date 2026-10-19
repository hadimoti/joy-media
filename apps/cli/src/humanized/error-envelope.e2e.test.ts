/**
 * Every `--json` failure is one document with the same shape, whether the
 * mistake is in the command line (usage, exit 2) or in the operation (exit 1):
 * `{"type":"error","code":...,"message":...}`. An agent can branch on `code`
 * without knowing which command produced it. Real binary, no media needed.
 */
import { describe, expect, it } from 'vitest';
import { createSandbox, describeRun, type RunResult } from './harness.js';
import { createProject } from './project-helpers.js';

function errorDoc(r: RunResult): Record<string, unknown> {
  const lines = r.stdout.split('\n').filter((line) => line.trim().length > 0);
  expect(lines.length, describeRun(r)).toBeGreaterThan(0);
  const doc = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
  expect(doc['type'], describeRun(r)).toBe('error');
  expect(typeof doc['code'], describeRun(r)).toBe('string');
  expect(typeof doc['message'], describeRun(r)).toBe('string');
  expect(doc['error'], describeRun(r)).toBeUndefined();
  return doc;
}

describe('every --json failure has one envelope', () => {
  it.each([
    ['project', 'list', '--json', '--nope'],
    ['timeline', 'add-clip', '--bogus', '--json'],
    ['render', '--json', '--bogus-flag'],
    ['worker', 'status', '--json', '--nope'],
  ])('a usage mistake in `%s` is exit 2 with the common envelope', async (...args) => {
    const sb = createSandbox('error-envelope-usage');
    try {
      const r = await sb.run([...args]);
      expect(r.code, describeRun(r)).toBe(2);
      expect(errorDoc(r)['code']).toBe('usage_error');
    } finally {
      sb.cleanup();
    }
  });

  it('a runtime failure carries the same type, code and message keys', async () => {
    const sb = createSandbox('error-envelope-runtime');
    try {
      const id = await createProject(sb, 'Envelope');
      const r = await sb.run([
        'timeline',
        'split',
        '--project',
        id,
        '--clip',
        'clip-none',
        '--at',
        '1',
        '--json',
      ]);
      expect(r.code, describeRun(r)).toBe(1);
      expect(Object.keys(errorDoc(r)).sort()).toEqual(['code', 'message', 'type']);
    } finally {
      sb.cleanup();
    }
  });

  it('the help for the project database does not name the wrong default path', async () => {
    const sb = createSandbox('error-envelope-help');
    try {
      const r = await sb.run(['project', '--help']);
      expect(r.code, describeRun(r)).toBe(0);
      expect(r.out).not.toMatch(/~\/\.joy-media\/joy-media\.sqlite3/);
      expect(r.out).toMatch(/doctor/);
    } finally {
      sb.cleanup();
    }
  });
});
