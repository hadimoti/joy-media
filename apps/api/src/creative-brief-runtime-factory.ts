/**
 * Creative Brief Runtime Factory - WP-37 S4 Phase 7-A
 *
 * Pure factory for creating OpenRouter Creative Brief runtime instances.
 * Fails closed to DEFAULT_CREATIVE_BRIEF_RUNTIME on any invalid configuration
 * or missing dependencies.
 */

import type {
  CreativeBriefRuntime,
  CreativeBriefRuntimeContext,
} from './creative-brief-runtime.js';
import { DEFAULT_CREATIVE_BRIEF_RUNTIME } from './creative-brief-runtime.js';
import type { CreativeBriefRuntimeConfig, OpenRouterConfig } from './creative-brief-runtime-config.js';
import {
  CREATIVE_BRIEF_MODEL_ID,
  CREATIVE_BRIEF_FREE_MODEL_IDS,
  CREATIVE_BRIEF_SECRET_REFERENCE,
  isDisabledConfig,
  isOpenRouterConfig,
} from './creative-brief-runtime-config.js';
import type {
  AsyncCreativeBriefOptions,
  AsyncCreativeBriefOutcome,
  AsyncAdapterOptions,
  AuditEventSink,
  AsyncCreativeModelAdapter,
  CreativeBriefInputV1,
} from '@joy-media/agent-tools';
import { createAsyncCreativeBrief } from '@joy-media/agent-tools';
import type { SecretResolver, HttpPostTransport, Clock } from '@joy-media/adapter-openrouter';
import { createOpenRouterCreativeAdapter } from '@joy-media/adapter-openrouter';

/**
 * Optional redacted audit sink for runtime events.
 * Receives only non-sensitive metadata.
 */
export type RedactedAuditSink = AuditEventSink;

/**
 * Runtime factory options for creating a creative brief runtime.
 */
export interface CreativeBriefRuntimeFactoryOptions {
  /** Injected secret resolver for resolving opaque secret references. */
  readonly secretResolver?: SecretResolver;
  /** Injected HTTP POST transport for making requests. */
  readonly transport?: HttpPostTransport;
  /** Optional redacted audit sink for runtime events. */
  readonly auditSink?: RedactedAuditSink;
  /** Optional clock for deterministic testing. */
  readonly clock?: Clock;
}

/**
 * Create an OpenRouter creative brief adapter from parsed config and injected dependencies.
 *
 * Returns a fail-closed adapter that returns unavailable when:
 * - Config is disabled
 * - Config is not OpenRouter
 * - Required dependencies (secretResolver, transport) are missing
 * - Model is not in the allowlist
 * - Allowlist is empty or invalid
 *
 * @param config - Parsed creative brief runtime configuration
 * @param deps - Injected dependencies (secret resolver, transport, audit sink, clock)
 * @returns A CreativeBriefRuntime instance
 */
export function createCreativeBriefRuntimeFactory(
  config: CreativeBriefRuntimeConfig,
  deps: CreativeBriefRuntimeFactoryOptions,
): CreativeBriefRuntime {
  // Fail closed for disabled config
  if (isDisabledConfig(config)) {
    return DEFAULT_CREATIVE_BRIEF_RUNTIME;
  }

  // Only OpenRouter config is valid
  if (!isOpenRouterConfig(config)) {
    return DEFAULT_CREATIVE_BRIEF_RUNTIME;
  }

  // Fail closed if dependencies are missing
  if (deps.secretResolver === undefined || deps.transport === undefined) {
    return DEFAULT_CREATIVE_BRIEF_RUNTIME;
  }

  // Re-check the complete free-only policy at the composition boundary. This
  // protects callers that construct OpenRouterConfig objects without using
  // the environment parser.
  if (
    !CREATIVE_BRIEF_FREE_MODEL_IDS.some((id) => id === config.modelId) ||
    config.allowedFreeModelIds.length !== 1 ||
    config.allowedFreeModelIds[0] !== config.modelId ||
    config.secretRef !== CREATIVE_BRIEF_SECRET_REFERENCE ||
    config.spendLimitUsdCents !== 0 ||
    config.timeoutMs < 1000 ||
    config.timeoutMs > 60000
  ) {
    return DEFAULT_CREATIVE_BRIEF_RUNTIME;
  }

  // Create the OpenRouter adapter with injected dependencies
  // Build options object carefully for exactOptionalPropertyTypes
  const baseAdapterOptions = {
    modelId: config.modelId,
    timeoutMs: config.timeoutMs,
    spendLimitUsdCents: config.spendLimitUsdCents,
    secretRef: config.secretRef,
    secretResolver: deps.secretResolver,
    transport: deps.transport,
    allowedFreeModelIds: config.allowedFreeModelIds,
  };
  const adapterOptions = deps.clock !== undefined
    ? { ...baseAdapterOptions, clock: deps.clock }
    : baseAdapterOptions;
  const adapter: AsyncCreativeModelAdapter = createOpenRouterCreativeAdapter(adapterOptions);

  // Return a runtime that executes through createAsyncCreativeBrief
  return new OpenRouterCreativeBriefRuntime(adapter, config, deps.auditSink, deps.clock);
}

/**
 * OpenRouter-based Creative Brief Runtime.
 * Wraps the OpenRouter adapter and delegates execution to createAsyncCreativeBrief.
 */
class OpenRouterCreativeBriefRuntime implements CreativeBriefRuntime {
  readonly #adapter: AsyncCreativeModelAdapter;
  readonly #config: OpenRouterConfig;
  readonly #auditSink: RedactedAuditSink | undefined;
  readonly #clock: Clock | undefined;

  constructor(
    adapter: AsyncCreativeModelAdapter,
    config: OpenRouterConfig,
    auditSink: RedactedAuditSink | undefined,
    clock: Clock | undefined,
  ) {
    this.#adapter = adapter;
    this.#config = config;
    this.#auditSink = auditSink;
    this.#clock = clock;
  }

  async execute(
    input: CreativeBriefInputV1,
    context: CreativeBriefRuntimeContext,
  ): Promise<AsyncCreativeBriefOutcome> {
    // Build adapter options from runtime context
    // Be careful with exactOptionalPropertyTypes - only include defined properties
    // Bound timeout to configured policy value
    // Use context timeout if it's smaller (more restrictive)
    const effectiveTimeoutMs =
      context.timeoutMs !== undefined && context.timeoutMs > 0
        ? Math.min(context.timeoutMs, this.#config.timeoutMs)
        : this.#config.timeoutMs;

    // Bound spend to configured policy value. Zero is intentional: it means
    // free-only mode. Negative context values are clamped to zero so callers
    // can never expand the configured budget.
    const effectiveSpendLimitUsdCents =
      context.spendLimitUsdCents === undefined
        ? this.#config.spendLimitUsdCents
        : Math.min(this.#config.spendLimitUsdCents, Math.max(0, context.spendLimitUsdCents));

    const asyncAdapterOptions: AsyncAdapterOptions = {
      correlationId: context.correlationId,
      timeoutMs: effectiveTimeoutMs,
      spendLimitUsdCents: effectiveSpendLimitUsdCents,
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
      ...(this.#auditSink !== undefined ? { auditSink: this.#auditSink } : {}),
    };

    // Convert Clock (now(): number) to creative brief clock (() => string) if provided
    // If not provided, createAsyncCreativeBrief will use its default
    // Only include clock in options if it's defined (for exactOptionalPropertyTypes)
    const clock = this.#clock;
    if (clock !== undefined) {
      const briefOptions: AsyncCreativeBriefOptions = {
        adapter: this.#adapter,
        adapterOptions: asyncAdapterOptions,
        clock: () => new Date(clock.now()).toISOString(),
      };
      return createAsyncCreativeBrief(input, briefOptions);
    }

    // Execute through createAsyncCreativeBrief with bounded options
    const briefOptions: AsyncCreativeBriefOptions = {
      adapter: this.#adapter,
      adapterOptions: asyncAdapterOptions,
    };
    return createAsyncCreativeBrief(input, briefOptions);
  }
}
