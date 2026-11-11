import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * The desktop app's view of the project-store package. The package exports one front door, so a deep import into its files
 * is refused, and the front door exports only the worker runner at run time. The types it exports are checked by the
 * typecheck, through project-store-boundary.fixture.ts.
 */
describe('the desktop app and the project-store package', () => {
  it('refuses a deep import into the package files', () => {
    const require = createRequire(import.meta.url);
    let code: unknown;
    try {
      require.resolve('@joy-media/project-store/dist/project-folder.js');
    } catch (error) {
      code = (error as { readonly code?: unknown }).code;
    }
    expect(code).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });

  it('exports only the worker runner at run time', async () => {
    const front = await import('@joy-media/project-store');
    expect(Object.keys(front).sort()).toEqual(['runProjectFolderWorker']);
  });
});
