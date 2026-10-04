import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHILD_GUARD_RELATIVE_PATH = join('tooling', 'testing', 'live-provider-guard-child.mjs');

export function resolveChildGuardPath(
  importMetaUrl: string,
  cwd = process.cwd(),
): string | undefined {
  try {
    const moduleUrl = new URL(importMetaUrl);
    if (moduleUrl.protocol === 'file:') {
      const siblingPath = fileURLToPath(new URL('./live-provider-guard-child.mjs', moduleUrl));
      if (existsSync(siblingPath)) return siblingPath;
    }
  } catch {
    // Some Vitest environments use non-file or synthetic module URLs.
  }

  let directory = resolve(cwd);
  while (true) {
    const candidate = join(directory, CHILD_GUARD_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
