import { describe, expect, it, vi } from 'vitest';
import { registerJoyProtocol } from './protocol-registration.js';

function fakeApp(isPackaged: boolean) {
  return { isPackaged, setAsDefaultProtocolClient: vi.fn((_protocol: string) => true) };
}

describe('registerJoyProtocol', () => {
  it('claims the joy protocol in a packaged build', () => {
    const app = fakeApp(true);

    expect(registerJoyProtocol(app)).toBe(true);
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('joy');
  });

  it('leaves the joy protocol alone in a development run', () => {
    const app = fakeApp(false);

    expect(registerJoyProtocol(app)).toBe(false);
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });
});
