import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Circuit } from '@/lib/api';

export type Tone = 'success' | 'warning' | 'destructive' | 'muted';
const dot: Record<Tone, string> = { success: 'bg-success', warning: 'bg-warning', destructive: 'bg-destructive', muted: 'bg-muted-foreground/40' };

export function StatusDot({ tone, pulse = false, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} aria-hidden>
      {pulse && <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', dot[tone])} />}
      <span className={cn('relative inline-flex size-2 rounded-full', dot[tone])} />
    </span>
  );
}

export const circuitTone: Record<Circuit, Tone> = { closed: 'success', 'half-open': 'warning', open: 'destructive' };
export const circuitLabel: Record<Circuit, string> = { closed: 'Доступен', 'half-open': 'Пробный запрос', open: 'Исключён' };

export function CircuitBadge({ circuit }: { circuit: Circuit }) {
  const variant = circuit === 'closed' ? 'success' : circuit === 'open' ? 'destructive' : 'warning';
  return <Badge variant={variant}><StatusDot tone={circuitTone[circuit]} />{circuitLabel[circuit]}</Badge>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="bg-card flex flex-col gap-2 rounded-xl border p-5">
      <div className="text-muted-foreground flex items-center justify-between text-sm">
        <span>{label}</span>
        {icon && <span className="[&_svg]:size-4">{icon}</span>}
      </div>
      <div className="text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {hint && <div className="text-muted-foreground text-xs">{hint}</div>}
    </div>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[0.8125rem]', className)}>{children}</span>;
}

/** Key–value rows used inside node and origin cards. */
export function Facts({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="space-y-1.5 text-sm">
      {items.map(([key, value], index) => (
        <div key={index} className="flex flex-wrap items-baseline justify-between gap-x-4">
          <dt className="text-muted-foreground shrink-0">{key}</dt>
          <dd className="ml-auto min-w-0 text-right break-words tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
