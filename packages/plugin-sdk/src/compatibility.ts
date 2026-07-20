import { PLUGIN_API_VERSION } from './api.js';

export interface PluginCompatibilityTarget {
  readonly pluginId: string;
  /** Supported v1 range, e.g. `>=1.0.0 <2.0.0`. */
  readonly joyApi: string;
}

export interface CompatibilityResult {
  readonly compatible: boolean;
  readonly hostVersion: string;
  readonly pluginRange: string;
  readonly reason?: string;
}

interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * Evaluates the deliberately small, documented range grammar used by v1
 * manifests: exact versions and space-separated >= / > / <= / < comparators.
 */
export function checkPluginCompatibility(
  target: PluginCompatibilityTarget,
  hostVersion: string = PLUGIN_API_VERSION,
): CompatibilityResult {
  const host = parseVersion(hostVersion);
  if (host === undefined) {
    return incompatible(hostVersion, target.joyApi, 'host API version is invalid');
  }
  const comparators = target.joyApi.trim().split(/\s+/).filter(Boolean);
  if (comparators.length === 0)
    return incompatible(hostVersion, target.joyApi, 'JOY API range is empty');
  for (const comparator of comparators) {
    const parsed = parseComparator(comparator);
    if (parsed === undefined) {
      return incompatible(
        hostVersion,
        target.joyApi,
        `unsupported JOY API comparator "${comparator}"`,
      );
    }
    if (!satisfies(host, parsed)) {
      return incompatible(
        hostVersion,
        target.joyApi,
        `host API ${hostVersion} does not satisfy ${comparator}`,
      );
    }
  }
  return { compatible: true, hostVersion, pluginRange: target.joyApi };
}

function incompatible(
  hostVersion: string,
  pluginRange: string,
  reason: string,
): CompatibilityResult {
  return { compatible: false, hostVersion, pluginRange, reason };
}

function parseVersion(value: string): Semver | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function parseComparator(
  value: string,
): { readonly operator: string; readonly version: Semver } | undefined {
  const match = /^(>=|>|<=|<|=)?(.+)$/.exec(value);
  if (match === null) return undefined;
  const version = parseVersion(match[2]!);
  if (version === undefined) return undefined;
  return { operator: match[1] ?? '=', version };
}

function satisfies(
  actual: Semver,
  comparator: { readonly operator: string; readonly version: Semver },
): boolean {
  const compared = compare(actual, comparator.version);
  switch (comparator.operator) {
    case '>':
      return compared > 0;
    case '>=':
      return compared >= 0;
    case '<':
      return compared < 0;
    case '<=':
      return compared <= 0;
    case '=':
      return compared === 0;
    default:
      return false;
  }
}

function compare(left: Semver, right: Semver): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}
