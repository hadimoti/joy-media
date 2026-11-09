// Type declarations for scenario-rules.mjs, so the TypeScript tests can import it.

export function realPathOf(path: string): string;
export function samePath(a: string, b: string): boolean;
export function isInside(child: string, parent: string): boolean;
export function unexpectedRunArtifacts(outDir: string): string[];
export function findOnPath(fileName: string, pathValue?: string): string | undefined;
export function systemTool(...parts: string[]): string;
export function linkOnPath(path: string): boolean;
export function linkInside(folder: string): string | undefined;
export function runFolderProblem(folder: string): string | undefined;
export const FRESH_PROCESS_OPTION_NAMES: readonly string[];
export const RUN_OPTION_NAMES: readonly string[];
export function parseRunArgs(
  argv: readonly string[],
  scenarios: readonly string[],
): Record<string, string | boolean>;
export function ownerLibraryRefusal(approved: number | undefined, actual: number): string | null;
export function countFiles(directory: string): number;
export function folderSignature(folder: string): string;
/** The report itself when nothing changed; otherwise a copy with the verdict failed, the changes added as blockers, and no receipt. */
export function reportWithChanges<T extends object>(report: T, changed: readonly string[]): T;
export function reportWithFolderChanges<T extends object>(
  report: T,
  watched: readonly { readonly label: string; readonly before: string; readonly after: string }[],
): T;
export function ownerDefaultLibrary(home: string): string;
export function approvedOwnerFilesOf(
  options: Readonly<Record<string, string | boolean>>,
): number | undefined;
