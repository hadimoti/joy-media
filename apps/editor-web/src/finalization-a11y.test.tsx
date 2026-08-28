import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import { resolveDialogInitialFocusIndex, resolveDialogKeyAction } from './dialog-a11y.js';
import { ProjectLibrary, projectLibraryRemovalCopy } from './ProjectLibrary.js';
import { SpecialistReviewPanel } from './SpecialistReviewPanel.js';
import { isTimelineEmptyStateActivationKey, TimelineEmptyState } from './TimelineEmptyState.js';
import { upsertCatalogProject } from './project-catalog.js';

function createStorage(): BrowserKeyValueStore {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function emptyTimelineProject(): SpikeProject {
  return {
    id: 'timeline-project',
    rootCompositionId: 'root',
    compositions: {
      root: { id: 'root', tracks: [] },
    },
  } as unknown as SpikeProject;
}

function emptyCreativeProject(): JoyProjectV1 {
  return {
    id: 'creative-project',
  } as unknown as JoyProjectV1;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const normalized =
    value.length === 3
      ? value
          .split('')
          .map((part) => `${part}${part}`)
          .join('')
      : value;
  return [
    parseInt(normalized.slice(0, 2), 16),
    parseInt(normalized.slice(2, 4), 16),
    parseInt(normalized.slice(4, 6), 16),
  ];
}

function cssColorToRgb(value: string): [number, number, number] {
  if (value.startsWith('#')) return hexToRgb(value);
  const normalized = value.replaceAll(',', ' ');
  const rgbMatch = normalized.match(/rgba?\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)/u);
  if (rgbMatch !== null) {
    return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
  }
  throw new Error(`Unsupported CSS color: ${value}`);
}

function luminance([r, g, b]: readonly [number, number, number]): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(leftHex: string, rightHex: string): number {
  const left = luminance(cssColorToRgb(leftHex));
  const right = luminance(cssColorToRgb(rightHex));
  const lighter = Math.max(left, right);
  const darker = Math.min(left, right);
  return (lighter + 0.05) / (darker + 0.05);
}

function rootCssVariables(css: string): Record<string, string> {
  const rootBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/u)?.[1] ?? '';
  const matches = [...rootBlock.matchAll(/(--joy-[\w-]+):\s*([^;]+);/gu)];
  return Object.fromEntries(
    matches.flatMap((match) =>
      match[1] === undefined || match[2] === undefined
        ? []
        : [[match[1], match[2].trim()] as const],
    ),
  );
}

describe('Task 28 finalization accessibility and localization', () => {
  it('chooses initial dialog focus and wraps focus traversal', () => {
    expect(resolveDialogInitialFocusIndex([{ disabled: true }, { autoFocus: true }, {}])).toBe(1);
    expect(
      resolveDialogKeyAction({
        key: 'Tab',
        shiftKey: false,
        activeIndex: 2,
        focusableCount: 3,
      }),
    ).toEqual({ type: 'focus', index: 0 });
    expect(
      resolveDialogKeyAction({
        key: 'Tab',
        shiftKey: true,
        activeIndex: 0,
        focusableCount: 3,
      }),
    ).toEqual({ type: 'focus', index: 2 });
    expect(
      resolveDialogKeyAction({
        key: 'Escape',
        shiftKey: false,
        activeIndex: 0,
        focusableCount: 3,
      }),
    ).toEqual({ type: 'close' });
  });

  it('keeps the timeline empty-state keyboard entry points explicit', () => {
    expect(isTimelineEmptyStateActivationKey('Enter')).toBe(true);
    expect(isTimelineEmptyStateActivationKey(' ')).toBe(true);
    expect(isTimelineEmptyStateActivationKey('Escape')).toBe(false);
  });

  it('renders truthful project-library removal copy instead of a destructive delete claim', () => {
    const storage = createStorage();
    upsertCatalogProject(storage, {
      id: 'project-1',
      title: 'Demo Project',
      createdAt: '2026-08-21T12:00:00.000Z',
      updatedAt: '2026-08-21T12:00:00.000Z',
      timelineProjectId: 'project-1',
      visualProjectId: 'project-1',
    });

    const markup = renderToStaticMarkup(
      <ProjectLibrary storage={storage} onOpen={() => undefined} onCreate={() => undefined} />,
    );

    expect(markup).toContain('aria-label="Remove Demo Project from library"');
    expect(markup).toContain('title="Remove from library"');
    expect(markup).not.toContain('aria-label="Delete Demo Project"');
    expect(projectLibraryRemovalCopy('Demo Project')).toContain('Remove “Demo Project”');
    expect(projectLibraryRemovalCopy('Demo Project')).toContain('are not deleted');
  });

  it('preserves Persian explainer copy without forcing layout direction', () => {
    const timelineMarkup = renderToStaticMarkup(
      <TimelineEmptyState
        project={emptyTimelineProject()}
        _playheadUs={0}
        compositionDurationUs={0}
        viewportPixelsPerSecond={20}
        onSeek={() => undefined}
        onImportClick={() => undefined}
        onAddFromLibrary={() => undefined}
        onContextMenu={() => undefined}
      />,
    );
    const specialistMarkup = renderToStaticMarkup(
      <SpecialistReviewPanel
        timeline={emptyTimelineProject()}
        creative={emptyCreativeProject()}
        compositionId="root"
        selectedClipIds={[]}
        projectId="project-1"
        revisionId={() => 'revision-1'}
        onApplyChangeSet={() => undefined}
      />,
    );

    expect(timelineMarkup).toContain('class="timeline-empty-text" lang="fa"');
    expect(timelineMarkup).not.toContain('dir="rtl"');
    expect(specialistMarkup).toContain('class="specialist-empty" lang="fa"');
    expect(specialistMarkup).not.toContain('dir="rtl"');
  });

  it('keeps the touched dialogs on the shared accessibility helper path', () => {
    const assetSource = readFileSync(
      fileURLToPath(new URL('./AssetLibraryPanel.tsx', import.meta.url)),
      'utf8',
    );
    const appSource = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8');
    const workflowSource = readFileSync(
      fileURLToPath(new URL('./WorkflowsPanel.tsx', import.meta.url)),
      'utf8',
    );

    expect(assetSource).toContain('useAccessibleDialog');
    expect(assetSource).toContain('aria-modal="true"');
    expect(assetSource).toContain('button[aria-label="Choose media file"]:not([disabled])');
    expect(appSource).toContain('useAccessibleDialog');
    expect(appSource).toContain('aria-modal="true"');
    expect(workflowSource).toContain('useAccessibleDialog');
    expect(workflowSource).toContain('aria-modal="true"');
    expect(workflowSource).toContain('aria-labelledby="workflow-run-dialog-title"');
    expect(workflowSource).toContain('aria-labelledby="workflow-approval-dialog-title"');
    expect(workflowSource).toContain('No saved workflows yet.');

    const productionSource = readFileSync(
      fileURLToPath(new URL('./ProductionBoardPanel.tsx', import.meta.url)),
      'utf8',
    );
    const agentSource = readFileSync(
      fileURLToPath(new URL('./AgentPanel.tsx', import.meta.url)),
      'utf8',
    );
    expect(productionSource).toContain('aria-live="assertive"');
    expect(productionSource).toContain("event.key === 'Home'");
    expect(agentSource).toContain('role="alert" aria-live="assertive"');
  });

  it('uses token-driven styling for the finalized workflow and project-library surfaces', () => {
    const css = readFileSync(fileURLToPath(new URL('./app.css', import.meta.url)), 'utf8');
    const design = readFileSync(
      fileURLToPath(new URL('../../../DESIGN.md', import.meta.url)),
      'utf8',
    );

    const workflowDialogSection =
      css.match(/\.workflow-run-modal\s*\{[\s\S]*?\.workflow-run-actions\s*\{[\s\S]*?\n\}/u)?.[0] ??
      '';
    const projectLibraryBlock =
      css.match(
        /\/\* —— Project library gate —— \*\/[\s\S]*?\.project-library-delete:focus-visible \{\s*opacity: 1;\s*\}/u,
      )?.[0] ?? '';

    expect(workflowDialogSection).toContain('var(--joy-border)');
    expect(workflowDialogSection).toContain('var(--joy-bg-input)');
    expect(workflowDialogSection).not.toMatch(/#[0-9a-f]{3,8}/iu);
    expect(projectLibraryBlock).toContain('var(--joy-bg-app)');
    expect(projectLibraryBlock).toContain('var(--joy-border)');
    expect(design).toContain('Remove from library');
  });

  it('keeps core text contrast above WCAG AA for finalized shell tokens', () => {
    const css = readFileSync(fileURLToPath(new URL('./app.css', import.meta.url)), 'utf8');
    const vars = rootCssVariables(css);

    expect(contrastRatio(vars['--joy-text']!, vars['--joy-bg-control']!)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(
      contrastRatio(vars['--joy-text-secondary']!, vars['--joy-bg-panel']!),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
