/** The environment variable that overrides the pinned key outside a packaged app, for development and tests. */
export const RELEASE_KEY_OVERRIDE_ENV = 'JOY_MEDIA_RELEASE_SIGNING_PUBLIC_KEY';

/**
 * Public keys that verify release manifests, compiled into every build (L1, decision D2). The private halves are
 * kept offline by the owner. They never reach this repository, CI, receipts or gbrain.
 *
 * The list stays empty until the owner's key ceremony adds the key. While it is empty, every update check and
 * every `update verify` refuses with `release-key-unconfigured`: the code fails closed rather than trust a key it
 * does not have. Rotation: a new key is added here, and a manifest signed by the old key announces it.
 */
export const PINNED_RELEASE_PUBLIC_KEYS_PEM: readonly string[] = [];

/**
 * The keys a build trusts. A packaged app trusts only the pinned keys. Outside a packaged app, a non-blank override
 * replaces them, so that tests and development builds can sign with a test key without a rebuild.
 */
export function resolveReleaseKeys(options: {
  readonly isPackaged: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}): readonly string[] {
  const override = options.env[RELEASE_KEY_OVERRIDE_ENV];
  if (!options.isPackaged && override !== undefined && override.trim() !== '') return [override];
  return PINNED_RELEASE_PUBLIC_KEYS_PEM;
}
