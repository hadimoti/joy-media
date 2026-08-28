// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import { ProjectLibrary } from './ProjectLibrary.js';
import { PROJECT_CATALOG_KEY, ACTIVE_PROJECT_KEY } from './project-catalog.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function storage(): BrowserKeyValueStore {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe('ProjectLibrary empty state', () => {
  it('only presents starting actions that have working callbacks', () => {
    const store = storage();
    store.setItem(PROJECT_CATALOG_KEY, JSON.stringify({ version: 1, projects: {} }));
    const markup = renderToStaticMarkup(
      <ProjectLibrary storage={store} onOpen={() => undefined} onCreate={() => undefined} />,
    );

    expect(markup).toContain('Your project library is empty');
    expect(markup).toContain('Create a project to enter the editor.');
    expect(markup).toContain('>New project<');
    expect(markup).not.toContain('>Import media<');
    expect(markup).not.toContain('>Start from template<');
    expect(markup).not.toContain('disabled=""');
    expect(markup).not.toContain('Open last project');
    expect(markup).not.toContain('project-library-card');
  });

  it('exposes provided import and template contracts without placeholder projects', () => {
    const store = storage();
    store.setItem(PROJECT_CATALOG_KEY, JSON.stringify({ version: 1, projects: {} }));
    const importMedia = vi.fn();
    const startFromTemplate = vi.fn();
    const markup = renderToStaticMarkup(
      <ProjectLibrary
        storage={store}
        onOpen={() => undefined}
        onCreate={() => undefined}
        onImportMedia={importMedia}
        onStartFromTemplate={startFromTemplate}
      />,
    );

    expect(markup).not.toContain('disabled=""');
    expect(markup).not.toContain('Imported media');
    expect(markup).not.toContain('Template project');
  });

  it('invokes the provided import and template actions', () => {
    const store = storage();
    store.setItem(PROJECT_CATALOG_KEY, JSON.stringify({ version: 1, projects: {} }));
    const importMedia = vi.fn();
    const startFromTemplate = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <ProjectLibrary
          storage={store}
          onOpen={() => undefined}
          onCreate={() => undefined}
          onImportMedia={importMedia}
          onStartFromTemplate={startFromTemplate}
        />,
      );
    });
    const buttons = [...container.querySelectorAll('button')];
    act(() => buttons.find((button) => button.textContent === 'Import media')?.click());
    act(() => buttons.find((button) => button.textContent === 'Start from template')?.click());
    expect(importMedia).toHaveBeenCalledOnce();
    expect(startFromTemplate).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it('only offers open-last when the active project is a real catalog entry', () => {
    const store = storage();
    const entry = {
      id: 'last-project',
      title: 'Last cut',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      timelineProjectId: 'last-project',
      visualProjectId: 'last-project',
    };
    store.setItem(
      PROJECT_CATALOG_KEY,
      JSON.stringify({ version: 1, projects: { [entry.id]: entry } }),
    );
    store.setItem(ACTIVE_PROJECT_KEY, JSON.stringify({ version: 1, projectId: entry.id }));
    const open = vi.fn();
    const markup = renderToStaticMarkup(
      <ProjectLibrary storage={store} onOpen={open} onCreate={() => undefined} />,
    );

    expect(markup).toContain('Open last project');
    expect(markup).toContain('Last cut');
  });
});
