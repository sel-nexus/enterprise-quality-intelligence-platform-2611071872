/** Show the inventory available to the signed-in user. */
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { inventoryRequest } from '../api';
import type { Application, Segment, User } from '../api';

/** Load, search and administer scoped inventory. */
export default function Inventory({ token, user }: { token: string; user: User }) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [message, setMessage] = useState('');
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState('');
  const [segmentId, setSegmentId] = useState('');
  const [segmentName, setSegmentName] = useState('');
  const [appId, setAppId] = useState('');
  const [name, setName] = useState('');
  const [appSegment, setAppSegment] = useState('');
  const [owner, setOwner] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  const [criticality, setCriticality] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setLoadFailed(false);
    Promise.all([inventoryRequest<{ items: Segment[] }>(token, 'segments'), inventoryRequest<{ items: Application[] }>(token, 'applications')])
      .then(([s, a]) => { if (active) { setSegments(s.items); setApplications(a.items); } })
      .catch((err: unknown) => { if (active) { setLoadFailed(true); setError(err instanceof Error ? err.message : 'Unable to load inventory'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, retry]);

  /** Submit a new segment and immediately reflect the saved record. */
  async function createSegment(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const saved = await inventoryRequest<Segment>(token, 'segments', 'POST', { id: segmentId, name: segmentName });
      setSegments(items => [...items, saved]); setSegmentId(''); setSegmentName(''); setMessage('Segment created.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to create segment'); }
    finally { setBusy(false); }
  }

  /** Submit a new application and immediately reflect the saved record. */
  async function createApplication(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const saved = await inventoryRequest<Application>(token, 'applications', 'POST', { id: appId, name, segmentId: appSegment, owner, lifecycle, criticality });
      setApplications(items => [...items, saved]); setAppId(''); setName(''); setOwner(''); setLifecycle(''); setCriticality(''); setMessage('Application created.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to create application'); }
    finally { setBusy(false); }
  }

  const filtered = applications.filter(app => [app.id, app.name, app.owner, app.segmentId].some(value => value.toLowerCase().includes(search.toLowerCase())));
  return (
    <section aria-labelledby="inventory-title">
      <h2 id="inventory-title">Inventory</h2>
      <p>{user.role === 'admin' || user.role === 'executive' ? 'Enterprise-wide inventory access.' : 'Showing inventory for your assigned segments only.'}</p>
      {loading && <p role="status">Loading inventory…</p>}
      {error && <div role="alert"><p className="error">{error}</p>{loadFailed && !loading && <button className="secondary" onClick={() => setRetry(value => value + 1)}>Retry loading</button>}</div>}
      {message && <p role="status">{message}</p>}
      {!loading && !loadFailed && (
        <>
          <h3>Segments</h3>
          {segments.length ? <ul>{segments.map(segment => <li key={segment.id}>{segment.name} ({segment.id})</li>)}</ul> : <p>No accessible segments.</p>}
          <h3>Applications</h3>
          <label htmlFor="inventory-search">Search applications</label>
          <input id="inventory-search" value={search} onChange={event => setSearch(event.target.value)} />
          {filtered.length ? <ul>{filtered.map(app => <li key={app.id}><strong>{app.name}</strong> ({app.id}) — {app.segmentId} · {app.owner} · {app.lifecycle} · {app.criticality} · Quality score: {app.qualityScore ?? 'Unavailable'}</li>)}</ul> : <p>No applications found.</p>}
        </>
      )}
      {user.role === 'admin' && !loading && !loadFailed && (
        <>
          <form onSubmit={createSegment}>
            <h3>Create segment</h3>
            <label htmlFor="segment-id">Segment ID</label>
            <input id="segment-id" required maxLength={80} value={segmentId} onChange={event => setSegmentId(event.target.value)} />
            <label htmlFor="segment-name">Segment name</label>
            <input id="segment-name" required maxLength={200} value={segmentName} onChange={event => setSegmentName(event.target.value)} />
            <button disabled={busy}>Create segment</button>
          </form>
          <form onSubmit={createApplication}>
            <h3>Create application</h3>
            <label htmlFor="app-id">Application ID</label>
            <input id="app-id" required maxLength={80} value={appId} onChange={event => setAppId(event.target.value)} />
            <label htmlFor="app-name">Application name</label>
            <input id="app-name" required maxLength={200} value={name} onChange={event => setName(event.target.value)} />
            <label htmlFor="app-segment">Application segment</label>
            <select id="app-segment" required value={appSegment} onChange={event => setAppSegment(event.target.value)}>
              <option value="">Select a segment</option>
              {segments.map(segment => <option key={segment.id} value={segment.id}>{segment.name}</option>)}
            </select>
            <label htmlFor="app-owner">Owner</label>
            <input id="app-owner" required maxLength={200} value={owner} onChange={event => setOwner(event.target.value)} />
            <label htmlFor="app-lifecycle">Lifecycle</label>
            <input id="app-lifecycle" required maxLength={200} value={lifecycle} onChange={event => setLifecycle(event.target.value)} />
            <label htmlFor="app-criticality">Criticality</label>
            <input id="app-criticality" required maxLength={200} value={criticality} onChange={event => setCriticality(event.target.value)} />
            <button disabled={busy}>Create application</button>
          </form>
        </>
      )}
    </section>
  );
}
