// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { emptySpikeProject } from '@joy-media/test-fixtures';
import { TimelineEmptyState } from './TimelineEmptyState.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The app's stylesheet. The name is held in a variable on purpose: written as
 * a literal, `new URL('./app.css', import.meta.url)` is an asset import to the
 * bundler, not a path on disk.
 */
const appCss = (): string => {
  const name = './app.css';
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
};

/** The body of the first rule that starts with the given selector. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(appCss());
  return match?.[1] ?? '';
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function renderEmptyState(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TimelineEmptyState
        project={emptySpikeProject({ trackCount: 0 })}
        _playheadUs={0}
        compositionDurationUs={30_000_000}
        viewportPixelsPerSecond={20}
        onSeek={() => undefined}
        onImportClick={() => undefined}
        onAddFromLibrary={() => undefined}
        onContextMenu={() => undefined}
      />,
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('the timeline empty state (T-D05)', () => {
  it('shows one hint', async () => {
    const rendered = await renderEmptyState();

    const hints = rendered.querySelectorAll<HTMLElement>('.timeline-empty-text');
    expect(hints).toHaveLength(1);
    expect(hints[0]?.textContent).toBe('Drag media here and start creating');
  });

  it('centres the hint', async () => {
    await renderEmptyState();

    expect(ruleBody('.timeline-empty-text')).toContain('text-align: center');
  });

  it('gives both buttons one size', async () => {
    const rendered = await renderEmptyState();

    const buttons = rendered.querySelectorAll<HTMLButtonElement>('.timeline-empty-action');
    expect(buttons).toHaveLength(2);
    // Both carry the same class, so the one size below is the size of both.
    expect(buttons[0]?.className).toBe(buttons[1]?.className);

    const rule = ruleBody('.timeline-empty-action');
    expect(rule).toContain('height:');
    expect(rule).toContain('min-width:');
  });
});
