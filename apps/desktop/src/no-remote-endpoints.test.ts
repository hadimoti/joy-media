import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// v1.1.0 is local-only (ADR-0043; PLAN-v4 §4a). The desktop main process and its preload must
// not reference any remote endpoint: no JOY host, no remote API base, and no remote URL other
// than the loopback development origins.

const here = path.dirname(fileURLToPath(import.meta.url));

const FORBIDDEN: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'joyst.ir host', pattern: /joyst\.ir/i },
  { name: 'joyteam.ir host', pattern: /joyteam\.ir/i },
  { name: 'remote API base', pattern: /DEFAULT_JOY_REMOTE_API_BASE|getRemoteApiBaseUrl/ },
  { name: 'remote release route', pattern: /\/v1\/releases\b|\/v1\/account\b/ },
  {
    name: 'non-loopback http(s) URL',
    pattern: /https?:\/\/(?!localhost\b|127\.0\.0\.1\b)[a-z0-9.-]+\.[a-z]{2,}/i,
  },
];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|cjs|mjs)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

describe('desktop has no remote endpoints (v1.1.0 local-only)', () => {
  const files = sourceFiles(here);

  it('scans the desktop source', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const rule of FORBIDDEN) {
    it(`no file contains a ${rule.name}`, () => {
      const hits = files.filter((file) => rule.pattern.test(fs.readFileSync(file, 'utf8')));
      expect(hits.map((file) => path.relative(here, file))).toEqual([]);
    });
  }
});
