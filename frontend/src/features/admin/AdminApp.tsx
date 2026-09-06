/**
 * Administrator console shell and router (FSD 10.3, screen inventory 10.4.2).
 *
 * "On desktop the admin console uses a left sidebar. On mobile it collapses to
 * a bottom bar of five items with the less frequent sections behind More."
 */
import { Route, Routes } from 'react-router-dom';
import { AdminShell } from './AdminShell';
import { Dashboard } from './Dashboard';
import { Churches } from './Churches';
import { Categories } from './Categories';
import { Items } from './Items';
import { Members } from './Members';
import { Registrations } from './Registrations';
import { Users } from './Users';
import { Panels } from './Panels';
import { Sessions } from './Sessions';
import { LiveConsole } from './LiveConsole';
import { ItemResults } from './ItemResults';
import { ResultsIndex } from './ResultsIndex';
import { ChurchLeaderboard } from './ChurchLeaderboard';
import { Champions } from './Champions';
import { ScoringConfig } from './ScoringConfig';
import { AuditLog } from './AuditLog';
import { Reports } from './Reports';
import { Settings } from './Settings';

export function AdminApp() {
  return (
    <Routes>
      <Route element={<AdminShell />}>
        <Route index element={<Dashboard />} />
        <Route path="live" element={<LiveConsole />} />
        <Route path="churches" element={<Churches />} />
        <Route path="categories" element={<Categories />} />
        <Route path="items" element={<Items />} />
        <Route path="members" element={<Members />} />
        <Route path="registrations" element={<Registrations />} />
        <Route path="judges" element={<Users />} />
        <Route path="panels" element={<Panels />} />
        <Route path="sessions" element={<Sessions />} />
        <Route path="results" element={<ResultsIndex />} />
        <Route path="results/:itemId" element={<ItemResults />} />
        <Route path="leaderboard" element={<ChurchLeaderboard />} />
        <Route path="champions" element={<Champions />} />
        <Route path="config" element={<ScoringConfig />} />
        <Route path="audit" element={<AuditLog />} />
        <Route path="reports" element={<Reports />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
