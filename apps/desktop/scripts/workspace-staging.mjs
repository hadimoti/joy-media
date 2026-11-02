import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';

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

/**
 * Packages the staged app gets from its host rather than from node_modules: the Electron runtime
 * that the packaged app runs in provides `electron`.
 */
const PROVIDED_BY_RUNTIME = new Set(['electron']);

/**
 * The third-party packages a manifest needs at runtime: every `dependencies` entry that is not a
 * `workspace:` package. The Worker's `playwright-core` is one of them. Like the workspace list, this
 * is read from the manifests, because a fixed list drifts and ships an app that cannot start.
 */
export function thirdPartyDependencyNames(manifest) {
  return Object.entries(manifest.dependencies ?? {})
    .filter(
      ([name, specifier]) =>
        !String(specifier).startsWith(WORKSPACE_SPECIFIER_PREFIX) && !PROVIDED_BY_RUNTIME.has(name),
    )
    .map(([name]) => name);
}

/**
 * The third-party packages that the given owners need at runtime, transitively, in name order.
 * `locate(name, fromDir)` returns the installed copy as seen from `fromDir` as `{ dir, manifest }`,
 * or undefined. A package that cannot be located is an error, not something to skip.
 */
export function thirdPartyRuntimeClosure(owners, locate) {
  const staged = new Map();
  const pending = owners.flatMap((owner) =>
    thirdPartyDependencyNames(owner.manifest).map((name) => ({
      name,
      from: owner.dir,
      requiredBy: owner.name,
    })),
  );
  while (pending.length > 0) {
    const { name, from, requiredBy } = pending.shift();
    if (staged.has(name)) continue;
    const installed = locate(name, from);
    if (installed === undefined) {
      throw new Error(
        `${requiredBy} depends on ${name}, but no installed copy of it was found. ` +
          `Run 'pnpm install' before packaging.`,
      );
    }
    staged.set(name, { name, dir: installed.dir, manifest: installed.manifest });
    for (const dependency of thirdPartyDependencyNames(installed.manifest)) {
      pending.push({ name: dependency, from: installed.dir, requiredBy: name });
    }
  }
  return [...staged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Finds an installed package the way Node does: from `fromDir`, up through each folder's
 * node_modules. pnpm links packages into node_modules, so the real folder is returned. From there
 * the package's own dependencies are found too, because pnpm keeps them beside it in the store.
 */
export function locateInstalledPackage(name, fromDir) {
  let dir = resolve(fromDir);
  for (;;) {
    const link = resolve(dir, 'node_modules', ...name.split('/'));
    if (existsSync(resolve(link, 'package.json'))) {
      const real = realpathSync(link);
      const manifest = JSON.parse(readFileSync(resolve(real, 'package.json'), 'utf8'));
      return { dir: real, manifest };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The bare module specifiers (`playwright-core`, `node:fs`, `electron`) that a piece of JavaScript
 * imports, in the static, dynamic and CommonJS forms. Relative and absolute paths are not bare.
 */
export function bareImportSpecifiers(sourceText) {
  const found = new Set();
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const match of sourceText.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
    found.add(specifier);
  }
  return [...found].sort();
}

/** The package a module specifier belongs to: `@scope/name`, or the first segment otherwise. */
export function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * The bare specifiers that the staged folder cannot serve: their package is neither a Node
 * built-in, nor provided by the runtime, nor a workspace package (checked by
 * unresolvedWorkspaceImports), nor staged as a third-party package.
 */
export function unresolvedThirdPartyImports(specifiers, stagedNames) {
  const staged = new Set(stagedNames);
  const builtins = new Set(builtinModules);
  return specifiers.filter((specifier) => {
    if (specifier.startsWith('node:')) return false;
    const name = packageNameOf(specifier);
    if (builtins.has(name) || PROVIDED_BY_RUNTIME.has(name)) return false;
    if (name.startsWith('@joy-media/')) return false;
    return !staged.has(name);
  });
}
