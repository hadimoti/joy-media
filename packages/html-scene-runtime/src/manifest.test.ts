import { describe, expect, it } from 'vitest';
import { validateSceneManifest } from './manifest.js';
import type { SceneManifestV1 } from './manifest.js';
import { generateSceneCsp } from './csp.js';

const valid: SceneManifestV1 = {
  formatVersion: 1,
  id: 'joy.firstparty.title',
  version: '1.0.0',
  runtime: 'joy-html-scene-1',
  entry: 'dist/index.js',
  viewport: { width: 1080, height: 1920 },
  transparent: true,
  durationUs: 5_000_000,
  permissions: { network: [], storage: 'none' },
  determinism: { seededRandom: true, wallClock: false },
};

describe('validateSceneManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(validateSceneManifest(valid)).toEqual([]);
    expect(
      validateSceneManifest({
        ...valid,
        permissions: { network: ['https://cdn.example.com'], storage: 'none' },
        variablesSchema: 'schema.json',
        inputs: {
          amount: {
            kind: 'number',
            default: 12,
            animation: 'hold',
            constraints: { min: 0, max: 100 },
          },
          offset: { kind: 'vector2', default: [0, 1], animation: 'hold' },
          accent: { kind: 'color', default: '#e9b949', animation: 'hold' },
        },
      }),
    ).toEqual([]);
  });

  it('reports each structural violation with a code', () => {
    const codes = validateSceneManifest({
      formatVersion: 2,
      id: '',
      version: '',
      runtime: 'other',
      entry: '',
      viewport: { width: 0, height: -1 },
      transparent: 'yes',
      durationUs: 0,
      permissions: { network: ['http://insecure'], storage: 'local' },
      determinism: { seededRandom: false, wallClock: true },
    }).map((diagnostic) => diagnostic.code);
    expect(codes).toContain('SCENE_MANIFEST_VERSION');
    expect(codes).toContain('SCENE_MANIFEST_RUNTIME');
    expect(codes).toContain('SCENE_MANIFEST_ID');
    expect(codes).toContain('SCENE_MANIFEST_ENTRY');
    expect(codes).toContain('SCENE_MANIFEST_VIEWPORT');
    expect(codes).toContain('SCENE_MANIFEST_TRANSPARENT');
    expect(codes).toContain('SCENE_MANIFEST_DURATION');
    expect(codes).toContain('SCENE_MANIFEST_PERMISSIONS');
    expect(codes).toContain('SCENE_MANIFEST_DETERMINISM');
  });

  it('rejects non-https network origins', () => {
    const diagnostics = validateSceneManifest({
      ...valid,
      permissions: { network: ['ftp://x'], storage: 'none' },
    });
    expect(diagnostics.some((d) => d.path === 'permissions.network')).toBe(true);
  });

  it('rejects package-path traversal for bundle and schema files', () => {
    const diagnostics = validateSceneManifest({
      ...valid,
      entry: '../outside.js',
      variablesSchema: '/absolute/schema.json',
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('SCENE_MANIFEST_ENTRY');
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'SCENE_MANIFEST_VARIABLES_SCHEMA',
    );
  });

  it('rejects invalid input declarations', () => {
    const diagnostics = validateSceneManifest({
      ...valid,
      inputs: {
        bad: { kind: 'number', default: '12', animation: 'linear' },
      },
    });
    expect(diagnostics.some((diagnostic) => diagnostic.code === 'SCENE_MANIFEST_INPUTS')).toBe(
      true,
    );
  });
});

describe('generateSceneCsp', () => {
  it('denies all network when the allowlist is empty', () => {
    const csp = generateSceneCsp({ network: [], storage: 'none' });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
  });

  it('opens connect-src to declared origins only, de-duplicated', () => {
    const csp = generateSceneCsp({
      network: ['https://a.example.com', 'https://a.example.com', 'https://b.example.com'],
      storage: 'none',
    });
    expect(csp).toContain('connect-src https://a.example.com https://b.example.com');
    expect(csp).not.toContain("connect-src 'none'");
    // Scene can never frame or run objects regardless of network.
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
  });
});
