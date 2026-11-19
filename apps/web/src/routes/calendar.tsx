import { addDuration, type Obligation } from '@am/core';
import { Link } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Link2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/display';
import { Segmented } from '@/components/ui/form';
import { api } from '@/lib/api';
import { useObligations } from '@/lib/queries';
import { cn, todayIso } from '@/lib/utils';

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

/** Month grid starting on Monday, covering whole weeks. */
function monthGrid(year: number, month: number) {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const start = iso(year, month, 1 - offset);
  const days = Math.ceil((offset + new Date(Date.UTC(year, month + 1, 0)).getUTCDate()) / 7) * 7;
  return Array.from({ length: days }, (_, i) => addDuration(start, { amount: i, unit: 'day' }));
}

export function CalendarPage() {
  const now = new Date();
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const days = useMemo(() => monthGrid(cursor.y, cursor.m), [cursor]);
  const obligations = useObligations({ from: days[0], to: days[days.length - 1], state: 'all', mine: scope === 'mine', limit: 500 });
  const byDay = useMemo(() => {
    const m = new Map<string, Obligation[]>();
    for (const o of obligations.data?.items ?? []) m.set(o.dueDate, [...(m.get(o.dueDate) ?? []), o]);
    return m;
  }, [obligations.data]);
  const today = todayIso();
  const monthKey = iso(cursor.y, cursor.m, 1).slice(0, 7);
  const shift = (n: number) => setCursor(({ y, m }) => ({ y: m + n < 0 ? y - 1 : m + n > 11 ? y + 1 : y, m: (m + n + 12) % 12 }));

  const copyFeed = async () => {
    const { url } = await api.get<{ url: string }>('/api/scheduler/calendar-feed');
    await navigator.clipboard.writeText(url).catch(() => undefined);
    toast.success('Calendar link copied', { description: 'In Outlook: Add calendar → Subscribe from web, and paste the link.' });
  };

  return (
    <>
      <PageHeader
        title={new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(cursor.y, cursor.m, 1)))}
        description="Every tracked date you can see. Subscribe in Outlook to get your own items on your calendar."
        actions={
          <>
            <Segmented value={scope} onChange={setScope} options={[{ value: 'all', label: 'Everything' }, { value: 'mine', label: 'Mine' }]} />
            <Button icon={<Link2 className="size-3.5" />} onClick={() => void copyFeed()}>
              Subscribe
            </Button>
            <div className="flex items-center">
              <Button size="icon" variant="ghost" aria-label="Previous month" icon={<ChevronLeft className="size-4" />} onClick={() => shift(-1)} />
              <Button size="sm" variant="ghost" onClick={() => setCursor({ y: now.getFullYear(), m: now.getMonth() })}>
                Today
              </Button>
              <Button size="icon" variant="ghost" aria-label="Next month" icon={<ChevronRight className="size-4" />} onClick={() => shift(1)} />
            </div>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
        <div className="grid grid-cols-7 pb-2 text-xs font-medium text-subtle">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <div key={d} className="px-2">
              {d}
            </div>
          ))}
        </div>
        <div className="grid flex-1 auto-rows-fr grid-cols-7 overflow-hidden rounded-xl border border-border bg-border gap-px">
          {days.map((d) => {
            const items = byDay.get(d) ?? [];
            return (
              <div key={d} className={cn('min-h-24 bg-surface p-1.5', d.slice(0, 7) !== monthKey && 'bg-surface-2/50')}>
                <div className={cn('mb-1 flex size-6 items-center justify-center rounded-full text-xs tabular-nums', d === today ? 'bg-accent font-semibold text-white' : d.slice(0, 7) === monthKey ? 'text-fg' : 'text-subtle')}>
                  {Number(d.slice(8))}
                </div>
                <div className="space-y-0.5">
                  {items.slice(0, 3).map((o) => (
                    <Link
                      key={o.id}
                      to="/assets/$assetId"
                      params={{ assetId: o.assetId }}
                      title={`${o.dateKind.name}: ${o.assetName}`}
                      className={cn('flex items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] font-medium transition-opacity hover:opacity-80', (o.state === 'done' || o.state === 'dismissed') && 'line-through opacity-50')}
                      style={{ background: `${o.dateKind.color}1f`, color: o.dateKind.color }}
                    >
                      <span className="truncate">{o.assetName}</span>
                    </Link>
                  ))}
                  {items.length > 3 && <p className="px-1.5 text-[11px] text-subtle">+{items.length - 3} more</p>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
