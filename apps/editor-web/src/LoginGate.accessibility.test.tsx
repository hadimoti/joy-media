// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rememberLoginContact } from './login-contact-history.js';

const { probeJoySession, requestOtp } = vi.hoisted(() => ({
  probeJoySession: vi.fn(async () => ({ kind: 'signed-out' as const })),
  requestOtp: vi.fn(async () => 'Enter the code we sent you'),
}));

vi.mock('./identity.js', () => ({ probeJoySession }));
vi.mock('./media-session.js', () => ({
  MEDIA_SESSION_CHANGED_EVENT: 'joy-media-session-changed',
  requestOtp,
  setStoredMediaToken: vi.fn(),
  verifyOtp: vi.fn(),
}));

import { LoginGate } from './LoginGate.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  window.localStorage.clear();
  probeJoySession.mockResolvedValue({ kind: 'signed-out' });
  requestOtp.mockResolvedValue('Enter the code we sent you');
});

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.clearAllMocks();
});

describe('LoginGate accessibility', () => {
  it('uses a labeled native email field and preserves remembered-contact suggestions', async () => {
    rememberLoginContact(window.localStorage, 'gmail', 'alice@gmail.com');
    await renderGate();

    const input = container?.querySelector<HTMLInputElement>('#login-contact');
    expect(input?.type).toBe('email');
    expect(input?.getAttribute('role')).toBeNull();
    expect(container?.querySelector('label[for="login-contact"]')?.textContent).toBe(
      'Enter your Gmail address',
    );

    await act(async () => input?.focus());
    const suggestion = [
      ...(container?.querySelectorAll<HTMLButtonElement>('.auth-suggest-item') ?? []),
    ].find((button) => button.textContent === 'alice@gmail.com');
    expect(suggestion).toBeDefined();

    await act(async () => {
      suggestion?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(input?.value).toBe('alice@gmail.com');
  });

  it('names the OTP group and boxes while preserving Backspace focus behavior', async () => {
    await renderGate();
    await submitEmail('editor@example.com');

    const group = container?.querySelector(
      '[role="group"][aria-label="One-time verification code"]',
    );
    const boxes = group?.querySelectorAll<HTMLInputElement>('.otp-box');
    expect(boxes).toHaveLength(6);
    expect(boxes?.[0]?.getAttribute('aria-label')).toBe('Verification code digit 1 of 6');
    expect(boxes?.[5]?.getAttribute('aria-label')).toBe('Verification code digit 6 of 6');

    boxes?.[1]?.focus();
    await act(async () => {
      boxes?.[1]?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Backspace' }));
    });
    expect(document.activeElement).toBe(boxes?.[0]);
  });

  it('announces request failures as assertive alerts', async () => {
    requestOtp.mockRejectedValueOnce(new Error('offline'));
    await renderGate();
    await submitEmail('editor@example.com');

    const alert = container?.querySelector('[role="alert"]');
    expect(alert?.getAttribute('aria-live')).toBe('assertive');
    expect(alert?.textContent).toBe('Could not request a login code. Try again.');
  });
});

async function renderGate(): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <LoginGate>
        <button type="button">Editor action</button>
      </LoginGate>,
    );
    await settle();
  });
}

async function submitEmail(value: string): Promise<void> {
  const input = container?.querySelector<HTMLInputElement>('#login-contact');
  if (input === undefined || input === null) throw new Error('Login contact input was not mounted');
  await act(async () => {
    setNativeValue(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const form = input.closest('form');
  if (form === null) throw new Error('Login form was not mounted');
  await act(async () => {
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();
  });
}

function setNativeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
