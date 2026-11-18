/** Verify real inventory changes feed the overview and CSV download. */
import { expect, test } from './fixtures';
import { readFile } from 'node:fs/promises';

test('creates persisted inventory, refreshes counts, and exports it', async ({ page }) => {

  const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const segmentId = `seg-${suffix}`;
  const appId = `app-${suffix}`;
  await page.goto('/');
  await page.getByLabel('Email').fill(process.env.E2E_EMAIL || 'admin@example.test');
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD || 'local-development-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Inventory overview' })).toBeVisible();
  await page.getByLabel('Segment ID').fill(segmentId);
  await page.getByLabel('Segment name').fill(`Reports ${suffix}`);
  await page.getByRole('button', { name: 'Create segment' }).click();
  await expect(page.getByText('Segment created.')).toBeVisible();
  await page.getByLabel('Application ID').fill(appId);
  await page.getByLabel('Application name').fill(`Report application ${suffix}`);
  await page.getByLabel('Application segment').selectOption(segmentId);
  await page.getByLabel('Owner').fill('Reporting team');
  await page.getByLabel('Lifecycle').fill('Active');
  await page.getByLabel('Criticality').fill('High');
  await page.getByRole('button', { name: 'Create application' }).click();
  await expect(page.getByText('Application created.')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh overview' }).click();
  await expect(page.getByText(`Reports ${suffix} (${segmentId}): 1`)).toBeVisible();
  await expect(page.getByText(/Historical trends and predictive metrics: Unavailable/)).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export applications CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('applications.csv');
  const path = await download.path();
  expect(path).not.toBeNull();
  const csv = await readFile(path!, 'utf8');
  expect(csv).toContain(`"Internal","${appId}","Report application ${suffix}","${segmentId}"`);
  expect(csv).not.toContain('Reporting team');
  await page.reload();
  await expect(page.getByText(`Reports ${suffix} (${segmentId}): 1`)).toBeVisible();
});

test('shows loading while a real overview request is held and then renders its response', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(process.env.E2E_EMAIL || 'admin@example.test');
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD || 'local-development-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Refresh overview' })).toBeEnabled();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/reports/overview', async route => {
    await gate;
    await route.continue();
  });
  try {
    const response = page.waitForResponse(r => r.url().endsWith('/api/v1/reports/overview'));
    await page.getByRole('button', { name: 'Refresh overview' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Loading overview' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh overview' })).toBeDisabled();
    release();
    expect((await response).status()).toBe(200);
    await expect(page.getByRole('status').filter({ hasText: 'Loading overview' })).toHaveCount(0);
    await expect(page.getByText('Historical trends and predictive metrics: Unavailable.')).toBeVisible();
  } finally {
    release();
    await page.unroute('**/api/v1/reports/overview');
  }
});
