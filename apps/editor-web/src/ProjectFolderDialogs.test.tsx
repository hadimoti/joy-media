// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectFolderAskDialog } from './ProjectFolderDialogs.js';
import type { ProjectFolderAsk } from './project-folder-client.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(element: ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(element);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
});

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent === text,
  );
  if (found === undefined) throw new Error(`no button named ${text}`);
  return found;
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setValue?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const noRecord: ProjectFolderAsk = { reason: 'no-record', projectId: 'project-1', siblings: [] };
const lostEntry: ProjectFolderAsk = {
  reason: 'entry-missing',
  projectId: 'project-1',
  recordedPath: 'C:\\Projects\\Summer.joyproj',
  recordedAt: '2026-11-10T10:00:00.000Z',
  siblings: [],
};

function askDialog(overrides: Partial<Parameters<typeof ProjectFolderAskDialog>[0]> = {}) {
  return (
    <ProjectFolderAskDialog
      folderName="Summer.joyproj"
      ask={noRecord}
      busy={false}
      onAnswer={vi.fn()}
      onRestore={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />
  );
}

describe('the ask dialog', () => {
  it('shows the question and both answers, and focuses neither of them', () => {
    render(askDialog());
    expect(container?.querySelector('h2')?.textContent).toBe('Which folder is the original?');
    expect(buttonNamed('This is the original')).toBeDefined();
    expect(buttonNamed('This is a copy')).toBeDefined();
    const focused = document.activeElement;
    expect(focused === buttonNamed('This is the original')).toBe(false);
    expect(focused === buttonNamed('This is a copy')).toBe(false);
  });

  it('sends the answer the owner picks, and nothing else', () => {
    const onAnswer = vi.fn();
    render(askDialog({ onAnswer }));
    act(() => buttonNamed('This is a copy').click());
    expect(onAnswer).toHaveBeenLastCalledWith('copy');
    act(() => buttonNamed('This is the original').click());
    expect(onAnswer).toHaveBeenLastCalledWith('original');
    expect(onAnswer).toHaveBeenCalledTimes(2);
  });

  it('closes without an answer on Not now', () => {
    const onClose = vi.fn();
    const onAnswer = vi.fn();
    render(askDialog({ onClose, onAnswer }));
    act(() => buttonNamed('Not now').click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('disables both answers while a change is being saved', () => {
    render(askDialog({ busy: true }));
    expect(buttonNamed('This is the original').disabled).toBe(true);
    expect(buttonNamed('This is a copy').disabled).toBe(true);
  });

  it('names the folder, and shows where the original was last seen', () => {
    render(askDialog({ ask: lostEntry }));
    expect(container?.textContent).toContain('Summer.joyproj');
    expect(container?.textContent).toContain('C:\\Projects\\Summer.joyproj');
  });
});

describe('the notice and the copy choice', () => {
  it('shows a refused answer inside the dialog, where the owner can see it', () => {
    render(
      askDialog({ notice: 'The original of this project id is still where it was recorded.' }),
    );
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      'still where it was recorded',
    );
  });

  it('offers only the original when a copy would be refused at this place', () => {
    render(
      askDialog({
        ask: {
          reason: 'claimant-missing',
          recordedPath: 'C:\\Projects\\Summer.joyproj',
          placeState: 'this-folder',
          siblings: [],
        },
      }),
    );
    expect(buttonNamed('This is the original')).toBeDefined();
    const labels = [...(container?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    expect(labels).not.toContain('This is a copy');
  });
});

describe('the restore prompt for a lost entry', () => {
  it('keeps the restore button off until a title is typed', () => {
    render(askDialog({ ask: lostEntry }));
    const restore = buttonNamed('Restore project');
    expect(restore.disabled).toBe(true);
    const input = container?.querySelector('input');
    if (input === null || input === undefined) throw new Error('no title input');
    act(() => typeInto(input, '   '));
    expect(buttonNamed('Restore project').disabled).toBe(true);
  });

  it('sends the trimmed title when the owner restores', () => {
    const onRestore = vi.fn();
    render(askDialog({ ask: lostEntry, onRestore }));
    const input = container?.querySelector('input');
    if (input === null || input === undefined) throw new Error('no title input');
    act(() => typeInto(input, '  Summer again  '));
    const form = container?.querySelector('form');
    if (form === null || form === undefined) throw new Error('no restore form');
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onRestore).toHaveBeenCalledWith('Summer again');
  });
});
