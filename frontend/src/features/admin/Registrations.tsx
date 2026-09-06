/**
 * Screen A8 — Item entries (FSD 5.6).
 * ADM-06-01: add participants by chest number/name; see the entry list with
 * church names. ADM-06-04: register a team for a group item. ADM-06-07:
 * generate the call sheet.
 */
import { useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { ErrorState, Field, LoadingState, PageHeader, Sheet } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface ItemOption {
  id: string;
  name: string;
  type: 'INDIVIDUAL' | 'GROUP';
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
interface MemberSearchResult {
  id: string;
  chestNumber: string;
  fullName: string;
  churchId: string;
  churchName: string;
}
interface ChurchOption {
  id: string;
  name: string;
}

export function Registrations() {
  const { can } = useAuth();
  const [items, setItems] = useState<ItemOption[]>([]);
  const [itemId, setItemId] = useState('');
  const [rows, setRows] = useState<RegistrationRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [churches, setChurches] = useState<ChurchOption[]>([]);

  // ADM-06-01: search-and-add an individual participant.
  const [adding, setAdding] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [addResults, setAddResults] = useState<MemberSearchResult[]>([]);
  const [addBusy, setAddBusy] = useState(false);
  const [ineligibleConfirm, setIneligibleConfirm] = useState<{ memberId: string; message: string; reason: string } | null>(null);

  // ADM-06-04: team registration.
  const [teamForm, setTeamForm] = useState<{
    teamName: string;
    churchId: string;
    memberQuery: string;
    memberResults: MemberSearchResult[];
    members: MemberSearchResult[];
    teamLeaderId: string;
  } | null>(null);
  const [teamSaving, setTeamSaving] = useState(false);
  const [teamError, setTeamError] = useState<unknown>(null);

  const currentItem = items.find((i) => i.id === itemId);

  useEffect(() => {
    api.get<ItemOption[]>('/api/admin/items').then((data) => {
      setItems(data);
      if (data.length > 0) setItemId(data[0]!.id);
    });
    api.get<ChurchOption[]>('/api/admin/churches', { pageSize: 200 }).then(setChurches).catch(() => undefined);
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

  useEffect(() => {
    if (!adding || addQuery.trim().length < 2) {
      setAddResults([]);
      return;
    }
    const handle = setTimeout(() => {
      api
        .get<MemberSearchResult[]>('/api/admin/members', { search: addQuery, pageSize: 10 })
        .then(setAddResults)
        .catch(() => setAddResults([]));
    }, 250);
    return () => clearTimeout(handle);
  }, [adding, addQuery]);

  async function addParticipant(memberId: string, eligibilityOverrideReason?: string) {
    setAddBusy(true);
    try {
      await api.post('/api/admin/registrations', { itemId, memberId, eligibilityOverrideReason });
      setAdding(false);
      setAddQuery('');
      setAddResults([]);
      setIneligibleConfirm(null);
      load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INELIGIBLE_ITEM') {
        setIneligibleConfirm({ memberId, message: err.message, reason: '' });
      } else {
        setError(err);
      }
    } finally {
      setAddBusy(false);
    }
  }

  function startTeam() {
    setTeamForm({ teamName: '', churchId: '', memberQuery: '', memberResults: [], members: [], teamLeaderId: '' });
    setTeamError(null);
  }

  useEffect(() => {
    if (!teamForm || teamForm.memberQuery.trim().length < 2) return;
    const handle = setTimeout(() => {
      api
        .get<MemberSearchResult[]>('/api/admin/members', { search: teamForm.memberQuery, pageSize: 10 })
        .then((results) => setTeamForm((f) => (f ? { ...f, memberResults: results } : f)))
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamForm?.memberQuery]);

  async function saveTeam() {
    if (!teamForm) return;
    setTeamSaving(true);
    setTeamError(null);
    try {
      await api.post('/api/admin/registrations/teams', {
        itemId,
        teamName: teamForm.teamName,
        churchId: teamForm.churchId,
        memberIds: teamForm.members.map((m) => m.id),
        teamLeaderId: teamForm.teamLeaderId || undefined,
      });
      setTeamForm(null);
      load();
    } catch (err) {
      setTeamError(err);
    } finally {
      setTeamSaving(false);
    }
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
        <div className="row row-wrap">
          {currentItem?.type === 'GROUP' ? (
            <button type="button" className="btn btn-primary" onClick={startTeam}>
              + Register a team
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              + Add participant
            </button>
          )}
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

      <Sheet open={adding} onClose={() => setAdding(false)} title="Add participant">
        <div className="stack">
          <Field label="Search by chest number or name">
            <input className="input" autoFocus value={addQuery} onChange={(e) => setAddQuery(e.target.value)} placeholder="e.g. 214 or Sarah" />
          </Field>
          <div className="stack-sm" style={{ maxHeight: 280, overflowY: 'auto' }}>
            {addResults.map((m) => (
              <div key={m.id} className="row-between" style={{ padding: 'var(--space-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                <span>
                  <strong className="num">{m.chestNumber}</strong> {m.fullName}
                  <span className="text-xs muted" style={{ marginLeft: 6 }}>
                    {m.churchName}
                  </span>
                </span>
                <button type="button" className="btn btn-sm btn-primary" disabled={addBusy} onClick={() => void addParticipant(m.id)}>
                  Add
                </button>
              </div>
            ))}
            {addQuery.trim().length >= 2 && addResults.length === 0 && <p className="text-sm muted">No members match.</p>}
          </div>
        </div>
      </Sheet>

      <Sheet
        open={ineligibleConfirm !== null}
        onClose={() => setIneligibleConfirm(null)}
        title="Not eligible for this item"
      >
        {ineligibleConfirm && (
          <div className="stack">
            <div className="banner banner-warning">{ineligibleConfirm.message}</div>
            <Field label="Reason to register anyway" required hint="At least 10 characters (FSD ADM-05-04 / ADM-06-03)">
              <textarea
                className="textarea"
                value={ineligibleConfirm.reason}
                onChange={(e) => setIneligibleConfirm({ ...ineligibleConfirm, reason: e.target.value })}
              />
            </Field>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setIneligibleConfirm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={addBusy || ineligibleConfirm.reason.trim().length < 10}
                onClick={() => void addParticipant(ineligibleConfirm.memberId, ineligibleConfirm.reason)}
              >
                {addBusy ? 'Adding…' : 'Register anyway'}
              </button>
            </div>
          </div>
        )}
      </Sheet>

      <Sheet open={teamForm !== null} onClose={() => setTeamForm(null)} title="Register a team">
        {teamForm && (
          <div className="stack">
            <Field label="Team name" required>
              <input className="input" value={teamForm.teamName} onChange={(e) => setTeamForm({ ...teamForm, teamName: e.target.value })} />
            </Field>
            <Field label="Owning church" required hint="All team members must belong to this church (ADM-06-04)">
              <select className="select" value={teamForm.churchId} onChange={(e) => setTeamForm({ ...teamForm, churchId: e.target.value })}>
                <option value="">Select a church</option>
                {churches.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Add members">
              <input
                className="input"
                value={teamForm.memberQuery}
                onChange={(e) => setTeamForm({ ...teamForm, memberQuery: e.target.value })}
                placeholder="Search by chest number or name"
              />
            </Field>
            <div className="stack-sm" style={{ maxHeight: 160, overflowY: 'auto' }}>
              {teamForm.memberResults
                .filter((m) => !teamForm.members.some((existing) => existing.id === m.id))
                .map((m) => (
                  <div key={m.id} className="row-between" style={{ padding: 'var(--space-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                    <span>
                      <strong className="num">{m.chestNumber}</strong> {m.fullName}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary"
                      onClick={() => setTeamForm({ ...teamForm, members: [...teamForm.members, m], memberQuery: '', memberResults: [] })}
                    >
                      Add to team
                    </button>
                  </div>
                ))}
            </div>
            {teamForm.members.length > 0 && (
              <Field label="Team roster">
                <div className="stack-sm">
                  {teamForm.members.map((m) => (
                    <div key={m.id} className="row-between">
                      <label className="row" style={{ gap: 'var(--space-2)' }}>
                        <input
                          type="radio"
                          name="team-leader"
                          checked={teamForm.teamLeaderId === m.id}
                          onChange={() => setTeamForm({ ...teamForm, teamLeaderId: m.id })}
                        />
                        {m.fullName} <span className="text-xs muted">({m.chestNumber})</span>
                      </label>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => setTeamForm({ ...teamForm, members: teamForm.members.filter((x) => x.id !== m.id) })}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <p className="hint">Select a team leader with the radio button (optional).</p>
              </Field>
            )}

            {teamError !== null && <ErrorState error={teamError} />}

            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setTeamForm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={teamSaving || !teamForm.teamName || !teamForm.churchId || teamForm.members.length === 0}
                onClick={() => void saveTeam()}
              >
                {teamSaving ? 'Registering…' : 'Register team'}
              </button>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}
