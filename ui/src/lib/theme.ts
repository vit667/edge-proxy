import { useCallback, useSyncExternalStore } from 'react';

type Theme = 'light' | 'dark';
const listeners = new Set<() => void>();
const current = (): Theme => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');

export function useTheme() {
  const theme = useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, current);
  const setTheme = useCallback((next: Theme) => {
    document.documentElement.classList.toggle('dark', next === 'dark');
    try { localStorage.setItem('edge-theme', next); } catch {}
    listeners.forEach(listener => listener());
  }, []);
  return { theme, setTheme };
}
