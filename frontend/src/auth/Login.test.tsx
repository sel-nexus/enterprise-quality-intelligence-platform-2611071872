/** Test the visible development sign-in behavior. */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Login from './Login';

const session = { token: 'signed-token', user: { id: '1', email: 'admin@example.test', role: 'admin', segments: [] } };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('development sign in', () => {
  it('submits credentials and receives the server session', async () => {
    const onLogin = vi.fn();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(session), { status: 200 }));
    const user = userEvent.setup();
    render(<Login onLogin={onLogin} />);
    await user.type(screen.getByLabelText('Email'), 'admin@example.test');
    await user.type(screen.getByLabelText('Password'), 'local-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(onLogin).toHaveBeenCalledWith(session);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ email: 'admin@example.test', password: 'local-password' });
  });
  it('displays a rejection without signing in', async () => {
    const onLogin = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
    const user = userEvent.setup();
    render(<Login onLogin={onLogin} />);
    await user.type(screen.getByLabelText('Email'), 'admin@example.test');
    await user.type(screen.getByLabelText('Password'), 'bad-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials');
    expect(onLogin).not.toHaveBeenCalled();
  });
  it('prevents submission of empty required fields', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    render(<Login onLogin={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByLabelText('Email')).toBeInvalid();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('announces a pending request and disables repeated submission', async () => {
    let resolve!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>(done => { resolve = done; }));
    const user = userEvent.setup();
    render(<Login onLogin={vi.fn()} />);
    await user.type(screen.getByLabelText('Email'), 'admin@example.test');
    await user.type(screen.getByLabelText('Password'), 'local-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    expect(screen.getByText('Checking your credentials…')).toBeInTheDocument();
    resolve(new Response('', { status: 401 }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
