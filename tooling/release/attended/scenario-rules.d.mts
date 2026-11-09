// Type declarations for scenario-rules.mjs, so the TypeScript tests can import it.

export function realPathOf(path: string): string;
export function samePath(a: string, b: string): boolean;
export function isInside(child: string, parent: string): boolean;
export function finishedRunArtifacts(outDir: string): string[];
export const FRESH_PROCESS_OPTION_NAMES: readonly string[];
export const RUN_OPTION_NAMES: readonly string[];
export function parseRunArgs(
  argv: readonly string[],
  scenarios: readonly string[],
): Record<string, string | boolean>;
