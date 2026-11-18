/** Render the development sign-in form. */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { login } from '../api';
import type { Session } from '../api';

interface LoginProps { onLogin: (session: Session) => void }

/** Accept credentials and report success, loading, or failure accessibly. */
export default function Login({ onLogin }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  /** Submit credentials without exposing them in the URL. */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      onLogin(await login(email.trim(), password));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-layout">
      <section className="intro" aria-labelledby="welcome-heading">
        <p className="eyebrow">Enterprise quality intelligence</p>
        <h1 id="welcome-heading">A clearer view of quality.</h1>
        <p>Sign in to the development portal to access your assigned workspace.</p>
        <p className="notice">Development access only · Not connected to enterprise SSO</p>
      </section>
      <section className="signin" aria-labelledby="signin-heading">
        <p className="eyebrow">EQIP / Access</p>
        <h2 id="signin-heading">Sign in</h2>
        <p>Use the local credentials configured by your administrator.</p>
        <form onSubmit={submit}>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" required aria-required="true" value={email} onChange={event => setEmail(event.target.value)} />
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" required aria-required="true" value={password} onChange={event => setPassword(event.target.value)} />
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'}</button>
          <p className="status" aria-live="polite">{loading ? 'Checking your credentials…' : ''}</p>
        </form>
      </section>
    </main>
  );
}
