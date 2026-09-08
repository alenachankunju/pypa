/**
 * Screen A17 — Reports (FSD 5.13). All nine catalogue reports generate real
 * output now; certificates and badges are PDF-only print layouts (no
 * barcode/QR — that needs a dedicated library this build doesn't install).
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { AlertDialog, ErrorState, Field, LoadingState, PageHeader } from '../../components/ui';

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
interface ChurchOption {
  id: string;
  name: string;
}
interface CategoryOption {
  id: string;
  name: string;
}

async function downloadReport(path: string, format: 'pdf' | 'xlsx' | undefined, fallbackName: string) {
  const { blob, filename } = await api.downloadFile(path, format ? { format } : undefined);
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
  const [alertError, setAlertError] = useState<unknown>(null);
  const [items, setItems] = useState<ItemOption[]>([]);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [churches, setChurches] = useState<ChurchOption[]>([]);
  const [selectedChurchId, setSelectedChurchId] = useState('');
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
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
    api
      .get<ChurchOption[]>('/api/admin/churches', { pageSize: 200 })
      .then((data) => {
        setChurches(data);
        if (data.length > 0) setSelectedChurchId(data[0]!.id);
      })
      .catch(() => undefined);
    api
      .get<CategoryOption[]>('/api/admin/categories', { pageSize: 200 })
      .then((data) => {
        setCategories(data);
        if (data.length > 0) setSelectedCategoryId(data[0]!.id);
      })
      .catch(() => undefined);
  }, []);

  async function run(key: string, path: string, format: 'pdf' | 'xlsx' | undefined, filename: string) {
    setBusy(key);
    try {
      await downloadReport(path, format, filename);
    } catch (err) {
      setAlertError(err);
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorState error={error} />;

  return (
    <div className="stack-lg">
      <PageHeader icon="⎙" title="Reports" subtitle="Export result sheets, leaderboards and exception reports" />

      <div className="card stack">
        <p className="eyebrow">Per-item reports</p>
        <Field label="Item">
          <select className="select" value={selectedItemId} onChange={(e) => setSelectedItemId(e.target.value)}>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="stack-sm">
          <div className="row-between">
            <span className="text-sm strong">Item result sheet</span>
            <div className="row">
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                disabled={!selectedItemId || busy !== null}
                onClick={() => void run('item-pdf', `/api/admin/reports/items/${selectedItemId}`, 'pdf', 'item-result.pdf')}
              >
                {busy === 'item-pdf' ? '…' : 'PDF'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                disabled={!selectedItemId || busy !== null}
                onClick={() => void run('item-xlsx', `/api/admin/reports/items/${selectedItemId}`, 'xlsx', 'item-result.xlsx')}
              >
                {busy === 'item-xlsx' ? '…' : 'Excel'}
              </button>
            </div>
          </div>
          <div className="row-between">
            <span className="text-sm strong">Participation list / call sheet</span>
            <div className="row">
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                disabled={!selectedItemId || busy !== null}
                onClick={() => void run('call-pdf', `/api/admin/reports/call-sheet/${selectedItemId}`, 'pdf', 'call-sheet.pdf')}
              >
                {busy === 'call-pdf' ? '…' : 'PDF'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                disabled={!selectedItemId || busy !== null}
                onClick={() => void run('call-xlsx', `/api/admin/reports/call-sheet/${selectedItemId}`, 'xlsx', 'call-sheet.xlsx')}
              >
                {busy === 'call-xlsx' ? '…' : 'Excel'}
              </button>
            </div>
          </div>
          <div className="row-between">
            <span className="text-sm strong">Certificates</span>
            <span className="text-xs muted" style={{ marginRight: 'auto', marginLeft: 'var(--space-3)' }}>
              One per 1st/2nd/3rd place
            </span>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={!selectedItemId || busy !== null}
              onClick={() => void run('cert-pdf', `/api/admin/reports/certificates/${selectedItemId}`, undefined, 'certificates.pdf')}
            >
              {busy === 'cert-pdf' ? '…' : 'PDF'}
            </button>
          </div>
        </div>
      </div>

      <div className="card stack">
        <p className="eyebrow">Church detail sheet</p>
        <Field label="Church">
          <select className="select" value={selectedChurchId} onChange={(e) => setSelectedChurchId(e.target.value)}>
            {churches.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!selectedChurchId || busy !== null}
            onClick={() => void run('church-detail-pdf', `/api/admin/reports/churches/${selectedChurchId}`, 'pdf', 'church-detail.pdf')}
          >
            {busy === 'church-detail-pdf' ? 'Generating…' : 'Download PDF'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!selectedChurchId || busy !== null}
            onClick={() => void run('church-detail-xlsx', `/api/admin/reports/churches/${selectedChurchId}`, 'xlsx', 'church-detail.xlsx')}
          >
            {busy === 'church-detail-xlsx' ? 'Generating…' : 'Download Excel'}
          </button>
        </div>
      </div>

      <div className="card stack">
        <p className="eyebrow">Category detail sheet</p>
        <p className="text-xs muted" style={{ marginTop: 'calc(var(--space-2) * -1)' }}>
          Every item restricted to this category, with each participant's full judge-by-judge marks — a
          category-wise backup of the mark lists.
        </p>
        <Field label="Category">
          <select className="select" value={selectedCategoryId} onChange={(e) => setSelectedCategoryId(e.target.value)}>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!selectedCategoryId || busy !== null}
            onClick={() =>
              void run(
                'category-detail-pdf',
                `/api/admin/reports/category-results?categoryId=${selectedCategoryId}`,
                'pdf',
                'category-results.pdf',
              )
            }
          >
            {busy === 'category-detail-pdf' ? 'Generating…' : 'Download PDF'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!selectedCategoryId || busy !== null}
            onClick={() =>
              void run(
                'category-detail-xlsx',
                `/api/admin/reports/category-results?categoryId=${selectedCategoryId}`,
                'xlsx',
                'category-results.xlsx',
              )
            }
          >
            {busy === 'category-detail-xlsx' ? 'Generating…' : 'Download Excel'}
          </button>
        </div>
      </div>

      <div className="card">
        <p className="eyebrow" style={{ marginBottom: 'var(--space-3)' }}>
          Event-wide reports
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
          <ReportTile
            name="Consolidated results"
            busy={busy}
            onPdf={() => void run('consolidated-pdf', '/api/admin/reports/consolidated', 'pdf', 'consolidated-results.pdf')}
            onXlsx={() => void run('consolidated-xlsx', '/api/admin/reports/consolidated', 'xlsx', 'consolidated-results.xlsx')}
            pdfKey="consolidated-pdf"
            xlsxKey="consolidated-xlsx"
          />
          <ReportTile
            name="Category-wise results (full backup)"
            busy={busy}
            onPdf={() => void run('category-all-pdf', '/api/admin/reports/category-results', 'pdf', 'category-results-all.pdf')}
            onXlsx={() => void run('category-all-xlsx', '/api/admin/reports/category-results', 'xlsx', 'category-results-all.xlsx')}
            pdfKey="category-all-pdf"
            xlsxKey="category-all-xlsx"
          />
          <div className="card stack-sm" style={{ background: 'var(--surface-sunken)' }}>
            <span className="text-sm strong">Badge sheet</span>
            <span className="text-xs muted">Chest number, name, church — no barcode/QR (not installed)</span>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={busy !== null}
              onClick={() => void run('badges-pdf', '/api/admin/reports/badges', undefined, 'badge-sheet.pdf')}
            >
              {busy === 'badges-pdf' ? '…' : 'PDF'}
            </button>
          </div>
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

      <AlertDialog error={alertError} onClose={() => setAlertError(null)} />
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
