import { describe, expect, it, vi } from 'vitest';
import { JOY_AGENT_FREE_MODELS } from '../../../apps/api/src/joy-free-models.ts';
import { JOY_FREE_MODELS_EXPECTED } from '../../ops/smoke-gateway-lib.mjs';
import { DEFAULT_JOY_HOSTED_MODEL } from '../../../packages/joy-agent-engine/src/provider-presets.ts';
import {
  OPENROUTER_PUBLIC_MODELS_URL,
  checkFreeModels,
  fetchPublicModels,
} from './free-model-check.ts';

// Offline fixture shaped like OpenRouter's public /models response (checked 8 Oct 2026).
function fixture() {
  const upstream = (id: string, modalities: string[]) => ({
    id,
    pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
    architecture: { input_modalities: modalities },
    supported_parameters: ['tools', 'tool_choice', 'max_tokens', 'reasoning'],
  });
  return {
    data: [
      upstream('nvidia/nemotron-3-super-120b-a12b:free', ['text']),
      upstream('nvidia/nemotron-3-ultra-550b-a55b:free', ['text']),
      upstream('cohere/north-mini-code:free', ['text']),
      upstream('google/gemma-4-31b-it:free', ['image', 'text', 'video']),
      upstream('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', [
        'text',
        'audio',
        'image',
        'video',
      ]),
      upstream('thinkingmachines/inkling:free', ['text', 'image', 'audio']),
      upstream('openrouter/free', ['text']),
    ],
  };
}

describe('free-model release check', () => {
  it('passes when every hosted free model is listed, zero-cost, tool-capable and vision-correct', () => {
    expect(checkFreeModels(fixture())).toEqual([]);
  });

  it('fails when a hosted id is missing upstream', () => {
    const body = fixture();
    body.data = body.data.filter((entry) => entry.id !== 'cohere/north-mini-code:free');
    expect(checkFreeModels(body)).toEqual([
      "cohere/north-mini-code:free: missing from OpenRouter's public model list.",
    ]);
  });

  it('fails on any non-zero price', () => {
    const body = fixture();
    body.data[1]!.pricing = { prompt: '0.0000002', completion: '0', request: '0', image: '0' };
    body.data[0]!.pricing = { prompt: '0', completion: '0', request: '-1', image: '0' };
    const problems = checkFreeModels(body);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/nemotron-3-super.*non-zero pricing \(request=-1\)/);
    expect(problems[1]).toMatch(/nemotron-3-ultra.*non-zero pricing \(prompt=0\.0000002\)/);
  });

  it('fails on a vision mismatch or missing tool support', () => {
    const body = fixture();
    body.data[4]!.architecture = { input_modalities: ['text'] };
    body.data[2]!.supported_parameters = ['max_tokens'];
    expect(checkFreeModels(body)).toEqual([
      'cohere/north-mini-code:free: no tool-calling support.',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free: catalog vision=true but OpenRouter image input=false.',
    ]);
  });

  it('fails when a reasoning model no longer takes the reasoning parameter', () => {
    const body = fixture();
    body.data[4]!.supported_parameters = ['tools', 'max_tokens'];
    expect(checkFreeModels(body)).toEqual([
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free: catalog says reasoning but OpenRouter lists no reasoning parameter.',
    ]);
  });

  it('rejects a malformed response and a non-:free catalog id', () => {
    expect(checkFreeModels({})).toEqual(['OpenRouter /models response has no data array.']);
    const priced = [{ ...JOY_AGENT_FREE_MODELS[0]!, id: 'nvidia/nemotron-3-super-120b-a12b' }];
    expect(checkFreeModels(fixture(), priced)[0]).toMatch(/does not end in ':free'/);
  });

  it('fetches the public list without any authorization header', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(fixture()), { status: 200 }));
    await fetchPublicModels(fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OPENROUTER_PUBLIC_MODELS_URL);
    expect(Object.keys((init.headers ?? {}) as Record<string, string>)).toEqual(['accept']);
  });

  it('keeps the engine hosted placeholder equal to the gateway catalog default', () => {
    expect(DEFAULT_JOY_HOSTED_MODEL).toBe(
      JOY_AGENT_FREE_MODELS.find((model) => model.isDefault)?.id,
    );
    expect(DEFAULT_JOY_HOSTED_MODEL).toBe('nvidia/nemotron-3-super-120b-a12b:free');
  });

  it('keeps the deploy smoke check in step with the gateway catalog', () => {
    expect(JOY_FREE_MODELS_EXPECTED.map(({ id, vision }) => ({ id, vision }))).toEqual(
      JOY_AGENT_FREE_MODELS.map(({ id, vision }) => ({ id, vision })),
    );
  });
});
