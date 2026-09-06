/**
 * Application router.
 *
 * Guarding rules:
 *   - Unauthenticated -> /login, remembering where they were headed.
 *   - mustChangePassword -> forced to /change-password (ADM-01-05), everywhere
 *     else refused, mirroring the server's requirePasswordChanged middleware.
 *   - Judge routes are only reachable to JUDGE (ADM-01-02: judges cannot reach
 *     admin routes; the reverse is true here for symmetry and to keep a judge's
 *     bundle out of the admin bundle's code-split boundary).
 */
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './lib/auth';
import { LoadingState } from './components/ui';
import { UpdatePrompt } from './components/UpdatePrompt';
import { Login } from './features/auth/Login';
import { ChangePassword } from './features/auth/ChangePassword';
import { JudgeSessionProvider } from './features/judge/JudgeSession';
import { JudgeShell } from './features/judge/JudgeShell';
import { NowOnStage } from './features/judge/NowOnStage';
import { Search } from './features/judge/Search';
import { MemberItems } from './features/judge/MemberItems';
import { MarkEntry } from './features/judge/MarkEntry';
import { MyMarks } from './features/judge/MyMarks';
import { Profile } from './features/judge/Profile';
import { AdminApp } from './features/admin/AdminApp';

function RequireAuth({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <LoadingState label="Signing you in…" />;
  if (status === 'anonymous') return <Navigate to="/login" state={{ from: location.pathname }} replace />;

  // ADM-01-05: nothing else is reachable until the issued password is changed.
  if (user?.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }

  return <>{children}</>;
}

function RequireRole({ role, children }: { role: 'JUDGE' | 'ADMIN_LIKE'; children: ReactNode }) {
  const { user } = useAuth();

  if (!user) return null;

  const isJudge = user.role === 'JUDGE';
  const matches = role === 'JUDGE' ? isJudge : !isJudge;

  if (!matches) {
    return <Navigate to={isJudge ? '/judge' : '/admin'} replace />;
  }

  return <>{children}</>;
}

export function App() {
  const { status } = useAuth();

  return (
    <>
      <UpdatePrompt />
      <Routes>
        <Route
          path="/login"
          element={status === 'authenticated' ? <Navigate to="/" replace /> : <Login />}
        />

        <Route
          path="/change-password"
          element={
            <RequireAuth>
              <ChangePassword />
            </RequireAuth>
          }
        />

        <Route
          path="/judge/*"
          element={
            <RequireAuth>
              <RequireRole role="JUDGE">
                <JudgeSessionProvider>
                  <Routes>
                    <Route element={<JudgeShell />}>
                      <Route index element={<NowOnStage />} />
                      <Route path="search" element={<Search />} />
                      <Route path="member/:memberId" element={<MemberItems />} />
                      <Route path="score/:performanceId" element={<MarkEntry />} />
                      <Route path="my-marks" element={<MyMarks />} />
                      <Route path="profile" element={<Profile />} />
                    </Route>
                  </Routes>
                </JudgeSessionProvider>
              </RequireRole>
            </RequireAuth>
          }
        />

        <Route
          path="/admin/*"
          element={
            <RequireAuth>
              <RequireRole role="ADMIN_LIKE">
                <AdminApp />
              </RequireRole>
            </RequireAuth>
          }
        />

        <Route path="/" element={<RootRedirect />} />
        <Route path="*" element={<RootRedirect />} />
      </Routes>
    </>
  );
}

function RootRedirect() {
  const { status, landingRoute } = useAuth();
  if (status === 'loading') return <LoadingState />;
  return <Navigate to={landingRoute} replace />;
}
