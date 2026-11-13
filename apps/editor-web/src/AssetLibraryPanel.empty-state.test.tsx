// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetLibraryPanel } from './AssetLibraryPanel.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The import itself is not what this card is about; the drop zone is. The
// mock fails on purpose, so the test can see that the dropped file reached it.
const mocks = vi.hoisted(() => ({
  importMediaFile: vi.fn(async () => {
    throw new Error('the import stops here in the test');
  }),
}));

vi.mock('./media-import.js', () => ({
  describeMedia: vi.fn(async () => ({ kind: 'video' as const, durationUs: 1_000_000 })),
  importMediaFile: mocks.importMediaFile,
}));

const storage = {
  getItem: (): string | null => null,
  setItem: (): void => undefined,
  removeItem: (): void => undefined,
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function renderPanel(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<AssetLibraryPanel projectId="project-1" storage={storage} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

/** A file the way the browser hands one to a drop handler. */
function droppedFile(name: string): File {
  return new File(['bytes'], name, { type: 'video/mp4' });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  mocks.importMediaFile.mockClear();
  vi.restoreAllMocks();
});

describe('the Media panel empty state (T-D05)', () => {
  it('says one thing and offers one way in', async () => {
    const rendered = await renderPanel();

    const dropZone = rendered.querySelector<HTMLElement>('.asset-library-drop-zone');
    expect(dropZone, 'the empty library is a drop zone').not.toBeNull();
    expect(dropZone?.textContent).toContain('Drop video, audio or images here');

    const buttons = [
      ...rendered.querySelectorAll<HTMLButtonElement>('.asset-library-empty button'),
    ];
    expect(buttons, 'the empty state offers exactly one button').toHaveLength(1);
    expect(buttons[0]?.textContent?.trim()).toBe('Import');
    expect(buttons[0]?.className).toContain('button-primary');

    // One message, not two: the filters did not hide anything, the library is empty.
    expect(rendered.textContent).not.toContain('No library assets match the current filters.');
    expect(rendered.textContent).not.toContain('Failed to load media catalog.');
  });

  it('imports a file dropped on the drop zone', async () => {
    const rendered = await renderPanel();
    const dropZone = rendered.querySelector<HTMLElement>('.asset-library-drop-zone');
    if (dropZone === null) throw new Error('Expected the asset library drop zone');

    const file = droppedFile('clip.mp4');
    const transfer = {
      files: [file],
      types: ['Files'],
      dropEffect: 'none',
    };
    // jsdom has no DragEvent, so the drop is a plain event carrying the
    // dataTransfer the way a browser would.
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: transfer });
    await act(async () => {
      dropZone.dispatchEvent(drop);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.importMediaFile).toHaveBeenCalledTimes(1);
    expect(mocks.importMediaFile).toHaveBeenCalledWith(
      expect.objectContaining({ file, projectId: 'project-1' }),
    );
  });
});
