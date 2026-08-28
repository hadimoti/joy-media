import type { CreativeBriefRuntime } from './creative-brief-runtime.js';
import { DEFAULT_CREATIVE_BRIEF_RUNTIME } from './creative-brief-runtime.js';
import {
  isDisabledConfig,
  parseCreativeBriefRuntimeConfig,
} from './creative-brief-runtime-config.js';
import {
  createCreativeBriefSecretResolver,
  type SecretSource,
} from './creative-brief-secret-resolver.js';
import {
  OpenRouterHttpPostTransport,
  type FetchImplementation,
} from './openrouter-http-transport.js';
import {
  createSystemdCredentialSecretSource,
  type ReadCredentialFile,
} from './systemd-credential-secret-source.js';
import { createCreativeBriefRuntimeFactory } from './creative-brief-runtime-factory.js';

/**
 * Compose the guarded production runtime from explicit non-secret inputs.
 *
 * This helper never reads process.env itself. The server bootstrap must build
 * the small runtime environment map explicitly, then pass the startup-only
 * credential reader and fetch implementation here.
 */
export function createProductionCreativeBriefRuntime(
  runtimeEnvironment: Readonly<Record<string, string | undefined>>,
  readCredential: ReadCredentialFile,
  fetchImplementation: FetchImplementation,
): CreativeBriefRuntime {
  const config = parseCreativeBriefRuntimeConfig(runtimeEnvironment);
  if (isDisabledConfig(config)) return DEFAULT_CREATIVE_BRIEF_RUNTIME;

  const secretSource: SecretSource = createSystemdCredentialSecretSource(readCredential);
  const secretResolver = createCreativeBriefSecretResolver(secretSource);
  const transport = new OpenRouterHttpPostTransport(fetchImplementation);
  return createCreativeBriefRuntimeFactory(config, { secretResolver, transport });
}
