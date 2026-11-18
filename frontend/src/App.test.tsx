/** Test tab session restoration, recovery, expiry, and sign out. */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const viewer = { id: 'v', email: 'viewer@example.test', role: 'viewer', segments: ['alpha'] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); });

describe('session shell', () => {
  it.each(['success', 'expired'])('ignores a stale %s session response after StrictMode effect replay', async result => {
    sessionStorage.setItem('eqip.session', 'stored-token');
    let resolveStale!: (response: Response) => void;
    let resolveCurrent!: (response: Response) => void;
    const staleResponse = new Promise<Response>(resolve => { resolveStale = resolve; });
    const currentResponse = new Promise<Response>(resolve => { resolveCurrent = resolve; });
    let sessionRequests = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).endsWith('/auth/me')) {
        sessionRequests += 1;
        if (sessionRequests === 1) return staleResponse;
        if (sessionRequests === 2) return currentResponse;
        throw new Error('Unexpected session request');
      }
      if (String(url).endsWith('/reports/overview')) return json({ segmentCount: 0, applicationCount: 0, scoredApplicationCount: 0, unknownScoreCount: 0, segments: [] });
      return json({ items: [] });
    });

    render(
      <StrictMode>
        <App />
      </StrictMode>
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading your session');
    expect(sessionRequests).toBe(2);
    await act(async () => {
      resolveCurrent(json(viewer));
      await currentResponse;
    });
    expect(await screen.findByText('viewer@example.test')).toBeInTheDocument();

    await act(async () => {
      resolveStale(result === 'success' ? json({ ...viewer, email: 'stale@example.test' }) : json({}, 401));
      await staleResponse;
    });
    expect(screen.getByText('viewer@example.test')).toBeInTheDocument();
    expect(screen.queryByText('stale@example.test')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('eqip.session')).toBe('stored-token');
  });

  it('restores and revalidates a stored session and signs out', async () => {
    sessionStorage.setItem('eqip.session', 'stored-token');
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).endsWith('/auth/me')) return json(viewer);
      if (String(url).endsWith('/reports/overview')) return json({ segmentCount: 0, applicationCount: 0, scoredApplicationCount: 0, unknownScoreCount: 0, segments: [] });
      return json({ items: [] });
    });
    render(<App />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading your session');
    expect(await screen.findByText('viewer@example.test')).toBeInTheDocument();
    expect(screen.getByText('Assigned: alpha')).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/auth/me'), { headers: { Authorization: 'Bearer stored-token' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    expect(sessionStorage.getItem('eqip.session')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('keeps the token after a network failure and retries restoration', async () => {
    sessionStorage.setItem('eqip.session', 'stored-token');
    let fail = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).endsWith('/auth/me')) {
        if (fail) throw new TypeError('Offline');
        return json(viewer);
      }
      if (String(url).endsWith('/reports/overview')) return json({ segmentCount: 0, applicationCount: 0, scoredApplicationCount: 0, unknownScoreCount: 0, segments: [] });
      return json({ items: [] });
    });
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection and retry');
    expect(sessionStorage.getItem('eqip.session')).toBe('stored-token');
    fail = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('viewer@example.test')).toBeInTheDocument();
  });

  it('clears an expired session and returns to sign in', async () => {
    sessionStorage.setItem('eqip.session', 'expired');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ message: 'Unauthorized' }, 401));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(sessionStorage.getItem('eqip.session')).toBeNull();
  });

  it('persists the token after signing in and revalidates the session', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).endsWith('/auth/login')) return json({ token: 'new-token', user: viewer });
      if (String(url).endsWith('/auth/me')) return json(viewer);
      if (String(url).endsWith('/reports/overview')) return json({ segmentCount: 0, applicationCount: 0, scoredApplicationCount: 0, unknownScoreCount: 0, segments: [] });
      return json({ items: [] });
    });
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText('Email'), 'viewer@example.test');
    await user.type(screen.getByLabelText('Password'), 'password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('viewer@example.test')).toBeInTheDocument();
    expect(sessionStorage.getItem('eqip.session')).toBe('new-token');
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/auth/me'), { headers: { Authorization: 'Bearer new-token' } });
  });

  it('allows sign out from the session error screen', async () => {
    sessionStorage.setItem('eqip.session', 'stored-token');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({}, 503));
    render(<App />);
    await screen.findByRole('alert');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    expect(sessionStorage.getItem('eqip.session')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});
