/**
 * Creative Brief Runtime Composition - WP-37 S4
 *
 * Composes the injected configuration parser and runtime factory without
 * reading process.env or resolving secrets. The default remains unavailable
 * whenever parsing or dependency composition fails closed.
 */

import type { CreativeBriefRuntime } from './creative-brief-runtime.js';
import type { CreativeBriefRuntimeFactoryOptions } from './creative-brief-runtime-factory.js';
import { createCreativeBriefRuntimeFactory } from './creative-brief-runtime-factory.js';
import { parseCreativeBriefRuntimeConfig } from './creative-brief-runtime-config.js';

export interface CreativeBriefRuntimeCompositionOptions extends CreativeBriefRuntimeFactoryOptions {
  /** Explicit environment map; this function never reads process.env. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Compose a Creative Brief runtime from an explicit environment map and
 * injected dependencies. Any disabled or incomplete configuration is handled
 * by the fail-closed runtime factory.
 */
export function composeCreativeBriefRuntime(
  options: CreativeBriefRuntimeCompositionOptions,
): CreativeBriefRuntime {
  const { env, ...dependencies } = options;
  const config = parseCreativeBriefRuntimeConfig(env);
  return createCreativeBriefRuntimeFactory(config, dependencies);
}
