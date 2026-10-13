import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { api, type Config } from '@/lib/api';
import { cn } from '@/lib/utils';

type Line = { kind: 'same' | 'add' | 'remove'; text: string };

/** Line diff (LCS) of two pretty-printed JSON documents; configurations are small, so O(n·m) is fine. */
export function diffLines(before: string, after: string): Line[] {
  const a = before.split('\n'), b = after.split('\n');
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const lines: Line[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { lines.push({ kind: 'same', text: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) lines.push({ kind: 'remove', text: a[i++] });
    else lines.push({ kind: 'add', text: b[j++] });
  }
  while (i < a.length) lines.push({ kind: 'remove', text: a[i++] });
  while (j < b.length) lines.push({ kind: 'add', text: b[j++] });
  return lines;
}

// Shows only changed lines with a little context, like a unified diff.
function visible(lines: Line[], context = 2) {
  const keep = lines.map(() => false);
  lines.forEach((line, index) => { if (line.kind !== 'same') for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true; });
  const result: (Line | null)[] = [];
  lines.forEach((line, index) => { if (keep[index]) result.push(line); else if (result.at(-1) !== null) result.push(null); });
  return result;
}

const pretty = (config: Config) => JSON.stringify(config, null, 2);

/** Confirmation dialog: shows the diff against the running configuration and applies the next revision. */
export function ApplyConfigDialog({ current, next, open, onOpenChange, onApplied }: { current: Config; next: Config | null; open: boolean; onOpenChange: (open: boolean) => void; onApplied: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!next) return null;
  const lines = visible(diffLines(pretty(current), pretty(next)));
  const changed = lines.some(line => line && line.kind !== 'same' && !/"revision"/.test(line.text));

  async function apply() {
    setBusy(true);
    try {
      const result = await api<{ revision: number }>('/admin/config', { method: 'PUT', body: next });
      toast.success(`Конфигурация revision ${result.revision} применена без перезапуска`);
      onOpenChange(false); onApplied();
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Применить revision {next.revision}?</DialogTitle>
          <DialogDescription>Изменения относительно работающей revision {current.revision}. Агент применит их сразу, без перезапуска.</DialogDescription>
        </DialogHeader>
        <div className="bg-muted/50 max-h-[50vh] overflow-auto rounded-lg border py-2 font-mono text-xs">
          {!changed && <p className="text-muted-foreground px-3 pb-2 font-sans text-sm">Кроме revision ничего не изменилось.</p>}
          {lines.map((line, index) => line === null
            ? <div key={index} className="text-muted-foreground px-3 select-none">⋯</div>
            : <div key={index} className={cn('px-3 whitespace-pre', line.kind === 'add' && 'bg-success/15 text-success', line.kind === 'remove' && 'bg-destructive/10 text-destructive')}>
                <span className="mr-2 inline-block w-3 select-none">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span>{line.text}
              </div>)}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button onClick={apply} disabled={busy}>{busy && <Spinner />}Применить</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Server-side validation, so the form and the agent never disagree about what is valid. */
export async function validateOnServer(config: Config) {
  const result = await api<{ valid: boolean; message?: string }>('/admin/config/validate', { method: 'POST', body: config });
  return result.valid ? null : result.message || 'Конфигурация не прошла проверку';
}
