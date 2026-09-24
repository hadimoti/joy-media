// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReleasableObjectUrl } from './media-object-url.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, {
      createObjectURL: vi.fn(() => 'blob:test'),
      revokeObjectURL: vi.fn(),
    }),
  );
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('App avatar object URL lifecycle', () => {
  it('removes the old avatar source before revoke on replace and unmount', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const target = container;
    const revoked: string[] = [];
    const owners = new Map<string, HTMLImageElement>();
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      const image = owners.get(url) ?? target.querySelector('img');
      if (image !== null) expect(image.getAttribute('src')).not.toBe(url);
      revoked.push(url);
    });
    function AvatarOwner({ url }: { readonly url: string }) {
      const imageRef = useReleasableObjectUrl<HTMLImageElement>(url);
      return <img ref={imageRef} src={url} alt="" />;
    }
    await act(async () => root?.render(<AvatarOwner url="blob:avatar-one" />));
    owners.set('blob:avatar-one', target.querySelector('img')!);
    await act(async () => root?.render(<AvatarOwner url="blob:avatar-two" />));
    expect(revoked).toEqual(['blob:avatar-one']);
    expect(target.querySelector('img')?.getAttribute('src')).toBe('blob:avatar-two');
    owners.set('blob:avatar-two', target.querySelector('img')!);

    await act(async () => root?.unmount());
    root = undefined;
    expect(revoked).toEqual(['blob:avatar-one', 'blob:avatar-two']);
  });
});
