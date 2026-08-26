import { expect } from '../../../tooling/browser-smoke/node_modules/@playwright/test/index.mjs';
import type { Page } from '../../../tooling/browser-smoke/node_modules/@playwright/test/index.js';
import { test } from '../../../tooling/browser-smoke/src/run.js';

const baseUrl = process.env.JOY_MEDIA_BROWSER_URL ?? 'http://127.0.0.1:5173';

async function prepareModulePage(page: Page): Promise<void> {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.setContent('<div id="root"></div>');
}

async function mountCaptionHarness(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const dynamicImport = (specifier: string): Promise<Record<string, unknown>> =>
      (0, eval)(`import(${JSON.stringify(specifier)})`) as Promise<Record<string, unknown>>;
    const React = await dynamicImport('/@id/react');
    const ReactDom = await dynamicImport('/@id/react-dom/client');
    const harnessModule = await dynamicImport('/e2e/CaptionInteractionHarness.tsx');
    const reactApi = (React['default'] ?? React) as Record<string, unknown>;
    const reactDomApi = (ReactDom['default'] ?? ReactDom) as Record<string, unknown>;
    const createElement = reactApi['createElement'] as (type: unknown) => unknown;
    const createRoot = reactDomApi['createRoot'] as (node: Element) => {
      render(element: unknown): void;
    };
    const Harness = harnessModule['CaptionInteractionHarness'];
    const root = document.getElementById('root');
    if (root === null || Harness === undefined) throw new Error('caption harness is unavailable');
    createRoot(root).render(createElement(Harness));
  });
}

test('caption editing has one-command commit, cancellation, revert, deletion, and undo boundaries', async ({
  page,
}) => {
  await prepareModulePage(page);
  await mountCaptionHarness(page);

  const input = page.getByRole('textbox', { name: 'Edit caption 1 at 0.00s' });
  const dispatchCount = page.getByTestId('dispatch-count');
  await expect(input).toHaveValue('سلام به جوی');
  await expect(dispatchCount).toHaveText('0');

  await input.fill('Corrected caption');
  await page.getByRole('navigation', { name: 'Caption test history' }).click();
  await expect(dispatchCount).toHaveText('1');
  await expect(input).toHaveValue('Corrected caption');

  await page.getByRole('button', { name: 'Harness undo' }).click();
  await expect(input).toHaveValue('سلام به جوی');
  await page.getByRole('button', { name: 'Harness redo' }).click();
  await expect(input).toHaveValue('Corrected caption');

  await input.fill('Committed with Enter');
  await input.press('Enter');
  await expect(dispatchCount).toHaveText('2');
  await page.getByRole('button', { name: 'Harness undo' }).click();
  await expect(input).toHaveValue('Corrected caption');

  await input.fill('Discard this draft');
  await input.press('Escape');
  await expect(input).toHaveValue('Corrected caption');
  await expect(dispatchCount).toHaveText('2');

  await input.fill('Unsaved focused draft');
  await page
    .getByRole('button', { name: 'Harness undo' })
    .evaluate((element: HTMLElement) => element.click());
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Unsaved focused draft');
  await input.press('Escape');
  await expect(input).toHaveValue('سلام به جوی');
  await expect(dispatchCount).toHaveText('2');

  await page.getByRole('button', { name: 'Harness redo' }).click();
  await expect(input).toHaveValue('Corrected caption');
  const revert = page.getByRole('button', {
    name: 'Revert caption 1 at 0.00s to source text',
  });
  await revert.click();
  await expect(dispatchCount).toHaveText('3');
  await expect(input).toHaveValue('سلام به جوی');
  await page.getByRole('button', { name: 'Harness undo' }).click();
  await expect(input).toHaveValue('Corrected caption');

  await revert.focus();
  await revert.press('Enter');
  await expect(dispatchCount).toHaveText('4');
  await expect(input).toHaveValue('سلام به جوی');
  await page.getByRole('button', { name: 'Harness undo' }).click();
  await expect(input).toHaveValue('Corrected caption');

  await input.fill('Dirty text must not be committed');
  await page.getByRole('button', { name: 'Delete caption 1 at 0.00s' }).click();
  await expect(dispatchCount).toHaveText('5');
  await expect(input).toHaveCount(0);
  await page.getByRole('button', { name: 'Harness undo' }).click();
  await expect(page.getByRole('textbox', { name: 'Edit caption 1 at 0.00s' })).toHaveValue(
    'Corrected caption',
  );
});

test('adding a caption creates an empty focused draft instead of authored placeholder copy', async ({
  page,
}) => {
  await prepareModulePage(page);
  await mountCaptionHarness(page);

  await page.getByRole('button', { name: 'Add caption' }).click();
  await expect(page.getByTestId('dispatch-count')).toHaveText('1');
  const newInput = page.getByRole('textbox', { name: 'Edit caption 2 at 1.00s' });
  await expect(newInput).toBeFocused();
  await expect(newInput).toHaveValue('');
  await expect(newInput).toHaveAttribute('placeholder', 'Write caption…');
  await expect(page.getByText(/New caption|Caption at/)).toHaveCount(0);
});

test('delivery status announces concise updates and keeps aggregate details keyboard reachable', async ({
  page,
}) => {
  await prepareModulePage(page);
  await page.evaluate(async () => {
    const dynamicImport = (specifier: string): Promise<Record<string, unknown>> =>
      (0, eval)(`import(${JSON.stringify(specifier)})`) as Promise<Record<string, unknown>>;
    const React = await dynamicImport('/@id/react');
    const ReactDom = await dynamicImport('/@id/react-dom/client');
    const statusModule = await dynamicImport('/src/DeliveryBlockedStatus.tsx');
    const reactApi = (React['default'] ?? React) as Record<string, unknown>;
    const reactDomApi = (ReactDom['default'] ?? ReactDom) as Record<string, unknown>;
    const createElement = reactApi['createElement'] as (
      type: unknown,
      props: Record<string, unknown>,
    ) => unknown;
    const createRoot = reactDomApi['createRoot'] as (node: Element) => {
      render(element: unknown): void;
    };
    const Status = statusModule['DeliveryBlockedStatus'];
    const host = document.getElementById('root');
    if (host === null || Status === undefined) throw new Error('delivery status is unavailable');
    const root = createRoot(host);
    const render = (failures: readonly { channel: string; detail: string }[]) =>
      root.render(createElement(Status, { id: 'delivery-blocked', failures }));
    render([{ channel: 'Quick export', detail: 'Source media is missing.' }]);
    Object.assign(window, { __renderDeliveryFailures: render });
  });

  const announcement = page.getByRole('status');
  await expect(announcement).toHaveText('Quick export is unavailable.');
  await expect(page.locator('summary')).toHaveText('Quick export unavailable');

  await page.evaluate(() => {
    const render = (
      window as Window & {
        __renderDeliveryFailures?: (
          failures: readonly { channel: string; detail: string }[],
        ) => void;
      }
    ).__renderDeliveryFailures;
    if (render === undefined) throw new Error('delivery rerender hook is unavailable');
    render([
      { channel: 'Quick export', detail: 'Source media is missing.' },
      { channel: 'Verified delivery', detail: 'A production worker is unavailable.' },
    ]);
  });

  await expect(announcement).toHaveText(
    'Export is unavailable. Quick export and verified delivery need attention.',
  );
  const summary = page.locator('summary');
  await expect(summary).toHaveText('Export unavailable');
  await summary.focus();
  await expect(summary).toBeFocused();
  await summary.press('Enter');
  await expect(page.locator('.delivery-blocked-detail li')).toHaveCount(2);
  await expect(page.locator('.delivery-blocked-status')).not.toContainText(/asset-|seg-/);
});
