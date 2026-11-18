/** Render the authenticated shell or the development login. */
import { useEffect, useState } from 'react';
import Login from './auth/Login';
import Inventory from './inventory/Inventory';
import Users from './users/Users';
import Overview from './reports/Overview';
import { currentUser } from './api';
import type { Session, User } from './api';

const tokenKey = 'eqip.session';

/** Restore a session from this browser tab and revalidate it with the API. */
export default function App() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(tokenKey));
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    let active = true;
    setLoading(true);
    setError('');
    currentUser(token).then(value => { if (active) setUser(value); }).catch((err: unknown) => {
      if (!active) return;
      if (err instanceof Error && err.message.startsWith('Session expired')) {
        sessionStorage.removeItem(tokenKey);
        setToken(null);
        setUser(null);
      } else setError('Unable to load your session. Check your connection and retry.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, retry]);

  /** Persist only the signed token for the lifetime of this tab. */
  function signedIn(session: Session): void {
    sessionStorage.setItem(tokenKey, session.token);
    setUser(session.user);
    setToken(session.token);
  }

  /** Remove the local session; the token itself expires on the server. */
  function signOut(): void {
    sessionStorage.removeItem(tokenKey);
    setToken(null);
    setUser(null);
    setError('');
  }

  if (loading) return <main className="state" role="status">Loading your session…</main>;
  if (error) return (
    <main className="state">
      <p role="alert">{error}</p>
      <button onClick={() => setRetry(value => value + 1)}>Retry</button>
      <button className="secondary" onClick={signOut}>Sign out</button>
    </main>
  );
  if (!token || !user) return <Login onLogin={signedIn} />;
  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <strong>EQIP</strong>
          <span>Enterprise Quality Intelligence Platform</span>
        </div>
        <button className="secondary" onClick={signOut}>Sign out</button>
      </header>
      <main className="workspace">
        <p className="eyebrow">Your workspace</p>
        <h1>Welcome to EQIP</h1>
        <p>
          Signed in as <strong>{user.email}</strong>
        </p>
        <dl>
          <div>
            <dt>Access role</dt>
            <dd>{user.role}</dd>
          </div>
          <div>
            <dt>Access scope</dt>
            <dd>
              {user.role === 'admin' || user.role === 'executive'
                ? 'Enterprise-wide'
                : user.segments.length
                  ? `Assigned: ${user.segments.join(', ')}`
                  : 'No segments assigned'}
            </dd>
          </div>
        </dl>
        <p className="notice">Development identity is active.</p>
        <Overview token={token} user={user} />
        <Inventory token={token} user={user} />
        {user.role === 'admin' && <Users token={token} />}
      </main>
    </div>
  );
}
