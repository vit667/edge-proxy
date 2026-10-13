import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Activity, Database, FileJson, LayoutDashboard, LogOut, Moon, Route, ScrollText, ShieldAlert, Sun, Waypoints, Webhook } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { StatusDot } from '@/components/common';
import { api, ApiError, hasToken, setToken, type Status } from '@/lib/api';
import { usePoll } from '@/lib/use-poll';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { OverviewPage } from '@/pages/overview';
import { RoutingPage } from '@/pages/routing';
import { LogPage } from '@/pages/log';
import { DatabasePage } from '@/pages/database';
import { ConfigPage } from '@/pages/config';
import { WebhooksPage } from '@/pages/webhooks';

const pages = [
  { id: 'overview', label: 'Обзор', icon: LayoutDashboard },
  { id: 'routing', label: 'Маршрутизация', icon: Route },
  { id: 'webhooks', label: 'Webhooks', icon: Webhook },
  { id: 'log', label: 'Журнал запросов', icon: ScrollText },
  { id: 'database', label: 'PostgreSQL', icon: Database },
  { id: 'config', label: 'Конфигурация', icon: FileJson }
] as const;
type PageId = (typeof pages)[number]['id'];

const pageFromHash = (): PageId => {
  const id = location.hash.replace(/^#\/?/, '');
  return (pages.find(page => page.id === id)?.id ?? 'overview') as PageId;
};

export function App() {
  const [authed, setAuthed] = useState(hasToken());
  return (
    <TooltipProvider delayDuration={200}>
      {authed ? <Shell onLogout={() => { setToken(''); setAuthed(false); }} /> : <Login onLogin={() => setAuthed(true)} />}
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <Button variant="ghost" size="icon-sm" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Сменить тему">
      {theme === 'dark' ? <Sun /> : <Moon />}
    </Button>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg"><Waypoints className="size-4" /></div>
      <div className="leading-tight">
        <div className="text-sm font-semibold">Edge Proxy</div>
        <div className="text-muted-foreground text-xs">Панель управления</div>
      </div>
    </div>
  );
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    // Tolerate what a copy from the env file brings along: spaces, quotes, or the whole "ADMIN_TOKEN=…" line.
    const cleaned = value.trim().replace(/^ADMIN_TOKEN\s*=\s*/, '').replace(/^["']|["']$/g, '').trim();
    setToken(cleaned);
    try { await api('/admin/status'); setValue(''); onLogin(); }
    catch (failure) { setToken(''); setError(failure instanceof ApiError && failure.status === 401 ? `Неверный ADMIN_TOKEN (введено символов: ${cleaned.length}). Нужен токен агента, к которому вы подключаетесь: ${location.host}.` : (failure as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <div className="bg-surface flex min-h-dvh items-center justify-center p-4">
      <div className="absolute top-4 right-4"><ThemeToggle /></div>
      <form onSubmit={submit} className="bg-card w-full max-w-sm space-y-6 rounded-xl border p-7 shadow-xs">
        <Brand />
        <div className="space-y-1.5">
          <h1 className="text-xl font-semibold">Вход администратора</h1>
          <p className="text-muted-foreground text-sm">Введите ADMIN_TOKEN. Токен хранится только в этой вкладке и удаляется при её закрытии или выходе.</p>
        </div>
        {error && <Alert variant="destructive"><ShieldAlert /><AlertTitle>{error}</AlertTitle></Alert>}
        <div className="space-y-2">
          <Label htmlFor="token">ADMIN_TOKEN</Label>
          {/* Masked text field instead of type="password": browsers and password managers do not offer to save it. */}
          <Input id="token" name="edge-admin-token" type="text" className="[-webkit-text-security:disc]" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-1p-ignore data-lpignore="true" data-bwignore autoFocus required value={value} onChange={event => setValue(event.target.value)} />
        </div>
        <Button type="submit" className="w-full" disabled={busy || !value}>{busy && <Spinner />}Подключиться</Button>
      </form>
    </div>
  );
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const [page, setPage] = useState<PageId>(pageFromHash);
  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  const status = usePoll(useCallback(() => api<Status>('/admin/status'), []), 5000, onLogout);
  const data = status.data;
  const online = !!data && !status.error;
  const healthy = data?.origins.filter(origin => origin.circuit === 'closed').length ?? 0;

  return (
    <div className="flex min-h-dvh">
      <aside className="bg-sidebar sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r p-4 md:flex">
        <Brand />
        <nav className="mt-8 flex flex-col gap-1">
          {pages.map(item => (
            <a key={item.id} href={`#/${item.id}`} className={cn('text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors [&_svg]:size-4', page === item.id && 'bg-sidebar-accent text-sidebar-accent-foreground')}>
              <item.icon />{item.label}
            </a>
          ))}
        </nav>
        <div className="mt-auto space-y-3">
          <div className="bg-card space-y-2 rounded-lg border p-3 text-xs">
            <div className="flex items-center gap-2 font-medium"><StatusDot tone={online ? 'success' : 'destructive'} pulse={online} />{online ? 'Агент на связи' : 'Нет связи с агентом'}</div>
            {data && <div className="text-muted-foreground">Узел <span className="text-foreground font-medium">{data.node}</span> · v{data.version}</div>}
          </div>
          <div className="flex items-center justify-between">
            <ThemeToggle />
            <Button variant="ghost" size="sm" onClick={onLogout}><LogOut />Выйти</Button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/80 sticky top-0 z-20 flex items-center gap-3 border-b px-4 py-3 backdrop-blur md:hidden">
          <Brand />
          <div className="ml-auto flex items-center gap-1"><ThemeToggle /><Button variant="ghost" size="icon-sm" onClick={onLogout} aria-label="Выйти"><LogOut /></Button></div>
        </header>
        <nav className="flex gap-1 overflow-x-auto border-b px-3 py-2 md:hidden">
          {pages.map(item => (
            <a key={item.id} href={`#/${item.id}`} className={cn('text-muted-foreground flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm [&_svg]:size-4', page === item.id && 'bg-accent text-accent-foreground')}><item.icon />{item.label}</a>
          ))}
        </nav>

        <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 p-4 md:p-8">
          {data?.edgeAuthDisabled && (
            <Alert variant="destructive"><ShieldAlert /><AlertTitle>Авторизация прокси отключена</AlertTitle><AlertDescription>EDGE_AUTH_DISABLED=1: основной порт принимает запросы без токена. Верните EDGE_AUTH_DISABLED=0 и перезапустите агент.</AlertDescription></Alert>
          )}
          {status.error && data && <Alert variant="destructive"><Activity /><AlertTitle>Статус не обновляется</AlertTitle><AlertDescription>{status.error.message}</AlertDescription></Alert>}
          {!data ? (
            <div className="text-muted-foreground flex h-64 items-center justify-center gap-2 text-sm">{status.error ? status.error.message : <><Spinner />Загрузка…</>}</div>
          ) : page === 'overview' ? <OverviewPage status={data} reload={status.reload} healthy={healthy} />
            : page === 'routing' ? <RoutingPage status={data} reload={status.reload} />
            : page === 'webhooks' ? <WebhooksPage status={data} reload={status.reload} />
            : page === 'log' ? <LogPage status={data} />
            : page === 'database' ? <DatabasePage config={data.config} />
            : <ConfigPage status={data} reload={status.reload} />}
        </main>
      </div>
    </div>
  );
}
