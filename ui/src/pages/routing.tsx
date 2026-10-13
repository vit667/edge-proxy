import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { PageHeader } from '@/components/common';
import { ApplyConfigDialog, validateOnServer } from '@/components/apply-config';
import type { Config, Origin, Status } from '@/lib/api';

const clone = <T,>(value: T): T => structuredClone(value);
const numberOrUndefined = (value: string) => (value === '' ? undefined : Number(value));

function Setting({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-muted-foreground text-xs">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export function RoutingPage({ status, reload }: { status: Status; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState<Config>(() => clone(status.config));
  const [baseRevision, setBaseRevision] = useState(status.config.revision);
  const [pending, setPending] = useState<Config | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(status.config), [draft, status.config]);
  const outdated = status.config.revision !== baseRevision;

  // Follow the server while nothing is being edited.
  useEffect(() => { if (!dirty) { setDraft(clone(status.config)); setBaseRevision(status.config.revision); } }, [status.config]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (patch: Partial<Config>) => setDraft(current => ({ ...current, ...patch }));
  const updateOrigin = (index: number, patch: Partial<Origin>) => setDraft(current => ({ ...current, origins: current.origins.map((origin, i) => (i === index ? { ...origin, ...patch } : origin)) }));
  const move = (index: number, delta: number) => setDraft(current => {
    const origins = [...current.origins];
    const [item] = origins.splice(index, 1);
    origins.splice(index + delta, 0, item);
    return { ...current, origins };
  });

  async function review() {
    setBusy(true); setError('');
    const next = { ...draft, revision: status.config.revision + 1 };
    // Optional fields left empty are dropped instead of being sent as nulls.
    next.origins = next.origins.map(origin => Object.fromEntries(Object.entries(origin).filter(([, value]) => value !== undefined && value !== '')) as Origin);
    if (next.circuit && Object.values(next.circuit).every(value => value === undefined)) delete next.circuit;
    try {
      const problem = await validateOnServer(next);
      if (problem) setError(problem); else setPending(next);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  const circuit = draft.circuit ?? {};
  return (
    <>
      <PageHeader
        title="Маршрутизация"
        description="Источники, приоритеты, веса и правила отказоустойчивости."
        actions={<>
          {dirty && <Button variant="ghost" size="sm" onClick={() => { setDraft(clone(status.config)); setBaseRevision(status.config.revision); setError(''); }}><RotateCcw />Сбросить</Button>}
          <Button size="sm" onClick={review} disabled={!dirty || busy}>{busy ? <Spinner /> : <Save />}Проверить и применить</Button>
        </>}
      />

      {outdated && dirty && <Alert><AlertTitle>Конфигурация на сервере изменилась</AlertTitle><AlertDescription>Пока вы редактировали, применена revision {status.config.revision}. Сравните изменения в диалоге перед применением.</AlertDescription></Alert>}
      {error && <Alert variant="destructive"><AlertTitle>Проверка не пройдена</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}

      <Card>
        <CardHeader>
          <CardTitle>Источники</CardTitle>
          <CardDescription>Запрос идёт в доступный источник с наименьшим приоритетом; при равном приоритете нагрузка делится по весу. Записи (POST, PUT…) не отправляются в источники «только чтение».</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {draft.origins.map((origin, index) => (
            <div key={index} className="space-y-4 rounded-lg border p-4">
              <div className="flex items-center gap-2">
                <Badge variant="outline">#{index + 1}</Badge>
                <span className="font-medium">{origin.id || 'новый источник'}</span>
                <div className="ml-auto flex gap-1">
                  <Button variant="ghost" size="icon-sm" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Выше"><ArrowUp /></Button>
                  <Button variant="ghost" size="icon-sm" disabled={index === draft.origins.length - 1} onClick={() => move(index, 1)} aria-label="Ниже"><ArrowDown /></Button>
                  <Button variant="ghost" size="icon-sm" disabled={draft.origins.length === 1} onClick={() => setDraft(current => ({ ...current, origins: current.origins.filter((_, i) => i !== index) }))} aria-label="Удалить"><Trash2 /></Button>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_2fr_6rem_6rem_1fr]">
                <Setting id={`id-${index}`} label="Идентификатор"><Input id={`id-${index}`} value={origin.id} onChange={event => updateOrigin(index, { id: event.target.value })} /></Setting>
                <Setting id={`url-${index}`} label="Базовый URL"><Input id={`url-${index}`} className="font-mono" value={origin.url} placeholder="https://app.example.com" onChange={event => updateOrigin(index, { url: event.target.value })} /></Setting>
                <Setting id={`priority-${index}`} label="Приоритет"><Input id={`priority-${index}`} type="number" value={origin.priority} onChange={event => updateOrigin(index, { priority: Number(event.target.value) })} /></Setting>
                <Setting id={`weight-${index}`} label="Вес"><Input id={`weight-${index}`} type="number" min={1} max={100} value={origin.weight ?? ''} placeholder="1" onChange={event => updateOrigin(index, { weight: numberOrUndefined(event.target.value) })} /></Setting>
                <Setting id={`health-${index}`} label="Путь проверки"><Input id={`health-${index}`} className="font-mono" value={origin.healthPath ?? ''} placeholder="/healthz" onChange={event => updateOrigin(index, { healthPath: event.target.value || undefined })} /></Setting>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Toggle id={`ro-${index}`} label="Только чтение" hint="Только GET/HEAD/OPTIONS, например для read-реплики." checked={!!origin.readOnly} onChange={value => updateOrigin(index, { readOnly: value || undefined })} />
                <Toggle id={`rw-${index}`} label="Перезапись хоста" hint="Location и Domain у cookie переписываются на адрес прокси." checked={!!origin.rewriteHost} onChange={value => updateOrigin(index, { rewriteHost: value || undefined })} />
              </div>
            </div>
          ))}
          <Button variant="outline" size="sm" disabled={draft.origins.length >= 8} onClick={() => setDraft(current => ({ ...current, origins: [...current.origins, { id: '', url: '', priority: Math.max(0, ...current.origins.map(origin => origin.priority)) + 1 }] }))}><Plus />Добавить источник</Button>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Отказоустойчивость</CardTitle>
            <CardDescription>Когда источник исключается из маршрутизации и когда возвращается.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Setting id="timeout" label="Таймаут заголовков, мс" hint="Сколько ждать ответа источника. Тело ответа не ограничено."><Input id="timeout" type="number" value={draft.timeoutMs} onChange={event => update({ timeoutMs: Number(event.target.value) })} /></Setting>
            <Setting id="interval" label="Интервал проверок, мс" hint="Фоновые health-check всех источников."><Input id="interval" type="number" value={draft.healthIntervalMs ?? ''} placeholder="5000" onChange={event => update({ healthIntervalMs: numberOrUndefined(event.target.value) })} /></Setting>
            <Setting id="threshold" label="Ошибок до исключения" hint="Подряд: таймауты, обрывы, 502/503/504."><Input id="threshold" type="number" value={circuit.failureThreshold ?? ''} placeholder="3" onChange={event => update({ circuit: { ...circuit, failureThreshold: numberOrUndefined(event.target.value) } })} /></Setting>
            <Setting id="cooldown" label="Пауза перед пробой, мс" hint="Потом один пробный запрос."><Input id="cooldown" type="number" value={circuit.cooldownMs ?? ''} placeholder="10000" onChange={event => update({ circuit: { ...circuit, cooldownMs: numberOrUndefined(event.target.value) } })} /></Setting>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Запросы</CardTitle>
            <CardDescription>Ограничения тела и повтор записей.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Setting id="body" label="Буфер повторяемых, байт" hint="GET и записи с Idempotency-Key."><Input id="body" type="number" value={draft.maxBodyBytes} onChange={event => update({ maxBodyBytes: Number(event.target.value) })} /></Setting>
              <Setting id="upload" label="Загрузки, байт" hint="Потоковая передача, по умолчанию 50 МБ."><Input id="upload" type="number" value={draft.maxUploadBytes ?? ''} placeholder="52428800" onChange={event => update({ maxUploadBytes: numberOrUndefined(event.target.value) })} /></Setting>
            </div>
            <Toggle id="retry" label="Повтор записей с Idempotency-Key" hint="Включайте, только если приложение само дедуплицирует по ключу." checked={!!draft.retryWrites} onChange={value => update({ retryWrites: value || undefined })} />
            <Toggle id="debug" label="Отладочные заголовки" hint="X-Edge-Origin и X-Edge-Attempts в ответах клиентам." checked={!!draft.exposeDebugHeaders} onChange={value => update({ exposeDebugHeaders: value || undefined })} />
          </CardContent>
        </Card>
      </div>

      <ApplyConfigDialog current={status.config} next={pending} open={!!pending} onOpenChange={open => { if (!open) setPending(null); }} onApplied={() => { if (pending) { setDraft(clone(pending)); setBaseRevision(pending.revision); } reload(); }} />
    </>
  );
}
