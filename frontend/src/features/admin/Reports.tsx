/**
 * Screen A17 — Reports (FSD 5.13).
 *
 * The exceptions report (ADM-10-04) and four of the nine catalogue reports
 * (item result sheet, church leaderboard, individual champion sheet, judge
 * activity) generate real PDF/Excel output. The rest — consolidated results,
 * participation/call sheet, certificates, badge sheet — remain the Phase 4
 * placeholder (FSD 16): the data APIs exist, the file-rendering layer for
 * those specific ones doesn't yet.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { ErrorState, Field, LoadingState, PageHeader } from '../../components/ui';

interface ExceptionsReport {
  revokedScores: { id: string; mark: number; item_name: string; judge_name: string; revoked_reason: string }[];
  voidedPerformances: { id: string; item_name: string; void_reason: string }[];
  absentees: { id: string; item_name: string; chest_number: string | null }[];
  forcedSessionClosures: { id: string; name: string; force_closed_reason: string }[];
  totals: Record<string, number>;
}

interface ItemOption {
  id: string;
  name: string;
}

const PLACEHOLDER_REPORTS = [
  'Consolidated results',
  'Church detail sheet',
  'Participation list / call sheet',
  'Certificates',
  'Badge sheet',
];

async function downloadReport(path: string, format: 'pdf' | 'xlsx', fallbackName: string) {
  const { blob, filename } = await api.downloadFile(path, { format });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename ?? fallbackName;
  a.click();
  URL.revokeObjectURL(url);
}

export function Reports() {
  const [exceptions, setExceptions] = useState<ExceptionsReport | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [items, setItems] = useState<ItemOption[]>([]);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api.get<ExceptionsReport>('/api/admin/audit/exceptions').then(setExceptions).catch(setError);
    api
      .get<ItemOption[]>('/api/admin/items')
      .then((data) => {
        setItems(data);
        if (data.length > 0) setSelectedItemId(data[0]!.id);
      })
      .catch(() => undefined);
  }, []);

  async function run(key: string, path: string, format: 'pdf' | 'xlsx', filename: string) {
    setBusy(key);
    try {
      await downloadReport(path, format, filename);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorState error={error} />;

  return (
    <div className="stack-lg">
      <PageHeader title="Reports" subtitle="Export result sheets, leaderboards and exception reports" />

      <div className="card stack">
        <p className="eyebrow">Item result sheet</p>
        <Field label="Item">
          <select className="select" value={selectedItemId} onChange={(e) => setSelectedItemId(e.target.value)}>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!selectedItemId || busy !== null}
            onClick={() => void run('item-pdf', `/api/admin/reports/items/${selectedItemId}`, 'pdf', 'item-result.pdf')}
          >
            {busy === 'item-pdf' ? 'Generating…' : 'Download PDF'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!selectedItemId || busy !== null}
            onClick={() => void run('item-xlsx', `/api/admin/reports/items/${selectedItemId}`, 'xlsx', 'item-result.xlsx')}
          >
            {busy === 'item-xlsx' ? 'Generating…' : 'Download Excel'}
          </button>
        </div>
      </div>

      <div className="card">
        <p className="eyebrow" style={{ marginBottom: 'var(--space-3)' }}>
          Available reports
        </p>
        <div className="grid grid-3">
          <ReportTile
            name="Church leaderboard"
            busy={busy}
            onPdf={() => void run('church-pdf', '/api/admin/reports/church-leaderboard', 'pdf', 'church-leaderboard.pdf')}
            onXlsx={() => void run('church-xlsx', '/api/admin/reports/church-leaderboard', 'xlsx', 'church-leaderboard.xlsx')}
            pdfKey="church-pdf"
            xlsxKey="church-xlsx"
          />
          <ReportTile
            name="Individual champion sheet"
            busy={busy}
            onPdf={() => void run('champion-pdf', '/api/admin/reports/champions', 'pdf', 'individual-champion.pdf')}
            onXlsx={() => void run('champion-xlsx', '/api/admin/reports/champions', 'xlsx', 'individual-champion.xlsx')}
            pdfKey="champion-pdf"
            xlsxKey="champion-xlsx"
          />
          <ReportTile
            name="Judge activity report"
            busy={busy}
            onPdf={() => void run('judge-pdf', '/api/admin/reports/judge-activity', 'pdf', 'judge-activity.pdf')}
            onXlsx={() => void run('judge-xlsx', '/api/admin/reports/judge-activity', 'xlsx', 'judge-activity.xlsx')}
            pdfKey="judge-pdf"
            xlsxKey="judge-xlsx"
          />
          {PLACEHOLDER_REPORTS.map((name) => (
            <div key={name} className="card row-between" style={{ background: 'var(--surface-sunken)' }}>
              <span className="text-sm">{name}</span>
              <span className="badge badge-neutral">Not yet built</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Exceptions report</span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => window.print()}>
            Print
          </button>
        </div>
        <div className="card-body">
          {!exceptions ? (
            <LoadingState />
          ) : (
            <div className="grid grid-2">
              <ExceptionList title="Revoked scores" items={exceptions.revokedScores.map((r) => `${r.item_name} · ${r.judge_name} · ${r.mark} · ${r.revoked_reason}`)} />
              <ExceptionList title="Voided performances" items={exceptions.voidedPerformances.map((r) => `${r.item_name} · ${r.void_reason}`)} />
              <ExceptionList title="Absentees" items={exceptions.absentees.map((r) => `${r.item_name} · ${r.chest_number ?? '—'}`)} />
              <ExceptionList title="Forced session closures" items={exceptions.forcedSessionClosures.map((r) => `${r.name} · ${r.force_closed_reason}`)} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ReportTile({
  name,
  busy,
  pdfKey,
  xlsxKey,
  onPdf,
  onXlsx,
}: {
  name: string;
  busy: string | null;
  pdfKey: string;
  xlsxKey: string;
  onPdf: () => void;
  onXlsx: () => void;
}) {
  return (
    <div className="card stack-sm" style={{ background: 'var(--surface-sunken)' }}>
      <span className="text-sm strong">{name}</span>
      <div className="row">
        <button type="button" className="btn btn-sm btn-secondary" disabled={busy !== null} onClick={onPdf}>
          {busy === pdfKey ? '…' : 'PDF'}
        </button>
        <button type="button" className="btn btn-sm btn-secondary" disabled={busy !== null} onClick={onXlsx}>
          {busy === xlsxKey ? '…' : 'Excel'}
        </button>
      </div>
    </div>
  );
}

function ExceptionList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="strong text-sm" style={{ marginBottom: 'var(--space-2)' }}>
        {title} ({items.length})
      </p>
      {items.length === 0 ? (
        <p className="text-sm muted">None</p>
      ) : (
        <ul className="stack-sm text-sm" style={{ listStyle: 'none' }}>
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
