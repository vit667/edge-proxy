import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

/** Polls `load` every `intervalMs` while the tab is visible; `reload()` refreshes immediately. */
export function usePoll<T>(load: () => Promise<T>, intervalMs: number, onUnauthorized?: () => void) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const authRef = useRef(onUnauthorized);
  authRef.current = onUnauthorized;

  const reload = useCallback(async () => {
    try { setData(await loadRef.current()); setError(null); }
    catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) authRef.current?.();
      setError(failure as Error);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    reload();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') reload(); }, intervalMs);
    const onVisible = () => { if (document.visibilityState === 'visible') reload(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [reload, intervalMs]);

  return { data, error, loading, reload };
}

/** Re-renders every second, for relative times and countdowns. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(timer); }, [intervalMs]);
  return now;
}
