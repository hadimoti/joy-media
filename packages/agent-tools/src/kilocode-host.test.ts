import { describe, expect, it } from 'vitest';
import { validateAgentHostManifest } from '@joy-media/provider-sdk';
import { createKiloCodeAgentHostManifest, KILOCODE_AGENT_HOST_ID } from './kilocode-host.js';

describe('KiloCode agent host manifest', () => {
  it('is the sole editing host and declares the complete adapter boundary', () => {
    const manifest = createKiloCodeAgentHostManifest();

    expect(manifest.kind).toBe('agent-host');
    expect(manifest.id).toBe(KILOCODE_AGENT_HOST_ID);
    expect(manifest.transport).toBe('code-server-extension');
    expect(manifest.tools.length).toBeGreaterThan(0);
    expect(manifest.tools.find((tool) => tool.name === 'trimClip')).toEqual({
      name: 'trimClip',
      requiredCapabilities: ['timeline.write'],
    });
    expect(manifest.reasoningModels).toEqual([]);
    expect(manifest.mediaProviders).toEqual([]);
    expect(manifest.localExecutors).toEqual([]);
    expect(manifest.health.strategy).toBe('extension-heartbeat');
    expect(manifest.cancellation.supported).toBe(true);
    expect(manifest.costReporting.supported).toBe(true);
    expect(manifest.settings.surface).toBe('code-server-extension');
    expect(validateAgentHostManifest(manifest)).toEqual({ valid: true, errors: [] });
  });

  it('contains only a server-side secret reference, never a credential value', () => {
    const manifest = createKiloCodeAgentHostManifest();
    const serialized = JSON.stringify(manifest);

    expect(manifest.settings.secretReferences).toEqual([
      {
        providerId: 'kilocode',
        fieldName: 'apiKey',
        scope: 'server-only',
      },
    ]);
    expect(serialized).not.toContain('sk-');
    expect(serialized).not.toContain('.env');
    expect(serialized).not.toContain('"apiKey":');
    expect(serialized).not.toContain('"token":');
    expect(serialized).not.toContain('"password":');
  });

  it('keeps models, media providers, and local executors distinct', () => {
    const manifest = createKiloCodeAgentHostManifest({
      reasoningModels: [
        {
          kind: 'reasoning-model',
          providerId: 'openai',
          model: { id: 'reasoning-model', displayName: 'Reasoning Model', version: 'v1' },
        },
      ],
      mediaProviders: [
        {
          kind: 'media-provider',
          providerId: 'image-provider',
          capabilities: ['image.generate'],
        },
      ],
      localExecutors: [
        {
          kind: 'local-executor',
          executorId: 'joy-windows-worker',
          displayName: 'JOY Windows Worker',
          capabilities: ['ffmpeg.render'],
        },
      ],
    });

    expect(manifest.reasoningModels[0]?.kind).toBe('reasoning-model');
    expect(manifest.mediaProviders[0]?.kind).toBe('media-provider');
    expect(manifest.localExecutors[0]?.kind).toBe('local-executor');
  });
});
