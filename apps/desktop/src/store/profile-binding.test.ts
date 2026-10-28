import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from './local-database.js';
import { endpointBindingDigest } from './profile-binding.js';

const OPENROUTER = 'https://openrouter.ai/api/v1';

describe('endpoint binding for saved profiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'joy-binding-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function open(): LocalDatabase {
    return new LocalDatabase({ filePath: join(dir, 'app.sqlite'), now: () => 'T0' });
  }

  it('binds a saved profile that has no binding yet, on the next start, when its URL is allowed', () => {
    const first = open();
    // A row as the v1.0.x build saved it: no binding was ever recorded.
    first.saveProviderProfile({
      id: 'p-or',
      provider: 'openrouter',
      baseUrl: OPENROUTER,
      modelId: 'm',
      secretHandleId: 'h-or',
      createdAt: 'T0',
      updatedAt: 'T0',
    });
    expect(first.getProviderProfile('p-or')?.bindingDigest).toBeUndefined();
    first.close();

    const second = open();
    expect(second.getProviderProfile('p-or')?.bindingDigest).toBe(
      endpointBindingDigest('p-or', 'https://openrouter.ai', '/api/v1'),
    );
    second.close();
  });

  it('leaves a disabled legacy profile and a public custom endpoint unbound', () => {
    const first = open();
    first.saveProviderProfile({
      id: 'p-kilo',
      provider: 'kilo',
      baseUrl: 'https://api.kilo.ai/api/gateway',
      modelId: 'm',
      secretHandleId: 'h-kilo',
      createdAt: 'T0',
      updatedAt: 'T0',
    });
    first.saveProviderProfile({
      id: 'p-public',
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'm',
      secretHandleId: 'h-public',
      createdAt: 'T0',
      updatedAt: 'T0',
    });
    first.markLegacyProfiles();
    first.close();

    const second = open();
    expect(second.getProviderProfile('p-kilo')?.bindingDigest).toBeUndefined();
    expect(second.getProviderProfile('p-public')?.bindingDigest).toBeUndefined();
    second.close();
  });
});
