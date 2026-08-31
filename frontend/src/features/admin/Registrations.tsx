/**
 * Screen A8 — Item entries (FSD 5.6).
 * ADM-06-01: add participants by chest number/name; see the entry list with
 * church names. ADM-06-07: generate the call sheet.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { ErrorState, LoadingState, PageHeader } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface ItemOption {
  id: string;
  name: string;
}
interface RegistrationRow {
  id: string;
  itemId: string;
  itemName: string;
  chestNumber: string | null;
  participantName: string;
  churchName: string;
  isLateEntry: boolean;
  withdrawnReason: string | null;
}

export function Registrations() {
  const { can } = useAuth();
  const [items, setItems] = useState<ItemOption[]>([]);
  const [itemId, setItemId] = useState('');
  const [rows, setRows] = useState<RegistrationRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.get<ItemOption[]>('/api/admin/items').then((data) => {
      setItems(data);
      if (data.length > 0) setItemId(data[0]!.id);
    });
  }, []);

  function load() {
    if (!itemId) return;
    api.get<RegistrationRow[]>('/api/admin/registrations', { itemId }).then(setRows).catch(setError);
  }

  useEffect(load, [itemId]);

  async function withdraw(id: string) {
    const reason = window.prompt('Reason for withdrawal (optional):') ?? undefined;
    await api.del(`/api/admin/registrations/${id}`, reason ? { reason } : undefined);
    load();
  }

  async function generateCallSheet(mode: 'CHEST_NUMBER' | 'RANDOM' | 'CHURCH') {
    await api.post('/api/admin/registrations/call-order', { itemId, mode });
    load();
  }

  if (error) return <ErrorState error={error} onRetry={load} />;

  return (
    <div className="stack-lg">
      <PageHeader
        title="Registrations"
        subtitle="Entry list per item"
        actions={
          <select className="select" value={itemId} onChange={(e) => setItemId(e.target.value)}>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        }
      />

      {can('MANAGE_REGISTRATIONS') && (
        <div className="row">
          <button type="button" className="btn btn-secondary" onClick={() => void generateCallSheet('CHEST_NUMBER')}>
            Order by chest number
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => void generateCallSheet('CHURCH')}>
            Order by church
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => void generateCallSheet('RANDOM')}>
            Randomise order
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
            Print call sheet
          </button>
        </div>
      )}

      {!rows ? (
        <LoadingState />
      ) : (
        <div className="card-flush">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Chest</th>
                  <th>Participant</th>
                  <th>Church</th>
                  <th></th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="num strong">{r.chestNumber ?? '—'}</td>
                    <td>{r.participantName}</td>
                    <td>{r.churchName}</td>
                    <td>{r.isLateEntry && <span className="badge badge-warning">Late entry</span>}</td>
                    <td>
                      {can('MANAGE_REGISTRATIONS') && (
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void withdraw(r.id)}>
                          Withdraw
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
