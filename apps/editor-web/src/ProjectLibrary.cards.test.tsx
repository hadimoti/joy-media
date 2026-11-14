// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import { PopupProvider } from './popup-manager.js';
import { PROJECT_CATALOG_KEY, type ProjectCatalogEntry } from './project-catalog.js';
import { ProjectLibrary } from './ProjectLibrary.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const COVER = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const NOW = new Date('2026-11-14T12:00:00.000Z');
const TWO_HOURS_AGO = '2026-11-14T10:00:00.000Z';

function entry(id: string, patch: Partial<ProjectCatalogEntry> = {}): ProjectCatalogEntry {
  return {
    id,
    title: id,
    createdAt: TWO_HOURS_AGO,
    updatedAt: TWO_HOURS_AGO,
    timelineProjectId: id,
    visualProjectId: id,
    ...patch,
  };
}

function storeWith(entries: readonly ProjectCatalogEntry[]): BrowserKeyValueStore {
  const values = new Map<string, string>();
  values.set(
    PROJECT_CATALOG_KEY,
    JSON.stringify({
      version: 4,
      projects: Object.fromEntries(entries.map((item) => [item.id, item])),
    }),
  );
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

const noop = () => undefined;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function render(storage: BrowserKeyValueStore, onCreate: () => void = noop) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <PopupProvider>
        <ProjectLibrary
          storage={storage}
          onOpen={noop}
          onCreate={onCreate}
          onRename={noop}
          onDuplicate={noop}
          onTrash={noop}
          onRestore={noop}
          onPurge={noop}
        />
      </PopupProvider>,
    ),
  );
}

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function all<T extends Element>(selector: string): T[] {
  return [...(container?.querySelectorAll<T>(selector) ?? [])];
}

function cardFor(title: string): HTMLElement {
  const found = all<HTMLElement>('.project-library-card').find(
    (card) => card.querySelector('.project-library-card-title strong')?.textContent === title,
  );
  if (found === undefined) throw new Error(`no card for ${title}`);
  return found;
}

describe('ProjectLibrary project cards', () => {
  it('shows a large New project tile before the first card', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    await render(storeWith([entry('Alpha'), entry('Beta')]));
    const items = all<HTMLElement>('.project-library-grid > li');
    expect(items).toHaveLength(3);
    const tile = items[0]?.querySelector<HTMLButtonElement>('.project-library-new-tile');
    expect(tile).not.toBeNull();
    expect(tile?.textContent).toContain('New project');
    expect(items[1]?.querySelector('.project-library-card')).not.toBeNull();
    // One control with this name: the e2e specs click it by role and name.
    expect(all('button[aria-label="New project"]')).toHaveLength(1);
  });

  it('opens the New project form from the tile', async () => {
    await render(storeWith([entry('Alpha')]));
    expect(all('.project-library-create')).toHaveLength(0);
    await act(async () => all<HTMLButtonElement>('.project-library-new-tile')[0]?.click());
    expect(all('.project-library-create')).toHaveLength(1);
  });

  it('keeps the tile, beside the empty note, when no project exists yet', async () => {
    await render(storeWith([]));
    expect(all('.project-library-empty')).toHaveLength(1);
    expect(all('.project-library-new-tile')).toHaveLength(1);
    expect(all('.project-library-card')).toHaveLength(0);
  });

  it('puts the cover first, the title below it, and format · length · age under the title', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    await render(
      storeWith([
        entry('Alpha', {
          canvas: { width: 1080, height: 1920 },
          durationUs: 24_000_000,
          coverDataUrl: COVER,
        }),
      ]),
    );
    const card = cardFor('Alpha');
    const parts = [...card.children].map((child) => child.className);
    expect(parts).toEqual(['project-library-card-thumb', 'project-library-card-body']);
    const cover = card.querySelector<HTMLImageElement>('img.project-library-card-cover');
    expect(cover?.getAttribute('src')).toBe(COVER);
    expect(card.querySelector('.project-library-card-placeholder')).toBeNull();
    expect(card.querySelector('.project-library-card-meta')?.textContent).toBe(
      '9:16 · 0:24 · edited 2 h ago',
    );
    const body = card.querySelector('.project-library-card-body');
    expect([...(body?.children ?? [])].map((child) => child.className)).toEqual([
      'project-library-card-title',
      'project-library-card-meta',
    ]);
  });

  it('shows a placeholder with the format when the project has no cover', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    await render(
      storeWith([entry('Alpha', { canvas: { width: 1920, height: 1080 }, durationUs: 5_000_000 })]),
    );
    const card = cardFor('Alpha');
    expect(card.querySelector('img')).toBeNull();
    const placeholder = card.querySelector<HTMLElement>('.project-library-card-placeholder');
    expect(placeholder?.textContent).toBe('16:9');
    expect(placeholder?.classList.contains('is-wide')).toBe(true);
    expect(placeholder?.style.aspectRatio).toBe(String(16 / 9));
  });

  it('sizes a portrait placeholder by its height', async () => {
    await render(storeWith([entry('Tall', { canvas: { width: 1080, height: 1920 } })]));
    const placeholder = cardFor('Tall').querySelector<HTMLElement>(
      '.project-library-card-placeholder',
    );
    expect(placeholder?.classList.contains('is-tall')).toBe(true);
  });

  it('shows only the age for a project saved before cards existed', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    await render(storeWith([entry('Old')]));
    const card = cardFor('Old');
    expect(card.querySelector('.project-library-card-meta')?.textContent).toBe('edited 2 h ago');
    expect(card.querySelector('.project-library-card-placeholder')).not.toBeNull();
  });

  it('never loads a cover that is not a small image data URL', async () => {
    await render(
      storeWith([entry('Evil', { coverDataUrl: 'https://example.com/tracker.png' })]),
    );
    const card = cardFor('Evil');
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('.project-library-card-placeholder')).not.toBeNull();
  });

  it('has no New project tile in Trash, and words the age by the trash time', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    await render(
      storeWith([entry('Gone', { trashedAt: '2026-11-14T11:30:00.000Z', durationUs: 1_000_000 })]),
    );
    const trashTab = all<HTMLButtonElement>('.project-library-tabs button').find((button) =>
      button.textContent?.startsWith('Trash'),
    );
    await act(async () => trashTab?.click());
    expect(all('.project-library-new-tile')).toHaveLength(0);
    expect(cardFor('Gone').querySelector('.project-library-card-meta')?.textContent).toBe(
      '0:01 · moved to Trash 30 min ago',
    );
  });
});
