/** Provide development account administration and access-change history. */
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { inventoryRequest } from '../api';
import type { ManagedUser, Segment, UserAudit } from '../api';

const roles = ['admin', 'executive', 'segment_leader', 'qe_leader', 'qe_manager', 'engineer', 'release_manager', 'auditor', 'vendor', 'viewer'];

/** Render editable access controls for one existing account. */
function UserEditor({ user, segments, busy, save }: { user: ManagedUser; segments: Segment[]; busy: boolean; save: (user: ManagedUser) => Promise<void> }) {
  const [role, setRole] = useState(user.role);
  const [active, setActive] = useState(user.active);
  const [assigned, setAssigned] = useState(user.segments);
  useEffect(() => { setRole(user.role); setActive(user.active); setAssigned(user.segments); }, [user]);
  return (
    <form onSubmit={event => { event.preventDefault(); void save({ ...user, role, active, segments: assigned }); }}>
      <h4>{user.email}</h4>
      <label htmlFor={`role-${user.id}`}>Role for {user.email}</label>
      <select id={`role-${user.id}`} value={role} onChange={event => setRole(event.target.value)}>
        {roles.map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
      </select>
      <label htmlFor={`active-${user.id}`}>Status for {user.email}</label>
      <select id={`active-${user.id}`} value={active ? 'active' : 'disabled'} onChange={event => setActive(event.target.value === 'active')}>
        <option value="active">Active</option>
        <option value="disabled">Disabled</option>
      </select>
      <label htmlFor={`segments-${user.id}`}>Segments for {user.email} (select multiple)</label>
      <select id={`segments-${user.id}`} multiple value={assigned} onChange={event => setAssigned(Array.from(event.target.selectedOptions, option => option.value))}>
        {segments.map(segment => <option key={segment.id} value={segment.id}>{segment.name} ({segment.id})</option>)}
      </select>
      <button disabled={busy}>Save access for {user.email}</button>
    </form>
  );
}

/** Load users, allow changes, and show the persisted audit trail. */
export default function Users({ token }: { token: string }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [audit, setAudit] = useState<UserAudit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [retry, setRetry] = useState(0);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('viewer');
  const [assigned, setAssigned] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(''); setLoadFailed(false);
    Promise.all([
      inventoryRequest<{ items: ManagedUser[] }>(token, 'users'),
      inventoryRequest<{ items: Segment[] }>(token, 'segments'),
      inventoryRequest<{ items: UserAudit[] }>(token, 'users/audit'),
    ]).then(([u, s, a]) => { if (alive) { setUsers(u.items); setSegments(s.items); setAudit(a.items); } })
      .catch((err: unknown) => { if (alive) { setLoadFailed(true); setError(err instanceof Error ? err.message : 'Unable to load users'); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [token, retry]);

  /** Save a new local account without retaining its password in component state. */
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      await inventoryRequest<ManagedUser>(token, 'users', 'POST', { email, password, role, active: true, segments: assigned });
      setEmail(''); setPassword(''); setAssigned([]); setMessage('User created.'); setRetry(value => value + 1);
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to create user'); }
    finally { setBusy(false); }
  }

  /** Persist a user's access changes. */
  async function save(user: ManagedUser) {
    setBusy(true); setError(''); setMessage('');
    try {
      await inventoryRequest<ManagedUser>(token, `users/${encodeURIComponent(user.id)}`, 'PATCH', { role: user.role, active: user.active, segments: user.segments });
      setMessage('Access saved.'); setRetry(value => value + 1);
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to save access'); }
    finally { setBusy(false); }
  }

  return (
    <section aria-labelledby="users-title">
      <h2 id="users-title">User administration</h2>
      <p>Manage local development accounts and their segment access. Disabling an account revokes its sessions.</p>
      {loading && <p role="status">Loading users…</p>}
      {error && <div role="alert"><p className="error">{error}</p><button className="secondary" onClick={() => setRetry(value => value + 1)}>Reload users</button></div>}
      {message && <p role="status">{message}</p>}
      {!loading && !loadFailed && (
        <>
          <button className="secondary" onClick={() => setRetry(value => value + 1)}>Refresh user data and segments</button>
          <form onSubmit={create}>
            <h3>Create development user</h3>
            <label htmlFor="new-user-email">User email</label>
            <input id="new-user-email" type="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} />
            <label htmlFor="new-user-password">Development password (12–256 characters)</label>
            <input id="new-user-password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={password} onChange={event => setPassword(event.target.value)} />
            <label htmlFor="new-user-role">New user role</label>
            <select id="new-user-role" value={role} onChange={event => setRole(event.target.value)}>
              {roles.map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
            </select>
            <label htmlFor="new-user-segments">New user segments (select multiple)</label>
            <select id="new-user-segments" multiple value={assigned} onChange={event => setAssigned(Array.from(event.target.selectedOptions, option => option.value))}>
              {segments.map(segment => <option key={segment.id} value={segment.id}>{segment.name} ({segment.id})</option>)}
            </select>
            <button disabled={busy}>Create user</button>
          </form>
          <h3>Users</h3>
          {users.length ? users.map(user => <UserEditor key={user.id} user={user} segments={segments} busy={busy} save={save} />) : <p>No users found.</p>}
          <h3>Access audit history</h3>
          {audit.length ? <ul>{audit.map(entry => (
            <li key={entry.id}>
              <strong>{entry.newValues.email}</strong> — {entry.occurredAt} · Actor: {users.find(user => user.id === entry.actorId)?.email || entry.actorId}
              <div>Before: {entry.oldValues ? `${entry.oldValues.role}, ${entry.oldValues.active ? 'active' : 'disabled'}, segments: ${entry.oldValues.segments.join(', ') || 'none'}` : 'new account'}</div>
              <div>After: {entry.newValues.role}, {entry.newValues.active ? 'active' : 'disabled'}, segments: {entry.newValues.segments.join(', ') || 'none'}</div>
            </li>
          ))}</ul> : <p>No access changes recorded.</p>}
        </>
      )}
    </section>
  );
}
