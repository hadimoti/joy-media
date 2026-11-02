export interface WorkspaceManifest {
  readonly name?: string;
  readonly main?: string;
  readonly exports?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

export interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  readonly manifest: WorkspaceManifest;
}

export function readWorkspacePackages(repoRoot: string): Promise<Map<string, WorkspacePackage>>;
export function workspaceDependencyNames(manifest: WorkspaceManifest): string[];
export function workspaceRuntimeClosure(
  rootManifests: readonly WorkspaceManifest[],
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
): WorkspacePackage[];
export function packageEntryPoints(manifest: WorkspaceManifest): string[];
export function missingEntryPoints(
  manifest: WorkspaceManifest,
  stagedDir: string,
  fileExists?: (path: string) => boolean,
): string[];
export function workspaceImportSpecifiers(sourceText: string): string[];
export function unresolvedWorkspaceImports(
  specifiers: readonly string[],
  stagedPackages: readonly WorkspacePackage[],
): string[];
