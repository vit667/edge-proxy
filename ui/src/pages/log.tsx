import { useCallback, useMemo, useState } from 'react';
import { Pause, Play, ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Mono, PageHeader } from '@/components/common';
import { api, type LogEntry, type Status, type Traffic } from '@/lib/api';
import { ms, reason, time } from '@/lib/format';
import { usePoll } from '@/lib/use-poll';

const classes = { all: 'Все ответы', ok: '2xx–3xx', client: '4xx', server: '5xx' } as const;
type StatusClass = keyof typeof classes;
const matches = (entry: LogEntry, kind: StatusClass) => kind === 'all' || (kind === 'ok' ? entry.status < 400 : kind === 'client' ? entry.status >= 400 && entry.status < 500 : entry.status >= 500);

function StatusBadge({ status }: { status: number }) {
  const variant = status >= 500 ? 'destructive' : status >= 400 ? 'warning' : status >= 300 ? 'info' : 'success';
  return <Badge variant={variant} className="font-mono tabular-nums">{status}</Badge>;
}

export function LogPage({ status }: { status: Status }) {
  const [paused, setPaused] = useState(false);
  const [kind, setKind] = useState<StatusClass>('all');
  const [origin, setOrigin] = useState('all');
  const [query, setQuery] = useState('');
  const traffic = usePoll(useCallback(() => api<Traffic>('/admin/traffic'), []), paused ? 3600000 : 3000);
  const entries = useMemo(() => (traffic.data?.log ?? []).filter(entry => matches(entry, kind) && (origin === 'all' || entry.origin === origin) && (!query || entry.path.includes(query))), [traffic.data, kind, origin, query]);

  return (
    <>
      <PageHeader
        title="Журнал запросов"
        description="Последние 200 запросов через этот агент. Строка запроса не записывается: в ней бывают секреты."
        actions={<Button variant="outline" size="sm" onClick={() => setPaused(value => !value)}>{paused ? <Play /> : <Pause />}{paused ? 'Продолжить' : 'Пауза'}</Button>}
      />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input placeholder="Фильтр по пути…" value={query} onChange={event => setQuery(event.target.value)} className="sm:max-w-xs" />
        <Select value={kind} onValueChange={value => setKind(value as StatusClass)}>
          <SelectTrigger className="sm:w-44"><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(classes).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={origin} onValueChange={setOrigin}>
          <SelectTrigger className="sm:w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все источники</SelectItem>
            {status.config.origins.map(item => <SelectItem key={item.id} value={item.id}>{item.id}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <Card className="py-0">
        {entries.length === 0 ? (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ScrollText /></EmptyMedia>
              <EmptyTitle>{traffic.data?.log.length ? 'Ничего не найдено' : 'Запросов ещё не было'}</EmptyTitle>
              <EmptyDescription>{traffic.data?.log.length ? 'Измените фильтры.' : 'Записи появятся, когда через прокси пройдут запросы.'}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Время</TableHead><TableHead>Запрос</TableHead><TableHead>Ответ</TableHead>
                <TableHead>Источник</TableHead><TableHead className="text-right">Попыток</TableHead><TableHead className="text-right">Длительность</TableHead><TableHead className="pr-4">Клиент</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry, index) => (
                <TableRow key={`${entry.at}-${index}`}>
                  <TableCell className="text-muted-foreground pl-4 tabular-nums">{time(entry.at)}</TableCell>
                  <TableCell className="max-w-[22rem]"><div className="flex items-center gap-2"><Badge variant="outline" className="font-mono">{entry.method}</Badge><Mono className="truncate">{entry.path}</Mono>{entry.webhook && <Badge variant="info">webhook</Badge>}</div></TableCell>
                  <TableCell><div className="flex items-center gap-2"><StatusBadge status={entry.status} />{entry.error && <span className="text-muted-foreground text-xs">{reason(entry.error)}</span>}</div></TableCell>
                  <TableCell>{entry.origin ?? '—'}</TableCell>
                  <TableCell className={`text-right tabular-nums ${entry.attempts > 1 ? 'text-warning font-medium' : ''}`}>{entry.attempts}</TableCell>
                  <TableCell className="text-right tabular-nums">{ms(entry.ms)}</TableCell>
                  <TableCell className="text-muted-foreground pr-4"><Mono>{entry.ip}</Mono></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </>
  );
}
