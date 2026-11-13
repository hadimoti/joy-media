import { expect, test } from '@playwright/test';
import { authenticate, openPanel, openReferenceWorkspace } from './wp29-r5-harness.js';
import { assertBrowserAudit, setupBrowserAudit } from './helpers/browser-console-audit.js';

test.describe('JOY Agent navigation', () => {
  test.beforeEach(({ page }) => {
    setupBrowserAudit(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await assertBrowserAudit(page, testInfo);
  });

  test('keeps Joy Code out of the dock on the very first run', async ({ page }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);

    // Joy Code is optional: the first run does not reserve a column for it.
    await expect(page.locator('.panel-tab[aria-label="Joy Code"]')).toHaveCount(0);

    // It opens on demand and gets a column of its own.
    await page.getByRole('button', { name: 'View', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Joy Code', exact: true }).click();
    const tab = page.locator('.panel-tab[aria-label="Joy Code"]').first();
    await expect(tab).toBeVisible();
  });

  test('removes the redundant capability heading', async ({ page }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');

    const toolbar = page.getByRole('toolbar', { name: 'Composer capabilities' });
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByText('Create with JOY', { exact: true })).toHaveCount(0);
  });

  test('keeps every capability and Settings reachable without a clipped toolbar', async ({
    page,
  }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');

    const toolbar = page.getByRole('toolbar', { name: 'Composer capabilities' });
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Joy Code Settings' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Select AI Model' })).toHaveCount(0);
    for (const capability of ['Edit', 'Creative Brief', 'Recipes', 'Looks']) {
      await expect(toolbar.getByRole('button', { name: capability, exact: true })).toBeVisible();
    }

    const geometry = await toolbar.evaluate((element) => {
      const parent = element.getBoundingClientRect();
      const controls = Array.from(element.querySelectorAll('button')).map((control) => {
        const rect = control.getBoundingClientRect();
        return {
          left: rect.left - parent.left,
          right: rect.right - parent.left,
          top: rect.top - parent.top,
          bottom: rect.bottom - parent.top,
        };
      });
      return {
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        controls,
      };
    });
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
    expect(geometry.controls).toHaveLength(5);
    for (const control of geometry.controls) {
      expect(control.left).toBeGreaterThanOrEqual(0);
      expect(control.right).toBeLessThanOrEqual(geometry.width);
    }
  });

  test('explains the disconnected Edit prerequisite before the first message', async ({ page }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');

    const readiness = page.getByRole('status', { name: 'Edit readiness' });
    await expect(readiness).toBeVisible();
    await expect(readiness).toContainText(
      'Joy Code is optional. Connect your own AI model to edit by describing what you want.',
    );
    // One calm card: the engineer wording is gone.
    await expect(readiness).not.toContainText('Connect a model with JOY edit tools');
    const dimensions = await readiness.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    await readiness.getByRole('button', { name: 'Connect a model' }).click();
    await expect(page.getByRole('dialog', { name: 'Joy Code Settings' })).toBeVisible();
  });

  test('keeps one message when a disconnected conversation asks for an edit', async ({ page }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');

    const composer = page.getByRole('textbox', { name: 'Message Joy Code' });
    await composer.fill('Make this edit more cinematic');
    await composer.press('Enter');

    // The card is the one message: the chat does not repeat it.
    await expect(page.locator('.joy-code-message.is-assistant')).toHaveCount(0);
    await expect(page.getByRole('status', { name: 'Edit readiness' })).toBeVisible();
  });

  test('explains the Recipes model prerequisite and hides runs while disconnected', async ({
    page,
  }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');

    const toolbar = page.getByRole('toolbar', { name: 'Composer capabilities' });
    await toolbar.getByRole('button', { name: 'Recipes', exact: true }).click();

    const readiness = page.getByRole('status', { name: 'Recipes readiness' });
    await expect(readiness).toBeVisible();
    await expect(readiness).toContainText('Joy Code is optional.');
    await expect(readiness.getByRole('button', { name: 'Connect a model' })).toBeVisible();

    // Recipe runs stay hidden until a model is connected.
    await expect(page.getByRole('button', { name: /^Run / })).toHaveCount(0);

    await readiness.getByRole('button', { name: 'Connect a model' }).click();
    await expect(page.getByRole('dialog', { name: 'Joy Code Settings' })).toBeVisible();
  });

  test('keeps manual Looks available and explains why Ask JOY is unavailable', async ({ page }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');

    const toolbar = page.getByRole('toolbar', { name: 'Composer capabilities' });
    await toolbar.getByRole('button', { name: 'Looks', exact: true }).click();

    const readiness = page.getByRole('status', { name: 'Looks readiness' });
    await expect(readiness).toBeVisible();
    await expect(readiness).toContainText('Joy Code is optional.');
    await expect(readiness.getByRole('button', { name: 'Connect a model' })).toBeVisible();

    const looks = page.getByRole('region', { name: 'Living Looks' });
    await expect(looks).toBeVisible();
    await expect(looks.getByRole('tab', { name: 'Browse', exact: true })).toBeVisible();
    await expect(looks.getByRole('tab', { name: 'Configure', exact: true })).toBeVisible();
    // Ask JOY needs a model; a manual Look does not.
    await expect(looks.getByRole('button', { name: 'Ask JOY', exact: true })).toHaveCount(0);

    await readiness.getByRole('button', { name: 'Connect a model' }).click();
    await expect(page.getByRole('dialog', { name: 'Joy Code Settings' })).toBeVisible();
  });

  test('keeps Creative Brief’s disconnected connect state routed through Settings', async ({
    page,
  }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');

    const toolbar = page.getByRole('toolbar', { name: 'Composer capabilities' });
    await toolbar.getByRole('button', { name: 'Creative Brief', exact: true }).click();

    const brief = page.locator('.joy-code-creative-brief');
    await expect(brief.getByRole('heading', { name: 'Connect a model to start' })).toBeVisible();
    await brief.getByRole('button', { name: 'Open JOY Agent Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Joy Code Settings' })).toBeVisible();
  });

  test('opens the full model drawer from Settings and returns to Settings when closed', async ({
    page,
  }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');

    const toolbar = page.getByRole('toolbar', { name: 'Composer capabilities' });
    await toolbar.getByRole('button', { name: 'Joy Code Settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Joy Code Settings' });
    await expect(settings).toBeVisible();

    await settings.getByRole('button', { name: 'Browse models & API connections' }).click();
    const modelDrawer = page.getByRole('dialog', { name: 'Model Drawer & API Connections' });
    await expect(modelDrawer).toBeVisible();
    await expect(settings).toBeHidden();
    await expect(modelDrawer.getByPlaceholder('Search models or providers…')).toBeVisible();

    await modelDrawer.getByRole('button', { name: 'Close Model Drawer' }).click();
    await expect(modelDrawer).toBeHidden();
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Connect model' })).toBeVisible();
  });
});
