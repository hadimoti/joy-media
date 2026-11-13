import { describe, expect, it } from 'vitest';
import { PROVIDER_REGISTRY, generationSupport, REGISTRY_PROVIDER_IDS } from './registry.js';

describe('generation support in the registry', () => {
  it('offers MiniMax pictures and videos in both regions, through the provider', () => {
    const minimax = PROVIDER_REGISTRY.find((provider) => provider.id === 'minimax');

    expect(minimax?.regions.map((region) => region.id)).toEqual(['international', 'china']);
    expect(generationSupport('minimax', 'image')).toMatchObject({
      supported: true,
      capability: { api: 'minimax-h3' },
    });
    expect(generationSupport('minimax', 'video')).toMatchObject({
      supported: true,
      capability: { api: 'minimax-h3' },
    });
  });

  it('refuses every other provider with a plain reason that names it', () => {
    for (const id of REGISTRY_PROVIDER_IDS.filter(
      (item) => item !== 'minimax' && item !== 'chatgpt',
    )) {
      const label = PROVIDER_REGISTRY.find((provider) => provider.id === id)?.label ?? id;
      const picture = generationSupport(id, 'image');
      const video = generationSupport(id, 'video');

      expect(picture).toMatchObject({ supported: false });
      expect(video).toMatchObject({ supported: false });
      if (!picture.supported)
        expect(picture.reason).toBe(
          `${label} cannot make pictures in JOY Media. Only MiniMax can.`,
        );
      if (!video.supported)
        expect(video.reason).toBe(`${label} cannot make videos in JOY Media. Only MiniMax can.`);
    }
  });

  it('refuses the ChatGPT sign-in and says why', () => {
    expect(generationSupport('chatgpt', 'image')).toEqual({
      supported: false,
      reason:
        'The ChatGPT sign-in cannot make pictures: OpenAI refuses image and video tools for a ChatGPT sign-in.',
    });
    expect(generationSupport('chatgpt', 'video')).toMatchObject({
      supported: false,
      reason: expect.stringContaining('cannot make videos'),
    });
  });

  it('refuses a custom endpoint and an unknown id', () => {
    expect(generationSupport('openai-compatible', 'image')).toEqual({
      supported: false,
      reason: 'A custom endpoint cannot make pictures in JOY Media.',
    });
    expect(generationSupport('no-such-provider', 'video')).toEqual({
      supported: false,
      reason: 'This provider cannot make videos in JOY Media.',
    });
  });
});
