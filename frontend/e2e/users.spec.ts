/** Exercise onboarding and audited access changes against live services. */
import { expect, test } from '@playwright/test';

test('creates a development user and persists role and segment changes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const email = `user-${suffix}@example.test`;
  const segmentId = `segment-${suffix}`;
  await page.goto('/');
  await page.getByLabel('Email').fill(process.env.E2E_EMAIL || 'admin@example.test');
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD || 'local-development-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Segment ID').fill(segmentId);
  await page.getByLabel('Segment name').fill(`Segment ${suffix}`);
  await page.getByRole('button', { name: 'Create segment' }).click();
  await expect(page.getByText('Segment created.')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh user data and segments' }).click();
  await page.getByLabel('User email').fill(email);
  await page.getByLabel(/Development password/).fill('development-user-password');
  await page.getByLabel('New user segments (select multiple)').selectOption(segmentId);
  const createdResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/users') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create user' }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  expect(await created.json()).toMatchObject({ email, role: 'viewer', segments: [segmentId] });
  await expect(page.getByRole('heading', { name: email })).toBeVisible();
  await page.getByLabel(`Role for ${email}`).selectOption('engineer');
  const updatedResponse = page.waitForResponse(response => response.url().includes('/api/v1/users/') && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: `Save access for ${email}` }).click();
  expect((await updatedResponse).status()).toBe(200);
  await expect(page.getByText(`After: engineer, active, segments: ${segmentId}`)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(`Role for ${email}`)).toHaveValue('engineer');
  await expect(page.getByText(`After: engineer, active, segments: ${segmentId}`)).toBeVisible();
  expect(errors).toEqual([]);
});
