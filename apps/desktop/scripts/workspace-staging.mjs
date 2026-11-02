import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Which workspace packages the staged app needs at runtime.
 *
 * The packaged app has no bundler and no `pnpm install`, so every `@joy-media/*` package that the
 * desktop main process or the Worker imports must be copied into `node_modules` by hand. A fixed
 * list drifts: provider-oauth was added to the desktop and never to the list, and the packaged app
 * then failed at startup with ERR_MODULE_NOT_FOUND. The list is therefore derived from the
 * manifests: the `workspace:` entries in `dependencies` (never `devDependencies`) of the staged
 * apps, and of each package they pull in, transitively.
 */

const WORKSPACE_SPECIFIER_PREFIX = 'workspace:';

/** The folders that pnpm-workspace.yaml lists, one level deep. */
const WORKSPACE_GROUP_DIRS = ['apps', 'packages', 'tooling'];

/** Reads every workspace package manifest, keyed by package name. */
export async function readWorkspacePackages(repoRoot) {
  const packagesByName = new Map();
  for (const group of WORKSPACE_GROUP_DIRS) {
    const groupDir = resolve(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    const entries = await readdir(groupDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = resolve(groupDir, entry.name);
      const manifestPath = resolve(dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (typeof manifest.name === 'string') {
        packagesByName.set(manifest.name, { name: manifest.name, dir, manifest });
      }
    }
  }
  return packagesByName;
}

/** The names of the `workspace:` packages that a manifest lists under `dependencies`. */
export function workspaceDependencyNames(manifest) {
  return Object.entries(manifest.dependencies ?? {})
    .filter(([, specifier]) => String(specifier).startsWith(WORKSPACE_SPECIFIER_PREFIX))
    .map(([name]) => name);
}

/**
 * The workspace packages needed by the given app manifests, in name order. A dependency that no
 * workspace package provides is an error, not something to skip.
 */
export function workspaceRuntimeClosure(rootManifests, packagesByName) {
  const staged = new Map();
  const pending = rootManifests.flatMap((manifest) =>
    workspaceDependencyNames(manifest).map((name) => ({ name, requiredBy: manifest.name })),
  );
  while (pending.length > 0) {
    const { name, requiredBy } = pending.shift();
    if (staged.has(name)) continue;
    const workspacePackage = packagesByName.get(name);
    if (workspacePackage === undefined) {
      throw new Error(
        `${requiredBy} depends on ${name} (${WORKSPACE_SPECIFIER_PREFIX}), but no workspace package has that name`,
      );
    }
    staged.set(name, workspacePackage);
    for (const dependency of workspaceDependencyNames(workspacePackage.manifest)) {
      pending.push({ name: dependency, requiredBy: name });
    }
  }
  return [...staged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The files a package's `main` and `exports` point at, relative to the package folder. Patterns
 * with `*` are skipped because they name no single file.
 */
export function packageEntryPoints(manifest) {
  const targets = new Set();
  if (typeof manifest.main === 'string') targets.add(manifest.main);
  const visit = (value) => {
    if (typeof value === 'string') targets.add(value);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(manifest.exports);
  return [...targets]
    .filter((target) => target.startsWith('./') && !target.includes('*'))
    .map((target) => target.slice(2))
    .sort();
}

/** The entry points of a staged package that are missing from its staged folder. */
export function missingEntryPoints(manifest, stagedDir, fileExists = existsSync) {
  return packageEntryPoints(manifest).filter((target) => !fileExists(resolve(stagedDir, target)));
}

/**
 * The `@joy-media/*` specifiers that a piece of JavaScript imports, with their subpath
 * (`@joy-media/provider-oauth/chatgpt.js`): static, dynamic and CommonJS forms.
 */
export function workspaceImportSpecifiers(sourceText) {
  const found = new Set();
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"](@joy-media\/[a-z0-9-]+(?:\/[^'"]*)?)['"]/g;
  for (const match of sourceText.matchAll(pattern)) found.add(match[1]);
  return [...found].sort();
}

function exportsCoverSubpath(exportsField, subpath) {
  if (exportsField === null || typeof exportsField !== 'object') return false;
  return Object.keys(exportsField).some((key) => {
    if (key === subpath) return true;
    const star = key.indexOf('*');
    return (
      star !== -1 && subpath.startsWith(key.slice(0, star)) && subpath.endsWith(key.slice(star + 1))
    );
  });
}

/**
 * The specifiers that the staged packages cannot serve: the package was not staged, or the
 * subpath is not one of its `exports`. A staged app that imports one fails at startup with
 * ERR_MODULE_NOT_FOUND, wherever the folder is run from.
 */
export function unresolvedWorkspaceImports(specifiers, stagedPackages) {
  const stagedByName = new Map(stagedPackages.map((entry) => [entry.name, entry]));
  return specifiers.filter((specifier) => {
    const [scope, name, ...subpathParts] = specifier.split('/');
    const staged = stagedByName.get(`${scope}/${name}`);
    if (staged === undefined) return true;
    if (subpathParts.length === 0) return false;
    return !exportsCoverSubpath(staged.manifest.exports, `./${subpathParts.join('/')}`);
  });
}
