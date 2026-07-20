/** Plugin package manifest and granular permission model (§24.2–§24.5). */

import { checkPluginCompatibility } from './compatibility.js';
import type { CompatibilityResult } from './compatibility.js';

export const PLUGIN_ENTRYPOINTS = ['ui', 'render', 'worker', 'server'] as const;
export type PluginEntrypoint = (typeof PLUGIN_ENTRYPOINTS)[number];

export const PLUGIN_EXECUTION_TIERS = [
  'data-only',
  'ui-sandbox',
  'render-sandbox',
  'worker-sandbox',
  'server-plugin',
] as const;
export type PluginExecutionTier = (typeof PLUGIN_EXECUTION_TIERS)[number];

export type PluginPermission =
  | 'project.read.metadata'
  | 'project.read.selection'
  | 'project.read.transcript'
  | 'project.command.timeline'
  | 'project.command.caption'
  | 'project.command.effect'
  | 'asset.read.thumbnail'
  | 'asset.read.proxy'
  | 'asset.read.original'
  | 'asset.write.generated'
  | 'worker.compute'
  | 'ui.panel'
  | 'developer.full-access'
  | `network.connect:${string}`
  | `provider.invoke:${string}`
  | `worker.files:${string}`
  | `secrets.use:${string}`;

export interface PluginEntrypointMap {
  readonly ui?: string;
  readonly render?: string;
  readonly worker?: string;
  readonly server?: string;
}

export interface PluginContributionsV1 {
  readonly panels?: readonly string[];
  readonly captionPacks?: readonly string[];
  readonly providerAdapters?: readonly string[];
  readonly commands?: readonly string[];
  readonly workflowNodes?: readonly string[];
}

export interface PluginManifestV1 {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  readonly joyApi: string;
  readonly entrypoints?: PluginEntrypointMap;
  readonly contributes: PluginContributionsV1;
  readonly permissions: readonly PluginPermission[];
}

export interface PluginManifestIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface ValidatedPluginManifest {
  readonly manifest?: PluginManifestV1;
  readonly issues: readonly PluginManifestIssue[];
  readonly compatibility?: CompatibilityResult;
}

const PLUGIN_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Validates untrusted plugin.json without throwing. */
export function validatePluginManifest(value: unknown): ValidatedPluginManifest {
  const issues: PluginManifestIssue[] = [];
  if (!isRecord(value)) {
    return { issues: [issue('plugin/manifest-not-object', 'manifest must be an object', '$')] };
  }
  if (value.manifestVersion !== 1)
    issues.push(issue('plugin/manifest-version', 'manifestVersion must be 1', 'manifestVersion'));
  validateString(value.id, 'id', PLUGIN_ID, 'a reverse-DNS identifier', issues);
  validateString(value.name, 'name', undefined, 'a non-empty string', issues);
  validateString(value.version, 'version', SEMVER, 'a semver version', issues);
  validateString(value.publisher, 'publisher', undefined, 'a non-empty string', issues);
  validateString(value.joyApi, 'joyApi', undefined, 'a supported API range', issues);
  const entrypoints = validateEntrypoints(value.entrypoints, issues);
  const contributes = validateContributions(value.contributes, issues);
  const permissions = validatePermissions(value.permissions, issues);
  const compatibility =
    typeof value.id === 'string' && typeof value.joyApi === 'string'
      ? checkPluginCompatibility({ pluginId: value.id, joyApi: value.joyApi })
      : undefined;
  if (compatibility !== undefined && !compatibility.compatible) {
    issues.push(
      issue(
        'plugin/api-incompatible',
        compatibility.reason ?? 'plugin API is incompatible',
        'joyApi',
      ),
    );
  }
  if (entrypoints !== undefined && entrypoints !== null)
    validateTierPermissions(entrypoints, permissions, issues);
  if (issues.length > 0 || entrypoints === null || contributes === null || permissions === null) {
    return { issues, ...(compatibility === undefined ? {} : { compatibility }) };
  }
  return {
    manifest: {
      manifestVersion: 1,
      id: value.id as string,
      name: value.name as string,
      version: value.version as string,
      publisher: value.publisher as string,
      joyApi: value.joyApi as string,
      ...(entrypoints === undefined ? {} : { entrypoints }),
      contributes,
      permissions,
    },
    issues,
    ...(compatibility === undefined ? {} : { compatibility }),
  };
}

/** Determines the strongest isolation tier required by declared entrypoints. */
export function executionTierFor(
  manifest: Pick<PluginManifestV1, 'entrypoints'>,
): PluginExecutionTier {
  const entries = manifest.entrypoints;
  if (entries?.server !== undefined) return 'server-plugin';
  if (entries?.worker !== undefined) return 'worker-sandbox';
  if (entries?.render !== undefined) return 'render-sandbox';
  if (entries?.ui !== undefined) return 'ui-sandbox';
  return 'data-only';
}

export function isPluginPermission(value: unknown): value is PluginPermission {
  if (typeof value !== 'string') return false;
  return (
    [
      'project.read.metadata',
      'project.read.selection',
      'project.read.transcript',
      'project.command.timeline',
      'project.command.caption',
      'project.command.effect',
      'asset.read.thumbnail',
      'asset.read.proxy',
      'asset.read.original',
      'asset.write.generated',
      'worker.compute',
      'ui.panel',
      'developer.full-access',
    ].includes(value) ||
    /^network\.connect:https:\/\/[^/]+$/.test(value) ||
    /^(provider\.invoke|worker\.files|secrets\.use):[^\s:][^\s]*$/.test(value)
  );
}

function validateEntrypoints(
  value: unknown,
  issues: PluginManifestIssue[],
): PluginEntrypointMap | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push(
      issue('plugin/entrypoints-invalid', 'entrypoints must be an object', 'entrypoints'),
    );
    return null;
  }
  const result: { -readonly [K in keyof PluginEntrypointMap]?: string } = {};
  for (const key of PLUGIN_ENTRYPOINTS) {
    const entry = value[key];
    if (entry === undefined) continue;
    if (!isPackagePath(entry)) {
      issues.push(
        issue(
          'plugin/entrypoint-path',
          `${key} must be a package-relative .js path`,
          `entrypoints.${key}`,
        ),
      );
    } else result[key] = entry;
  }
  for (const key of Object.keys(value)) {
    if (!(PLUGIN_ENTRYPOINTS as readonly string[]).includes(key)) {
      issues.push(
        issue('plugin/entrypoint-unknown', `unknown entrypoint "${key}"`, `entrypoints.${key}`),
      );
    }
  }
  return result as PluginEntrypointMap;
}

function validateContributions(
  value: unknown,
  issues: PluginManifestIssue[],
): PluginContributionsV1 | null {
  if (!isRecord(value)) {
    issues.push(
      issue('plugin/contributes-invalid', 'contributes must be an object', 'contributes'),
    );
    return null;
  }
  const result: {
    -readonly [K in keyof PluginContributionsV1]?: readonly string[];
  } = {};
  for (const key of [
    'panels',
    'captionPacks',
    'providerAdapters',
    'commands',
    'workflowNodes',
  ] as const) {
    const contribution = value[key];
    if (contribution === undefined) continue;
    if (
      !Array.isArray(contribution) ||
      contribution.some((item) => typeof item !== 'string' || item.length === 0)
    ) {
      issues.push(
        issue(
          'plugin/contribution-invalid',
          `${key} must be an array of non-empty strings`,
          `contributes.${key}`,
        ),
      );
    } else result[key] = contribution;
  }
  for (const key of Object.keys(value)) {
    if (
      !['panels', 'captionPacks', 'providerAdapters', 'commands', 'workflowNodes'].includes(key)
    ) {
      issues.push(
        issue('plugin/contribution-unknown', `unknown contribution "${key}"`, `contributes.${key}`),
      );
    }
  }
  return result as PluginContributionsV1;
}

function validatePermissions(
  value: unknown,
  issues: PluginManifestIssue[],
): readonly PluginPermission[] | null {
  if (!Array.isArray(value)) {
    issues.push(issue('plugin/permissions-invalid', 'permissions must be an array', 'permissions'));
    return null;
  }
  const unique = new Set<PluginPermission>();
  for (const [index, permission] of value.entries()) {
    if (!isPluginPermission(permission)) {
      issues.push(
        issue(
          'plugin/permission-invalid',
          'permission is unknown or malformed',
          `permissions.${index}`,
        ),
      );
    } else if (unique.has(permission)) {
      issues.push(
        issue(
          'plugin/permission-duplicate',
          `duplicate permission "${permission}"`,
          `permissions.${index}`,
        ),
      );
    } else unique.add(permission);
  }
  return [...unique];
}

function validateTierPermissions(
  entrypoints: PluginEntrypointMap,
  permissions: readonly PluginPermission[] | null,
  issues: PluginManifestIssue[],
): void {
  if (permissions === null) return;
  const required: Partial<Record<PluginEntrypoint, PluginPermission>> = {
    ui: 'ui.panel',
    worker: 'worker.compute',
    server: 'developer.full-access',
  };
  for (const [entrypoint, permission] of Object.entries(required) as [
    PluginEntrypoint,
    PluginPermission,
  ][]) {
    if (entrypoints[entrypoint] !== undefined && !permissions.includes(permission)) {
      issues.push(
        issue(
          'plugin/tier-permission-missing',
          `${entrypoint} entrypoint requires ${permission}`,
          'permissions',
        ),
      );
    }
  }
}

function validateString(
  value: unknown,
  path: string,
  pattern: RegExp | undefined,
  expected: string,
  issues: PluginManifestIssue[],
): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    issues.push(issue('plugin/manifest-field', `${path} must be ${expected}`, path));
  }
}

function isPackagePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.endsWith('.js') &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

function issue(code: string, message: string, path: string): PluginManifestIssue {
  return { code, message, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
