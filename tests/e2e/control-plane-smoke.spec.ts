import { expect, test } from '@playwright/test';

test.describe('WP-29 control-plane disposable project', () => {
  test('creates an owner-scoped disposable project through the control plane', async ({ page }) => {
    await page.goto('/');
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
});
