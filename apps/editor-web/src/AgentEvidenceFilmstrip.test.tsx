// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentEvidenceFilmstrip,
  type AgentEvidenceFilmstripEvidence,
  type AgentEvidenceFilmstripProps,
} from './AgentEvidenceFilmstrip.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cursorRange = { startUs: 0, endUs: 2_000_000 } as const;

const evidence: readonly AgentEvidenceFilmstripEvidence[] = Object.freeze([
  Object.freeze({ id: 'evidence-01', timestampUs: 500_000, coverage: 'sampled' as const }),
  Object.freeze({ id: 'evidence-02', timestampUs: 1_000_000, coverage: 'partial' as const }),
  Object.freeze({ id: 'evidence-03', timestampUs: 1_500_000, coverage: 'unknown' as const }),
]);

function props(overrides: Partial<AgentEvidenceFilmstripProps> = {}): AgentEvidenceFilmstripProps {
  return {
    evidence,
    reviewCursorRange: cursorRange,
    reviewCursorUs: 500_000,
    reviewCursorStepUs: 100_000,
    onReviewCursorChange: () => undefined,
    ...overrides,
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('AgentEvidenceFilmstrip', () => {
  it('renders safe timestamp and explicit coverage labels with distinct read and proposed ranges', () => {
    const privateFields = {
      url: 'https://provider.example/raw-video.mp4',
      path: 'C:\\private\\source.mov',
      provider: 'private-provider',
      blob: new Blob(['raw media']),
    };
    const markup = renderToStaticMarkup(
      <AgentEvidenceFilmstrip
        {...props({
          evidence: [
            {
              ...evidence[0]!,
              ...privateFields,
            } as unknown as AgentEvidenceFilmstripEvidence,
            ...evidence.slice(1),
          ],
          activeReadRange: { startUs: 0, endUs: 1_000_000 },
          proposedEditRange: { startUs: 1_200_000, endUs: 1_800_000 },
          direction: 'rtl',
          narrow: true,
          reducedMotion: true,
        })}
      />,
    );

    expect(markup).toContain('data-agent-evidence-filmstrip="true"');
    expect(markup).toContain('class="agent-evidence-filmstrip is-narrow is-rtl is-reduced-motion"');
    expect(markup).toContain('dir="rtl"');
    expect(markup).toContain('0:00.500');
    expect(markup).toContain('Sampled coverage');
    expect(markup).toContain('Partial coverage');
    expect(markup).toContain('Coverage unknown');
    expect(markup).toContain('data-evidence-range="active-read"');
    expect(markup).toContain('Active read range');
    expect(markup).toContain('data-evidence-range="proposed-edit"');
    expect(markup).toContain('Proposed edit range');
    expect(markup).toContain('aria-label="Review cursor (does not change playback)"');
    expect(markup).toContain(
      'Use arrow keys to move this review cursor independently of playback.',
    );
    expect(markup).not.toContain(privateFields.url);
    expect(markup).not.toContain(privateFields.path);
    expect(markup).not.toContain(privateFields.provider);
  });

  it('uses only the controlled review cursor callback for keyboard and evidence-marker navigation', async () => {
    const onReviewCursorChange = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const rendered = container;

    await act(async () => {
      root?.render(<AgentEvidenceFilmstrip {...props({ onReviewCursorChange })} />);
    });

    const cursor = rendered.querySelector<HTMLInputElement>('input[type="range"]');
    expect(cursor?.getAttribute('aria-label')).toBe('Review cursor (does not change playback)');
    expect(cursor?.getAttribute('aria-keyshortcuts')).toContain('ArrowRight');

    await act(async () => {
      cursor?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
      cursor?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }),
      );
      if (cursor !== null) {
        const nativeValueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        nativeValueSetter?.call(cursor, '700000');
        cursor.dispatchEvent(new Event('input', { bubbles: true }));
      }
      rendered.querySelector<HTMLButtonElement>('button[data-evidence-time-us="1500000"]')?.click();
    });

    expect(onReviewCursorChange).toHaveBeenNthCalledWith(1, 600_000);
    expect(onReviewCursorChange).toHaveBeenNthCalledWith(2, 0);
    expect(onReviewCursorChange).toHaveBeenNthCalledWith(3, 700_000);
    expect(onReviewCursorChange).toHaveBeenNthCalledWith(4, 1_500_000);
    expect(onReviewCursorChange).toHaveBeenCalledTimes(4);
  });

  it('fails closed for malformed cursor bounds and does not expose malformed evidence markers', () => {
    const invalidMarkup = renderToStaticMarkup(
      <AgentEvidenceFilmstrip
        {...props({ reviewCursorRange: { startUs: 2_000_000, endUs: 0 } })}
      />,
    );
    expect(invalidMarkup).toBe('');

    const markup = renderToStaticMarkup(
      <AgentEvidenceFilmstrip
        {...props({
          evidence: [
            ...evidence,
            { id: '../not-a-safe-marker', timestampUs: 1_000_000, coverage: 'sampled' },
            { id: 'bad-time', timestampUs: Number.NaN, coverage: 'unknown' },
          ] as readonly AgentEvidenceFilmstripEvidence[],
        })}
      />,
    );
    expect(markup).not.toContain('not-a-safe-marker');
    expect(markup).not.toContain('bad-time');
    expect(markup).toContain('data-evidence-time-us="500000"');
  });
});
