import * as RTabs from '@radix-ui/react-tabs';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cn, initials } from '@/lib/utils';

export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={cn('rounded-xl border border-border bg-surface', padded && 'p-4', className)}>{children}</div>;
}

export function SectionTitle({ children, aside, className }: { children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-3 flex items-center justify-between gap-2', className)}>
      <h2 className="text-[13px] font-semibold">{children}</h2>
      {aside}
    </div>
  );
}

export function PageHeader({ title, description, icon, actions, children }: { title: ReactNode; description?: ReactNode; icon?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="border-b border-border bg-bg/80 px-4 pt-5 pb-4 backdrop-blur has-[[role=tablist]]:pb-0 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-[min(100%,22rem)] items-center gap-3">
          {icon}
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold tracking-tight [overflow-wrap:anywhere] sm:truncate">{title}</h1>
            {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-4 has-[[role=tablist]]:-mb-px">{children}</div>}
    </div>
  );
}

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  accent: 'bg-accent-soft text-accent-fg',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};

/** A badge either has a semantic tone or a custom color (rendered as a dot). */
export function Badge({ children, tone = 'neutral', color, className }: { children: ReactNode; tone?: Tone; color?: string; className?: string }) {
  return (
    <span className={cn('inline-flex h-5 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium whitespace-nowrap', color ? 'bg-surface-2 text-fg' : tones[tone], className)}>
      {color && <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />}
      {children}
    </span>
  );
}

export function Avatar({ name, size = 22, className }: { name: string; size?: number; className?: string }) {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  const style: CSSProperties = { width: size, height: size, fontSize: size * 0.42, background: `hsl(${hue} 55% 55% / 0.18)`, color: `hsl(${hue} 50% 42%)` };
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold dark:brightness-150', className)} style={style} title={name}>
      {initials(name) || '?'}
    </span>
  );
}

/** Colored rounded square with an icon — used for asset types everywhere. */
export function IconTile({ color, children, size = 28 }: { color: string; children: ReactNode; size?: number }) {
  return (
    <span className="tint inline-flex shrink-0 items-center justify-center rounded-lg [&>svg]:size-[55%]" style={{ width: size, height: size, ['--c' as string]: color }}>
      {children}
    </span>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 sm:px-6 py-16 text-center">
      {icon && <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-surface-2 text-muted [&>svg]:size-5">{icon}</div>}
      <p className="text-[14px] font-medium">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-subtle', className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-surface-2', className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-surface-2 px-1 font-sans text-[11px] text-muted">{children}</kbd>;
}

/** Which ends of a horizontal scroller have more content, to fade them as a hint. */
function useScrollEdges<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => (el.removeEventListener('scroll', update), ro.disconnect());
  }, []);
  const mask = edges.left || edges.right ? `linear-gradient(to right, ${edges.left ? 'transparent, black 28px' : 'black'}, ${edges.right ? 'black calc(100% - 28px), transparent' : 'black'})` : undefined;
  return { ref, style: mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined };
}

export function Tabs({ value, onValueChange, tabs, children }: { value: string; onValueChange: (v: string) => void; tabs: Array<{ value: string; label: ReactNode; count?: number }>; children?: ReactNode }) {
  const scroller = useScrollEdges<HTMLDivElement>();
  // Keep the chosen tab in view on narrow screens (e.g. opened from a link to the last tab).
  useEffect(() => {
    scroller.ref.current?.querySelector<HTMLElement>('[data-state=active]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [value, scroller.ref]);
  return (
    <RTabs.Root value={value} onValueChange={onValueChange}>
      <RTabs.List ref={scroller.ref} style={scroller.style} className="-mx-4 flex gap-4 overflow-x-auto border-b border-border px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => (
          <RTabs.Trigger
            key={t.value}
            value={t.value}
            className="-mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 whitespace-nowrap sm:h-9 border-transparent text-[13px] font-medium text-muted transition-colors hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg"
          >
            {t.label}
            {t.count !== undefined && <span className="rounded bg-surface-2 px-1 text-[11px] text-muted">{t.count}</span>}
          </RTabs.Trigger>
        ))}
        {/* End padding that scrolls (a flex row's own padding-right does not), so the last tab clears the fade. */}
        <span aria-hidden className="w-px shrink-0 sm:hidden" />
      </RTabs.List>
      {children}
    </RTabs.Root>
  );
}

export function Stat({ label, value, hint, tone, onClick }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'danger' | 'warning'; /** Makes the card a button, e.g. jump to the list it counts. */ onClick?: () => void }) {
  const body = (
    <>
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={cn('mt-1.5 text-2xl font-semibold tracking-tight tabular-nums', tone === 'danger' && 'text-danger', tone === 'warning' && 'text-warning')}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-subtle">{hint}</p>}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="rounded-xl border border-border bg-surface p-4 text-start transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-accent">
      {body}
    </button>
  ) : (
    <Card>{body}</Card>
  );
}

/** Where a multi-step flow stands, in one line: for phones, where the full row of steps does not fit. */
export function CompactSteps({ index, total, label, color, done, className }: { index: number; total: number; label: string; color?: string; done?: boolean; className?: string }) {
  const pct = done ? 100 : Math.round(((index + 1) / total) * 100);
  return (
    <div className={cn('space-y-1.5', className)}>
      <p className="flex items-center justify-between text-xs text-muted">
        <span>
          {done ? 'Done' : `Step ${index + 1} of ${total}`} · <span className="font-medium text-fg">{label}</span>
        </span>
      </p>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={cn('h-full rounded-full transition-all', done ? 'bg-success' : !color && 'bg-accent')} style={{ width: `${pct}%`, ...(color && !done && { background: color }) }} />
      </div>
    </div>
  );
}
