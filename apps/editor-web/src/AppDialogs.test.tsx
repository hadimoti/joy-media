// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDialogHost } from './AppDialogs.js';
import { confirmDialog, getAppDialogQueue, promptDialog, settleAppDialog } from './app-dialogs.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<AppDialogHost />);
  });
});

afterEach(async () => {
  for (const entry of getAppDialogQueue()) settleAppDialog(entry.id, null);
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function openDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="alertdialog"], [role="dialog"]');
}

function dialogButton(text: string): HTMLButtonElement {
  const button = Array.from(openDialog()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (candidate) => candidate.textContent === text,
  );
  if (button === undefined) throw new Error(`Expected dialog button "${text}"`);
  return button;
}

async function press(key: string, init: { shiftKey?: boolean } = {}): Promise<void> {
  await act(async () => {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        shiftKey: init.shiftKey ?? false,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
}

// Synchronous on purpose: these return the pending answer itself. An async helper would adopt the answer and
// wait for the dialog to close before returning.
function openConfirm(options: Parameters<typeof confirmDialog>[0]): Promise<boolean> {
  let pending: Promise<boolean> | undefined;
  act(() => {
    pending = confirmDialog(options);
  });
  if (pending === undefined) throw new Error('confirmDialog did not start');
  return pending;
}

function openPrompt(options: Parameters<typeof promptDialog>[0]): Promise<string | null> {
  let pending: Promise<string | null> | undefined;
  act(() => {
    pending = promptDialog(options);
  });
  if (pending === undefined) throw new Error('promptDialog did not start');
  return pending;
}

function setInputText(input: HTMLInputElement, text: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setValue?.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('confirmDialog', () => {
  it('resolves true when the confirm button is clicked', async () => {
    const pending = openConfirm({
      message: 'Delete “Intro” from the catalog?',
      confirmLabel: 'Delete',
    });

    expect(openDialog()?.getAttribute('role')).toBe('alertdialog');
    expect(openDialog()?.textContent).toContain('Delete “Intro” from the catalog?');
    await click(dialogButton('Delete'));

    await expect(pending).resolves.toBe(true);
    expect(openDialog()).toBeNull();
  });

  it('resolves false when Cancel is clicked', async () => {
    const pending = openConfirm({ message: 'Cancel job j1?', confirmLabel: 'Cancel job' });

    await click(dialogButton('Cancel'));

    await expect(pending).resolves.toBe(false);
  });

  it('resolves true on Enter with the confirm button focused, and the confirm button starts focused', async () => {
    const pending = openConfirm({ message: 'Sign out?', confirmLabel: 'Sign out' });

    expect(document.activeElement).toBe(dialogButton('Sign out'));
    await press('Enter');

    await expect(pending).resolves.toBe(true);
  });

  it('resolves false on Escape', async () => {
    const pending = openConfirm({ message: 'Log out?' });

    await press('Escape');

    await expect(pending).resolves.toBe(false);
    expect(openDialog()).toBeNull();
  });

  it('leaves Enter to a focused Cancel button, so Enter there cancels and does not confirm', async () => {
    const pending = openConfirm({ message: 'Remove?', confirmLabel: 'Remove' });
    await act(async () => {
      dialogButton('Cancel').focus();
    });

    await press('Enter');
    expect(getAppDialogQueue()).toHaveLength(1);

    await click(dialogButton('Cancel'));
    await expect(pending).resolves.toBe(false);
  });

  it('wraps Tab from the last control to the first, and Shift+Tab from the first to the last', async () => {
    const pending = openConfirm({ message: 'Keep focus here?' });
    // Order inside the dialog: Cancel, then the confirm button (OK). jsdom does not move focus on Tab itself,
    // so only the wrap-around that the trap performs is checked here.
    await act(async () => {
      dialogButton('OK').focus();
    });
    await press('Tab');
    expect(document.activeElement).toBe(dialogButton('Cancel'));

    await act(async () => {
      dialogButton('Cancel').focus();
    });
    await press('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(dialogButton('OK'));

    await click(dialogButton('Cancel'));
    await expect(pending).resolves.toBe(false);
  });

  it('styles the confirm button as danger for a delete', async () => {
    const pending = openConfirm({
      message: 'Delete?',
      confirmLabel: 'Delete',
      tone: 'danger',
    });

    expect(dialogButton('Delete').classList.contains('app-dialog-button-danger')).toBe(true);
    expect(dialogButton('Cancel').classList.contains('app-dialog-button-danger')).toBe(false);
    await click(dialogButton('Cancel'));
    await pending;
  });

  it('shows the title as the dialog heading when one is given', async () => {
    const pending = openConfirm({ title: 'Log out', message: 'Log out now?' });

    const heading = openDialog()?.querySelector('h2');
    expect(heading?.textContent).toBe('Log out');
    expect(openDialog()?.getAttribute('aria-labelledby')).toBe(heading?.id);
    await click(dialogButton('Cancel'));
    await pending;
  });

  it('returns focus to the element that opened the dialog', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open';
    document.body.append(opener);
    opener.focus();

    const pending = openConfirm({ message: 'Focus back?' });
    expect(document.activeElement).not.toBe(opener);
    await press('Escape');
    await pending;

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('shows one dialog at a time and opens the next request after the first is answered', async () => {
    const first = openConfirm({ message: 'First question' });
    const second = openConfirm({ message: 'Second question' });

    expect(openDialog()?.textContent).toContain('First question');
    expect(openDialog()?.textContent).not.toContain('Second question');

    await click(dialogButton('Cancel'));
    await expect(first).resolves.toBe(false);
    expect(openDialog()?.textContent).toContain('Second question');

    await click(dialogButton('OK'));
    await expect(second).resolves.toBe(true);
  });
});

describe('promptDialog', () => {
  it('starts with the default value selected, and resolves the typed text on Enter', async () => {
    const pending = openPrompt({
      message: 'Rename motion',
      defaultValue: 'Intro',
      confirmLabel: 'Rename',
    });
    const input = openDialog()?.querySelector<HTMLInputElement>('input');

    expect(input?.value).toBe('Intro');
    expect(document.activeElement).toBe(input);
    expect(input?.selectionStart).toBe(0);
    expect(input?.selectionEnd).toBe('Intro'.length);

    if (input === undefined || input === null) throw new Error('Expected prompt input');
    await act(async () => setInputText(input, '  Opening title  '));
    await press('Enter');

    await expect(pending).resolves.toBe('  Opening title  ');
    expect(openDialog()).toBeNull();
  });

  it('resolves the typed text when the confirm button is clicked', async () => {
    const pending = openPrompt({ message: 'Save to My Templates', defaultValue: 'Copy' });
    const input = openDialog()?.querySelector<HTMLInputElement>('input');
    if (input === undefined || input === null) throw new Error('Expected prompt input');
    await act(async () => setInputText(input, 'Lower third'));

    await click(dialogButton('OK'));

    await expect(pending).resolves.toBe('Lower third');
  });

  it('resolves null on Escape and on Cancel', async () => {
    const escaped = openPrompt({ message: 'Rename motion', defaultValue: 'Intro' });
    await press('Escape');
    await expect(escaped).resolves.toBeNull();

    const cancelled = openPrompt({ message: 'Rename motion', defaultValue: 'Intro' });
    await click(dialogButton('Cancel'));
    await expect(cancelled).resolves.toBeNull();
  });

  it('uses the message as the label of the text field', async () => {
    const pending = openPrompt({ message: 'Rename motion', defaultValue: 'Intro' });
    const input = openDialog()?.querySelector<HTMLInputElement>('input');

    expect(openDialog()?.querySelector('label')?.textContent).toBe('Rename motion');
    expect(input?.id).toBeTruthy();
    expect(openDialog()?.querySelector('label')?.htmlFor).toBe(input?.id);
    await press('Escape');
    await pending;
  });
});

describe('AppDialogHost', () => {
  it('draws nothing when no dialog is open', () => {
    expect(container?.querySelector('.app-dialog-backdrop')).toBeNull();
  });
});
