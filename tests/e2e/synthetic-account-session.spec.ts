import { expect, test, type Page } from '@playwright/test';
import { controlPortConfig, controlRequest } from './helpers/control-port.js';

// Account persistence in the browser, against the real login gate and the real /v1/auth endpoints.
// The E2E server runs synthetic accounts only (see tooling/e2e-synthetic-accounts.ts). The control
// port reads the one-time code and seeds or expires state; it never touches the editor itself.

const TOKEN_KEY = 'joy-media-session-token';

async function control<T>(path: string, body?: unknown): Promise<{ status: number; data: T }> {
  return controlRequest<T>(path, body);
}

function uniqueContact(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@synthetic.joy-media.test`;
}

/** The most recent code the server sent to this contact, or undefined before any was sent. */
async function latestCode(contact: string): Promise<{ code: string; sentAt: string } | undefined> {
  const response = await control<{ code: string; sentAt: string }>(
    `/__e2e/otp/latest?contact=${encodeURIComponent(contact)}`,
  );
  return response.status === 200 ? response.data : undefined;
}

async function signInWithSyntheticAccount(page: Page, contact: string): Promise<void> {
  const emailField = page.getByPlaceholder('your@gmail.com');
  await expect(emailField).toBeVisible();
  const previousSentAt = (await latestCode(contact))?.sentAt;
  await emailField.fill(contact);
  // Saved-contact suggestions open over the submit button; dismiss them as a user would.
  await emailField.press('Escape');
  await emailField.blur();
  await expect(page.locator('.auth-suggest')).toHaveCount(0);
  await page.getByRole('button', { name: /Send Code/u }).click();
  // Wait for a code sent by this request, not an earlier one, then type it as a user would.
  await expect.poll(async () => (await latestCode(contact))?.sentAt).not.toBe(previousSentAt);
  const sent = await latestCode(contact);
  const digits = page.locator('.otp-row input');
  for (let index = 0; index < 6; index += 1)
    await digits.nth(index).fill(sent?.code.charAt(index) ?? '');
  // The OTP row leaves the DOM only when the gate unlocks after a verified code, so wait for that.
  await expect(digits).toHaveCount(0);
  await expect.poll(() => storedToken(page)).not.toBeNull();
}

async function storedToken(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), TOKEN_KEY);
}

async function subscriptionStatus(page: Page): Promise<string> {
  return page.evaluate(async (key) => {
    const token = window.localStorage.getItem(key);
    const response = await fetch('/api/v1/account/subscription', {
      headers: { authorization: `Bearer ${token ?? ''}` },
    });
    const body = (await response.json()) as { data: { status: string } };
    return body.data.status;
  }, TOKEN_KEY);
}

test.describe('account persistence on the synthetic E2E server', { tag: '@fixture-only' }, () => {
  test.beforeAll(() => {
    if (controlPortConfig().token.length === 0)
      throw new Error('JOY_MEDIA_E2E_CONTROL_TOKEN is required for synthetic account tests.');
  });

  test('sign-in persists across reloads, subscription states read back, sign-out ends the session, and an expired session is refused', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const contact = uniqueContact();
    const clientKey = Math.random().toString(36).slice(2, 10);
    // One OTP rate-limit bucket per test, as the production limiter keys by client address.
    await page.route('**/api/v1/auth/**', (route) =>
      route.continue({
        headers: { ...route.request().headers(), 'x-joy-e2e-client': clientKey },
      }),
    );
    expect((await control('/__e2e/accounts', { contact })).status).toBe(200);

    await page.goto('/');
    await signInWithSyntheticAccount(page, contact);

    // Persistence: the session survives a reload without signing in again.
    await page.reload();
    await expect(page.getByPlaceholder('your@gmail.com')).toHaveCount(0);
    expect(await storedToken(page)).toBeTruthy();

    // Subscription states, read through the real account endpoint with the stored session.
    expect(await subscriptionStatus(page)).toBe('none');
    await control('/__e2e/subscriptions', { contact, state: 'active' });
    expect(await subscriptionStatus(page)).toBe('active');
    await control('/__e2e/subscriptions', { contact, state: 'expired' });
    expect(await subscriptionStatus(page)).toBe('expired');

    // The account control lives in the editor header, so open a project first, as a user would.
    await page.getByRole('list').getByRole('listitem').first().getByRole('button').first().click();
    await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();

    // Sign-out from the account card clears the stored session and returns to the gate.
    await page.getByRole('button', { name: 'JOY Studio account' }).click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByPlaceholder('your@gmail.com')).toBeVisible();
    expect(await storedToken(page)).toBeNull();
    await page.reload();
    await expect(page.getByPlaceholder('your@gmail.com')).toBeVisible();

    // Expiry: a new session is refused once the server-side expiry passes.
    await signInWithSyntheticAccount(page, contact);
    expect((await control('/__e2e/sessions/expire', { contact })).status).toBe(200);
    await page.reload();
    await expect(page.getByPlaceholder('your@gmail.com')).toBeVisible();
  });
});
