/**
 * Creative Brief Secret Resolver Boundary - WP-37 S4-F10-E1
 *
 * Server-side opaque secret-reference resolver boundary for OpenRouter creative brief.
 * Provides a structurally compatible resolver that delegates to an injected secret source
 * only for the exact canonical reference.
 */

/**
 * Canonical opaque reference constant for OpenRouter Creative Brief API key.
 */
export const CREATIVE_BRIEF_SECRET_REFERENCE = 'joy-media/openrouter/creative-brief/v1' as const;

/**
 * Injected secret source interface.
 * Accepts an opaque reference and returns the resolved secret value or undefined.
 * Implementations must NOT access process.env, filesystem, or systemd directly.
 */
export interface SecretSource {
  /**
   * Get the secret value for the given reference.
   * @param reference - The opaque secret reference
   * @returns The secret value as a string, or undefined if not found/missing
   */
  getSecret(reference: string): string | undefined;
}

/**
 * Structurally compatible resolver shape for the OpenRouter adapter.
 * Uses the same method signature as the adapter's SecretResolver interface.
 */
export interface CreativeBriefSecretResolver {
  /**
   * Resolve a secret by its reference name.
   * @param ref - Opaque reference name
   * @returns The resolved secret value, or undefined if not found
   */
  resolve(ref: string): string | undefined;
}

/**
 * Create a creative brief secret resolver that delegates to an injected source.
 *
 * The resolver:
 * - Only delegates to the source for the exact canonical reference
 * - Returns undefined for unknown, empty, malformed, or wrong references without calling the source
 * - Never logs, serializes, caches, transforms, or includes the resolved secret in errors/messages
 * - Treats a missing source value as undefined (fail closed)
 * - Catches source errors and returns undefined (fail closed) without exposing error details
 *
 * @param source - Injected secret source (must NOT be process.env or filesystem access)
 * @returns A structurally compatible resolver for the OpenRouter adapter
 *
 * @example
 * ```ts
 * const source: SecretSource = {
 *   getSecret(ref: string): string | undefined {
 *     // Implementation that does NOT use process.env, filesystem, or systemd
 *     return mySecureStore.get(ref);
 *   },
 * };
 * const resolver = createCreativeBriefSecretResolver(source);
 * // Pass to OpenRouter adapter: { secretResolver: resolver, secretRef: CREATIVE_BRIEF_SECRET_REFERENCE }
 * ```
 */
export function createCreativeBriefSecretResolver(
  source: SecretSource,
): CreativeBriefSecretResolver {
  return {
    resolve(ref: string): string | undefined {
      // Only delegate for the exact canonical reference
      if (ref !== CREATIVE_BRIEF_SECRET_REFERENCE) {
        return undefined;
      }

      // Delegate to injected source for the canonical reference
      // Catch any errors and return undefined (fail closed) without exposing details
      try {
        return source.getSecret(ref);
      } catch {
        // Fail closed: source error means no secret available
        return undefined;
      }
    },
  };
}
