import { useState } from 'react';
import { CheckCircle2, Copy, KeyRound, Pencil, Plus, RefreshCw, Send, ShieldCheck, Trash2, TriangleAlert, Webhook } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Facts, Mono, PageHeader } from '@/components/common';
import { ApplyConfigDialog, validateOnServer } from '@/components/apply-config';
import { api, type Config, type Status, type TelegramInfo, type WebhookRoute, type WebhookState } from '@/lib/api';
import { ago, dateTime, number, reason } from '@/lib/format';
import { useNow } from '@/lib/use-poll';

const blank: WebhookRoute = { id: 'telegram', path: '/telegram/webhook', provider: 'telegram', secretEnv: 'TELEGRAM_WEBHOOK_SECRET', botTokenEnv: 'TELEGRAM_BOT_TOKEN' };

// Telegram accepts A-Z, a-z, 0-9, _ and - in secret_token.
function randomSecret() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  return Array.from(crypto.getRandomValues(new Uint8Array(48)), byte => alphabet[byte % 64]).join('');
}

export function WebhooksPage({ status, reload }: { status: Status; reload: () => Promise<void> }) {
  const routes = status.config.webhooks ?? [];
  const [editing, setEditing] = useState<{ route: WebhookRoute; index: number } | null>(null);
  const [pending, setPending] = useState<Config | null>(null);

  async function propose(webhooks: WebhookRoute[]) {
    const next: Config = { ...status.config, revision: status.config.revision + 1, webhooks };
    if (!webhooks.length) delete next.webhooks;
    const problem = await validateOnServer(next);
    if (problem) { toast.error(problem); return false; }
    setPending(next);
    return true;
  }

  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Внешние сервисы не умеют отправлять x-edge-token, поэтому для их маршрутов прокси проверяет подпись самого сервиса."
        actions={routes.length > 0 && <Button size="sm" onClick={() => setEditing({ route: { ...blank, id: `telegram-${routes.length + 1}`, path: `/telegram/webhook-${routes.length + 1}` }, index: -1 })}><Plus />Добавить</Button>}
      />

      {routes.length === 0 ? (
        <Card>
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Webhook /></EmptyMedia>
              <EmptyTitle>Маршрутов пока нет</EmptyTitle>
              <EmptyDescription>Telegram присылает в каждом запросе заголовок X-Telegram-Bot-Api-Secret-Token со значением, заданным при setWebhook. Прокси сверяет его и только тогда передаёт обновление в приложение.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent><Button onClick={() => setEditing({ route: blank, index: -1 })}><Plus />Добавить Telegram-бота</Button></EmptyContent>
          </Empty>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {routes.map((route, index) => (
            <RouteCard key={route.id} route={route} state={status.webhooks.find(item => item.id === route.id)}
              onEdit={() => setEditing({ route, index })}
              onDelete={() => propose(routes.filter((_, i) => i !== index))} />
          ))}
        </div>
      )}

      <RouteDialog editing={editing} onClose={() => setEditing(null)} onSubmit={async route => {
        const next = editing!.index < 0 ? [...routes, route] : routes.map((item, i) => (i === editing!.index ? route : item));
        if (await propose(next)) setEditing(null);
      }} />
      <ApplyConfigDialog current={status.config} next={pending} open={!!pending} onOpenChange={open => { if (!open) setPending(null); }} onApplied={reload} />
    </>
  );
}

function RouteCard({ route, state, onEdit, onDelete }: { route: WebhookRoute; state?: WebhookState; onEdit: () => void; onDelete: () => void }) {
  const now = useNow(5000);
  const [info, setInfo] = useState<TelegramInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [registering, setRegistering] = useState(false);

  async function loadInfo() {
    setLoading(true);
    try { setInfo(await api<TelegramInfo>(`/admin/webhooks/telegram?id=${encodeURIComponent(route.id)}`)); }
    catch (error) { toast.error((error as Error).message); }
    finally { setLoading(false); }
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Send className="size-4 text-sky-500" />{route.id}</CardTitle>
        <CardDescription><Mono>POST {route.path}</Mono></CardDescription>
        <CardAction className="flex gap-1">
          <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label="Изменить"><Pencil /></Button>
          <Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label="Удалить"><Trash2 /></Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {state && !state.secretConfigured && (
          <Alert variant="destructive"><KeyRound /><AlertTitle>Секрет не задан</AlertTitle><AlertDescription>Задайте агенту переменную {route.secretEnv} и перезапустите его. Пока её нет, все обновления отклоняются с кодом 503.</AlertDescription></Alert>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">Telegram</Badge>
          {state?.secretConfigured && <Badge variant="success"><ShieldCheck />secret token задан</Badge>}
          {route.checkSourceIp && <Badge variant="outline">Только IP Telegram</Badge>}
        </div>
        <Facts items={[
          ['Принято', number(state?.accepted ?? 0)],
          ['Отклонено', <span key="r" className={state?.rejected ? 'text-destructive' : undefined}>{number(state?.rejected ?? 0)}</span>],
          ['Последний запрос', state?.lastAt ? `${ago(state.lastAt, now)} · HTTP ${state.lastStatus}` : '—'],
          ...(state?.lastReject ? [['Последний отказ', `${reason(state.lastReject.reason)} · ${ago(state.lastReject.at, now)}`] as [string, string]] : []),
          ['Секрет', <Mono key="s">{route.secretEnv}</Mono>],
          ['Токен бота', route.botTokenEnv ? <Mono key="t">{route.botTokenEnv}{state && !state.botTokenConfigured ? ' (не задан)' : ''}</Mono> : '—']
        ]} />

        <div className="space-y-3 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Состояние в Telegram</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={!state?.botTokenConfigured || loading} onClick={loadInfo}>{loading ? <Spinner /> : <RefreshCw />}Проверить</Button>
              <Button size="sm" variant="outline" disabled={!state?.botTokenConfigured || !state?.secretConfigured} onClick={() => setRegistering(true)}>Зарегистрировать</Button>
            </div>
          </div>
          {!state?.botTokenConfigured && <p className="text-muted-foreground text-xs">Чтобы проверять и регистрировать webhook отсюда, задайте агенту {route.botTokenEnv ?? 'botTokenEnv'} с токеном бота. Токен не покидает агент.</p>}
          {info && <TelegramState info={info} now={now} />}
        </div>
      </CardContent>
      <RegisterDialog route={route} open={registering} onClose={() => setRegistering(false)} onDone={setInfo} />
    </Card>
  );
}

function TelegramState({ info, now }: { info: TelegramInfo; now: number }) {
  const recentError = info.lastErrorAt && now - info.lastErrorAt < 24 * 3600 * 1000;
  return (
    <div className="space-y-3">
      {!info.url && <Alert><TriangleAlert /><AlertTitle>Webhook у бота не установлен</AlertTitle><AlertDescription>Telegram не отправляет обновления. Нажмите «Зарегистрировать».</AlertDescription></Alert>}
      {info.url && info.pathMatches === false && <Alert variant="destructive"><TriangleAlert /><AlertTitle>Бот отправляет обновления на другой путь</AlertTitle><AlertDescription>Telegram шлёт на {info.url}, а маршрут ждёт другой путь.</AlertDescription></Alert>}
      {info.url && info.pathMatches && !recentError && <Alert><CheckCircle2 /><AlertTitle>Webhook установлен на этот маршрут</AlertTitle></Alert>}
      <Facts items={[
        ['URL', <Mono key="u" className="break-all">{info.url || '—'}</Mono>],
        ['В очереди у Telegram', <span key="p" className={info.pendingUpdates > 0 ? 'text-warning font-medium' : undefined}>{number(info.pendingUpdates)}</span>],
        ['Последняя ошибка', info.lastError ? <span key="e" className={recentError ? 'text-destructive' : 'text-muted-foreground'} title={dateTime(info.lastErrorAt!)}>{info.lastError} · {ago(info.lastErrorAt, now)}</span> : 'нет'],
        ['IP, на который шлёт Telegram', info.ipAddress ?? '—']
      ]} />
    </div>
  );
}

function RegisterDialog({ route, open, onClose, onDone }: { route: WebhookRoute; open: boolean; onClose: () => void; onDone: (info: TelegramInfo) => void }) {
  const [publicUrl, setPublicUrl] = useState('https://');
  const [drop, setDrop] = useState(false);
  const [busy, setBusy] = useState(false);
  let preview = '';
  try { const base = new URL(publicUrl); if (base.protocol === 'https:' && base.host) preview = new URL(route.path, base.origin).href; } catch {}

  async function register() {
    setBusy(true);
    try {
      const result = await api<TelegramInfo>('/admin/webhooks/telegram', { method: 'POST', body: { id: route.id, publicUrl: new URL(publicUrl).origin, dropPendingUpdates: drop } });
      toast.success('Webhook зарегистрирован в Telegram', { description: result.url });
      onDone(result); onClose();
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Зарегистрировать webhook в Telegram</DialogTitle>
          <DialogDescription>Агент вызовет setWebhook для бота из {route.botTokenEnv} с secret_token из {route.secretEnv}. Прежний адрес webhook у бота будет заменён.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="public-url">Публичный адрес прокси (HTTPS)</Label>
          <Input id="public-url" className="font-mono" value={publicUrl} onChange={event => setPublicUrl(event.target.value)} placeholder="https://edge.odora.uz" />
          <p className="text-muted-foreground text-xs">{preview ? <>Telegram будет слать на <Mono>{preview}</Mono></> : 'Telegram принимает только https:// на портах 443, 80, 88 или 8443.'}</p>
        </div>
        <label className="flex items-start justify-between gap-4 rounded-lg border p-3 text-sm">
          <span><span className="font-medium">Сбросить очередь</span><span className="text-muted-foreground block text-xs">Telegram удалит накопленные необработанные обновления.</span></span>
          <Switch checked={drop} onCheckedChange={setDrop} />
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Отмена</Button>
          <Button onClick={register} disabled={busy || !preview}>{busy && <Spinner />}Зарегистрировать</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RouteDialog({ editing, onClose, onSubmit }: { editing: { route: WebhookRoute; index: number } | null; onClose: () => void; onSubmit: (route: WebhookRoute) => Promise<void> }) {
  const [route, setRoute] = useState<WebhookRoute>(blank);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<typeof editing>(null);
  if (editing !== opened) { setOpened(editing); if (editing) { setRoute(editing.route); setSecret(''); } }
  const set = (patch: Partial<WebhookRoute>) => setRoute(current => ({ ...current, ...patch }));

  async function submit() {
    setBusy(true);
    const clean: WebhookRoute = { id: route.id, path: route.path, provider: 'telegram', secretEnv: route.secretEnv, ...(route.botTokenEnv ? { botTokenEnv: route.botTokenEnv } : {}), ...(route.checkSourceIp ? { checkSourceIp: true } : {}) };
    try { await onSubmit(clean); } finally { setBusy(false); }
  }

  return (
    <Dialog open={!!editing} onOpenChange={value => { if (!value) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing && editing.index >= 0 ? `Маршрут ${editing.route.id}` : 'Новый Telegram-бот'}</DialogTitle>
          <DialogDescription>В конфигурации хранятся только имена переменных окружения. Сами секреты задаются агенту (.env) и в панель не попадают.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="wh-id">Идентификатор</Label><Input id="wh-id" value={route.id} onChange={event => set({ id: event.target.value })} /></div>
          <div className="space-y-2"><Label htmlFor="wh-path">Путь</Label><Input id="wh-path" className="font-mono" value={route.path} onChange={event => set({ path: event.target.value })} /></div>
          <div className="space-y-2"><Label htmlFor="wh-secret">Переменная секрета</Label><Input id="wh-secret" className="font-mono" value={route.secretEnv} onChange={event => set({ secretEnv: event.target.value.toUpperCase() })} /></div>
          <div className="space-y-2"><Label htmlFor="wh-bot">Переменная токена бота</Label><Input id="wh-bot" className="font-mono" value={route.botTokenEnv ?? ''} placeholder="необязательно" onChange={event => set({ botTokenEnv: event.target.value.toUpperCase() || undefined })} /></div>
        </div>
        <label className="flex items-start justify-between gap-4 rounded-lg border p-3 text-sm">
          <span><span className="font-medium">Только с IP Telegram</span><span className="text-muted-foreground block text-xs">149.154.160.0/20 и 91.108.4.0/22. За Cloudflare или nginx включайте вместе с TRUST_PROXY=1, иначе прокси увидит их IP.</span></span>
          <Switch checked={!!route.checkSourceIp} onCheckedChange={value => set({ checkSourceIp: value })} />
        </label>
        <div className="bg-muted/50 space-y-2 rounded-lg border p-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">Строка для .env агента</span>
            <Button size="sm" variant="ghost" onClick={() => setSecret(randomSecret())}><KeyRound />Сгенерировать</Button>
          </div>
          {secret ? (
            <div className="flex items-center gap-2">
              <Mono className="min-w-0 flex-1 break-all">{route.secretEnv}={secret}</Mono>
              <Button size="icon-sm" variant="ghost" aria-label="Копировать" onClick={() => navigator.clipboard.writeText(`${route.secretEnv}=${secret}`).then(() => toast.success('Скопировано'), () => toast.error('Не удалось скопировать'))}><Copy /></Button>
            </div>
          ) : <p className="text-muted-foreground text-xs">Секрет генерируется в браузере и никуда не отправляется. Добавьте строку в .env и перезапустите агент.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Отмена</Button>
          <Button onClick={submit} disabled={busy}>{busy && <Spinner />}Далее</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
