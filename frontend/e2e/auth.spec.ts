/** Verify the development login and persisted session across the real API proxy. */
import { expect, test } from './fixtures';

test('signs in, restores the server identity after reload and signs out', async ({ page }, testInfo) => {

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email').fill(process.env.E2E_EMAIL || 'admin@example.test');
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD || 'local-development-password');
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const session = await response.json();
  await expect(page.locator('main.workspace > p').filter({ hasText: 'Signed in as' })).toContainText(session.user.email);
  await expect(page.getByText('Loading overview…')).toHaveCount(0);
  await expect(page.getByText('Loading inventory…')).toHaveCount(0);
  await expect(page.getByText('Loading users…')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  await page.reload();
  await expect(page.locator('main.workspace > p').filter({ hasText: 'Signed in as' })).toContainText(session.user.email);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('main.workspace dl dd').first()).toHaveText(session.user.role);
  await page.screenshot({ path: testInfo.outputPath('workspace-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('rejects unauthenticated requests and invalid credentials', async ({ page, request, browserErrors }) => {
  for (const endpoint of ['auth/me', 'segments', 'applications', 'reports/overview', 'users']) {
    const response = await request.get(`/api/v1/${endpoint}`);
    expect(response.status(), endpoint).toBe(401);
  }
  await page.goto('/');
  await page.getByLabel('Email').fill(process.env.E2E_EMAIL || 'admin@example.test');
  await page.getByLabel('Password').fill('incorrect-password');
  browserErrors.expectHttpError('POST', '/api/v1/auth/login', 401);
  const response = page.waitForResponse(r => r.url().endsWith('/api/v1/auth/login') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in' }).click();
  expect((await response).status()).toBe(401);
  await expect(page.getByRole('alert')).toHaveText('Invalid credentials or development login is unavailable.');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
});
