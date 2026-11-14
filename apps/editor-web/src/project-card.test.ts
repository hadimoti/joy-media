import { describe, expect, it } from 'vitest';
import { formatDuration, formatLabel, projectCardView, relativeTime } from './project-card.js';
import type { ProjectCatalogEntry } from './project-catalog.js';

const NOW = new Date('2026-11-14T12:00:00.000Z');
const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

function entry(patch: Partial<ProjectCatalogEntry> = {}): ProjectCatalogEntry {
  return {
    id: 'p',
    title: 'P',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-14T10:00:00.000Z',
    timelineProjectId: 'p',
    visualProjectId: 'p',
    ...patch,
  };
}

describe('formatLabel', () => {
  it('reduces the size to a short ratio', () => {
    expect(formatLabel(1080, 1920)).toBe('9:16');
    expect(formatLabel(1920, 1080)).toBe('16:9');
    expect(formatLabel(1080, 1080)).toBe('1:1');
    expect(formatLabel(1080, 1350)).toBe('4:5');
  });

  it('shows the size when the ratio is not short', () => {
    expect(formatLabel(1000, 777)).toBe('1000×777');
    expect(formatLabel(1920.5, 1080)).toBe('1921×1080');
  });
});

describe('formatDuration', () => {
  it('shows minutes and seconds, with hours only when needed', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(24_000_000)).toBe('0:24');
    expect(formatDuration(125_000_000)).toBe('2:05');
    expect(formatDuration(3_723_000_000)).toBe('1:02:03');
  });

  it('rounds to the nearest second and never goes below zero', () => {
    expect(formatDuration(23_600_000)).toBe('0:24');
    expect(formatDuration(-5)).toBe('0:00');
  });
});

describe('relativeTime', () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  it('counts minutes, hours and days', () => {
    expect(relativeTime(ago(10_000), NOW)).toBe('just now');
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe('5 min ago');
    expect(relativeTime(ago(2 * 3_600_000 + 5000), NOW)).toBe('2 h ago');
    expect(relativeTime(ago(3 * 86_400_000), NOW)).toBe('3 d ago');
  });

  it('shows a date after 30 days', () => {
    expect(relativeTime(ago(40 * 86_400_000), NOW)).toMatch(/^on .*2026/);
  });

  it('treats a time in the future as just now and a broken time as unknown', () => {
    expect(relativeTime(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe('just now');
    expect(relativeTime('not a date', NOW)).toBe('at an unknown time');
  });
});

describe('projectCardView', () => {
  it('joins format, length and age', () => {
    const view = projectCardView(
      entry({ canvas: { width: 1080, height: 1920 }, durationUs: 24_000_000 }),
      NOW,
    );
    expect(view.meta).toBe('9:16 · 0:24 · edited 2 h ago');
    expect(view.format).toBe('9:16');
    expect(view.duration).toBe('0:24');
    expect(view.aspect).toBeCloseTo(9 / 16);
  });

  it('leaves out what is not known yet', () => {
    const view = projectCardView(entry(), NOW);
    expect(view.meta).toBe('edited 2 h ago');
    expect(view.format).toBeUndefined();
    expect(view.duration).toBeUndefined();
    expect(view.aspect).toBeCloseTo(16 / 9);
  });

  it('ignores a broken size or length', () => {
    const view = projectCardView(
      entry({ canvas: { width: 0, height: -3 }, durationUs: Number.NaN }),
      NOW,
    );
    expect(view.meta).toBe('edited 2 h ago');
  });

  it('words a trashed project by its trash time', () => {
    const view = projectCardView(
      entry({ trashedAt: '2026-11-14T11:30:00.000Z', durationUs: 1_000_000 }),
      NOW,
      true,
    );
    expect(view.meta).toBe('0:01 · moved to Trash 30 min ago');
  });

  it('accepts only a small image data URL as a cover', () => {
    expect(projectCardView(entry({ coverDataUrl: TINY_JPEG }), NOW).coverUrl).toBe(TINY_JPEG);
    expect(projectCardView(entry(), NOW).coverUrl).toBeUndefined();
    for (const bad of [
      'https://example.com/a.png',
      'javascript:alert(1)',
      'data:text/html;base64,PGI+',
      'data:image/svg+xml;base64,PHN2Zz4=',
      `data:image/jpeg;base64,${'A'.repeat(60 * 1024)}`,
    ]) {
      expect(projectCardView(entry({ coverDataUrl: bad }), NOW).coverUrl).toBeUndefined();
    }
  });
});
