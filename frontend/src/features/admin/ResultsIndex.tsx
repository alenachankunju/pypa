/**
 * Results index — item readiness overview (feeds into screen A14).
 * ADM-12-04: bulk publish all Ready items with a summary confirmation.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ApiMeta } from '../../lib/api';
import { AlertDialog, ErrorState, LoadingState, PageHeader, StatusBadge } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface ItemReadiness {
  itemId: string;
  itemName: string;
  categoryName: string | null;
  publicationState: string;
  hasUnresolvedTie: boolean;
  performanceCount: number;
  completeCount: number;
  pendingCount: number;
  isReady: boolean;
}

export function ResultsIndex() {
  const { can } = useAuth();
  const [rows, setRows] = useState<ItemReadiness[] | null>(null);
  const [meta, setMeta] = useState<ApiMeta>({});
  const [error, setError] = useState<unknown>(null);
  const [alertError, setAlertError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<{ itemName: string }[] | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    api
      .getWithMeta<ItemReadiness[]>('/api/admin/results/items')
      .then((r) => {
        setRows(r.data);
        setMeta(r.meta ?? {});
      })
      .catch(setError);
  }

  useEffect(load, []);

  async function previewPublishAll() {
    try {
      const result = await api.post<{ published: { itemName: string }[] }>('/api/admin/results/publish-all', { dryRun: true });
      setConfirm(result.published);
    } catch (err) {
      setAlertError(err);
    }
  }

  async function confirmPublishAll() {
    setBusy(true);
    try {
      await api.post('/api/admin/results/publish-all', { dryRun: false });
      setConfirm(null);
      load();
    } catch (err) {
      setAlertError(err);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!rows) return <LoadingState />;

  return (
    <div className="stack-lg">
      <PageHeader
        icon="☰"
        title="Item results"
        subtitle={
          typeof meta.unpublishedItemCount === 'number'
            ? `${meta.unpublishedItemCount} item(s) still unpublished`
            : undefined
        }
        actions={
          can('PUBLISH_RESULTS') && (
            <button type="button" className="btn btn-primary" onClick={() => void previewPublishAll()}>
              Publish all ready
            </button>
          )
        }
      />

      <div className="card-flush">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th>Progress</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.itemId}>
                  <td>{r.itemName}</td>
                  <td>{r.categoryName ?? '—'}</td>
                  <td className="num">
                    {r.completeCount}/{r.performanceCount}
                  </td>
                  <td>
                    <StatusBadge status={r.publicationState} />
                    {r.hasUnresolvedTie && <span className="badge badge-danger" style={{ marginLeft: 4 }}>Tie</span>}
                  </td>
                  <td>
                    <Link to={`/admin/results/${r.itemId}`} className="btn btn-sm btn-secondary">
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {confirm && (
        <div className="overlay" onClick={() => setConfirm(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2 className="page-title">Publish {confirm.length} item(s)?</h2>
            <div className="stack-sm text-sm" style={{ margin: 'var(--space-3) 0' }}>
              {confirm.map((c, i) => (
                <div key={i}>{c.itemName}</div>
              ))}
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void confirmPublishAll()}>
                {busy ? 'Publishing…' : 'Publish all'}
              </button>
            </div>
          </div>
        </div>
      )}

      <AlertDialog error={alertError} onClose={() => setAlertError(null)} />
    </div>
  );
}
