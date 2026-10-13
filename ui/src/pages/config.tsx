import { useCallback, useState } from 'react';
import { CheckCircle2, Download, History, RotateCcw, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { PageHeader } from '@/components/common';
import { ApplyConfigDialog, validateOnServer } from '@/components/apply-config';
import { api, type Config, type HistoryEntry, type Status } from '@/lib/api';
import { ago, dateTime } from '@/lib/format';
import { useNow, usePoll } from '@/lib/use-poll';

const pretty = (config: Config) => JSON.stringify(config, null, 2);

export function ConfigPage({ status, reload }: { status: Status; reload: () => Promise<void> }) {
  const [text, setText] = useState(() => pretty(status.config));
  const [problem, setProblem] = useState<{ title: string; message: string } | null>(null);
  const [valid, setValid] = useState(false);
  const [pending, setPending] = useState<Config | null>(null);
  const [busy, setBusy] = useState(false);
  const history = usePoll(useCallback(() => api<{ history: HistoryEntry[] }>('/admin/config/history'), []), 15000);
  const now = useNow(10000);
  const dirty = text !== pretty(status.config);

  async function check(apply: boolean) {
    setBusy(true); setProblem(null); setValid(false);
    try {
      let parsed: Config;
      try { parsed = JSON.parse(text); } catch (error) { setProblem({ title: 'Ошибка синтаксиса JSON', message: (error as Error).message }); return; }
      // Applying always produces the next revision, so a draft based on an old revision cannot overwrite a newer one silently.
      const next = { ...parsed, revision: status.config.revision + 1 };
      const message = await validateOnServer(next);
      if (message) { setProblem({ title: 'Конфигурация не прошла проверку', message }); return; }
      if (apply) setPending(next); else setValid(true);
    } catch (error) { setProblem({ title: 'Ошибка', message: (error as Error).message }); }
    finally { setBusy(false); }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([pretty(status.config) + '\n'], { type: 'application/json' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: `${status.config.app}-r${status.config.revision}.json` });
    link.click(); URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader
        title="Конфигурация"
        description={<>JSON этого агента. Применение создаёт revision {status.config.revision + 1}; другие агенты обновляются отдельно.</>}
        actions={<Button variant="outline" size="sm" onClick={download}><Download />Скачать</Button>}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card className="gap-4">
          <CardHeader>
            <CardTitle>Редактор</CardTitle>
            <CardDescription>Поля описаны в README. Поле revision при применении проставляется автоматически.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {problem && <Alert variant="destructive"><AlertTitle>{problem.title}</AlertTitle><AlertDescription>{problem.message}</AlertDescription></Alert>}
            {valid && <Alert><CheckCircle2 /><AlertTitle>Конфигурация корректна</AlertTitle></Alert>}
            <Textarea value={text} onChange={event => { setText(event.target.value); setValid(false); }} spellCheck={false} className="min-h-[28rem] font-mono text-xs leading-relaxed" aria-label="JSON конфигурации" />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => check(true)} disabled={busy || !dirty}>{busy ? <Spinner /> : <Save />}Проверить и применить</Button>
              <Button variant="outline" onClick={() => check(false)} disabled={busy}>Только проверить</Button>
              <Button variant="ghost" onClick={() => { setText(pretty(status.config)); setProblem(null); setValid(false); }} disabled={!dirty}><RotateCcw />Текущая с сервера</Button>
            </div>
          </CardContent>
        </Card>

        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><History className="size-4" />История</CardTitle>
            <CardDescription>Ревизии с момента запуска агента. Загрузите любую в редактор, чтобы откатиться.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {(history.data?.history ?? []).map(entry => (
              <div key={`${entry.revision}-${entry.appliedAt}`} className="flex items-center justify-between gap-2 rounded-lg border p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">revision {entry.revision}{entry.revision === status.config.revision && <Badge variant="success">текущая</Badge>}</div>
                  <div className="text-muted-foreground text-xs" title={dateTime(entry.appliedAt)}>{ago(entry.appliedAt, now)}</div>
                </div>
                {entry.revision !== status.config.revision && <Button variant="outline" size="sm" onClick={() => { setText(pretty(entry.config)); setProblem(null); setValid(false); }}>В редактор</Button>}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      <ApplyConfigDialog current={status.config} next={pending} open={!!pending} onOpenChange={open => { if (!open) setPending(null); }} onApplied={() => { if (pending) setText(pretty(pending)); reload(); history.reload(); }} />
    </>
  );
}
