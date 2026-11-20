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
import { getLocale, intlLocale, plural, t, tMaybe } from '@/lib/i18n';

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

/** First day of the week (0 = Sunday): Sunday in Hebrew, Monday otherwise. */
const weekStart = getLocale() === 'he' ? 0 : 1;

/** Short weekday names in the page's language, in grid order (1 Jan 2023 was a Sunday). */
const weekdayFmt = new Intl.DateTimeFormat(intlLocale(), { weekday: 'short', timeZone: 'UTC' });
const weekdays = Array.from({ length: 7 }, (_, i) => weekdayFmt.format(new Date(Date.UTC(2023, 0, 1 + ((weekStart + i) % 7)))));

/** Month grid starting on the week's first day, covering whole weeks. */
function monthGrid(year: number, month: number) {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (first.getUTCDay() - weekStart + 7) % 7;
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
  // Phones: the grid shows dots; the chosen day's items are listed below it.
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked && picked.slice(0, 7) === monthKey ? picked : today.slice(0, 7) === monthKey ? today : (days.find((d) => d.slice(0, 7) === monthKey && byDay.has(d)) ?? iso(cursor.y, cursor.m, 1));
  const dayItems = byDay.get(selected) ?? [];
  const shift = (n: number) => setCursor(({ y, m }) => ({ y: m + n < 0 ? y - 1 : m + n > 11 ? y + 1 : y, m: (m + n + 12) % 12 }));

  const copyFeed = async () => {
    const { url } = await api.get<{ url: string }>('/api/scheduler/calendar-feed');
    await navigator.clipboard.writeText(url).catch(() => undefined);
    toast.success(t('Calendar link copied'), { description: t('In Outlook: Add calendar → Subscribe from web, and paste the link.') });
  };

  return (
    <>
      <PageHeader
        title={new Intl.DateTimeFormat(intlLocale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(cursor.y, cursor.m, 1)))}
        description={t('Every tracked date you can see. Subscribe in Outlook to get your own items on your calendar.')}
        actions={
          <>
            <Segmented value={scope} onChange={setScope} options={[{ value: 'all', label: t('Everything') }, { value: 'mine', label: t('Mine') }]} />
            <Button icon={<Link2 className="size-3.5" />} onClick={() => void copyFeed()}>
              {t('Subscribe')}
            </Button>
            <div className="flex items-center">
              <Button size="icon" variant="ghost" aria-label={t('Previous month')} icon={<ChevronLeft className="size-4" />} onClick={() => shift(-1)} />
              <Button size="sm" variant="ghost" onClick={() => setCursor({ y: now.getFullYear(), m: now.getMonth() })}>
                {t('Today')}
              </Button>
              <Button size="icon" variant="ghost" aria-label={t('Next month')} icon={<ChevronRight className="size-4" />} onClick={() => shift(1)} />
            </div>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col px-4 sm:px-6 py-4">
        <div className="grid grid-cols-7 pb-2 text-xs font-medium text-subtle">
          {weekdays.map((d) => (
            <div key={d} className="px-2">
              {d}
            </div>
          ))}
        </div>
        <div className="grid shrink-0 auto-rows-fr grid-cols-7 gap-px overflow-hidden rounded-xl border border-border bg-border md:flex-1">
          {days.map((d) => {
            const items = byDay.get(d) ?? [];
            return (
              <div
                key={d}
                onClick={() => setPicked(d)}
                className={cn('min-h-12 cursor-pointer bg-surface p-1 md:min-h-24 md:cursor-default md:p-1.5', d.slice(0, 7) !== monthKey && 'bg-surface-2/50', d === selected && 'max-md:bg-accent-soft')}
              >
                <div className={cn('mx-auto mb-1 flex size-6 md:mx-0 items-center justify-center rounded-full text-xs tabular-nums', d === today ? 'bg-accent font-semibold text-white' : d.slice(0, 7) === monthKey ? 'text-fg' : 'text-subtle')}>
                  {Number(d.slice(8))}
                </div>
                {items.length > 0 && (
                  <div className="flex flex-wrap justify-center gap-0.5 md:hidden" aria-label={plural(items.length, '{n} date', '{n} dates')}>
                    {items.slice(0, 4).map((o) => (
                      <span key={o.id} className="size-1.5 rounded-full" style={{ background: o.dateKind.color }} />
                    ))}
                  </div>
                )}
                <div className="hidden space-y-0.5 md:block">
                  {items.slice(0, 3).map((o) => (
                    <Link
                      key={o.id}
                      to="/assets/$assetId"
                      params={{ assetId: o.assetId }}
                      title={t('{kind}: {asset}', { kind: tMaybe(o.dateKind.name), asset: o.assetName })}
                      className={cn('tint flex items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] font-medium transition-opacity hover:opacity-80', (o.state === 'done' || o.state === 'dismissed') && 'line-through opacity-50')}
                      style={{ ['--c' as string]: o.dateKind.color }}
                    >
                      <span className="truncate">{o.assetName}</span>
                    </Link>
                  ))}
                  {items.length > 3 && <p className="px-1.5 text-[11px] text-subtle">{t('+{n} more', { n: items.length - 3 })}</p>}
                </div>
              </div>
            );
          })}
        </div>
        <section className="mt-4 md:hidden" aria-live="polite">
          <h2 className="mb-2 px-1 text-[13px] font-semibold">
            {new Intl.DateTimeFormat(intlLocale(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${selected}T00:00:00Z`))}
          </h2>
          {dayItems.length ? (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {dayItems.map((o) => (
                <li key={o.id}>
                  <Link to="/assets/$assetId" params={{ assetId: o.assetId }} className={cn('flex min-h-12 items-center gap-3 px-3 py-2 active:bg-surface-2', (o.state === 'done' || o.state === 'dismissed') && 'opacity-60')}>
                    <span className="size-2 shrink-0 rounded-full" style={{ background: o.dateKind.color }} />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate text-[14px] font-medium', (o.state === 'done' || o.state === 'dismissed') && 'line-through')}>{o.assetName}</span>
                      <span className="block truncate text-xs text-muted">
                        {tMaybe(o.dateKind.name)} · {o.label}
                      </span>
                    </span>
                    <ChevronRight className="size-4 text-subtle" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-1 text-[13px] text-muted">{t('Nothing due this day.')}</p>
          )}
        </section>
      </div>
    </>
  );
}
