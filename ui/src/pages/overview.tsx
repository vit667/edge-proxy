import { useCallback, useState } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { AlertTriangle, Gauge, Globe, RefreshCw, Server, Timer, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CircuitBadge, Facts, Mono, PageHeader, Stat } from '@/components/common';
import { api, type OriginState, type Status, type Traffic } from '@/lib/api';
import { ago, duration, ms, number, percent, reason, time } from '@/lib/format';
import { useNow, usePoll } from '@/lib/use-poll';

const chartConfig = {
  requests: { label: 'Запросы', color: 'var(--chart-1)' },
  errors: { label: 'Ошибки 5xx', color: 'var(--destructive)' }
} satisfies ChartConfig;

export function OverviewPage({ status, reload, healthy }: { status: Status; reload: () => Promise<void>; healthy: number }) {
  const traffic = usePoll(useCallback(() => api<Traffic>('/admin/traffic'), []), 5000);
  const [checking, setChecking] = useState(false);
  const now = useNow();
  const { config, origins, traffic: totals } = status;
  const total = config.origins.length;

  async function checkNow() {
    setChecking(true);
    try { await api('/admin/health/check', { method: 'POST', body: {} }); await reload(); toast.success('Проверка источников выполнена'); }
    catch (error) { toast.error((error as Error).message); }
    finally { setChecking(false); }
  }

  const series = (traffic.data?.series ?? []).map(point => ({ ...point, label: time(point.minute).slice(0, 5) }));

  return (
    <>
      <PageHeader
        title={config.app}
        description={<>Конфигурация <span className="text-foreground font-medium">revision {config.revision}</span> · агент работает {duration(status.startedAt, now)}</>}
        actions={<Button variant="outline" size="sm" onClick={checkNow} disabled={checking}>{checking ? <Spinner /> : <RefreshCw />}Проверить сейчас</Button>}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Доступные источники" icon={<Server />} value={<span className={healthy < total ? 'text-destructive' : undefined}>{healthy} / {total}</span>} hint={healthy === total ? 'Все источники в работе' : `${total - healthy} исключено из маршрутизации`} />
        <Stat label="Запросы за 5 минут" icon={<Zap />} value={number(totals.requests)} hint="через этот агент" />
        <Stat label="Ошибки 5xx" icon={<AlertTriangle />} value={<span className={totals.errorRate > 0.05 ? 'text-destructive' : undefined}>{percent(totals.errorRate)}</span>} hint={`${number(totals.errors)} ответов за 5 минут`} />
        <Stat label="Среднее время ответа" icon={<Timer />} value={ms(totals.avgMs)} hint={`таймаут заголовков ${ms(config.timeoutMs)}`} />
      </div>

      <Card className="gap-4">
        <CardHeader>
          <CardTitle>Трафик за час</CardTitle>
          <CardDescription>Запросы и ответы 5xx по минутам</CardDescription>
        </CardHeader>
        <CardContent className="px-2 sm:px-6">
          <ChartContainer config={chartConfig} className="aspect-auto h-56 w-full">
            <AreaChart data={series} margin={{ left: 0, right: 8, top: 8 }}>
              <defs>
                <linearGradient id="fill-requests" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-requests)" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="var(--color-requests)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={40} />
              <YAxis width={36} tickLine={false} axisLine={false} allowDecimals={false} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
              <Area dataKey="requests" type="monotone" stroke="var(--color-requests)" fill="url(#fill-requests)" strokeWidth={2} isAnimationActive={false} />
              <Area dataKey="errors" type="monotone" stroke="var(--color-errors)" fill="var(--color-errors)" fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} />
            </AreaChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Источники</h2>
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {config.origins.map(origin => {
            const state = origins.find(item => item.id === origin.id);
            return state ? <OriginCard key={origin.id} origin={origin} state={state} now={now} /> : null;
          })}
        </div>
      </div>
    </>
  );
}

function OriginCard({ origin, state, now }: { origin: Status['config']['origins'][number]; state: OriginState; now: number }) {
  const check = state.check;
  const checkText = !check ? 'ещё не выполнялась' : check.healthy ? `HTTP ${check.status} · ${ms(check.latencyMs)}` : check.status ? `HTTP ${check.status}` : reason(check.error);
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Globe className="text-muted-foreground size-4" />{origin.id}</CardTitle>
        <CardDescription className="truncate"><Mono>{origin.url}</Mono></CardDescription>
        <CardAction><CircuitBadge circuit={state.circuit} /></CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">Приоритет {origin.priority}</Badge>
          <Badge variant="outline">Вес {origin.weight ?? 1}</Badge>
          <Badge variant="outline">{origin.readOnly ? 'Только чтение' : 'Чтение и запись'}</Badge>
          {origin.rewriteHost && <Badge variant="outline">Перезапись хоста</Badge>}
        </div>
        <Facts items={[
          ['Отклик (EWMA)', <span key="l" className="inline-flex items-center gap-1"><Gauge className="text-muted-foreground size-3.5" />{ms(state.latencyMs)}</span>],
          ['Запросы / ошибки', `${number(state.requests)} / ${number(state.errors)}`],
          [<Tooltip key="c"><TooltipTrigger className="underline decoration-dotted underline-offset-2">Health-check</TooltipTrigger><TooltipContent>Путь {check?.path ?? origin.healthPath ?? '/healthz'} · {check ? ago(check.at, now) : '—'}</TooltipContent></Tooltip>, <span key="h" className={check && !check.healthy ? 'text-destructive' : undefined}>{checkText}</span>],
          ...(state.lastError ? [['Последняя ошибка', <span key="e" className="text-destructive">{reason(state.lastError)}</span>] as [string, React.ReactNode]] : []),
          ...(state.circuit !== 'closed' && state.retryAt ? [['Повторная попытка', state.retryAt > now ? `через ${Math.ceil((state.retryAt - now) / 1000)} с` : 'при следующем запросе'] as [string, string]] : [])
        ]} />
      </CardContent>
    </Card>
  );
}
