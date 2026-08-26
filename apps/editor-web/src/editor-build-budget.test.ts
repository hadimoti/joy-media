import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialEntryFiles, type EditorManifest } from './editor-build-budget.js';

describe('editor initial JS budget manifest traversal', () => {
  it('follows static imports but excludes dynamic panel imports', () => {
    const manifest: EditorManifest = {
      'index.html': {
        file: 'assets/entry.js',
        src: 'index.html',
        isEntry: true,
        imports: ['react.js'],
      },
      'react.js': { file: 'assets/react.js', imports: ['dock.js'] },
      'dock.js': { file: 'assets/dock.js' },
      'src/MotionPanel.tsx': { file: 'assets/motion.js', imports: ['react.js'] },
    };
    expect(initialEntryFiles(manifest)).toEqual([
      'assets/entry.js',
      'assets/react.js',
      'assets/dock.js',
    ]);
  });

  it('keeps the full static editor closure below the 300 KiB gzip ceiling', () => {
    const manifestPath = resolve(import.meta.dirname, '../dist/.vite/manifest.json');
    // This test is the enforcement point for `check:budget`, which builds the
    // editor first. A missing manifest is a failed build/evidence condition,
    // never a reason to silently skip the budget gate.
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as EditorManifest;
    const files = initialEntryFiles(manifest);
    expect(files.length).toBeGreaterThan(0);
    // Include every eagerly requested resource. React and Dockview are
    // separately cached vendor entries, but are still part of initial JS.
    const staticClosureGzipBytes = files.reduce(
      (total, file) =>
        total + gzipSync(readFileSync(resolve(import.meta.dirname, '../dist', file))).length,
      0,
    );
    expect(staticClosureGzipBytes).toBeLessThanOrEqual(300 * 1024);
  });
});
