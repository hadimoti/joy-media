// @vitest-environment jsdom
/**
 * Behaviour tests for the library card previews (T-V07 / T-V09).
 *
 * Covered: hover and focus start playing, reduced motion keeps the still, strip
 * frame stepping and the scrub bar, the preview fallback after a load error, the
 * before/after slider, rail keyboard roving, and that the Filters and Effects
 * panels render the shared LibraryCard and LibraryRail.
 *
 * Not covered (jsdom does no layout and has no image decoding): the 280 px panel
 * layout and the visible look of the frames. Those need the attended driver run.
 * The suite drives React with act and DOM events, like the other panel tests,
 * because Testing Library is not installed in this repository.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EffectPreviewMedia } from './EffectPreviewMedia.js';
import { LibraryCard } from './LibraryCard.js';
import { LibraryRail, libraryTabPanelProps } from './LibraryRail.js';
import { TransitionStripPreview } from './TransitionStripPreview.js';

vi.mock('./editor-panel-context.js', async () => {
  const { createContext } = await import('react');
  return { EditorPanelContext: createContext(undefined) };
});

vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
});

import { EffectsPanel } from './EffectsPanel.js';
import { FiltersPanel } from './FiltersPanel.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function setReducedMotion(reduced: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: reduced && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  setReducedMotion(false);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.useRealTimers();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

function render(node: React.ReactNode): HTMLDivElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return container;
}

function setRange(input: HTMLInputElement, value: number): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function cardWithStrip() {
  return (
    <LibraryCard
      id="gl:fade"
      name="Fade"
      description="Cross fade"
      preview={(active) => (
        <TransitionStripPreview transitionId="gl:fade" label="Fade" playing={active} />
      )}
      isFavorite={false}
      onToggleFavorite={() => undefined}
      onAdd={() => undefined}
    />
  );
}

function strip(): HTMLElement {
  const element = container?.querySelector<HTMLElement>('.transition-strip');
  if (element === null || element === undefined) throw new Error('no strip rendered');
  return element;
}

function frameOf(element: HTMLElement): number {
  return Number(element.dataset['stripFrame']);
}

function activeOf(element: HTMLElement): string | undefined {
  return element.dataset['previewPlaying'];
}

describe('library card hover and focus play', () => {
  function previewProbe() {
    return (
      <LibraryCard
        id="probe"
        name="Probe"
        description="Probe card"
        preview={(active) => <span data-testid="probe" data-active={String(active)} />}
        isFavorite={false}
        onToggleFavorite={() => undefined}
        onAdd={() => undefined}
      />
    );
  }
  const probeActive = () =>
    container?.querySelector<HTMLElement>('[data-testid="probe"]')?.dataset['active'];

  it('starts on pointer enter and stops on pointer leave', () => {
    const view = render(previewProbe());
    const card = view.querySelector<HTMLElement>('[data-library-card="true"]')!;
    expect(probeActive()).toBe('false');

    act(() => {
      card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(probeActive()).toBe('true');

    act(() => {
      card.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(probeActive()).toBe('false');
  });

  it('starts on keyboard focus inside the card and stops on blur', () => {
    const view = render(previewProbe());
    const favorite = view.querySelector<HTMLButtonElement>('.library-card-favorite')!;

    act(() => favorite.focus());
    expect(probeActive()).toBe('true');

    act(() => favorite.blur());
    expect(probeActive()).toBe('false');
  });

  it('keeps the still with reduced motion, on hover and on focus', () => {
    setReducedMotion(true);
    const view = render(previewProbe());
    const card = view.querySelector<HTMLElement>('[data-library-card="true"]')!;

    act(() => {
      card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(probeActive()).toBe('false');

    act(() => view.querySelector<HTMLButtonElement>('.library-card-favorite')!.focus());
    expect(probeActive()).toBe('false');
  });
});

describe('transition strip preview', () => {
  it('shows the still first frame at rest and loads the 24-frame WebP strip', () => {
    const view = render(cardWithStrip());
    const image = view.querySelector<HTMLImageElement>('img.transition-strip-image')!;

    expect(frameOf(strip())).toBe(0);
    expect(activeOf(strip())).toBe('false');
    expect(image.getAttribute('src')).toMatch(/^\/transitions\/preview\/gl-fade\.webp\?v=/);
    expect(image.style.transform).toBe('translateX(-0%)');
    expect(view.querySelector('canvas')).toBeNull();
    expect(image.getAttribute('src')).not.toContain('.svg');
  });

  it('steps frames while the pointer is on the card and returns to the still after', () => {
    vi.useFakeTimers();
    const view = render(cardWithStrip());
    const card = view.querySelector<HTMLElement>('[data-library-card="true"]')!;

    act(() => {
      card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(activeOf(strip())).toBe('true');
    act(() => {
      vi.advanceTimersByTime(42 * 5);
    });
    expect(frameOf(strip())).toBe(5);
    expect(
      view.querySelector<HTMLImageElement>('img.transition-strip-image')!.style.transform,
    ).toBe(`translateX(-${(5 / 24) * 100}%)`);

    act(() => {
      card.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(frameOf(strip())).toBe(0);
    expect(activeOf(strip())).toBe('false');
  });

  it('wraps around after the last frame', () => {
    vi.useFakeTimers();
    const view = render(cardWithStrip());
    act(() => {
      view
        .querySelector<HTMLElement>('[data-library-card="true"]')!
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(42 * 24);
    });
    expect(frameOf(strip())).toBe(0);
    act(() => {
      vi.advanceTimersByTime(42 * 2);
    });
    expect(frameOf(strip())).toBe(2);
  });

  it('does not autoplay with reduced motion, and the scrub bar still moves the frame', () => {
    vi.useFakeTimers();
    setReducedMotion(true);
    const view = render(cardWithStrip());
    const card = view.querySelector<HTMLElement>('[data-library-card="true"]')!;
    act(() => {
      card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(frameOf(strip())).toBe(0);
    expect(activeOf(strip())).toBe('false');

    const scrub = view.querySelector<HTMLInputElement>('input.transition-strip-scrub')!;
    setRange(scrub, 12);
    expect(frameOf(strip())).toBe(12);
    expect(scrub.getAttribute('aria-valuetext')).toBe('Frame 13 of 24');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(frameOf(strip())).toBe(12);
  });

  it('pauses autoplay when the scrub bar is used while playing', () => {
    vi.useFakeTimers();
    const view = render(cardWithStrip());
    act(() => {
      view
        .querySelector<HTMLElement>('[data-library-card="true"]')!
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(42 * 3);
    });
    setRange(view.querySelector<HTMLInputElement>('input.transition-strip-scrub')!, 20);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(frameOf(strip())).toBe(20);
  });

  it('labels the scrub bar with the transition name and covers every frame', () => {
    const view = render(cardWithStrip());
    const scrub = view.querySelector<HTMLInputElement>('input.transition-strip-scrub')!;
    expect(scrub.getAttribute('aria-label')).toBe('Scrub Fade preview');
    expect(scrub.min).toBe('0');
    expect(scrub.max).toBe('23');
  });

  it('shows the fallback state instead of a broken image when the strip is missing', () => {
    const view = render(cardWithStrip());
    const image = view.querySelector<HTMLImageElement>('img.transition-strip-image')!;

    act(() => {
      image.dispatchEvent(new Event('error'));
    });

    expect(strip().classList.contains('is-fallback')).toBe(true);
    expect(view.querySelector('img')).toBeNull();
  });
});

describe('effect preview media', () => {
  it('shows the result picture alone, with no slider, divider or labels', () => {
    const view = render(<EffectPreviewMedia effectId="pixelate" label="Pixelate" />);
    expect(view.querySelector('input')).toBeNull();
    expect(view.querySelector('.library-compare-divider')).toBeNull();
    expect(view.textContent).not.toMatch(/Before|After/);
    expect(view.querySelectorAll('img')).toHaveLength(1);
  });

  it('falls back when the picture is missing', () => {
    const view = render(<EffectPreviewMedia effectId="pixelate" />);
    const image = view.querySelector<HTMLImageElement>('img.effect-preview-media-fallback')!;

    act(() => {
      image.dispatchEvent(new Event('error'));
    });

    const media = view.querySelector<HTMLElement>('.effect-preview-media')!;
    expect(media.classList.contains('is-fallback')).toBe(true);
    expect(view.querySelector('img')).toBeNull();
    expect(view.querySelector('input')).toBeNull();
  });
});

describe('library rail', () => {
  function rail(onSelect: (id: string) => void, selectedId = 'b') {
    return (
      <div>
        <LibraryRail
          label="Test categories"
          panelId="test-panel"
          selectedId={selectedId}
          onSelect={onSelect}
          items={[
            { id: 'a', label: 'Alpha', count: 1 },
            { id: 'b', label: 'Beta', count: 2 },
            { id: 'c', label: 'Gamma', count: 3 },
          ]}
        />
        <div {...libraryTabPanelProps('test-panel', selectedId)} />
      </div>
    );
  }

  it('marks the selected tab, keeps one tab stop and ties the tab to its panel', () => {
    const view = render(rail(() => undefined));
    const tabs = [...view.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual([null, 'true', null]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
    const panel = view.querySelector<HTMLElement>('[role="tabpanel"]')!;
    expect(panel.id).toBe('test-panel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[1]!.id);
    expect(tabs[1]!.getAttribute('aria-controls')).toBe('test-panel');
  });

  it.each([
    ['ArrowDown', 'c'],
    ['ArrowRight', 'c'],
    ['ArrowUp', 'a'],
    ['ArrowLeft', 'a'],
    ['Home', 'a'],
    ['End', 'c'],
  ])('moves the selection with %s', (key, expected) => {
    const onSelect = vi.fn();
    const view = render(rail(onSelect));
    const selected = view.querySelector<HTMLButtonElement>('[aria-selected="true"]')!;

    act(() => {
      selected.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
    });

    expect(onSelect).toHaveBeenCalledWith(expected);
  });

  it('wraps from the last tab to the first', () => {
    const onSelect = vi.fn();
    const view = render(rail(onSelect, 'c'));
    act(() => {
      view
        .querySelector<HTMLButtonElement>('[aria-selected="true"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('a');
  });
});

describe('the Filters and Effects panels use the shared card and rail', () => {
  it('Filters renders LibraryRail tabs, a tab panel and LibraryCards with before/after previews', async () => {
    const view = render(
      <FiltersPanel canCreate={true} targetLabel="Product" onAddFilter={() => undefined} />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(view.querySelectorAll('.library-rail [role="tab"]').length).toBeGreaterThan(1);
    const panel = view.querySelector<HTMLElement>('[role="tabpanel"]')!;
    const selected = view.querySelector<HTMLElement>('.library-rail [aria-selected="true"]')!;
    expect(panel.getAttribute('aria-labelledby')).toBe(selected.id);
    const cards = panel.querySelectorAll('article.library-card[data-library-card="true"]');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0]!.querySelector('.effect-preview-media')).not.toBeNull();
    expect(cards[0]!.getAttribute('role')).toBeNull();
    expect(cards[0]!.getAttribute('aria-label')).toBeNull();
  });

  it('Effects renders LibraryRail tabs, a tab panel and LibraryCards', async () => {
    const view = render(
      <EffectsPanel
        project={INITIAL_EDITOR_PROJECT}
        objectId={undefined}
        canApplyEffects={false}
        onDispatch={() => undefined}
        showToast={() => undefined}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(view.querySelectorAll('.library-rail [role="tab"]').length).toBeGreaterThan(1);
    const panel = view.querySelector<HTMLElement>('[role="tabpanel"]')!;
    expect(
      panel.querySelectorAll('article.library-card[data-library-card="true"]').length,
    ).toBeGreaterThan(0);
  });
});
