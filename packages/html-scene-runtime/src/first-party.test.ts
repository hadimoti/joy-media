import { describe, expect, it } from 'vitest';
import { compileScenePackage } from './compile.js';
import {
  findFirstPartyScene,
  FIRST_PARTY_SCENES,
  resolveFirstPartySceneInstance,
} from './first-party.js';

/** Pinned first-frame RGBA hashes (compileScenePackage reference render). */
const REFERENCE_FRAME_SHA256: Readonly<Record<string, string>> = {
  'joy.firstparty.title': '3a54c71f6fcbbdec490ef90d43597f81a6e99dce9f3b7e61720aebdf3bfa2010',
  'joy.firstparty.product-card':
    '7424ce5449dcd34ec6702daffadc0c1ec6f325df35ea25e1c1f15b25b5f259ed',
  'joy.firstparty.lower-third':
    'ccb978dc2efa7a85371ea38c78a38fc13abb091e15d4851d330fed245567c296',
  'joy.firstparty.data-list': '4c582d523b74c6ae39f8a151d3bfe528afc3200a9c34a6a7fc7c6e56579da998',
  'joy.firstparty.lower-third-bar':
    'd16b8fa965c3cd6116938227435dc631e82d15ba1cbe126c05fda2e8bc08232c',
  'joy.firstparty.lower-third-split':
    'eb7db63d713378585c75a590f83bebb324a2040ede4e7cede0d6efd1796d709c',
  'joy.firstparty.title-cinematic':
    '21814446b648f75f0cb1806173324f34978fa9ce23cb567f798f3ebb2c6e66e9',
  'joy.firstparty.countdown': '3c2c02086dbf4fe94564bf56f0250ebe47dcd46281e739df1700bbb9cd4ace13',
  'joy.firstparty.caption-card':
    '67605ad41001768709801ade8f107ac3d303a7a3455ac94a2db471505452892d',
  'joy.firstparty.end-slate': 'af88bff5082c4d10ddea7c62e421dcff564536d9595f87db3bff22bd43cfd80e',
  'joy.firstparty.super-app-hero':
    'ccf909c3fcc237041b5451f8a9b4d065c081388f3af7bd3c5b6adcddfba873a3',
  'joy.firstparty.news-ticker':
    '6f4298bb4b42c5ba94b5da78ec6d6f6a2cf5acb78169130b47edc727654e8c3b',
  'joy.firstparty.social-badge':
    '1f9b132194137442c6d8da590fc2d9b7dae1009da587cc4fa0854932eb5547b5',
  'joy.firstparty.chapter-marker':
    'a8c27e0661d44c5b4b5ef7c5a060ff56b593d30ff013429795c876c884de64d1',
  'joy.firstparty.score-bug':
    '9d030708b0653ddf8e06c47ac99107f31114769b5db37ecc9f3eb6c68b34a107',
};

describe('first-party JOY scene packages', () => {
  it('ships the catalog templates including the OSS overlay pack', () => {
    expect(FIRST_PARTY_SCENES.map((scene) => scene.id)).toEqual(Object.keys(REFERENCE_FRAME_SHA256));
    for (const scene of FIRST_PARTY_SCENES) {
      const compiled = compileScenePackage({
        manifest: scene.manifest,
        source: scene.source,
        variableSchema: scene.variableSchema,
      });
      expect(compiled.diagnostics).toEqual([]);
      expect(compiled.referenceFrameSha256).toBe(REFERENCE_FRAME_SHA256[scene.id]);
    }
  });

  it('resolves nested-composition variables with local overrides taking precedence', () => {
    const resolved = resolveFirstPartySceneInstance(
      'joy.firstparty.title',
      { title: 'Nested local', accent: '#0f0' },
      { title: 'Template title', subtitle: 'Parent subtitle', accent: '#fff' },
    );
    expect(resolved?.variables).toEqual({
      title: 'Nested local',
      subtitle: 'Parent subtitle',
      accent: '#0f0',
    });
    expect(findFirstPartyScene('missing')).toBeUndefined();
  });
});
