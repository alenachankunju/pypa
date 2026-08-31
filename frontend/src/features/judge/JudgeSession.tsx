/**
 * Judge session state.
 *
 * Holds the offline bundle (JDG-08-01), the current on-stage performance
 * (JDG-02-01/02), and the realtime subscription that keeps them fresh.
 *
 * FSD 3.3 makes realtime a convenience, so the current performance is ALSO
 * polled on a short interval. If the broadcast never arrives — a blocked
 * websocket, a proxy that strips upgrades, a Supabase outage — the judge's
 * screen still follows the coordinator, just a few seconds later.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, api } from '../../lib/api';
import { RealtimeEvent, subscribeToSession } from '../../lib/realtime';

export interface JudgeItem {
  id: string;
  name: string;
  code: string;
  type: 'INDIVIDUAL' | 'GROUP';
  stage: string | null;
  maxMark: number;
  criteria: { id: string; name: string; maxMark: number }[];
}

export interface JudgePerformance {
  performanceId: string;
  registrationId: string;
  itemId: string;
  status: string;
  isCurrent: boolean;
  callOrder: number | null;
  attemptNo: number;
  memberId: string | null;
  chestNumber: string | null;
  participantName: string;
  photoPath: string | null;
  churchName: string;
  churchShortCode: string;
  categoryName: string | null;
  myScore: { mark: number; submittedAt: string } | null;
  revokedScore: { mark: number; reason: string | null } | null;
}

export interface JudgeBundle {
  session: { id: string; name: string; stage: string | null; status: string; panelName: string };
  judge: { id: string; fullName: string };
  config: { maxMark: number; decimalPlaces: number; showOutOfSessionItems: boolean };
  items: JudgeItem[];
  performances: JudgePerformance[];
  cachedAt: string;
}

export interface CurrentPerformance {
  performanceId: string;
  itemId: string;
  itemName: string;
  maxMark: number;
  status: string;
  chestNumber: string | null;
  participantName: string;
  photoPath: string | null;
  churchName: string;
  progress: { position: number; total: number };
  myScore: { mark: number; submittedAt: string } | null;
}

export interface JudgeSessionSummary {
  id: string;
  name: string;
  stage: string | null;
  status: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  panelName: string;
  itemCount: number;
  myOutstandingCount: number;
}

interface JudgeSessionContextValue {
  sessions: { open: JudgeSessionSummary[]; upcoming: JudgeSessionSummary[] } | null;
  sessionId: string | null;
  setSessionId: (id: string | null) => void;
  bundle: JudgeBundle | null;
  current: CurrentPerformance | null;
  /** True when no performance is on stage (JDG-02-05 sends the judge to search). */
  useManualSearch: boolean;
  loading: boolean;
  error: unknown;
  refreshBundle: () => Promise<void>;
  refreshCurrent: () => Promise<void>;
  /** Applied locally after a submission so the screen updates before the refetch. */
  markScoredLocally: (performanceId: string, mark: number) => void;
  findPerformance: (performanceId: string) => JudgePerformance | undefined;
  findItem: (itemId: string) => JudgeItem | undefined;
}

const JudgeSessionContext = createContext<JudgeSessionContextValue | null>(null);

const SESSION_KEY = 'pypa.judge.session';
const BUNDLE_KEY = 'pypa.judge.bundle';

/** JDG-02-02 polling backstop. Frequent enough to feel live, light enough for 50 devices. */
const CURRENT_POLL_MS = 4000;

export function JudgeSessionProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<JudgeSessionContextValue['sessions']>(null);
  const [sessionId, setSessionIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
  });
  const [bundle, setBundle] = useState<JudgeBundle | null>(() => readCachedBundle());
  const [current, setCurrent] = useState<CurrentPerformance | null>(null);
  const [useManualSearch, setUseManualSearch] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const setSessionId = useCallback((id: string | null) => {
    setSessionIdState(id);
    try {
      if (id) localStorage.setItem(SESSION_KEY, id);
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      /* storage unavailable — the session still works for this tab */
    }
  }, []);

  // --- Sessions list -------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const data = await api.get<{
          open: JudgeSessionSummary[];
          upcoming: JudgeSessionSummary[];
          autoSelectSessionId: string | null;
        }>('/api/judge/sessions');

        if (cancelled) return;
        setSessions({ open: data.open, upcoming: data.upcoming });

        // JDG-01-02: "If exactly one session is open, the judge is taken
        // straight into it."
        const stillOpen = data.open.some((s) => s.id === sessionIdRef.current);
        if (!stillOpen) setSessionId(data.autoSelectSessionId);
      } catch (err) {
        // Offline with a cached bundle is a supported state, not an error
        // (JDG-08-01) — the judge keeps working against the cache.
        if (!cancelled && !(err instanceof ApiError && err.isOffline)) setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [setSessionId]);

  // --- Bundle --------------------------------------------------------------
  const refreshBundle = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) {
      setBundle(null);
      return;
    }

    try {
      const data = await api.get<JudgeBundle>(`/api/judge/sessions/${id}/bundle`);
      setBundle(data);
      cacheBundle(data);
      setError(null);
    } catch (err) {
      // JDG-08-01: fall back to the cached copy rather than emptying the screen.
      if (err instanceof ApiError && err.isOffline) {
        const cached = readCachedBundle();
        if (cached && cached.session.id === id) setBundle(cached);
        return;
      }
      setError(err);
    }
  }, []);

  useEffect(() => {
    void refreshBundle();
  }, [sessionId, refreshBundle]);

  // --- Current performance -------------------------------------------------
  const refreshCurrent = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) {
      setCurrent(null);
      return;
    }

    try {
      const data = await api.get<{ current: CurrentPerformance | null; useManualSearch: boolean }>(
        '/api/judge/current',
        { sessionId: id },
      );
      setCurrent(data.current);
      setUseManualSearch(data.useManualSearch);
    } catch (err) {
      // Offline: keep showing the last known participant. Better than a blank
      // screen while the judge is standing in front of them (FSD 10.1).
      if (!(err instanceof ApiError && err.isOffline)) setCurrent(null);
    }
  }, []);

  useEffect(() => {
    if (!sessionId) return;

    void refreshCurrent();
    const interval = window.setInterval(() => void refreshCurrent(), CURRENT_POLL_MS);
    return () => window.clearInterval(interval);
  }, [sessionId, refreshCurrent]);

  // --- Realtime ------------------------------------------------------------
  useEffect(() => {
    if (!sessionId) return;

    return subscribeToSession(sessionId, (event) => {
      switch (event) {
        case RealtimeEvent.CURRENT_PERFORMANCE:
        case RealtimeEvent.PERFORMANCE_STATUS:
          // Re-fetch rather than trusting the payload: the authoritative shape,
          // including this judge's own mark, comes from the API.
          void refreshCurrent();
          break;
        case RealtimeEvent.SCORE_REVOKED:
        case RealtimeEvent.PANEL_CHANGED:
          // ADM-10-03: the judge is prompted to re-enter a revoked mark.
          void refreshBundle();
          void refreshCurrent();
          break;
        case RealtimeEvent.SESSION_STATUS:
          void refreshBundle();
          break;
        default:
          break;
      }
    });
  }, [sessionId, refreshCurrent, refreshBundle]);

  const markScoredLocally = useCallback((performanceId: string, mark: number) => {
    const submittedAt = new Date().toISOString();

    setBundle((prev) =>
      prev
        ? {
            ...prev,
            performances: prev.performances.map((p) =>
              p.performanceId === performanceId
                ? { ...p, myScore: { mark, submittedAt }, revokedScore: null }
                : p,
            ),
          }
        : prev,
    );

    setCurrent((prev) =>
      prev && prev.performanceId === performanceId
        ? { ...prev, myScore: { mark, submittedAt } }
        : prev,
    );
  }, []);

  const value = useMemo<JudgeSessionContextValue>(
    () => ({
      sessions,
      sessionId,
      setSessionId,
      bundle,
      current,
      useManualSearch,
      loading,
      error,
      refreshBundle,
      refreshCurrent,
      markScoredLocally,
      findPerformance: (id) => bundle?.performances.find((p) => p.performanceId === id),
      findItem: (id) => bundle?.items.find((i) => i.id === id),
    }),
    [
      sessions,
      sessionId,
      setSessionId,
      bundle,
      current,
      useManualSearch,
      loading,
      error,
      refreshBundle,
      refreshCurrent,
      markScoredLocally,
    ],
  );

  return <JudgeSessionContext.Provider value={value}>{children}</JudgeSessionContext.Provider>;
}

export function useJudgeSession(): JudgeSessionContextValue {
  const context = useContext(JudgeSessionContext);
  if (!context) throw new Error('useJudgeSession must be used inside a JudgeSessionProvider.');
  return context;
}

// --- Bundle cache -----------------------------------------------------------
//
// The service worker caches the bundle response for offline navigation, but a
// copy is kept in localStorage as well so the very first paint after a reload
// has data without waiting on a cache lookup — the judge app must be usable in
// under three seconds (FSD 11.1).

function cacheBundle(bundle: JudgeBundle): void {
  try {
    localStorage.setItem(BUNDLE_KEY, JSON.stringify(bundle));
  } catch {
    /* quota or private mode — the service worker cache still covers offline */
  }
}

function readCachedBundle(): JudgeBundle | null {
  try {
    const raw = localStorage.getItem(BUNDLE_KEY);
    return raw ? (JSON.parse(raw) as JudgeBundle) : null;
  } catch {
    return null;
  }
}
