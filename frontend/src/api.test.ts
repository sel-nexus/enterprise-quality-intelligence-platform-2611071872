/** Test API client response handling and request contracts. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentUser, downloadApplicationsCsv, inventoryRequest, login } from './api';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => vi.restoreAllMocks());

describe('API client', () => {
  it('logs in with JSON credentials and returns the session', async () => {
    const session = { token: 'abc', user: { id: '1', email: 'a@example.test', role: 'viewer', segments: [] } };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(session));
    await expect(login('a@example.test', 'password')).resolves.toEqual(session);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/api/v1/auth/login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.test', password: 'password' }) });
  });
  it('distinguishes rejected credentials, server failure, and network failure', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({}, 503)).mockRejectedValueOnce(new TypeError('Offline'));
    await expect(login('a', 'b')).rejects.toThrow('Invalid credentials');
    await expect(login('a', 'b')).rejects.toThrow('Unable to sign in');
    await expect(login('a', 'b')).rejects.toThrow('Offline');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('loads current identity and differentiates expiry and other failures', async () => {
    const user = { id: '1', email: 'a@example.test', role: 'viewer', segments: [] };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(user)).mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({}, 500));
    await expect(currentUser('token')).resolves.toEqual(user);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/auth/me'), { headers: { Authorization: 'Bearer token' } });
    await expect(currentUser('token')).rejects.toThrow('Session expired');
    await expect(currentUser('token')).rejects.toThrow('Unable to load your session');
  });
  it('sends authenticated PATCH JSON and returns the saved record', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ id: 'a', name: 'Changed' }));
    await expect(inventoryRequest('token', 'segments/a', 'PATCH', { name: 'Changed' })).resolves.toEqual({ id: 'a', name: 'Changed' });
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/api/v1/segments/a'), { method: 'PATCH', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: '{"name":"Changed"}' });
  });
  it('returns server errors and status fallback for non-JSON errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ message: 'Forbidden' }, 403)).mockResolvedValueOnce(new Response('not json', { status: 502 })).mockRejectedValueOnce(new TypeError('Offline'));
    await expect(inventoryRequest('token', 'segments')).rejects.toThrow('Forbidden');
    await expect(inventoryRequest('token', 'segments')).rejects.toThrow('Request failed (502)');
    await expect(inventoryRequest('token', 'segments')).rejects.toThrow('Offline');
  });
  it('downloads CSV bytes and reports export failures', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('id,name\na,Alpha\n', { headers: { 'Content-Type': 'text/csv' } })).mockResolvedValueOnce(json({ message: 'Denied' }, 403)).mockResolvedValueOnce(new Response('not json', { status: 500 }));
    const blob = await downloadApplicationsCsv('token');
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(text).toBe('id,name\na,Alpha\n');
    expect(blob.type).toContain('text/csv');
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/reports/applications.csv'), { headers: { Authorization: 'Bearer token' } });
    await expect(downloadApplicationsCsv('token')).rejects.toThrow('Denied');
    await expect(downloadApplicationsCsv('token')).rejects.toThrow('Export failed (500)');
  });
});
