/** Communicate with the same-origin identity API. */
export interface User { id: string; email: string; role: string; segments: string[] }
export interface Session { token: string; user: User }
export interface Segment { id: string; name: string }
export interface ManagedUser extends User { active: boolean }
export interface UserAudit { id: number; actorId: string; targetId: string; occurredAt: string; oldValues: ManagedUser | null; newValues: ManagedUser }
export interface Application { id: string; name: string; segmentId: string; owner: string; lifecycle: string; criticality: string; qualityScore: number | null }
export interface OverviewReport { segmentCount: number; applicationCount: number; scoredApplicationCount: number; unknownScoreCount: number; segments: { id: string; name: string; applicationCount: number }[] }
const base = import.meta.env.VITE_API_BASE_URL || '';

/** Fetch an authorized CSV as a download rather than exposing the session in a URL. */
export async function downloadApplicationsCsv(token: string): Promise<Blob> {
  const response = await fetch(`${base}/api/v1/reports/applications.csv`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(typeof payload?.message === 'string' ? payload.message : `Export failed (${response.status})`);
  }
  return response.blob();
}

/** Send an authenticated inventory request and expose actionable server errors. */
export async function inventoryRequest<T>(token: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api/v1/${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(typeof payload?.message === 'string' ? payload.message : `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

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
