/** Developer-kit primitives: scaffold, local capability simulation, fixtures, snapshots (§24.8). */

import { createHash } from 'node:crypto';
import { decidePluginExecution } from './security.js';
import { validatePluginManifest } from './manifest.js';
import type {
  PluginEntrypoint,
  PluginExecutionPolicy,
  PluginManifestV1,
  PluginPermission,
} from './index.js';

export interface PluginScaffoldOptions {
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  readonly kind: 'panel' | 'caption-pack' | 'provider-adapter';
}

export interface PluginScaffold {
  readonly manifest: PluginManifestV1;
  readonly files: Readonly<Record<string, string>>;
}

export interface PermissionSimulation {
  readonly entrypoint: PluginEntrypoint;
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface PluginFixture {
  readonly name: string;
  readonly manifest: unknown;
  readonly policy: PluginExecutionPolicy;
  readonly expectedManifestValid: boolean;
  readonly expectedEntrypoints: readonly PermissionSimulation[];
}

/** Generates an inspectable, data-minimal package skeleton without I/O. */
export function createPluginScaffold(options: PluginScaffoldOptions): PluginScaffold {
  const base = {
    manifestVersion: 1 as const,
    id: options.id,
    name: options.name,
    version: '1.0.0',
    publisher: options.publisher,
    joyApi: '>=1.0.0 <2.0.0',
  };
  switch (options.kind) {
    case 'panel':
      return {
        manifest: {
          ...base,
          entrypoints: { ui: 'ui/index.js' },
          contributes: { panels: [options.id] },
          permissions: ['ui.panel'],
        },
        files: {
          'plugin.json': JSON.stringify(
            {
              ...base,
              entrypoints: { ui: 'ui/index.js' },
              contributes: { panels: [options.id] },
              permissions: ['ui.panel'],
            },
            null,
            2,
          ),
          'ui/index.js': 'export function mountPanel(api) { return api; }\n',
          README: '# JOY plugin panel\n',
        },
      };
    case 'caption-pack':
      return {
        manifest: { ...base, contributes: { captionPacks: [options.id] }, permissions: [] },
        files: {
          'plugin.json': JSON.stringify(
            { ...base, contributes: { captionPacks: [options.id] }, permissions: [] },
            null,
            2,
          ),
          'data/captions.json': '{}\n',
          README: '# JOY caption pack\n',
        },
      };
    case 'provider-adapter':
      return {
        manifest: {
          ...base,
          entrypoints: { worker: 'worker/index.js' },
          contributes: { providerAdapters: [options.id] },
          permissions: ['worker.compute'],
        },
        files: {
          'plugin.json': JSON.stringify(
            {
              ...base,
              entrypoints: { worker: 'worker/index.js' },
              contributes: { providerAdapters: [options.id] },
              permissions: ['worker.compute'],
            },
            null,
            2,
          ),
          'worker/index.js': 'export async function invoke(request) { return request; }\n',
          README: '# JOY provider adapter\n',
        },
      };
  }
}

/** Runs a fixture through manifest validation and every declared entrypoint gate. */
export function runPluginFixture(fixture: PluginFixture): {
  readonly passed: boolean;
  readonly failures: readonly string[];
} {
  const validated = validatePluginManifest(fixture.manifest);
  const failures: string[] = [];
  if ((validated.manifest !== undefined) !== fixture.expectedManifestValid)
    failures.push('manifest validity differs');
  if (validated.manifest !== undefined) {
    for (const expected of fixture.expectedEntrypoints) {
      const actual = decidePluginExecution(validated.manifest, expected.entrypoint, fixture.policy);
      if (actual.allowed !== expected.allowed || actual.reason !== expected.reason) {
        failures.push(`entrypoint ${expected.entrypoint} differs`);
      }
    }
  }
  return { passed: failures.length === 0, failures };
}

/** Simulates a permission grant set without executing any third-party code. */
export function simulatePluginPermissions(
  manifest: PluginManifestV1,
  approvedPermissions: Iterable<PluginPermission>,
  safeMode = false,
): readonly PermissionSimulation[] {
  const policy: PluginExecutionPolicy = {
    safeMode,
    approvedPermissions: new Set(approvedPermissions),
  };
  return (Object.keys(manifest.entrypoints ?? {}) as PluginEntrypoint[]).map((entrypoint) => {
    const decision = decidePluginExecution(manifest, entrypoint, policy);
    return {
      entrypoint,
      allowed: decision.allowed,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    };
  });
}

/** Stable JSON snapshot digest for data-only contributions and fixture outputs. */
export function pluginRenderSnapshot(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
