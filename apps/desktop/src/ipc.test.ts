import { describe, expect, it } from 'vitest';
import { isTrustedIpcSenderFrame } from './ipc.js';

describe('IPC sender frame policy', () => {
  it('accepts the allow-listed main frame and its canonical app origin', () => {
    const frame = { url: 'joy-media-app://renderer/index.html' };
    expect(
      isTrustedIpcSenderFrame({ senderFrame: frame, mainFrame: frame }, 'joy-media-app://renderer'),
    ).toBe(true);
  });

  it('rejects a frame whose origin is not the origin the request claims', () => {
    const frame = { url: 'https://joyst.ir/editor' };
    expect(
      isTrustedIpcSenderFrame({ senderFrame: frame, mainFrame: frame }, 'https://www.joyst.ir'),
    ).toBe(false);
    expect(
      isTrustedIpcSenderFrame({ senderFrame: frame, mainFrame: frame }, 'joy-media-app://renderer'),
    ).toBe(false);
    const appFrame = { url: 'joy-media-app://renderer/index.html' };
    expect(
      isTrustedIpcSenderFrame({ senderFrame: appFrame, mainFrame: appFrame }, 'https://joyst.ir'),
    ).toBe(false);
  });

  it('rejects subframes, mismatched origins and malformed frame URLs', () => {
    const mainFrame = { url: 'https://joyst.ir/editor' };
    expect(
      isTrustedIpcSenderFrame(
        { senderFrame: { url: 'https://joyst.ir/iframe' }, mainFrame },
        'https://joyst.ir',
      ),
    ).toBe(false);
    expect(
      isTrustedIpcSenderFrame({ senderFrame: mainFrame, mainFrame }, 'https://evil.example'),
    ).toBe(false);
    expect(
      isTrustedIpcSenderFrame({ senderFrame: { url: 'not a URL' }, mainFrame }, 'https://joyst.ir'),
    ).toBe(false);
  });
});
