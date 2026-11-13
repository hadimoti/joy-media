// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import { PopupProvider, usePopupManager } from './popup-manager.js';
import { POPUP_IDS } from './popup-ids.js';
import { PROJECT_CATALOG_KEY } from './project-catalog.js';
import { ProjectLibrary } from './ProjectLibrary.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-11-01T10:00:00.000Z';

function memoryStore(): BrowserKeyValueStore {
  const values = new Map<string, string>();
  values.set(
    PROJECT_CATALOG_KEY,
    JSON.stringify({
      version: 4,
      projects: {
        alpha: {
          id: 'alpha',
          title: 'Alpha',
          createdAt: NOW,
          updatedAt: NOW,
          timelineProjectId: 'alpha-timeline',
          visualProjectId: 'alpha-visual',
        },
      },
    }),
  );
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

const noop = () => undefined;

// Shows the id of the one open popup, as the app's header and the manager see it.
function ManagerProbe() {
  const { openId } = usePopupManager();
  return <output data-testid="open-id">{openId ?? 'none'}</output>;
}

function Screen({
  storage,
  showLibrary,
}: {
  readonly storage: BrowserKeyValueStore;
  readonly showLibrary: boolean;
}) {
  return (
    <PopupProvider>
      {showLibrary && (
        <ProjectLibrary
          storage={storage}
          onOpen={noop}
          onCreate={noop}
          onRename={noop}
          onDuplicate={noop}
          onTrash={noop}
          onRestore={noop}
          onPurge={noop}
        />
      )}
      <ManagerProbe />
    </PopupProvider>
  );
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function render(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
}

async function rerender(element: React.ReactElement) {
  await act(async () => root?.render(element));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function query<T extends Element>(selector: string): T | null {
  return container?.querySelector<T>(selector) ?? null;
}

function actionsTrigger(): HTMLButtonElement {
  const found = query<HTMLButtonElement>('button[aria-label="Project actions for Alpha"]');
  if (found === null) throw new Error('missing project actions trigger');
  return found;
}

function projectMenu(): Element | null {
  return query('[role="menu"][aria-label="Actions for Alpha"]');
}

function openIdText(): string | null | undefined {
  return query('[data-testid="open-id"]')?.textContent;
}

// A real click sends pointerdown before focus and click.
async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    element.focus();
    element.click();
  });
}

async function flushMicrotasks() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('ProjectLibrary project menu on the popup manager', () => {
  it('opening the project menu makes it the one open popup', async () => {
    await render(<Screen storage={memoryStore()} showLibrary />);

    await click(actionsTrigger());

    expect(projectMenu()).not.toBeNull();
    expect(openIdText()).toBe(POPUP_IDS.projectMenu);
    expect(actionsTrigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('unmounting the library while its menu is open leaves no stale open id', async () => {
    const storage = memoryStore();
    await render(<Screen storage={storage} showLibrary />);

    await click(actionsTrigger());
    expect(openIdText()).toBe(POPUP_IDS.projectMenu);

    await rerender(<Screen storage={storage} showLibrary={false} />);
    await flushMicrotasks();

    expect(openIdText()).toBe('none');

    await rerender(<Screen storage={storage} showLibrary />);
    await flushMicrotasks();

    expect(projectMenu()).toBeNull();
    expect(openIdText()).toBe('none');
    expect(actionsTrigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('after remounting, the project menu opens again from its trigger', async () => {
    const storage = memoryStore();
    await render(<Screen storage={storage} showLibrary />);

    await click(actionsTrigger());
    await rerender(<Screen storage={storage} showLibrary={false} />);
    await flushMicrotasks();
    await rerender(<Screen storage={storage} showLibrary />);
    await flushMicrotasks();

    await click(actionsTrigger());

    expect(projectMenu()).not.toBeNull();
    expect(openIdText()).toBe(POPUP_IDS.projectMenu);
  });
});

describe('ProjectLibrary New project asks for the format first', () => {
  function renderCreate(onCreate: (title: string, spec: unknown) => void) {
    return render(
      <PopupProvider>
        <ProjectLibrary
          storage={memoryStore()}
          onOpen={noop}
          onCreate={onCreate}
          onRename={noop}
          onDuplicate={noop}
          onTrash={noop}
          onRestore={noop}
          onPurge={noop}
        />
      </PopupProvider>,
    );
  }

  async function openNewProjectForm() {
    const newButton = query<HTMLButtonElement>('button[aria-label="New project"]');
    if (newButton === null) throw new Error('missing New project button');
    await click(newButton);
  }

  function formatRadio(value: string): HTMLInputElement {
    const radio = query<HTMLInputElement>(`input[name="new-project-format"][value="${value}"]`);
    if (radio === null) throw new Error(`missing format ${value}`);
    return radio;
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function typeName(value: string) {
    const input = query<HTMLInputElement>('input[placeholder="Project name"]');
    if (input === null) throw new Error('missing project name input');
    await act(async () => setInputValue(input, value));
  }

  async function submit() {
    const button = query<HTMLButtonElement>('button[aria-label="Create project"]');
    if (button === null) throw new Error('missing Create project button');
    await click(button);
  }

  it('shows the five formats, with 16:9 selected, before the name field', async () => {
    await renderCreate(vi.fn());
    await openNewProjectForm();

    const radios = Array.from(
      container?.querySelectorAll<HTMLInputElement>('input[name="new-project-format"]') ?? [],
    );
    expect(radios.map((input) => input.value)).toEqual([
      'youtube-16-9',
      'reels-9-16',
      'square-1-1',
      'feed-4-5',
      'custom',
    ]);
    expect(formatRadio('youtube-16-9').checked).toBe(true);

    const nameInput = query<HTMLInputElement>('input[placeholder="Project name"]');
    if (nameInput === null) throw new Error('missing project name input');
    const lastFormat = formatRadio('custom');
    expect(lastFormat.compareDocumentPosition(nameInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('creates the project with the chosen format and name', async () => {
    const onCreate = vi.fn();
    await renderCreate(onCreate);
    await openNewProjectForm();

    await click(formatRadio('reels-9-16'));
    await typeName('Reel');
    await submit();

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith('Reel', {
      canvas: { width: 1080, height: 1920 },
      presetId: 'reels-1080',
    });
  });

  it('creates a 16:9 project at 1920×1080 with the default selection', async () => {
    const onCreate = vi.fn();
    await renderCreate(onCreate);
    await openNewProjectForm();

    await typeName('Landscape');
    await submit();

    expect(onCreate).toHaveBeenCalledWith('Landscape', {
      canvas: { width: 1920, height: 1080 },
      presetId: 'youtube-1080',
    });
  });

  it('refuses a Custom size outside the limits and keeps the form open', async () => {
    const onCreate = vi.fn();
    await renderCreate(onCreate);
    await openNewProjectForm();

    await click(formatRadio('custom'));
    const width = query<HTMLInputElement>('.new-project-custom-size input');
    if (width === null) throw new Error('missing custom width');
    await act(async () => setInputValue(width, '4'));
    await typeName('Tiny');
    await submit();

    expect(onCreate).not.toHaveBeenCalled();
    expect(query('#project-create-error')?.textContent).toContain('16 to 7680');
    expect(query('input[placeholder="Project name"]')).not.toBeNull();
  });

  it('asks for a name after a valid format is chosen', async () => {
    const onCreate = vi.fn();
    await renderCreate(onCreate);
    await openNewProjectForm();

    await click(formatRadio('square-1-1'));
    await submit();

    expect(onCreate).not.toHaveBeenCalled();
    expect(query('#project-create-error')?.textContent).toBe(
      'Enter a project name before creating it.',
    );
  });
});
