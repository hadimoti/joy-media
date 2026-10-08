/**
 * The hosted JOY Agent's zero-cost model allow-list (Round FC, approved 8 Oct 2026).
 *
 * The gateway serves and forwards only these ids (plus paid ids explicitly listed in
 * JOY_GATEWAY_PAID_MODEL_ALLOWLIST, which stays unset in production). Every id is an
 * OpenRouter ":free" variant with tool calling; the first entry is the default. On an
 * upstream 429/5xx the gateway falls back through this list in order, never outside it.
 *
 * This file has no imports so `tooling/release/src/free-model-check.ts` can load it with
 * Node's type stripping and compare it with OpenRouter's public /models list.
 */

export interface JoyModelCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly contextLength: number;
  readonly vision: boolean;
  readonly isDefault?: boolean;
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

export const JOY_AGENT_FREE_MODELS: readonly JoyModelCatalogEntry[] = Object.freeze([
  Object.freeze({
    id: 'google/gemma-4-31b-it:free',
    displayName: 'Gemma 4 31B (free)',
    description: 'Default. Vision and tool calling at zero cost.',
    contextLength: 262144,
    vision: true,
    isDefault: true,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
  }),
  Object.freeze({
    id: 'thinkingmachines/inkling:free',
    displayName: 'Inkling (free)',
    description: 'Vision and tool calling at zero cost.',
    contextLength: 1048576,
    vision: true,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
  }),
  Object.freeze({
    id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    displayName: 'Nemotron 3 Ultra (free)',
    description: 'Large text model with tool calling at zero cost.',
    contextLength: 1000000,
    vision: false,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
  }),
  Object.freeze({
    id: 'nvidia/nemotron-3-super-120b-a12b:free',
    displayName: 'Nemotron 3 Super (free)',
    description: 'Text model with tool calling at zero cost.',
    contextLength: 262144,
    vision: false,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
  }),
  Object.freeze({
    id: 'cohere/north-mini-code:free',
    displayName: 'North Mini Code (free)',
    description: 'Compact text and code model with tool calling at zero cost.',
    contextLength: 256000,
    vision: false,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
  }),
]);

/**
 * Throws unless every entry is an OpenRouter ":free" id with zero prices, ids are unique and
 * exactly one entry is the default. Run at module load, so a bad edit stops the API at startup
 * instead of forwarding a priced model as "free".
 */
export function assertFreeCatalog(catalog: readonly JoyModelCatalogEntry[]): void {
  if (catalog.length === 0) throw new Error('joy free catalog: no models');
  const seen = new Set<string>();
  for (const model of catalog) {
    if (!model.id.endsWith(':free'))
      throw new Error(`joy free catalog: ${model.id} is not an OpenRouter ":free" id`);
    if (model.inputUsdPerMillion !== 0 || model.outputUsdPerMillion !== 0)
      throw new Error(`joy free catalog: ${model.id} has a non-zero price`);
    if (seen.has(model.id)) throw new Error(`joy free catalog: ${model.id} is listed twice`);
    seen.add(model.id);
  }
  const defaults = catalog.filter((model) => model.isDefault === true).length;
  if (defaults !== 1)
    throw new Error(`joy free catalog: needs exactly one default model, found ${defaults}`);
}

assertFreeCatalog(JOY_AGENT_FREE_MODELS);

/** Ids installed clients may still send; all resolve to the free default. */
export const JOY_AGENT_LEGACY_MODEL_IDS: readonly string[] = Object.freeze([
  'openrouter/free',
  'minimax/minimax-m3',
  'anthropic/claude-3.5-sonnet',
  'meta-llama/llama-3.3-70b-instruct',
]);
