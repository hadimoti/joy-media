import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** The variable that opens the synthetic control port. A file that names it reaches the port. */
export const CONTROL_TOKEN_NAME = 'JOY_MEDIA_E2E_CONTROL_TOKEN';

// Relative module specifiers: static imports and re-exports, dynamic imports, and side-effect imports.
const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/gu;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|mts|mjs|js)$/u.test(entry.name) ? [path] : [];
  });
}

// TypeScript and ESM specifiers name the emitted extension (`./x.js` for `x.ts`), so try both forms.
function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/u, '.ts'),
    base.replace(/\.js$/u, '.mjs'),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mjs`,
    `${base}.js`,
    join(base, 'index.ts'),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/**
 * Names of the spec files in `directory` that reach the control port: a spec reaches it by naming the token,
 * or by importing `helperFile`, or by importing any file that does, however deep the chain.
 */
export function specsReachingControlPort(directory: string, helperFile: string): string[] {
  const reaches = (file: string, visited: Set<string>): boolean => {
    if (file === helperFile) return true;
    if (visited.has(file)) return false;
    visited.add(file);
    const text = readFileSync(file, 'utf8');
    if (text.includes(CONTROL_TOKEN_NAME)) return true;
    for (const match of text.matchAll(RELATIVE_SPECIFIER)) {
      const next = resolveSpecifier(file, match[1]!);
      if (next !== undefined && reaches(next, visited)) return true;
    }
    return false;
  };
  return sourceFiles(directory)
    .filter((file) => file.endsWith('.spec.ts'))
    .filter((spec) => reaches(spec, new Set()))
    .map((spec) => basename(spec))
    .sort();
}
