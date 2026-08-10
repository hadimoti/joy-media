import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const E2E_TOKEN = 'joy-media-e2e-token';

test.describe('WP-29 authenticated disposable stack', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((token) => {
      window.localStorage.setItem('joy-media-session-token', token);
    }, E2E_TOKEN);
  });

  test('accepts the test session and owns a disposable project', async ({ page }) => {
    await page.goto('/');
    const session = await page.evaluate(async () => {
      const response = await fetch('/api/v1/auth/session', {
        headers: { authorization: 'Bearer joy-media-e2e-token' },
      });
      return { status: response.status, body: await response.json() };
    });
    expect(session.status).toBe(200);
    expect(session.body.data).toMatchObject({ displayName: 'JOY E2E' });

    const projectId = `e2e-project-${Date.now()}`;
    const created = await page.evaluate(async (id) => {
      const response = await fetch('/api/v1/projects', {
        method: 'POST',
        headers: {
          authorization: 'Bearer joy-media-e2e-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ id, title: 'WP-29 E2E disposable' }),
      });
      return { status: response.status, body: await response.json() };
    }, projectId);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ id: projectId, ownerId: 'e2e-owner@example.test' });
  });

  test('registers, uploads, reloads, and reads an authorized fixture original', async ({
    page,
  }) => {
    const bytes = readFileSync(join(process.cwd(), 'packages/test-fixtures/media/video.mp4'));
    const encoded = bytes.toString('base64');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const projectId = `e2e-media-${Date.now()}`;
    const assetId = `media-${Date.now()}`;
    await page.goto('/');

    const created = await page.evaluate(async (id) => {
      const response = await fetch('/api/v1/projects', {
        method: 'POST',
        headers: {
          authorization: 'Bearer joy-media-e2e-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ id, title: 'WP-29 media disposable' }),
      });
      return response.status;
    }, projectId);
    expect(created).toBe(201);

    const registered = await page.evaluate(
      async ({ projectId: id, assetId: mediaId, sha256: digest, bytes: size }) => {
        const response = await fetch(`/api/v1/projects/${id}/assets`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer joy-media-e2e-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            id: mediaId,
            kind: 'video',
            displayName: 'video.mp4',
            sha256: digest,
            bytes: size,
            descriptor: { mimeType: 'video/mp4', durationUs: 3_000_000, width: 320, height: 180 },
            locations: [{ kind: 'opfs-cache', ref: `opfs-${digest.slice(0, 16)}` }],
          }),
        });
        return { status: response.status, body: await response.json() };
      },
      { projectId, assetId, sha256, bytes: bytes.byteLength },
    );
    expect(registered.status).toBe(201);
    expect(registered.body.data).toMatchObject({ id: assetId, cloudBacked: false });

    const uploaded = await page.evaluate(
      async ({ projectId: id, assetId: mediaId, sha256: digest, payload }) => {
        const raw = atob(payload);
        const body = Uint8Array.from(raw, (character) => character.charCodeAt(0));
        const response = await fetch(`/api/v1/projects/${id}/assets/${mediaId}/original`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer joy-media-e2e-token',
            'content-type': 'video/mp4',
            'x-joy-sha256': digest,
            'x-joy-bytes': String(body.byteLength),
          },
          body,
        });
        return { status: response.status, body: await response.json() };
      },
      { projectId, assetId, sha256, payload: encoded },
    );
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.data.asset).toMatchObject({ id: assetId, cloudBacked: true });

    await page.reload();
    const downloaded = await page.evaluate(
      async ({ projectId: id, assetId: mediaId }) => {
        const response = await fetch(`/api/v1/projects/${id}/assets/${mediaId}/original`, {
          headers: { authorization: 'Bearer joy-media-e2e-token' },
        });
        const content = new Uint8Array(await response.arrayBuffer());
        const digest = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', content)),
          (byte) => byte.toString(16).padStart(2, '0'),
        ).join('');
        return {
          status: response.status,
          contentType: response.headers.get('content-type'),
          bytes: content.byteLength,
          sha256: digest,
        };
      },
      { projectId, assetId },
    );
    expect(downloaded).toEqual({
      status: 200,
      contentType: 'video/mp4',
      bytes: bytes.byteLength,
      sha256,
    });

    const assetDeleted = await page.evaluate(
      async ({ projectId: id, assetId: mediaId }) => {
        const response = await fetch(`/api/v1/projects/${id}/assets/${mediaId}`, {
          method: 'DELETE',
          headers: { authorization: 'Bearer joy-media-e2e-token' },
        });
        return response.status;
      },
      { projectId, assetId },
    );
    expect(assetDeleted).toBe(200);

    const trashed = await page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/projects/${id}/trash`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer joy-media-e2e-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ baseRevision: 0 }),
      });
      return response.status;
    }, projectId);
    expect(trashed).toBe(200);

    const deleted = await page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/projects/${id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer joy-media-e2e-token' },
      });
      return response.status;
    }, projectId);
    expect(deleted).toBe(200);
  });
});
