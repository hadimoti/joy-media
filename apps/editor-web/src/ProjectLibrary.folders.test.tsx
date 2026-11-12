// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectLibrary } from './ProjectLibrary.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The project list with folder projects, inside the desktop app: a folder row sits next to the browser projects, and
 * opening it goes through the desktop's open (the approved gate) and then into the editor.
 */

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
  delete (window as { joyDesktop?: unknown }).joyDesktop;
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const FOLDER = {
  key: 'folder-1',
  name: 'Summer.joyproj',
  entry: {
    id: 'project-folder-1',
    title: 'Summer folder',
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
    timelineProjectId: 'project-folder-1',
    visualProjectId: 'project-folder-1',
  },
};

const READY = {
  kind: 'ready',
  claim: 'kept',
  id: 'project-folder-1',
  title: 'Summer folder',
  siblings: [],
};

function installDesktop(openReply: unknown = READY) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'desktop.project-folder.list') return { kind: 'listed', folders: [FOLDER] };
    if (channel === 'desktop.project-folder.open') return openReply;
    throw new Error(`unexpected channel ${channel}`);
  });
  (window as { joyDesktop?: unknown }).joyDesktop = { channels: [], invoke };
  return invoke;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderLibrary(onOpenFolder?: (...args: unknown[]) => Promise<string | undefined>) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const noop = () => undefined;
  act(() => {
    root?.render(
      <ProjectLibrary
        storage={memoryStorage()}
        onOpen={noop}
        onCreate={noop}
        onRename={noop as never}
        onDuplicate={noop as never}
        onTrash={noop}
        onRestore={noop}
        onPurge={noop}
        {...(onOpenFolder === undefined ? {} : { onOpenFolder })}
      />,
    );
  });
  await settle();
  return container;
}

function folderCard(): HTMLButtonElement {
  const card = [...(container?.querySelectorAll('button') ?? [])].find((button) =>
    button.textContent?.includes('Folder project · Summer.joyproj'),
  );
  if (card === undefined) throw new Error('no folder card');
  return card;
}

describe('folder projects in the project list', () => {
  it('shows a folder project next to the browser projects', async () => {
    installDesktop();
    const view = await renderLibrary(async () => undefined);
    expect(folderCard().textContent).toContain('Summer folder');
    // The seeded browser projects are still listed beside it.
    expect(view.querySelectorAll('.project-library-card').length).toBeGreaterThan(1);
  });

  it('opens a ready folder in the editor through the desktop open, without the old not-built words', async () => {
    const invoke = installDesktop();
    const onOpenFolder = vi.fn(async () => undefined);
    const view = await renderLibrary(onOpenFolder);
    await act(async () => {
      folderCard().click();
    });
    await settle();
    expect(invoke).toHaveBeenCalledWith('desktop.project-folder.open', { key: 'folder-1' });
    expect(onOpenFolder).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'folder-1', name: 'Summer.joyproj' }),
      READY,
    );
    expect(view.textContent).not.toContain('not built yet');
  });

  it('shows why a folder did not open in the editor', async () => {
    installDesktop();
    const view = await renderLibrary(
      async () => 'The saved project in this folder could not be read.',
    );
    await act(async () => {
      folderCard().click();
    });
    await settle();
    expect(view.textContent).toContain('The saved project in this folder could not be read.');
  });

  it('does not open the editor for a folder that is not ready', async () => {
    installDesktop({ kind: 'refused', code: 'busy' });
    const onOpenFolder = vi.fn(async () => undefined);
    const view = await renderLibrary(onOpenFolder);
    await act(async () => {
      folderCard().click();
    });
    await settle();
    expect(onOpenFolder).not.toHaveBeenCalled();
    expect(view.textContent).toContain('The project is busy.');
  });
});
