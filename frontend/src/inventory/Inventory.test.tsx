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
  it('shows scoped records, unavailable scores and search filtering without admin forms', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => json({ items: String(url).endsWith('/segments') ? [segment] : [app] }));
    render(<Inventory token="token" user={{ ...admin, role: 'viewer', segments: ['alpha'] }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading inventory');
    expect((await screen.findByText('Claims')).closest('li')).toHaveTextContent('Quality score: Unavailable');
    expect(screen.getByText(/assigned segments only/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create segment' })).not.toBeInTheDocument();
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
