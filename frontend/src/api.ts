/** Communicate with the same-origin identity API. */
export interface User { id: string; email: string; role: string; segments: string[] }
export interface Session { token: string; user: User }
const base = import.meta.env.VITE_API_BASE_URL || '';

/** Exchange credentials for a development session. */
export async function login(email: string, password: string): Promise<Session> {
  const response = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'Invalid credentials or development login is unavailable.' : 'Unable to sign in. Please try again.');
  return response.json() as Promise<Session>;
}

/** Load the current identity and distinguish an expired session from network failure. */
export async function currentUser(token: string): Promise<User> {
  const response = await fetch(`${base}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 401) throw new Error('Session expired. Please sign in again.');
  if (!response.ok) throw new Error('Unable to load your session. Please try again.');
  return response.json() as Promise<User>;
}
