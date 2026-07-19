/** A recoverable visual contract for compile/runtime/missing-package failures. */

import type { SceneDiagnostic } from './diagnostics.js';

export interface SceneDiagnosticPlaceholder {
  readonly kind: 'scene-placeholder';
  readonly title: string;
  readonly message: string;
  readonly diagnostics: readonly SceneDiagnostic[];
}

export function createSceneDiagnosticPlaceholder(
  diagnostics: readonly SceneDiagnostic[],
  title = 'Scene unavailable',
): SceneDiagnosticPlaceholder {
  const first = diagnostics[0];
  return {
    kind: 'scene-placeholder',
    title,
    message: first === undefined ? 'Scene could not be loaded.' : first.message,
    diagnostics: [...diagnostics],
  };
}
