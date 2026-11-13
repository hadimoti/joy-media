// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECOND_US } from '@joy-media/test-fixtures';
import { MissingExportDialog } from './MissingExportDialog.js';
import type { MissingExportClip } from './export-missing-media.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clips: readonly MissingExportClip[] = [
  {
    clipId: 'clip-1',
    assetId: 'asset-1',
    name: 'intro.mp4',
    startUs: 0,
    endUs: 2 * SECOND_US,
  },
  {
    clipId: 'clip-2',
    assetId: 'asset-1',
    name: 'intro.mp4',
    startUs: 5 * SECOND_US,
    endUs: 6 * SECOND_US,
  },
];

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

async function renderDialog(handlers: {
  readonly onRelink: () => void;
  readonly onExportAnyway: () => void;
  readonly onCancel: () => void;
}): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<MissingExportDialog clips={clips} fps={30} {...handlers} />);
  });
}

function dialogButton(text: string): HTMLButtonElement {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
  ).find((candidate) => candidate.textContent === text);
  if (button === undefined) throw new Error(`Expected dialog button "${text}"`);
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
}

async function press(key: string): Promise<void> {
  await act(async () => {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('MissingExportDialog (T-R04 three choices)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('lists each clip with its time code and says that missing parts export black and silent', async () => {
    await renderDialog({ onRelink: vi.fn(), onExportAnyway: vi.fn(), onCancel: vi.fn() });

    const text = document.querySelector('[role="alertdialog"]')?.textContent ?? '';
    expect(text).toContain('2 clips use files that are not on this PC.');
    expect(text).toContain('black and silent');
    expect(text).toContain('intro.mp4 at 00:00:00:00 - 00:00:02:00');
    expect(text).toContain('intro.mp4 at 00:00:05:00 - 00:00:06:00');
  });

  it('Relink… calls only the relink handler', async () => {
    const handlers = { onRelink: vi.fn(), onExportAnyway: vi.fn(), onCancel: vi.fn() };
    await renderDialog(handlers);

    await click(dialogButton('Relink…'));

    expect(handlers.onRelink).toHaveBeenCalledTimes(1);
    expect(handlers.onExportAnyway).not.toHaveBeenCalled();
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  it('Export anyway calls only the export handler', async () => {
    const handlers = { onRelink: vi.fn(), onExportAnyway: vi.fn(), onCancel: vi.fn() };
    await renderDialog(handlers);

    await click(dialogButton('Export anyway'));

    expect(handlers.onExportAnyway).toHaveBeenCalledTimes(1);
    expect(handlers.onRelink).not.toHaveBeenCalled();
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  it('Cancel and Escape call only the cancel handler', async () => {
    const handlers = { onRelink: vi.fn(), onExportAnyway: vi.fn(), onCancel: vi.fn() };
    await renderDialog(handlers);

    await click(dialogButton('Cancel'));
    await press('Escape');

    expect(handlers.onCancel).toHaveBeenCalledTimes(2);
    expect(handlers.onExportAnyway).not.toHaveBeenCalled();
    expect(handlers.onRelink).not.toHaveBeenCalled();
  });

  it('Enter is Relink, so a stray Enter never starts an export with missing parts', async () => {
    const handlers = { onRelink: vi.fn(), onExportAnyway: vi.fn(), onCancel: vi.fn() };
    await renderDialog(handlers);

    await press('Enter');

    expect(handlers.onRelink).toHaveBeenCalledTimes(1);
    expect(handlers.onExportAnyway).not.toHaveBeenCalled();
  });
});
