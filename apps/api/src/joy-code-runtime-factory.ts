import {
  createOpenRouterJoyCodeAdapter,
  JOY_CODE_MODEL_ID,
  JOY_CODE_SECRET_REF,
} from '@joy-media/adapter-openrouter';
import type { HttpPostTransport, SecretResolver } from '@joy-media/adapter-openrouter';
import type { JoyCodeRuntime, JoyCodeRuntimeDeps } from './joy-code-runtime.js';
import { ConfiguredJoyCodeRuntime, DEFAULT_JOY_CODE_RUNTIME } from './joy-code-runtime.js';
import type { JoyCodeRuntimeConfig } from './joy-code-runtime-config.js';
import { isJoyCodeRuntimeEnabled, JOY_CODE_CONSENT_VERSION } from './joy-code-runtime-config.js';

export function createJoyCodeRuntimeFactory(
  config: JoyCodeRuntimeConfig,
  deps: { readonly secretResolver?: SecretResolver; readonly transport?: HttpPostTransport },
): JoyCodeRuntime {
  if (
    !isJoyCodeRuntimeEnabled(config) ||
    deps.secretResolver === undefined ||
    deps.transport === undefined
  )
    return DEFAULT_JOY_CODE_RUNTIME;
  if (
    config.modelId !== JOY_CODE_MODEL_ID ||
    config.secretRef !== JOY_CODE_SECRET_REF ||
    config.spendLimitUsdCents !== 0 ||
    config.allowedFreeModelIds.length !== 1 ||
    config.allowedFreeModelIds[0] !== JOY_CODE_MODEL_ID
  )
    return DEFAULT_JOY_CODE_RUNTIME;
  const validationOptions = {
    textTemplateIds: ['clean-title', 'hero-title'],
    captionTemplateIds: ['joy-clean', 'joy-karaoke-pop', 'joy-rtl-classic'],
    transitionIds: ['dissolve', 'wipe', 'slide'],
    allowedModelIds: [JOY_CODE_MODEL_ID],
    consentVersion: JOY_CODE_CONSENT_VERSION,
  } as const;
  const adapter = createOpenRouterJoyCodeAdapter({
    modelId: config.modelId,
    timeoutMs: config.timeoutMs,
    spendLimitUsdCents: 0,
    secretRef: config.secretRef,
    secretResolver: deps.secretResolver,
    transport: deps.transport,
    validationOptions,
  });
  const runtimeDeps: JoyCodeRuntimeDeps = {
    adapter,
    validationOptions,
    modelId: config.modelId,
    consentVersion: JOY_CODE_CONSENT_VERSION,
  };
  return new ConfiguredJoyCodeRuntime(runtimeDeps);
}
