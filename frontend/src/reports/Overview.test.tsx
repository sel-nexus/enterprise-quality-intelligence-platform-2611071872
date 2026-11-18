/** Test reporting states and export behavior at the HTTP boundary. */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Overview from './Overview';
import type { User } from '../api';

const admin: User = { id: 'admin', email: 'admin@example.test', role: 'admin', segments: [] };
const report = { segmentCount: 1, applicationCount: 2, scoredApplicationCount: 1, unknownScoreCount: 1, segments: [{ id: 'a', name: 'Alpha', applicationCount: 2 }] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('inventory overview', () => {
  it('renders scoped persisted counts and unavailable metrics for a reader without export', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(report));
    render(<Overview token="session" user={{ ...admin, role: 'viewer', segments: ['a'] }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading overview');
    expect(await screen.findByText('Alpha (a): 2')).toBeInTheDocument();
    expect(screen.getByText('Applications with an unavailable quality score').nextElementSibling).toHaveTextContent('1');
    expect(screen.getByText(/Historical trends and predictive metrics: Unavailable/)).toBeInTheDocument();
    expect(screen.getByText('Assigned segments only.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export applications CSV' })).not.toBeInTheDocument();
  });

  it('retries failures and displays the empty state', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ message: 'Unavailable' }, 503));
    render(<Overview token="session" user={admin} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable');
    fetcher.mockResolvedValue(json({ segmentCount: 0, applicationCount: 0, scoredApplicationCount: 0, unknownScoreCount: 0, segments: [] }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry overview' }));
    expect(await screen.findByText('No accessible segments.')).toBeInTheDocument();
    expect(screen.getByText('No accessible applications.')).toBeInTheDocument();
  });

  it('sends the bearer token and reports a denied export', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).endsWith('.csv') ? json({ message: 'Export denied' }, 403) : json(report));
    render(<Overview token="session" user={admin} />);
    await screen.findByText('Alpha (a): 2');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export applications CSV' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Export denied');
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/reports/applications.csv'), expect.objectContaining({ headers: { Authorization: 'Bearer session' } }));
  });

  it('downloads the response for an executive', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).endsWith('.csv') ? new Response('csv data', { status: 200 }) : json(report));
    const create = vi.fn(() => 'blob:report');
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<Overview token="session" user={{ ...admin, role: 'executive' }} />);
    await screen.findByText('Alpha (a): 2');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export applications CSV' }));
    expect(create).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:report');
    vi.unstubAllGlobals();
  });
});
