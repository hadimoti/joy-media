import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// v1.1.0 is local-only (ADR-0043; PLAN-v4 §4a, §11 P1). The editor's production source must not
// reach any remote JOY service: no JOY host, no remote API base, no remote /v1/ route, and no
// remote origin. Local channels (desktop.media.*) are the only transport.

const here = path.dirname(fileURLToPath(import.meta.url));

const FORBIDDEN: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'joyst.ir host', pattern: /joyst\.ir/i },
  { name: 'joyteam.ir host', pattern: /joyteam\.ir/i },
  { name: 'remote API base', pattern: /DEFAULT_JOY_REMOTE_API_BASE|getRemoteApiBaseUrl/ },
  { name: 'remote /v1/ route', pattern: /['"`]\/v1\// },
  { name: 'remote auth helper', pattern: /getStoredMediaToken|probeJoySession|media-session/ },
];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

describe('the editor has no remote endpoints (v1.1.0 local-only)', () => {
  const files = sourceFiles(here);

  it('scans the editor source', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const rule of FORBIDDEN) {
    it(`no editor file contains a ${rule.name}`, () => {
      const hits = files.filter((file) => rule.pattern.test(fs.readFileSync(file, 'utf8')));
      expect(hits.map((file) => path.relative(here, file))).toEqual([]);
    });
  }
});
