/** Verify administrator-visible user management interactions. */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Users from './Users';

const account = { id: 'u1', email: 'reader@example.test', role: 'viewer', active: true, segments: ['alpha'] };
const segment = { id: 'alpha', name: 'Alpha' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('user administration', () => {
  it('loads users, creates a development account, and renders persisted changes', async () => {
    let created = false;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const path = String(url);
      if (options?.method === 'POST') { created = true; return json(account, 201); }
      if (path.endsWith('/users/audit')) return json({ items: [] });
      if (path.endsWith('/segments')) return json({ items: [segment] });
      return json({ items: created ? [account] : [] });
    });
    const user = userEvent.setup();
    render(<Users token="session" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading users');
    expect(await screen.findByText('No users found.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('User email'), account.email);
    await user.type(screen.getByLabelText(/Development password/), 'reader-local-password');
    await user.selectOptions(screen.getByLabelText(/New user segments/), 'alpha');
    await user.click(screen.getByRole('button', { name: 'Create user' }));
    expect(await screen.findByText('User created.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: account.email })).toBeInTheDocument();
    const call = fetcher.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ email: account.email, role: 'viewer', segments: ['alpha'] });
    expect(screen.getByLabelText(/Development password/)).toHaveValue('');
  });
  it('updates role and status and shows the audit history', async () => {
    let updated = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (options?.method === 'PATCH') { updated = true; return json({ ...account, active: false, role: 'engineer' }); }
      if (String(url).endsWith('/users/audit')) return json({ items: updated ? [{ id: 1, actorId: 'a', targetId: 'u1', occurredAt: '2025-01-01', oldValues: account, newValues: { ...account, active: false, role: 'engineer' } }] : [] });
      if (String(url).endsWith('/segments')) return json({ items: [segment] });
      return json({ items: [updated ? { ...account, active: false, role: 'engineer' } : account] });
    });
    const user = userEvent.setup(); render(<Users token="session" />);
    await screen.findByRole('heading', { name: account.email });
    await user.selectOptions(screen.getByLabelText(`Role for ${account.email}`), 'engineer');
    await user.selectOptions(screen.getByLabelText(`Status for ${account.email}`), 'disabled');
    await user.click(screen.getByRole('button', { name: `Save access for ${account.email}` }));
    expect(await screen.findByText('Access saved.')).toBeInTheDocument();
    expect(await screen.findByText(/After: engineer, disabled/)).toBeInTheDocument();
  });
  it('shows errors and retries loading', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ message: 'Unavailable' }, 503));
    render(<Users token="session" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable');
    fetcher.mockImplementation(async () => json({ items: [] }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload users' }));
    expect(await screen.findByText('No users found.')).toBeInTheDocument();
  });
  it('reports rejected updates without showing success', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (options?.method === 'PATCH') return json({ message: 'At least one active administrator is required' }, 409);
      return json({ items: String(url).endsWith('/users') ? [account] : [] });
    });
    render(<Users token="session" />);
    await screen.findByRole('heading', { name: account.email });
    await userEvent.setup().click(screen.getByRole('button', { name: `Save access for ${account.email}` }));
    expect(await screen.findByRole('alert')).toHaveTextContent('At least one active administrator');
    expect(screen.queryByText('Access saved.')).not.toBeInTheDocument();
  });
});
