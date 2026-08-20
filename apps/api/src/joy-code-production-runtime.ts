import { createJoyCodeSecretResolver } from './joy-code-secret-resolver.js';
import { createJoyCodeRuntimeFactory } from './joy-code-runtime-factory.js';
import { DEFAULT_JOY_CODE_RUNTIME, type JoyCodeRuntime } from './joy-code-runtime.js';
import { parseJoyCodeRuntimeConfig } from './joy-code-runtime-config.js';
import { createOpenRouterSystemdCredentialSource, type ReadCredentialFile } from './openrouter-systemd-credential-source.js';
import { OpenRouterHttpPostTransport, type FetchImplementation } from './openrouter-http-transport.js';

export type JoyCodeRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

/** Compose the guarded Joy Code runtime from explicit startup inputs only. */
export function createProductionJoyCodeRuntime(
  environment: JoyCodeRuntimeEnvironment,
  readCredential: ReadCredentialFile,
  fetchImplementation: FetchImplementation,
): JoyCodeRuntime {
  const config = {
    JOY_MEDIA_JOY_CODE_RUNTIME_MODE: environment.JOY_MEDIA_JOY_CODE_RUNTIME_MODE,
    JOY_MEDIA_JOY_CODE_RUNTIME_MODEL_ID: environment.JOY_MEDIA_JOY_CODE_RUNTIME_MODEL_ID,
    JOY_MEDIA_JOY_CODE_RUNTIME_TIMEOUT_MS: environment.JOY_MEDIA_JOY_CODE_RUNTIME_TIMEOUT_MS,
    JOY_MEDIA_JOY_CODE_RUNTIME_SPEND_LIMIT_USD_CENTS: environment.JOY_MEDIA_JOY_CODE_RUNTIME_SPEND_LIMIT_USD_CENTS,
    JOY_MEDIA_JOY_CODE_RUNTIME_SECRET_REF: environment.JOY_MEDIA_JOY_CODE_RUNTIME_SECRET_REF,
    JOY_MEDIA_JOY_CODE_RUNTIME_ALLOWED_FREE_MODEL_IDS: environment.JOY_MEDIA_JOY_CODE_RUNTIME_ALLOWED_FREE_MODEL_IDS,
  };
  const parsed = parseJoyCodeRuntimeConfig(config);
  if (parsed.mode === 'disabled') return DEFAULT_JOY_CODE_RUNTIME;
  const source = createOpenRouterSystemdCredentialSource(readCredential);
  const secretResolver = createJoyCodeSecretResolver(source);
  const transport = new OpenRouterHttpPostTransport(fetchImplementation);
  return createJoyCodeRuntimeFactory(parsed, { secretResolver, transport });
}
