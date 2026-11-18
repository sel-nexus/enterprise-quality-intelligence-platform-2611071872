/** Verify the development login and persisted session across the real API proxy. */
import { expect, test } from '@playwright/test';

test('signs in, restores the server identity after reload and signs out', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email').fill(process.env.E2E_EMAIL || 'admin@example.test');
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD || 'local-development-password');
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const session = await response.json();
  await expect(page.getByText(session.user.email)).toBeVisible();
  await page.reload();
  await expect(page.getByText(session.user.email)).toBeVisible();
  await expect(page.getByText(session.user.role, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(errors).toEqual([]);
});
