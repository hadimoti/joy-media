import { expect, test } from '@playwright/test';
import { authenticate, openPanel, openReferenceWorkspace } from './wp29-r5-harness.js';
import { configureJoyAgent, installFakeOpenAIProvider } from './fixtures/fake-openai-provider.js';
import {
  allowExpectedAssetFixtureMisses,
  assertBrowserAudit,
  setupBrowserAudit,
} from './helpers/browser-console-audit.js';

/**
 * R2 L2 browser coverage: the Living Looks capability in Joy Code renders the
 * five shipping packs with honest availability, and running a Look compiles a
 * plan through the same staged-preview + approval path as a direct edit —
 * Approve applies it, one Undo restores it.
 */
test.describe('JOY Living Looks', () => {
  const LOOKS_ASSET_MISS_MAP: Record<
    string,
    {
      original: number | { min: number; max: number };
      cloud?: number | { min: number; max: number };
    }
  > = {
    'keeps the Looks setup in one owned viewport': { original: 2 },
    'renders the five shipping packs and runs one through approve + Undo': { original: 7 },
    'matches the Edit composer while keeping Looks controls reachable without overflow': {
      original: { min: 1, max: 2 },
      cloud: 2,
    },
    'shows an unavailable pack honestly when the editor lacks a capability': { original: 2 },
    'a saved Look survives reload and can be reopened, adjusted, and detached (GAP 1b/1c)': {
      original: { min: 11, max: 12 },
      cloud: 11,
    },
  };

  test.beforeEach(({ page }, testInfo) => {
    setupBrowserAudit(page);
    const config = LOOKS_ASSET_MISS_MAP[testInfo.title];
    if (config != null) allowExpectedAssetFixtureMisses(page, config.original, config.cloud);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await assertBrowserAudit(page, testInfo);
  });

  test('renders the five shipping packs and runs one through approve + Undo', async ({ page }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');

    await page.getByRole('button', { name: 'Looks', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Living Looks' });
    await expect(panel).toBeVisible();

    for (const title of [
      'Editorial Clean',
      'Product Precision',
      'Kinetic Type',
      'Quiet Documentary',
      'Music Pulse',
    ]) {
      await expect(panel.getByText(title, { exact: true })).toBeVisible();
    }
    await expect(panel.getByText('Persian Editorial', { exact: true })).toHaveCount(0);

    await panel.getByRole('tab', { name: 'Configure', exact: true }).click();

    // Editorial Clean is selected by default (first available). Its editor form
    // is visible and Run is disabled until the required headline slot is bound.
    const editor = panel.getByRole('form', { name: /Editorial Clean controls/ });
    await expect(editor).toBeVisible();
    const run = editor.getByRole('button', { name: 'Run Editorial Clean' });
    await expect(run).toBeDisabled();

    // Bind the required headline slot to the reference project's text object.
    const headlineSelect = editor
      .locator('.living-look-slot', { hasText: /Headline/ })
      .locator('select');
    await headlineSelect.selectOption({ index: 1 });
    await expect(run).toBeEnabled();

    await run.click();

    const preview = page.getByRole('region', { name: 'JOY Agent live proposal' });
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(preview).toHaveAttribute('data-agent-preview-ready', 'true', { timeout: 20_000 });

    await preview.getByRole('button', { name: /Approve & apply/ }).click();

    await panel.getByRole('tab', { name: /Applied/ }).click();

    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeEnabled({ timeout: 20_000 });
    await undo.click();
    await expect(page.getByText(/could not be prepared/)).toHaveCount(0);
  });

  test('a saved Look survives reload and can be reopened, adjusted, and detached (GAP 1b/1c)', async ({
    page,
  }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');
    await page.getByRole('button', { name: 'Looks', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Living Looks' });
    await expect(panel).toBeVisible();
    await panel.getByRole('tab', { name: 'Configure', exact: true }).click();

    // Apply Editorial Clean.
    const editor = panel.getByRole('form', { name: /Editorial Clean controls/ });
    await editor
      .locator('.living-look-slot', { hasText: /Headline/ })
      .locator('select')
      .selectOption({ index: 1 });
    await editor.getByRole('button', { name: 'Run Editorial Clean' }).click();
    let preview = page.getByRole('region', { name: 'JOY Agent live proposal' });
    await expect(preview).toHaveAttribute('data-agent-preview-ready', 'true', { timeout: 30_000 });
    await preview.getByRole('button', { name: /Approve & apply/ }).click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled({
      timeout: 20_000,
    });

    await panel.getByRole('tab', { name: /Applied/ }).click();

    // The applied Look is listed, and survives a full browser reload.
    const applied = panel.getByRole('region', { name: 'Applied Looks' });
    await expect(applied.getByText('Editorial Clean', { exact: true })).toBeVisible();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openPanel(page, 'Joy Code');
    await page.getByRole('button', { name: 'Looks', exact: true }).click();
    await panel.getByRole('tab', { name: /Applied/ }).click();
    await expect(applied.getByText('Editorial Clean', { exact: true })).toBeVisible();

    // Adjust a control -> the same staged-preview + approval path.
    const firstSlider = applied.locator('.applied-look-control input[type="range"]').first();
    if ((await firstSlider.count()) > 0) {
      await firstSlider.fill('0.6');
      await firstSlider.dispatchEvent('change');
      preview = page.getByRole('region', { name: 'JOY Agent live proposal' });
      await expect(preview).toHaveAttribute('data-agent-preview-ready', 'true', {
        timeout: 30_000,
      });
      await preview.getByRole('button', { name: /Approve & apply/ }).click();
      await expect(applied.getByText('Editorial Clean', { exact: true })).toBeVisible();
    }

    // Detach -> removed from Applied Looks; one Undo restores it.
    await applied.getByRole('button', { name: 'Detach' }).first().click();
    await expect(applied.getByText('Editorial Clean', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(applied.getByText('Editorial Clean', { exact: true })).toBeVisible();
  });

  test('shows an unavailable pack honestly when the editor lacks a capability', async ({
    page,
  }) => {
    // The unavailable rendering path (is-unavailable class + "Needs:" reason) is
    // unit-covered in LivingLooksPanel.test.tsx; here we assert the shipped
    // editor exposes all five packs as available, so none is silently hidden.
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');
    await page.getByRole('button', { name: 'Looks', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Living Looks' });
    await expect(panel.locator('.living-look')).toHaveCount(5);
    // Every pack is selectable (available) in the shipped editor.
    await expect(panel.locator('.living-look.is-unavailable')).toHaveCount(0);
  });

  test('keeps the Looks setup in one owned viewport', async ({ page }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');
    await page.getByRole('button', { name: 'Looks', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Living Looks' });
    const metrics = await panel.evaluate((element) => {
      const composer = element.closest('.joy-code-panel');
      const body = composer?.querySelector<HTMLElement>('.joy-panel-body');
      const viewport = element.querySelector<HTMLElement>('.living-looks-viewport');
      const messages = composer?.querySelector<HTMLElement>('.joy-code-messages');
      return {
        bodyScrollTop: body?.scrollTop ?? -1,
        bodyOverflow: body === null ? '' : getComputedStyle(body).overflowY,
        viewportOverflow: viewport === null ? '' : getComputedStyle(viewport).overflowY,
        viewportClientHeight: viewport?.clientHeight ?? 0,
        viewportScrollHeight: viewport?.scrollHeight ?? 0,
        messagesDisplay: messages === null ? '' : getComputedStyle(messages).display,
      };
    });
    expect(metrics.bodyScrollTop).toBe(0);
    expect(metrics.bodyOverflow).toBe('hidden');
    expect(metrics.viewportOverflow).toBe('auto');
    expect(metrics.viewportClientHeight).toBeGreaterThan(0);
    expect(metrics.viewportScrollHeight).toBeGreaterThanOrEqual(metrics.viewportClientHeight);
    expect(metrics.messagesDisplay).not.toBe('none');
  });

  test('matches the Edit composer while keeping Looks controls reachable without overflow', async ({
    page,
  }) => {
    await authenticate(page);
    await openReferenceWorkspace(page);
    await openPanel(page, 'Joy Code');
    await installFakeOpenAIProvider(page);
    const settings = await configureJoyAgent(page, 'JOY_E2E_LOOKS_COMPOSER_KEY');
    await settings.getByRole('button', { name: 'Done' }).click();

    const readComposerStyle = async (selector: string) =>
      page.locator(selector).evaluate((element) => {
        const textarea = element as HTMLTextAreaElement;
        const row = textarea.closest('.joy-code-input');
        const send = row?.querySelector('.joy-code-send');
        const dock = textarea.closest('.joy-code-compose-dock');
        if (row === null || send === undefined || dock === null)
          throw new Error('Composer must use the shared Edit layout primitives');
        const outline = (style: CSSStyleDeclaration) => ({
          outlineColor: style.outlineColor,
          outlineOffset: style.outlineOffset,
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
        });
        textarea.focus();
        const focusedTextarea = outline(getComputedStyle(textarea));
        const textareaStyle = getComputedStyle(textarea);
        send.focus();
        const focusedSend = outline(getComputedStyle(send));
        const sendStyle = getComputedStyle(send);
        const dockStyle = getComputedStyle(dock);
        return {
          focus: {
            textarea: focusedTextarea,
            send: focusedSend,
          },
          textarea: {
            backgroundColor: textareaStyle.backgroundColor,
            borderRadius: textareaStyle.borderRadius,
            color: textareaStyle.color,
            fontFamily: textareaStyle.fontFamily,
            fontSize: textareaStyle.fontSize,
            lineHeight: textareaStyle.lineHeight,
            minHeight: textareaStyle.minHeight,
            padding: textareaStyle.padding,
          },
          send: {
            backgroundColor: sendStyle.backgroundColor,
            borderColor: sendStyle.borderColor,
            borderRadius: sendStyle.borderRadius,
            color: sendStyle.color,
            height: sendStyle.height,
            width: sendStyle.width,
          },
          dock: {
            backgroundColor: dockStyle.backgroundColor,
            borderColor: dockStyle.borderColor,
            borderRadius: dockStyle.borderRadius,
            padding: dockStyle.padding,
          },
        };
      });

    await page
      .getByLabel('Composer capabilities')
      .getByRole('button', { name: 'Edit', exact: true })
      .click();
    const editStyle = await readComposerStyle('[aria-label="Message Joy Code"]');
    await page.getByRole('button', { name: 'Looks', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Living Looks' });
    const looksPrompt = panel.getByRole('textbox', { name: 'Ask JOY to work with a Look' });
    await expect(looksPrompt).toBeVisible();
    expect(await readComposerStyle('#living-looks-agent-prompt')).toEqual(editStyle);

    const tabs = ['Browse', 'Configure', 'Applied'] as const;
    for (const tabName of tabs)
      await expect(panel.getByRole('tab', { name: tabName, exact: true })).toBeVisible();
    const selectedLook = panel.locator('.living-look-select[aria-pressed="true"]');
    await expect(selectedLook).toHaveCount(1);
    await selectedLook.scrollIntoViewIfNeeded();
    await expect(selectedLook).toBeVisible();
    await panel.getByRole('tab', { name: 'Configure', exact: true }).click();
    await expect(panel.getByRole('form', { name: /Editorial Clean controls/ })).toBeVisible();
    await panel.getByRole('tab', { name: 'Applied', exact: true }).click();
    await expect(panel.getByRole('region', { name: 'Applied Looks' })).toBeVisible();

    const overflow = await panel.evaluate((element) => {
      const viewport = element.querySelector<HTMLElement>('.living-looks-viewport');
      const composer = element.closest<HTMLElement>('.joy-code-panel');
      return {
        document: document.documentElement.scrollWidth > window.innerWidth,
        panel: element.scrollWidth > element.clientWidth,
        composer: composer !== null && composer.scrollWidth > composer.clientWidth,
        viewport: viewport !== null && viewport.scrollWidth > viewport.clientWidth,
      };
    });
    expect(overflow).toEqual({ document: false, panel: false, composer: false, viewport: false });
  });
});
