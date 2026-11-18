/** Exercise onboarding and audited access changes against live services. */
import { expect, test } from './fixtures';

test('edits existing user access, persists audit history, and enforces scope and revocation', async ({ page, context, request, browserErrors }) => {
  test.setTimeout(120_000);

  const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const email = `user-${suffix}@example.test`;
  const segmentId = `segment-a-${suffix}`;
  const otherSegmentId = `segment-b-${suffix}`;
  const password = 'development-user-password';
  await page.goto('/');
  await page.getByLabel('Email').fill(process.env.E2E_EMAIL || 'admin@example.test');
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD || 'local-development-password');
  const adminLogin = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const adminResponse = await adminLogin;
  expect(adminResponse.status()).toBe(200);
  const admin = await adminResponse.json();
  for (const [id, name] of [[segmentId, `Segment A ${suffix}`], [otherSegmentId, `Segment B ${suffix}`]]) {
    await page.getByLabel('Segment ID').fill(id);
    await page.getByLabel('Segment name').fill(name);
    const response = page.waitForResponse(r => r.url().endsWith('/api/v1/segments') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create segment' }).click();
    expect((await response).status()).toBe(201);
    await expect(page.getByText('Segment created.')).toBeVisible();
    expect((await request.post('/api/v1/applications', { headers: { Authorization: `Bearer ${admin.token}` }, data: { id: `app-${id}`, name: `Application ${id}`, segmentId: id, owner: 'Test team', lifecycle: 'Active', criticality: 'High' } })).status()).toBe(201);
  }
  await page.getByRole('button', { name: 'Refresh user data and segments' }).click();
  await page.getByLabel('User email').fill(email);
  await page.getByLabel(/Development password/).fill(password);
  await page.getByLabel('New user segments (select multiple)').selectOption(segmentId);
  const createdResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/users') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create user' }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  expect(await created.json()).toMatchObject({ email, role: 'viewer', segments: [segmentId] });
  await expect(page.getByRole('heading', { name: email })).toBeVisible();
  const viewerPage = await context.newPage();
  await viewerPage.goto('/');
  await viewerPage.getByLabel('Email').fill(email);
  await viewerPage.getByLabel('Password').fill(password);
  const viewerLogin = viewerPage.waitForResponse(r => r.url().endsWith('/api/v1/auth/login') && r.request().method() === 'POST');
  await viewerPage.getByRole('button', { name: 'Sign in' }).click();
  const viewerResponse = await viewerLogin;
  expect(viewerResponse.status()).toBe(200);
  const viewer = await viewerResponse.json();
  const viewerHeaders = { Authorization: `Bearer ${viewer.token}` };
  await expect(viewerPage.getByText(`Application ${segmentId}`, { exact: true })).toBeVisible();
  await expect(viewerPage.getByText(`Application ${otherSegmentId}`, { exact: true })).toHaveCount(0);

  await page.getByLabel(`Role for ${email}`).selectOption('engineer');
  await page.getByLabel(`Segments for ${email} (select multiple)`).selectOption(otherSegmentId);
  const updatedResponse = page.waitForResponse(response => response.url().includes('/api/v1/users/') && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: `Save access for ${email}` }).click();
  const updated = await updatedResponse;
  expect(updated.status()).toBe(200);
  expect(await updated.json()).toMatchObject({ email, role: 'engineer', active: true, segments: [otherSegmentId] });
  const scopeAudit = page.locator('li').filter({ has: page.getByText(email, { exact: true }) }).filter({ hasText: `Before: viewer, active, segments: ${segmentId}` });
  await expect(scopeAudit).toContainText(`After: engineer, active, segments: ${otherSegmentId}`);
  await expect(scopeAudit).toContainText(`Actor: ${admin.user.email}`);
  await page.reload();
  await expect(page.getByLabel(`Role for ${email}`)).toHaveValue('engineer');
  await expect(page.getByLabel(`Segments for ${email} (select multiple)`)).toHaveValues([otherSegmentId]);
  await expect(scopeAudit).toContainText(`After: engineer, active, segments: ${otherSegmentId}`);

  const currentIdentity = await request.get('/api/v1/auth/me', { headers: viewerHeaders });
  expect(currentIdentity.status()).toBe(200);
  expect(await currentIdentity.json()).toMatchObject({ email, role: 'engineer', segments: [otherSegmentId] });
  const scopedInventory = await request.get('/api/v1/applications', { headers: viewerHeaders });
  expect(scopedInventory.status()).toBe(200);
  expect((await scopedInventory.json()).items.map((item: { id: string }) => item.id)).toEqual([`app-${otherSegmentId}`]);
  await viewerPage.reload();
  await expect(viewerPage.getByText(`Application ${otherSegmentId}`, { exact: true })).toBeVisible();
  await expect(viewerPage.getByText(`Application ${segmentId}`, { exact: true })).toHaveCount(0);

  await page.getByLabel(`Status for ${email}`).selectOption('disabled');
  const disabledResponse = page.waitForResponse(r => r.url().includes('/api/v1/users/') && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: `Save access for ${email}` }).click();
  const disabled = await disabledResponse;
  expect(disabled.status()).toBe(200);
  expect(await disabled.json()).toMatchObject({ email, role: 'engineer', active: false, segments: [otherSegmentId] });
  const statusAudit = page.locator('li').filter({ has: page.getByText(email, { exact: true }) }).filter({ hasText: `Before: engineer, active, segments: ${otherSegmentId}` });
  await expect(statusAudit).toContainText(`After: engineer, disabled, segments: ${otherSegmentId}`);
  await expect(statusAudit).toContainText(`Actor: ${admin.user.email}`);
  await page.reload();
  await expect(page.getByLabel(`Status for ${email}`)).toHaveValue('disabled');
  await expect(page.getByLabel(`Segments for ${email} (select multiple)`)).toHaveValues([otherSegmentId]);
  await expect(statusAudit).toContainText(`After: engineer, disabled, segments: ${otherSegmentId}`);
  expect((await request.get('/api/v1/auth/me', { headers: viewerHeaders })).status()).toBe(401);
  // StrictMode runs the session-validation effect twice on reload.
  browserErrors.expectHttpError('GET', '/api/v1/auth/me', 401, 2);
  await viewerPage.reload();
  await expect(viewerPage.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await page.getByLabel(`Status for ${email}`).selectOption('active');
  const reenabledResponse = page.waitForResponse(r => r.url().includes('/api/v1/users/') && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: `Save access for ${email}` }).click();
  expect((await reenabledResponse).status()).toBe(200);
  const reenabledAudit = page.locator('li').filter({ has: page.getByText(email, { exact: true }) }).filter({ hasText: `Before: engineer, disabled, segments: ${otherSegmentId}` });
  await expect(reenabledAudit).toContainText(`After: engineer, active, segments: ${otherSegmentId}`);
  await page.reload();
  await expect(page.getByLabel(`Status for ${email}`)).toHaveValue('active');
  await expect(reenabledAudit).toContainText(`After: engineer, active, segments: ${otherSegmentId}`);
  expect((await request.get('/api/v1/auth/me', { headers: viewerHeaders })).status()).toBe(401);
  await viewerPage.getByLabel('Email').fill(email);
  await viewerPage.getByLabel('Password').fill(password);
  const newLogin = viewerPage.waitForResponse(r => r.url().endsWith('/api/v1/auth/login') && r.request().method() === 'POST');
  await viewerPage.getByRole('button', { name: 'Sign in' }).click();
  expect((await newLogin).status()).toBe(200);
  await expect(viewerPage.getByText(`Application ${otherSegmentId}`, { exact: true })).toBeVisible();
  await expect(viewerPage.getByText(`Application ${segmentId}`, { exact: true })).toHaveCount(0);
});
