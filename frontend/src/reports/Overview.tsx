/** Show a scoped overview of persisted inventory and an authorized export. */
import { useEffect, useState } from 'react';
import { downloadApplicationsCsv, inventoryRequest } from '../api';
import type { OverviewReport, User } from '../api';

/** Load current inventory counts and present unavailable metrics honestly. */
export default function Overview({ token, user }: { token: string; user: User }) {
  const [report, setReport] = useState<OverviewReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exportError, setExportError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    inventoryRequest<OverviewReport>(token, 'reports/overview')
      .then(value => { if (active) setReport(value); })
      .catch((err: unknown) => { if (active) { setReport(null); setError(err instanceof Error ? err.message : 'Unable to load overview'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, refresh]);

  /** Download the server-authorized attachment and release the temporary URL. */
  async function exportCsv(): Promise<void> {
    setBusy(true);
    setExportError('');
    try {
      const blob = await downloadApplicationsCsv(token);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'applications.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Unable to export applications');
    } finally { setBusy(false); }
  }

  return (
    <section aria-labelledby="overview-title">
      <h2 id="overview-title">Inventory overview</h2>
      <p>{user.role === 'admin' || user.role === 'executive' ? 'Enterprise-wide scope.' : 'Assigned segments only.'}</p>
      <p className="notice">Sensitivity: Internal. Handle exported inventory accordingly.</p>
      {loading && <p role="status">Loading overview…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && report && (
        <>
          <dl>
            <div><dt>Segments</dt><dd>{report.segmentCount}</dd></div>
            <div><dt>Applications</dt><dd>{report.applicationCount}</dd></div>
            <div><dt>Applications with a quality score</dt><dd>{report.scoredApplicationCount}</dd></div>
            <div><dt>Applications with an unavailable quality score</dt><dd>{report.unknownScoreCount}</dd></div>
          </dl>
          <h3>Applications by segment</h3>
          {report.segments.length ? <ul>{report.segments.map(segment => <li key={segment.id}>{segment.name} ({segment.id}): {segment.applicationCount}</li>)}</ul> : <p>No accessible segments.</p>}
          {report.applicationCount === 0 && <p>No accessible applications.</p>}
          <p>Historical trends and predictive metrics: Unavailable.</p>
        </>
      )}
      <button className="secondary" onClick={() => setRefresh(value => value + 1)} disabled={loading}>{error ? 'Retry overview' : 'Refresh overview'}</button>
      {(user.role === 'admin' || user.role === 'executive') && <button onClick={exportCsv} disabled={busy}>{busy ? 'Exporting…' : 'Export applications CSV'}</button>}
      {exportError && <p role="alert">{exportError}</p>}
    </section>
  );
}
