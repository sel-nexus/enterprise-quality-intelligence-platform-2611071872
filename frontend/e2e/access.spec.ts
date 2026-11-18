/** Exercise scoped identities, empty states, and responsive layout with real data. */
import { expect, test } from './fixtures';

test('viewer sees only assigned inventory and cannot use administrator controls', async ({ page, request }, testInfo) => {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const assigned = `assigned-${suffix}`;
  const hidden = `hidden-${suffix}`;
  const email = `viewer-${suffix}@example.test`;
  const password = 'development-viewer-password';
  const login = await request.post('/api/v1/auth/login', { data: { email: process.env.E2E_EMAIL || 'admin@example.test', password: process.env.E2E_PASSWORD || 'local-development-password' } });
  expect(login.status()).toBe(200);
  const admin = await login.json();
  const headers = { Authorization: `Bearer ${admin.token}` };
  for (const [id, name] of [[assigned, `Assigned ${suffix}`], [hidden, `Hidden ${suffix}`]]) {
    expect((await request.post('/api/v1/segments', { headers, data: { id, name } })).status()).toBe(201);
    expect((await request.post('/api/v1/applications', { headers, data: { id: `app-${id}`, name: `Application ${id}`, segmentId: id, owner: 'Test team', lifecycle: 'Active', criticality: 'High' } })).status()).toBe(201);
  }
  expect((await request.post('/api/v1/users', { headers, data: { email, password, role: 'viewer', active: true, segments: [assigned] } })).status()).toBe(201);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  const viewerResponse = page.waitForResponse(r => r.url().endsWith('/api/v1/auth/login') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const viewer = await (await viewerResponse).json();
  await expect(page.getByText('Showing inventory for your assigned segments only.')).toBeVisible();
  await expect(page.getByText(`Application ${assigned}`)).toBeVisible();
  await expect(page.getByText(`Application ${hidden}`)).toHaveCount(0);
  await expect(page.getByText(`Assigned ${suffix} (${assigned}): 1`)).toBeVisible();
  await expect(page.getByText(`Hidden ${suffix} (${hidden}): 1`)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'User administration' })).toHaveCount(0);
  for (const name of ['Create segment', 'Create application', 'Export applications CSV']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: /^Edit (segment|application)/ })).toHaveCount(0);
  const viewerHeaders = { Authorization: `Bearer ${viewer.token}` };
  expect((await request.get('/api/v1/users', { headers: viewerHeaders })).status()).toBe(403);
  expect((await request.get('/api/v1/reports/applications.csv', { headers: viewerHeaders })).status()).toBe(403);
  expect((await request.post('/api/v1/segments', { headers: viewerHeaders, data: { id: `forbidden-${suffix}`, name: 'Forbidden' } })).status()).toBe(403);
  const applications = await request.get('/api/v1/applications', { headers: viewerHeaders });
  expect((await applications.json()).items.map((item: { id: string }) => item.id)).toEqual([`app-${assigned}`]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('viewer-mobile.png'), fullPage: true });
  await page.reload();
  await expect(page.getByText(`Application ${assigned}`)).toBeVisible();
  await expect(page.getByText(`Application ${hidden}`)).toHaveCount(0);
});

test('viewer without assignments sees an empty overview even when inventory exists', async ({ page, request }) => {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const email = `empty-${suffix}@example.test`;
  const password = 'development-viewer-password';
  const login = await request.post('/api/v1/auth/login', { data: { email: process.env.E2E_EMAIL || 'admin@example.test', password: process.env.E2E_PASSWORD || 'local-development-password' } });
  expect(login.status()).toBe(200);
  const admin = await login.json();
  const headers = { Authorization: `Bearer ${admin.token}` };
  expect((await request.post('/api/v1/segments', { headers, data: { id: `unassigned-${suffix}`, name: 'Unassigned segment' } })).status()).toBe(201);
  expect((await request.post('/api/v1/users', { headers, data: { email, password, role: 'viewer', active: true, segments: [] } })).status()).toBe(201);
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  const overviewResponse = page.waitForResponse(r => r.url().endsWith('/api/v1/reports/overview'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  const overview = await overviewResponse;
  expect(overview.status()).toBe(200);
  expect(await overview.json()).toMatchObject({ segmentCount: 0, applicationCount: 0, segments: [] });
  const section = page.getByRole('region', { name: 'Inventory overview' });
  await expect(section.getByText('No accessible segments.')).toBeVisible();
  await expect(section.getByText('No accessible applications.')).toBeVisible();
  await expect(page.getByText('No applications found.')).toBeVisible();
  await expect(page.getByText('Unassigned segment')).toHaveCount(0);
});
