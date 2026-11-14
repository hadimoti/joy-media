// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { TemplatesPanel } from './TemplatesPanel.js';
import { TransitionsPanel } from './TransitionsPanel.js';
import { TEMPLATE_FAVORITES_KEY } from './template-favorites.js';
import { TRANSITION_FAVORITES_KEY } from './transition-panel-state.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const storageMap = new Map<string, string>();
const storage = {
  getItem: (key: string) => storageMap.get(key) ?? null,
  setItem: (key: string, value: string) => storageMap.set(key, value),
  removeItem: (key: string) => storageMap.delete(key),
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  storageMap.clear();
});

async function mount(node: React.ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
    await Promise.resolve();
  });
  return container;
}

async function setSearch(panel: HTMLDivElement, text: string): Promise<void> {
  await act(async () => {
    panel.querySelector<HTMLButtonElement>('button[aria-label^="Search "]')?.click();
  });
  const input = panel.querySelector<HTMLInputElement>('input[type="search"]');
  if (input === null) throw new Error('the panel has no search box');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function renderTransitions() {
  return (
    <TransitionsPanel
      project={INITIAL_EDITOR_PROJECT}
      timelineProject={buildReferenceSpikeProject()}
      selectedClipIds={[]}
      onAddTransition={() => undefined}
      onRemoveTransition={() => undefined}
      onUpdateTransition={() => undefined}
      showToast={() => undefined}
      storage={storage}
    />
  );
}

function renderTemplates() {
  return (
    <TemplatesPanel
      onApplyTemplate={() => undefined}
      showToast={() => undefined}
      storage={storage}
    />
  );
}

describe('Transitions and Templates library interactions', () => {
  it('searches transition cards by id and narrows the results', async () => {
    const panel = await mount(renderTransitions());
    await setSearch(panel, 'gl:fadegrayscale');

    expect(panel.querySelector('[data-library-id="gl:fadegrayscale"]')).not.toBeNull();
    expect(panel.querySelectorAll('.transition-card')).toHaveLength(1);
  });

  it('filters transition cards to favorites and saves the selected id', async () => {
    const panel = await mount(renderTransitions());
    await act(async () => {
      panel
        .querySelector<HTMLButtonElement>('[data-library-id="gl:fade"] .library-card-favorite')
        ?.click();
    });
    await act(async () => {
      panel.querySelector<HTMLButtonElement>('[data-library-category="favorites"]')?.click();
    });

    expect(panel.querySelectorAll('.transition-card')).toHaveLength(1);
    expect(panel.querySelector('[data-library-id="gl:fade"]')).not.toBeNull();
    expect(storageMap.get(TRANSITION_FAVORITES_KEY)).toBe('["gl:fade"]');
  });

  it('searches templates by name across categories', async () => {
    const panel = await mount(renderTemplates());
    await setSearch(panel, 'spotlight');

    expect(panel.querySelector('[data-library-id="joy.spotlight-quote"]')).not.toBeNull();
    expect(panel.querySelectorAll('.template-card')).toHaveLength(1);
  });

  it('filters template cards to favorites and persists them', async () => {
    const panel = await mount(renderTemplates());
    await act(async () => {
      panel
        .querySelector<HTMLButtonElement>('[data-library-id="joy.title"] .library-card-favorite')
        ?.click();
    });
    await act(async () => {
      panel.querySelector<HTMLButtonElement>('[data-library-category="favorites"]')?.click();
    });

    expect(panel.querySelectorAll('.template-card')).toHaveLength(1);
    expect(panel.querySelector('[data-library-id="joy.title"]')).not.toBeNull();
    expect(storageMap.get(TEMPLATE_FAVORITES_KEY)).toBe('["joy.title"]');
  });
});
