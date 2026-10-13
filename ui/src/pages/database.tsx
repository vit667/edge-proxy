import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, Crown, Database, GitBranch, Link2, Lock, ShieldAlert, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Facts, Mono, PageHeader, StatusDot } from '@/components/common';
import { api, type Config, type DbNode, type DbStatus, type Sender } from '@/lib/api';
import { ago, bytes } from '@/lib/format';
import { useNow, usePoll } from '@/lib/use-poll';

const example = `"database": {
  "name": "edge",
  "nodes": [
    { "id": "main",    "host": "127.0.0.1", "port": 15432, "replicationHost": "main",    "replicationPort": 5432 },
    { "id": "standby", "host": "127.0.0.1", "port": 15433, "replicationHost": "standby", "replicationPort": 5432 },
    { "id": "replica", "host": "127.0.0.1", "port": 15434, "replicationHost": "replica", "replicationPort": 5432 }
  ]
}`;

function parseSync(value = '') {
  const text = value.trim();
  if (!text) return { method: 'FIRST' as const, count: 1, names: [] as string[] };
  const match = /^(FIRST|ANY)\s+(\d+)\s*\((.*)\)$/i.exec(text);
  const names = (match ? match[3] : text).split(',').map(name => name.trim().replace(/^"|"$/g, '')).filter(Boolean);
  return { method: (match ? match[1].toUpperCase() : 'FIRST') as 'FIRST' | 'ANY', count: match ? Number(match[2]) : 1, names };
}

const syncLabel: Record<string, string> = { sync: 'синхронно', quorum: 'кворум', potential: 'резерв sync', async: 'асинхронно' };

/** Button that is disabled with an explanation when the agent has no PG_ADMIN_* credentials. */
function Guarded({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  if (enabled) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild><span tabIndex={0} className="inline-flex cursor-not-allowed [&>*]:pointer-events-none [&>*]:opacity-50">{children}</span></TooltipTrigger>
      <TooltipContent>Задайте агенту PG_ADMIN_USER и PG_ADMIN_PASSWORD</TooltipContent>
    </Tooltip>
  );
}

export function DatabasePage({ config }: { config: Config }) {
  const enabled = !!config.database;
  const db = usePoll(useCallback(() => (enabled ? api<DbStatus>('/admin/db/status') : Promise.resolve(null)), [enabled]), 5000);
  const now = useNow(5000);
  const [promoteNode, setPromoteNode] = useState<DbNode | null>(null);
  const [followNode, setFollowNode] = useState<DbNode | null>(null);

  if (!enabled) return (
    <>
      <PageHeader title="PostgreSQL" description="Статус и управление физической репликацией." />
      <Card>
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Database /></EmptyMedia>
            <EmptyTitle>База данных не подключена</EmptyTitle>
            <EmptyDescription>Добавьте в конфигурацию раздел database со всеми узлами кластера, а агенту задайте PGUSER/PGPASSWORD (мониторинг) и PG_ADMIN_USER/PG_ADMIN_PASSWORD (управление).</EmptyDescription>
          </EmptyHeader>
          <EmptyContent><pre className="bg-muted/50 w-full max-w-2xl overflow-x-auto rounded-lg border p-4 text-left font-mono text-xs">{example}</pre></EmptyContent>
        </Empty>
      </Card>
    </>
  );

  const data = db.data;
  const primary = data?.nodes.find(node => node.id === data.primary);
  const senderOf = (id: string): Sender | undefined => data?.nodes.flatMap(node => node.senders ?? []).find(sender => sender.name === id);

  return (
    <>
      <PageHeader
        title="PostgreSQL"
        description={<>Кластер <span className="text-foreground font-medium">{config.database!.name ?? 'postgres'}</span> · {config.database!.nodes.length} узла · обновляется каждые 5 с</>}
        actions={data && !data.controlEnabled && <Badge variant="warning"><Lock />Только мониторинг</Badge>}
      />

      {!data ? (
        <div className="text-muted-foreground flex h-40 items-center justify-center gap-2 text-sm">{db.error ? db.error.message : <><Spinner />Опрос узлов…</>}</div>
      ) : (
        <>
          {data.warnings.map(warning => (
            <Alert key={warning.code + warning.message} variant={warning.level === 'critical' ? 'destructive' : 'default'}>
              {warning.level === 'critical' ? <ShieldAlert /> : <TriangleAlert />}
              <AlertTitle>{warning.message}</AlertTitle>
            </Alert>
          ))}

          <Topology data={data} />

          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {data.nodes.map(node => (
              <NodeCard key={node.id} node={node} sender={senderOf(node.id)} now={now} controlEnabled={data.controlEnabled}
                onPromote={() => setPromoteNode(node)} onFollow={() => setFollowNode(node)} />
            ))}
          </div>

          {primary && <SyncCard primary={primary} nodes={data.nodes} controlEnabled={data.controlEnabled} onChanged={db.reload} />}
          {primary && <SlotsCard primary={primary} controlEnabled={data.controlEnabled} onChanged={db.reload} />}

          <PromoteDialog node={promoteNode} data={data} onClose={() => setPromoteNode(null)} onDone={db.reload} />
          <FollowDialog node={followNode} data={data} onClose={() => setFollowNode(null)} onDone={db.reload} />
        </>
      )}
    </>
  );
}

function Topology({ data }: { data: DbStatus }) {
  const standbys = data.nodes.filter(node => node.role === 'standby');
  const roots = data.nodes.filter(node => node.role === 'primary');
  const lost = data.nodes.filter(node => !node.reachable);
  return (
    <Card className="gap-4">
      <CardHeader><CardTitle className="flex items-center gap-2"><GitBranch className="size-4" />Потоки WAL</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {roots.length === 0 && <p className="text-muted-foreground text-sm">Нет узла, принимающего запись.</p>}
        {roots.map(root => {
          const children = standbys.filter(node => node.upstreamId === root.id);
          return (
            <div key={root.id} className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <NodeChip node={root} />
              {children.length > 0 && (
                <div className="flex flex-col gap-2 border-l pl-3 sm:border-l-0 sm:pl-0">
                  {children.map(child => {
                    const sender = root.senders?.find(item => item.name === child.id);
                    return (
                      <div key={child.id} className="flex items-center gap-2 text-sm">
                        <ArrowRight className={`size-4 ${sender?.state === 'streaming' ? 'text-success' : 'text-destructive'}`} />
                        <span className="text-muted-foreground w-28 text-xs">{sender ? `${syncLabel[sender.syncState] ?? sender.syncState} · ${bytes(sender.lagBytes)}` : 'нет потока'}</span>
                        <NodeChip node={child} />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {standbys.filter(node => !roots.some(root => root.id === node.upstreamId)).map(node => (
          <div key={node.id} className="flex items-center gap-2 text-sm"><NodeChip node={node} /><span className="text-muted-foreground">ожидает upstream {node.upstream?.host ?? '—'}</span></div>
        ))}
        {lost.length > 0 && <div className="flex flex-wrap items-center gap-2 pt-1">{lost.map(node => <NodeChip key={node.id} node={node} />)}</div>}
      </CardContent>
    </Card>
  );
}

function NodeChip({ node }: { node: DbNode }) {
  const tone = !node.reachable ? 'destructive' : node.role === 'primary' ? 'success' : node.receiver?.status === 'streaming' ? 'success' : 'warning';
  return (
    <span className="bg-card inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-sm font-medium">
      <StatusDot tone={tone} />{node.id}
      <span className="text-muted-foreground text-xs font-normal">{!node.reachable ? 'недоступен' : node.role === 'primary' ? 'primary' : 'standby'}</span>
    </span>
  );
}

function NodeCard({ node, sender, now, controlEnabled, onPromote, onFollow }: { node: DbNode; sender?: Sender; now: number; controlEnabled: boolean; onPromote: () => void; onFollow: () => void }) {
  if (!node.reachable) return (
    <Card className="gap-4 border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Database className="text-muted-foreground size-4" />{node.id}</CardTitle>
        <CardDescription>Узел недоступен: {node.error}</CardDescription>
        <CardAction><Badge variant="destructive">Недоступен</Badge></CardAction>
      </CardHeader>
      <CardContent className="text-muted-foreground text-sm">Если это прежний primary после переключения, верните его через pg_rewind или новый base backup — затем он станет standby.</CardContent>
    </Card>
  );
  const isPrimary = node.role === 'primary';
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">{isPrimary ? <Crown className="size-4 text-warning" /> : <Database className="text-muted-foreground size-4" />}{node.id}</CardTitle>
        <CardDescription>PostgreSQL {node.version?.split(' ')[0]} · timeline {node.timeline}</CardDescription>
        <CardAction>{isPrimary ? <Badge variant="success">Primary</Badge> : <Badge variant={node.receiver?.status === 'streaming' ? 'info' : 'warning'}>Standby</Badge>}</CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <Facts items={isPrimary ? [
          ['Текущий LSN', <Mono key="l">{node.currentLsn}</Mono>],
          ['Синхронные standby', node.synchronousStandbyNames || 'нет (асинхронно)'],
          ['synchronous_commit', node.synchronousCommit],
          ['Подключено standby', String(node.senders?.filter(item => item.state === 'streaming').length ?? 0)]
        ] : [
          ['Upstream', node.upstreamId ?? node.upstream?.host ?? '—'],
          ['Поток WAL', <span key="s" className={node.receiver?.status === 'streaming' ? undefined : 'text-destructive'}>{node.receiver?.status ?? 'не подключён'}</span>],
          ['Режим', sender ? syncLabel[sender.syncState] ?? sender.syncState : '—'],
          ['Отставание', sender ? `${bytes(sender.lagBytes)}${sender.replayLagSeconds ? ` · ${sender.replayLagSeconds.toFixed(1)} с` : ''}` : '—'],
          ['Принято / применено', <Mono key="r">{node.receivedLsn ?? '—'} / {node.replayedLsn ?? '—'}</Mono>],
          ['Последняя транзакция', ago(node.lastReplayAt, now)]
        ]} />
        {!isPrimary && (
          <div className="flex flex-wrap gap-2">
            <Guarded enabled={controlEnabled}><Button size="sm" variant="outline" onClick={onFollow}><Link2 />Сменить upstream</Button></Guarded>
            <Guarded enabled={controlEnabled}><Button size="sm" variant="outline" className="text-destructive" onClick={onPromote}><Crown />Повысить до primary</Button></Guarded>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SyncCard({ primary, nodes, controlEnabled, onChanged }: { primary: DbNode; nodes: DbNode[]; controlEnabled: boolean; onChanged: () => void }) {
  const current = parseSync(primary.synchronousStandbyNames);
  const [mode, setMode] = useState<'sync' | 'async'>(current.names.length ? 'sync' : 'async');
  const [method, setMethod] = useState(current.method);
  const [count, setCount] = useState(current.count);
  const [selected, setSelected] = useState<string[]>(current.names);
  const [busy, setBusy] = useState(false);
  const signature = primary.id + '|' + primary.synchronousStandbyNames;
  useEffect(() => { setMode(current.names.length ? 'sync' : 'async'); setMethod(current.method); setCount(current.count); setSelected(current.names); }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const candidates = nodes.filter(node => node.id !== primary.id);
  const streaming = new Set(primary.senders?.filter(sender => sender.state === 'streaming').map(sender => sender.name));

  async function apply() {
    setBusy(true);
    try {
      const result = await api<{ synchronousStandbyNames: string }>('/admin/db/sync', { method: 'POST', body: mode === 'async' ? { mode } : { mode, method, count, standbys: selected } });
      toast.success(result.synchronousStandbyNames ? `synchronous_standby_names = '${result.synchronousStandbyNames}'` : 'Репликация переключена в асинхронный режим');
      onChanged();
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Режим подтверждения записи</CardTitle>
        <CardDescription>Синхронно: коммит на {primary.id} ждёт подтверждения standby — без потерь при отказе, но запись встаёт, если standby пропал. Асинхронно: быстрее, при отказе возможна потеря последних транзакций.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label>Режим</Label>
            <Select value={mode} onValueChange={value => setMode(value as 'sync' | 'async')}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="sync">Синхронный</SelectItem><SelectItem value="async">Асинхронный</SelectItem></SelectContent>
            </Select>
          </div>
          {mode === 'sync' && <>
            <div className="space-y-2">
              <Label>Метод</Label>
              <Select value={method} onValueChange={value => setMethod(value as 'FIRST' | 'ANY')}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="FIRST">FIRST — по порядку</SelectItem><SelectItem value="ANY">ANY — кворум</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sync-count">Сколько подтверждений</Label>
              <Input id="sync-count" type="number" min={1} max={Math.max(1, selected.length)} value={count} onChange={event => setCount(Math.max(1, Number(event.target.value)))} />
            </div>
          </>}
        </div>
        {mode === 'sync' && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {candidates.map(node => (
              <label key={node.id} className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                <span className="flex items-center gap-2"><StatusDot tone={streaming.has(node.id) ? 'success' : 'destructive'} />{node.id}<span className="text-muted-foreground text-xs">{streaming.has(node.id) ? 'подключён' : 'не подключён'}</span></span>
                <Switch checked={selected.includes(node.id)} onCheckedChange={checked => setSelected(list => (checked ? [...list, node.id] : list.filter(id => id !== node.id)))} />
              </label>
            ))}
          </div>
        )}
        <Guarded enabled={controlEnabled}>
          <Button onClick={apply} disabled={busy || (mode === 'sync' && (selected.length === 0 || count > selected.length))}>{busy && <Spinner />}Применить на {primary.id}</Button>
        </Guarded>
      </CardContent>
    </Card>
  );
}

function SlotsCard({ primary, controlEnabled, onChanged }: { primary: DbNode; controlEnabled: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState('');
  async function drop(slot: string) {
    setBusy(slot);
    try { await api('/admin/db/slots', { method: 'DELETE', body: { node: primary.id, slot } }); toast.success(`Слот ${slot} удалён`); onChanged(); }
    catch (error) { toast.error((error as Error).message); }
    finally { setBusy(''); }
  }
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Слоты репликации на {primary.id}</CardTitle>
        <CardDescription>Слот удерживает WAL, пока standby его не получит. Неактивный слот забытого узла копит WAL до лимита max_slot_wal_keep_size.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader><TableRow><TableHead className="pl-6">Слот</TableHead><TableHead>Состояние</TableHead><TableHead>WAL</TableHead><TableHead className="text-right">Удерживает</TableHead><TableHead className="pr-6" /></TableRow></TableHeader>
          <TableBody>
            {(primary.slots ?? []).map(slot => (
              <TableRow key={slot.name}>
                <TableCell className="pl-6 font-medium">{slot.name}</TableCell>
                <TableCell>{slot.active ? <Badge variant="success">используется</Badge> : <Badge variant="outline">свободен</Badge>}</TableCell>
                <TableCell className="text-muted-foreground">{slot.walStatus ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">{bytes(slot.retainedBytes)}</TableCell>
                <TableCell className="pr-6 text-right">
                  {!slot.active && <Guarded enabled={controlEnabled}><Button variant="ghost" size="icon-sm" disabled={busy === slot.name} onClick={() => drop(slot.name)} aria-label={`Удалить слот ${slot.name}`}>{busy === slot.name ? <Spinner /> : <Trash2 />}</Button></Guarded>}
                </TableCell>
              </TableRow>
            ))}
            {!primary.slots?.length && <TableRow><TableCell colSpan={5} className="text-muted-foreground pl-6">Слотов нет</TableCell></TableRow>}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function PromoteDialog({ node, data, onClose, onDone }: { node: DbNode | null; data: DbStatus; onClose: () => void; onDone: () => void }) {
  const [typed, setTyped] = useState('');
  const [fenced, setFenced] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTyped(''); setFenced(false); }, [node]);
  const alive = data.nodes.filter(item => item.role === 'primary');

  async function promote() {
    if (!node) return;
    setBusy(true);
    try {
      const result = await api<{ promoted: string; note?: string }>('/admin/db/promote', { method: 'POST', body: { node: node.id, fenced } });
      toast.success(`${result.promoted} теперь primary`, { description: result.note ?? 'Переключите оставшиеся standby на новый primary и обновите подключения приложений.' });
      onClose(); onDone();
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <AlertDialog open={!!node} onOpenChange={open => { if (!open) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Повысить {node?.id} до primary?</AlertDialogTitle>
          <AlertDialogDescription>Узел выйдет из recovery и начнёт принимать запись на новом timeline. Отменить это нельзя: прежний primary придётся возвращать через pg_rewind.</AlertDialogDescription>
        </AlertDialogHeader>
        {alive.length > 0 && (
          <Alert variant="destructive">
            <ShieldAlert />
            <AlertTitle>{alive.map(item => item.id).join(', ')} всё ещё принимает запись</AlertTitle>
            <AlertDescription>
              Два primary одновременно — это split brain и расхождение данных. Сначала остановите или изолируйте прежний primary.
              <label className="text-foreground mt-2 flex items-center gap-2"><Switch checked={fenced} onCheckedChange={setFenced} />Прежний primary изолирован, клиенты к нему не подключатся</label>
            </AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="confirm-node">Для подтверждения введите <Mono>{node?.id}</Mono></Label>
          <Input id="confirm-node" value={typed} onChange={event => setTyped(event.target.value)} autoComplete="off" />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <Button variant="destructive" disabled={busy || typed !== node?.id || (alive.length > 0 && !fenced)} onClick={promote}>{busy && <Spinner />}Повысить</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function FollowDialog({ node, data, onClose, onDone }: { node: DbNode | null; data: DbStatus; onClose: () => void; onDone: () => void }) {
  const options = data.nodes.filter(item => item.reachable && item.id !== node?.id);
  const [upstream, setUpstream] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setUpstream(data.primary && data.primary !== node?.id ? data.primary : options[0]?.id ?? ''); }, [node]); // eslint-disable-line react-hooks/exhaustive-deps

  async function follow() {
    if (!node) return;
    setBusy(true);
    try {
      const result = await api<{ streaming: boolean; note?: string }>('/admin/db/follow', { method: 'POST', body: { node: node.id, upstream } });
      if (result.streaming) toast.success(`${node.id} получает WAL от ${upstream}`); else toast.warning('Настройка применена, поток ещё не установлен', { description: result.note });
      onClose(); onDone();
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={!!node} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Сменить upstream для {node?.id}</DialogTitle>
          <DialogDescription>Standby переключится на другой источник WAL без перезапуска (primary_conninfo, PostgreSQL 13+). На новом upstream будет создан слот {node?.id}.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Новый upstream</Label>
          <Select value={upstream} onValueChange={setUpstream}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Выберите узел" /></SelectTrigger>
            <SelectContent>{options.map(item => <SelectItem key={item.id} value={item.id}>{item.id} · {item.role === 'primary' ? 'primary' : 'standby (каскад)'}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Отмена</Button>
          <Button onClick={follow} disabled={busy || !upstream}>{busy && <Spinner />}Переключить</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
