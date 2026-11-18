/** Test inventory rendering, scope, creation, and errors at the network boundary. */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Inventory from './Inventory';
import type { User } from '../api';

const admin: User = { id: '1', email: 'admin@example.test', role: 'admin', segments: [] };
const segment = { id: 'alpha', name: 'Alpha' };
const app = { id: 'claims', name: 'Claims', segmentId: 'alpha', owner: 'Team', lifecycle: 'Active', criticality: 'High', qualityScore: null };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('inventory', () => {
  it('renders stored script and event-handler payloads as inert text', async () => {
    const script = '<script>window.__inventoryXss = true</script>';
    const handler = '<img src=x onerror="window.__inventoryXss = true">';
    const storedSegment = { ...segment, name: script };
    const storedApp = { ...app, name: handler, owner: script };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url =>
      json({ items: String(url).endsWith('/segments') ? [storedSegment] : [storedApp] }),
    );
    const { container } = render(<Inventory token="token" user={{ ...admin, role: 'viewer' }} />);

    const appName = await screen.findByText(handler);
    expect(appName).toBeVisible();
    expect(screen.getByText(`${script} (alpha)`)).toBeVisible();
    expect(appName.closest('li')).toHaveTextContent(script);
    expect(container.querySelector('script, img')).toBeNull();
    expect(Reflect.get(window, '__inventoryXss')).toBeUndefined();
  });

  it('shows scoped records, unavailable scores and search filtering without admin forms', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => json({ items: String(url).endsWith('/segments') ? [segment] : [app] }));
    render(<Inventory token="token" user={{ ...admin, role: 'viewer', segments: ['alpha'] }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading inventory');
    expect((await screen.findByText('Claims')).closest('li')).toHaveTextContent('Quality score: Unavailable');
    expect(screen.getByText(/assigned segments only/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create segment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit segment|Edit application/ })).not.toBeInTheDocument();
    await userEvent.setup().type(screen.getByLabelText('Search applications'), 'missing');
    expect(screen.getByText('No applications found.')).toBeInTheDocument();
  });
  it('creates a segment and application and renders the returned records', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (options?.method === 'POST') return json(String(url).endsWith('/segments') ? segment : app, 201);
      return json({ items: [] });
    });
    const user = userEvent.setup();
    render(<Inventory token="token" user={admin} />);
    expect(await screen.findByText('No accessible segments.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Segment ID'), 'alpha');
    await user.type(screen.getByLabelText('Segment name'), 'Alpha');
    await user.click(screen.getByRole('button', { name: 'Create segment' }));
    expect(await screen.findByText('Segment created.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Application ID'), 'claims');
    await user.type(screen.getByLabelText('Application name'), 'Claims');
    await user.selectOptions(screen.getByLabelText('Application segment'), 'alpha');
    await user.type(screen.getByLabelText('Owner'), 'Team');
    await user.type(screen.getByLabelText('Lifecycle'), 'Active');
    await user.type(screen.getByLabelText('Criticality'), 'High');
    await user.click(screen.getByRole('button', { name: 'Create application' }));
    expect(await screen.findByText('Application created.')).toBeInTheDocument();
    expect(screen.getByText('Claims').closest('li')).toHaveTextContent('Claims (claims)');
  });
  it('edits both records through PATCH and displays persisted values after remount', async () => {
    let savedSegment = { ...segment };
    let savedApp = { ...app };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const path = String(url);
      if (options?.method === 'PATCH') {
        const body = JSON.parse(String(options.body));
        if (path.endsWith('/segments/alpha')) savedSegment = { ...savedSegment, ...body };
        else if (path.endsWith('/applications/claims')) savedApp = { ...savedApp, ...body };
        else throw new Error(`Unexpected PATCH: ${path}`);
        return json(path.includes('/segments/') ? savedSegment : savedApp);
      }
      return json({ items: path.endsWith('/segments') ? [savedSegment] : [savedApp] });
    });
    const user = userEvent.setup();
    const view = render(<Inventory token="token" user={admin} />);
    await screen.findByText('Claims');
    await user.click(screen.getByRole('button', { name: 'Edit segment Alpha' }));
    await user.clear(screen.getByLabelText('Edit segment name'));
    await user.type(screen.getByLabelText('Edit segment name'), 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save segment' }));
    expect(await screen.findByText('Segment updated.')).toBeInTheDocument();
    expect(screen.getByText('Renamed (alpha)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit application Claims' }));
    await user.clear(screen.getByLabelText('Edit application name'));
    await user.type(screen.getByLabelText('Edit application name'), 'Updated Claims');
    await user.clear(screen.getByLabelText('Edit owner'));
    await user.type(screen.getByLabelText('Edit owner'), 'New team');
    await user.click(screen.getByRole('button', { name: 'Save application' }));
    expect(await screen.findByText('Application updated.')).toBeInTheDocument();
    expect(screen.getByText('Updated Claims').closest('li')).toHaveTextContent('New team');
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/segments/alpha'), expect.objectContaining({ method: 'PATCH', headers: expect.objectContaining({ Authorization: 'Bearer token' }), body: JSON.stringify({ name: 'Renamed' }) }));
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/applications/claims'), expect.objectContaining({ method: 'PATCH', body: expect.stringContaining('Updated Claims') }));
    view.unmount();
    render(<Inventory token="token" user={admin} />);
    expect(await screen.findByText('Renamed (alpha)')).toBeInTheDocument();
    expect(screen.getByText('Updated Claims').closest('li')).toHaveTextContent('New team');
  });

  it('keeps edit input and reports denied updates without changing the record', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => options?.method === 'PATCH' ? json({ message: 'Administrator access required' }, 403) : json({ items: String(url).endsWith('/segments') ? [segment] : [app] }));
    const user = userEvent.setup();
    render(<Inventory token="token" user={admin} />);
    await screen.findByText('Claims');
    await user.click(screen.getByRole('button', { name: 'Edit application Claims' }));
    await user.clear(screen.getByLabelText('Edit application name'));
    await user.type(screen.getByLabelText('Edit application name'), 'Attempted');
    await user.click(screen.getByRole('button', { name: 'Save application' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Administrator access required');
    expect(screen.getByLabelText('Edit application name')).toHaveValue('Attempted');
    expect(screen.getByText('Claims')).toBeInTheDocument();
    expect(screen.queryByText('Application updated.')).not.toBeInTheDocument();
  });

  it('reports a segment update failure and retains the draft', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => options?.method === 'PATCH' ? json({ message: 'Segment not found' }, 404) : json({ items: String(url).endsWith('/segments') ? [segment] : [app] }));
    const user = userEvent.setup();
    render(<Inventory token="token" user={admin} />);
    await screen.findByText('Claims');
    await user.click(screen.getByRole('button', { name: 'Edit segment Alpha' }));
    await user.clear(screen.getByLabelText('Edit segment name'));
    await user.type(screen.getByLabelText('Edit segment name'), 'Draft');
    await user.click(screen.getByRole('button', { name: 'Save segment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Segment not found');
    expect(screen.getByLabelText('Edit segment name')).toHaveValue('Draft');
    expect(screen.getByText('Alpha (alpha)')).toBeInTheDocument();
    expect(screen.queryByText('Segment updated.')).not.toBeInTheDocument();
  });

  it('shows server errors and allows retrying a failed load', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ message: 'Unavailable' }, 503));
    render(<Inventory token="token" user={admin} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable');
    fetcher.mockImplementation(async () => json({ items: [] }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry loading' }));
    expect(await screen.findByText('No accessible segments.')).toBeInTheDocument();
  });
  it('shows a mutation error without pretending creation succeeded', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => options?.method === 'POST' ? json({ message: 'Segment identifier already exists' }, 409) : json({ items: [] }));
    const user = userEvent.setup();
    render(<Inventory token="token" user={admin} />);
    await screen.findByText('No accessible segments.');
    await user.type(screen.getByLabelText('Segment ID'), 'alpha');
    await user.type(screen.getByLabelText('Segment name'), 'Alpha');
    await user.click(screen.getByRole('button', { name: 'Create segment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    expect(screen.queryByText('Segment created.')).not.toBeInTheDocument();
  });
});
