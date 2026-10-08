// Manual release check (Round FC): confirm every id in the hosted free catalog still exists on
// OpenRouter, costs nothing, supports tool calling and matches our vision flag.
//
//   pnpm release:check-free-models
//
// It reads OpenRouter's public model list, which needs no API key; never pass one. Run directly by
// Node's strip-types loader, so imports keep their .ts extension.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  JOY_AGENT_FREE_MODELS,
  type JoyModelCatalogEntry,
} from '../../../apps/api/src/joy-free-models.ts';

export const OPENROUTER_PUBLIC_MODELS_URL = 'https://openrouter.ai/api/v1/models';

interface OpenRouterModel {
  readonly id?: unknown;
  readonly pricing?: Record<string, unknown>;
  readonly architecture?: { readonly input_modalities?: unknown };
  readonly supported_parameters?: unknown;
}

function isZeroPrice(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  const parsed = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(parsed) && parsed === 0;
}

/** Returns one human-readable problem per mismatch; an empty list means the catalog is safe. */
export function checkFreeModels(
  body: unknown,
  catalog: readonly JoyModelCatalogEntry[] = JOY_AGENT_FREE_MODELS,
): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return ['OpenRouter /models response has no data array.'];
  const byId = new Map<string, OpenRouterModel>();
  for (const entry of data as OpenRouterModel[])
    if (typeof entry?.id === 'string') byId.set(entry.id, entry);
  const problems: string[] = [];
  for (const model of catalog) {
    if (!model.id.endsWith(':free')) problems.push(`${model.id}: id does not end in ':free'.`);
    const upstream = byId.get(model.id);
    if (upstream === undefined) {
      problems.push(`${model.id}: missing from OpenRouter's public model list.`);
      continue;
    }
    const pricing = upstream.pricing;
    if (pricing === undefined || typeof pricing !== 'object') {
      problems.push(`${model.id}: OpenRouter lists no pricing.`);
    } else {
      const priced = Object.entries(pricing).filter(([, value]) => !isZeroPrice(value));
      if (priced.length > 0)
        problems.push(
          `${model.id}: non-zero pricing (${priced.map(([key, value]) => `${key}=${String(value)}`).join(', ')}).`,
        );
    }
    const parameters = Array.isArray(upstream.supported_parameters)
      ? upstream.supported_parameters
      : [];
    if (!parameters.includes('tools')) problems.push(`${model.id}: no tool-calling support.`);
    // The gateway sends `reasoning: { exclude: true }` to reasoning models (FC3).
    if (model.reasoning === true && !parameters.includes('reasoning'))
      problems.push(
        `${model.id}: catalog says reasoning but OpenRouter lists no reasoning parameter.`,
      );
    const modalities = Array.isArray(upstream.architecture?.input_modalities)
      ? upstream.architecture.input_modalities
      : [];
    const upstreamVision = modalities.includes('image');
    if (upstreamVision !== model.vision)
      problems.push(
        `${model.id}: catalog vision=${String(model.vision)} but OpenRouter image input=${String(upstreamVision)}.`,
      );
  }
  return problems;
}

export async function fetchPublicModels(fetchImpl: typeof fetch = fetch): Promise<unknown> {
  // Deliberately no authorization header: the public list must not need a key.
  const response = await fetchImpl(OPENROUTER_PUBLIC_MODELS_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`OpenRouter /models returned HTTP ${response.status}`);
  return response.json();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const problems = checkFreeModels(await fetchPublicModels());
    if (problems.length > 0) {
      for (const problem of problems) process.stderr.write(`free-model-check: ${problem}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `free-model-check: all ${JOY_AGENT_FREE_MODELS.length} hosted models are listed, free, tool-capable and match their vision flags.\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `free-model-check: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
