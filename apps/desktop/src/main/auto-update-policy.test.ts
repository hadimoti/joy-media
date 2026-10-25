import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { checkForReleaseUpdate } from './auto-update-policy.js';

const SETUP_SHA = 'a'.repeat(64);

function keyPair(): { privateKey: KeyObject; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

function manifestBytes(version: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      channel: 'stable',
      version,
      issuedAt: '2026-10-26T00:00:00Z',
      files: [{ name: 'joy-media-setup.exe', size: 202988544, sha256: SETUP_SHA }],
    }),
  );
}

/** Serves the named release files; each response reports the GitHub URL it was requested from. */
function serve(files: Record<string, Uint8Array>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = files[url.slice(url.lastIndexOf('/') + 1)];
    if (body === undefined)
      return { ok: false, status: 404, url, headers: new Headers() } as Response;
    return {
      ok: true,
      status: 200,
      url,
      headers: new Headers(),
      arrayBuffer: async () => body.slice().buffer,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function signatureText(manifest: Uint8Array, key: KeyObject): string {
  return `${sign(null, manifest, key).toString('base64url')}\n`;
}

describe('checkForReleaseUpdate', () => {
  it('makes no request at all when no key is trusted', async () => {
    const fetchFn = vi.fn(serve({}));
    const result = await checkForReleaseUpdate({
      currentVersion: '1.0.2',
      publicKeysPem: [],
      fetch: fetchFn,
    });
    expect(result).toEqual({ status: 'blocked', reason: 'release-key-unconfigured' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reports a newer signed release as a notice that links to its release page', async () => {
    const key = keyPair();
    const manifest = manifestBytes('1.0.3');
    const result = await checkForReleaseUpdate({
      currentVersion: '1.0.2',
      publicKeysPem: [key.publicPem],
      fetch: serve({
        'release-manifest.json': manifest,
        'release-manifest.json.sig': new TextEncoder().encode(
          signatureText(manifest, key.privateKey),
        ),
      }),
    });
    expect(result).toEqual({
      status: 'update',
      latestVersion: '1.0.3',
      forced: false,
      releaseUrl: 'https://github.com/hadimoti/joy-media/releases/tag/v1.0.3',
    });
  });

  it('reports the installed version as current when the signed release is not newer', async () => {
    const key = keyPair();
    const manifest = manifestBytes('1.0.3');
    const result = await checkForReleaseUpdate({
      currentVersion: '1.0.3',
      publicKeysPem: [key.publicPem],
      fetch: serve({
        'release-manifest.json': manifest,
        'release-manifest.json.sig': new TextEncoder().encode(
          signatureText(manifest, key.privateKey),
        ),
      }),
    });
    expect(result).toEqual({ status: 'current', reason: 'not-newer', latestVersion: '1.0.3' });
  });

  it('blocks a manifest that changed after it was signed', async () => {
    const key = keyPair();
    const signed = manifestBytes('1.0.3');
    const result = await checkForReleaseUpdate({
      currentVersion: '1.0.2',
      publicKeysPem: [key.publicPem],
      fetch: serve({
        'release-manifest.json': manifestBytes('9.9.9'),
        'release-manifest.json.sig': new TextEncoder().encode(
          signatureText(signed, key.privateKey),
        ),
      }),
    });
    expect(result).toEqual({ status: 'blocked', reason: 'signature-invalid' });
  });

  it('reports a failed download as a block, never as an update', async () => {
    const key = keyPair();
    const result = await checkForReleaseUpdate({
      currentVersion: '1.0.2',
      publicKeysPem: [key.publicPem],
      fetch: serve({}),
    });
    expect(result).toEqual({ status: 'blocked', reason: 'network-unavailable' });
  });
});
