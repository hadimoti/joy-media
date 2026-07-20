/** Verification, update approval, tier gate, and safe-mode policy (§24.5, §29.7). */

import { createHash, verify } from 'node:crypto';
import { executionTierFor, validatePluginManifest } from './manifest.js';
import type {
  PluginEntrypoint,
  PluginExecutionTier,
  PluginManifestV1,
  PluginPermission,
} from './manifest.js';

export interface PluginPackageSignatureV1 {
  readonly algorithm: 'ed25519';
  readonly keyId: string;
  readonly packageSha256: string;
  readonly signatureBase64: string;
}

export interface PluginPackageV1 {
  readonly manifest: unknown;
  /** Every package-relative file except signature.json, as original bytes. */
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly signature: PluginPackageSignatureV1;
}

export interface PluginTrustStore {
  readonly keys: Readonly<Record<string, string>>;
}

export interface PluginVerificationResult {
  readonly verified: boolean;
  readonly manifest?: PluginManifestV1;
  readonly packageSha256: string;
  readonly issues: readonly string[];
}

export interface PluginPermissionDiff {
  readonly added: readonly PluginPermission[];
  readonly removed: readonly PluginPermission[];
  /** Any added permission requires an explicit update approval. */
  readonly requiresApproval: boolean;
}

export interface PluginExecutionPolicy {
  readonly safeMode: boolean;
  /** Server plugins are never enabled by default. */
  readonly allowServerPlugins?: boolean;
  readonly approvedPermissions: ReadonlySet<PluginPermission>;
}

export interface PluginExecutionDecision {
  readonly allowed: boolean;
  readonly tier: PluginExecutionTier;
  readonly reason?:
    'safe-mode' | 'server-plugin-disabled' | 'permission-unapproved' | 'entrypoint-missing';
}

/** Canonical content hash: sorted package paths, delimiters, and original bytes. */
export function hashPluginPackage(files: Readonly<Record<string, Uint8Array>>): string {
  const digest = createHash('sha256');
  for (const path of Object.keys(files).sort()) {
    if (!isPackageFilePath(path)) throw new RangeError(`invalid plugin package path "${path}"`);
    digest.update(path, 'utf8');
    digest.update('\0', 'utf8');
    digest.update(files[path]!);
    digest.update('\0', 'utf8');
  }
  return digest.digest('hex');
}

/** Validates manifest, immutable hash, and trusted Ed25519 package signature. */
export function verifyPluginPackage(
  pluginPackage: PluginPackageV1,
  trustStore: PluginTrustStore,
): PluginVerificationResult {
  const validated = validatePluginManifest(pluginPackage.manifest);
  const issues = validated.issues.map((entry) => `${entry.code}: ${entry.message}`);
  let packageSha256 = '';
  try {
    packageSha256 = hashPluginPackage(pluginPackage.files);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  if (packageSha256 !== pluginPackage.signature.packageSha256)
    issues.push('plugin/package-hash-mismatch');
  const publicKey = trustStore.keys[pluginPackage.signature.keyId];
  if (publicKey === undefined) issues.push('plugin/signature-key-untrusted');
  if (pluginPackage.signature.algorithm !== 'ed25519')
    issues.push('plugin/signature-algorithm-unsupported');
  if (
    publicKey !== undefined &&
    packageSha256.length > 0 &&
    pluginPackage.signature.algorithm === 'ed25519'
  ) {
    try {
      const signatureValid = verify(
        null,
        Buffer.from(packageSha256, 'utf8'),
        publicKey,
        Buffer.from(pluginPackage.signature.signatureBase64, 'base64'),
      );
      if (!signatureValid) issues.push('plugin/signature-invalid');
    } catch {
      issues.push('plugin/signature-invalid');
    }
  }
  return {
    verified: issues.length === 0,
    ...(validated.manifest === undefined ? {} : { manifest: validated.manifest }),
    packageSha256,
    issues,
  };
}

export function diffPluginPermissions(
  installed: Pick<PluginManifestV1, 'permissions'>,
  candidate: Pick<PluginManifestV1, 'permissions'>,
): PluginPermissionDiff {
  const previous = new Set(installed.permissions);
  const next = new Set(candidate.permissions);
  const added = [...next].filter((permission) => !previous.has(permission)).sort();
  const removed = [...previous].filter((permission) => !next.has(permission)).sort();
  return { added, removed, requiresApproval: added.length > 0 };
}

/** Blocks all third-party code in safe mode and enforces tier permissions. */
export function decidePluginExecution(
  manifest: PluginManifestV1,
  entrypoint: PluginEntrypoint,
  policy: PluginExecutionPolicy,
): PluginExecutionDecision {
  const tier = executionTierFor(manifest);
  if (manifest.entrypoints?.[entrypoint] === undefined)
    return { allowed: false, tier, reason: 'entrypoint-missing' };
  if (policy.safeMode) return { allowed: false, tier, reason: 'safe-mode' };
  if (tier === 'server-plugin' && policy.allowServerPlugins !== true) {
    return { allowed: false, tier, reason: 'server-plugin-disabled' };
  }
  const missing = manifest.permissions.some(
    (permission) => !policy.approvedPermissions.has(permission),
  );
  if (missing) return { allowed: false, tier, reason: 'permission-unapproved' };
  return { allowed: true, tier };
}

function isPackageFilePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}
