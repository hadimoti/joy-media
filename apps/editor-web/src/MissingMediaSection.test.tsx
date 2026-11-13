// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetRecordV1 } from '@joy-media/project-schema';
import { MissingMediaSection } from './MissingMediaSection.js';
import type { MissingMediaEntry } from './missing-media.js';
import type { MissingMediaHost } from './missing-media-host.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function entriesOf(count: number): MissingMediaEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const record: AssetRecordV1 = {
      id: `asset-${index}`,
      kind: 'video',
      displayName: `clip-${index}.mp4`,
      sha256: 'a'.repeat(64),
      bytes: 1024,
      descriptor: { mimeType: 'video/mp4' },
    };
    return { assetId: `asset-${index}`, record };
  });
}

/** Only `list` is exercised here; the relink and match calls belong to the desktop specs. */
function hostWith(entries: readonly MissingMediaEntry[]): MissingMediaHost {
  return {
    list: async () => entries,
  } as unknown as MissingMediaHost;
}

interface SectionProps {
  readonly projectId?: string;
  readonly revision?: string;
  readonly reviewRequested?: boolean;
  readonly onReviewRequestHandled?: () => void;
}

function section(host: MissingMediaHost, props: SectionProps) {
  return (
    <MissingMediaSection
      host={host}
      projectId={props.projectId ?? 'project-a'}
      revision={props.revision ?? 'r1'}
      reviewRequested={props.reviewRequested}
      onReviewRequestHandled={props.onReviewRequestHandled}
    />
  );
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function mount(host: MissingMediaHost, props: SectionProps = {}): Promise<HTMLDivElement> {
  const mounted = document.createElement('div');
  document.body.appendChild(mounted);
  const nextRoot = createRoot(mounted);
  root = nextRoot;
  container = mounted;
  await act(async () => {
    nextRoot.render(section(host, props));
  });
  await act(async () => undefined);
  return mounted;
}

/** Re-renders the mounted section with new props, as the editor does after an edit or a request. */
async function rerender(host: MissingMediaHost, props: SectionProps): Promise<void> {
  const current = root;
  await act(async () => {
    current?.render(section(host, props));
  });
  await act(async () => undefined);
}

async function unmount(): Promise<void> {
  const current = root;
  await act(async () => current?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
}

function buttonNamed(scope: ParentNode, label: string): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll('button')).find(
    (button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === label,
  );
}

const HIDE_LABEL = 'Hide missing media for this session';

afterEach(async () => {
  await unmount();
});

describe('MissingMediaSection banner', () => {
  it('shows one slim banner with the count and a Review button', async () => {
    const mounted = await mount(hostWith(entriesOf(3)));
    const banner = mounted.querySelector('.missing-media-banner');
    expect(banner?.textContent).toContain('3 files are missing from this project');
    expect(
      Array.from(banner?.querySelectorAll('button') ?? []).map(
        (button) => button.getAttribute('aria-label') ?? button.textContent?.trim(),
      ),
    ).toEqual(['Review', HIDE_LABEL]);
  });

  it('uses the singular for one missing file and shows nothing when none are missing', async () => {
    const one = await mount(hostWith(entriesOf(1)));
    expect(one.querySelector('.missing-media-banner')?.textContent).toContain(
      '1 file is missing from this project',
    );
    await unmount();

    const none = await mount(hostWith([]));
    expect(none.querySelector('section.missing-media')).toBeNull();
  });

  it('hides for the session when its close control is pressed, and stays hidden on remount', async () => {
    const host = hostWith(entriesOf(2));
    const first = await mount(host);
    const close = buttonNamed(first, HIDE_LABEL);
    expect(close).toBeDefined();
    await act(async () => close?.click());
    expect(first.querySelector('.missing-media-banner')).toBeNull();
    await unmount();

    const remounted = await mount(host);
    expect(remounted.querySelector('section.missing-media')).toBeNull();
    await unmount();

    const otherSession = await mount(hostWith(entriesOf(2)));
    expect(otherSession.querySelector('.missing-media-banner')).not.toBeNull();
  });

  it('brings a hidden banner back when the missing set changes', async () => {
    let entries = entriesOf(2);
    const host = { list: async () => entries } as unknown as MissingMediaHost;
    const mounted = await mount(host);
    await act(async () => buttonNamed(mounted, HIDE_LABEL)?.click());
    expect(mounted.querySelector('.missing-media-banner')).toBeNull();

    entries = entriesOf(3);
    await rerender(host, { revision: 'r2' });
    expect(mounted.querySelector('.missing-media-banner')?.textContent).toContain(
      '3 files are missing from this project',
    );
  });

  it('brings a hidden banner back when another project is open, even with the same missing set', async () => {
    const host = hostWith(entriesOf(2));
    const mounted = await mount(host, { projectId: 'project-a' });
    await act(async () => buttonNamed(mounted, HIDE_LABEL)?.click());
    expect(mounted.querySelector('.missing-media-banner')).toBeNull();

    await rerender(host, { projectId: 'project-b', revision: 'r2' });
    expect(mounted.querySelector('.missing-media-banner')).not.toBeNull();
  });
});

describe('MissingMediaSection review dialog', () => {
  it('lists one tidy row per file and has exactly one gold button', async () => {
    const mounted = await mount(hostWith(entriesOf(12)));
    const review = buttonNamed(mounted, 'Review');
    expect(review).toBeDefined();
    await act(async () => review?.click());

    const dialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Missing media"]',
    );
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelectorAll('.missing-media-row')).toHaveLength(12);
    expect(dialog?.querySelector('[data-missing-asset-id="asset-0"]')?.textContent).toContain(
      'clip-0.mp4',
    );

    const gold = Array.from(document.querySelectorAll('.asset-import-btn'));
    expect(gold).toHaveLength(1);
    expect(gold[0]?.textContent).toContain('Match files');

    const relinks = Array.from(dialog?.querySelectorAll('.missing-media-relink') ?? []);
    expect(relinks).toHaveLength(12);
    expect(relinks.every((label) => label.textContent?.trim() === 'Relink')).toBe(true);
    expect(dialog?.querySelector('input[aria-label="Relink clip-3.mp4"]')).not.toBeNull();
  });

  it('closes on Escape', async () => {
    const mounted = await mount(hostWith(entriesOf(2)));
    await act(async () => buttonNamed(mounted, 'Review')?.click());
    expect(document.querySelector('[role="dialog"][aria-label="Missing media"]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(document.querySelector('[role="dialog"][aria-label="Missing media"]')).toBeNull();
    expect(mounted.querySelector('.missing-media-banner')).not.toBeNull();
  });

  it('returns focus to the Review button on close, and Escape does not reach other listeners', async () => {
    const mounted = await mount(hostWith(entriesOf(2)));
    const review = buttonNamed(mounted, 'Review');
    expect(review).toBeDefined();
    review?.focus();
    await act(async () => review?.click());

    const elsewhere = vi.fn();
    window.addEventListener('keydown', elsewhere);
    try {
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(document.querySelector('[role="dialog"][aria-label="Missing media"]')).toBeNull();
      expect(document.activeElement).toBe(review);
      expect(elsewhere).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', elsewhere);
    }
  });

  it('the export Relink opens the Review dialog and shows the banner again when it was hidden', async () => {
    const host = hostWith(entriesOf(2));
    const mounted = await mount(host);
    await act(async () => buttonNamed(mounted, HIDE_LABEL)?.click());
    expect(mounted.querySelector('.missing-media-banner')).toBeNull();

    const handled = vi.fn();
    await rerender(host, { reviewRequested: true, onReviewRequestHandled: handled });

    expect(handled).toHaveBeenCalledTimes(1);
    expect(mounted.querySelector('.missing-media-banner')).not.toBeNull();
    expect(document.querySelector('[role="dialog"][aria-label="Missing media"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-missing-asset-id]')).toHaveLength(2);
  });
});
