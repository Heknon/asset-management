import type { SearchHit } from '@am/core';
import { Link, useNavigate, useSearch as useRouteSearch } from '@tanstack/react-router';
import { Inbox, Search } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useDebounced } from '@/lib/hooks';
import { Highlight } from '@/components/highlight';
import { HitIcon, hitLink } from '@/components/search-hit';
import { Card, EmptyState, PageHeader, Spinner } from '@/components/ui/display';
import { Input } from '@/components/ui/form';
import { useUniversalSearch } from '@/lib/search';

function Section({ title, hits, more }: { title: string; hits: SearchHit[]; more?: ReactNode }) {
  if (!hits.length) return null;
  return (
    <section>
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 className="text-[13px] font-semibold">
          {title} <span className="font-normal text-subtle">{hits.length}</span>
        </h2>
        {more}
      </div>
      <Card padded={false} className="overflow-hidden">
        <ul className="divide-y divide-border">
          {hits.map((h) => (
            <li key={`${h.kind}-${h.id}`}>
              <Link {...(hitLink(h) as { to: '/' })} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2/50">
                <HitIcon hit={h} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate font-medium">{h.title}</span>
                    {h.subtitle && <span className="truncate text-xs text-subtle">{h.subtitle}</span>}
                  </span>
                  {h.snippet && <Highlight snippet={h.snippet} className="mt-0.5 block text-xs leading-relaxed text-muted" />}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

export function SearchPage() {
  const { q: initial } = useRouteSearch({ strict: false }) as { q?: string };
  const [q, setQ] = useState(initial ?? '');
  const navigate = useNavigate();
  const debounced = useDebounced(q, 200);
  const r = useUniversalSearch(debounced, 30);
  useEffect(() => setQ(initial ?? ''), [initial]);
  useEffect(() => {
    if (debounced !== (initial ?? '')) void navigate({ to: '/search', search: { q: debounced || undefined }, replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  return (
    <>
      <PageHeader title="Search" description="Every field of every asset you can see, plus requests, teams and people. Partial words and small typos are fine.">
        <div className="relative max-w-2xl">
          <Search className="pointer-events-none absolute top-1/2 start-3 size-4 -translate-y-1/2 text-subtle" />
          <Input autoFocus className="h-11 ps-10 text-[15px]" placeholder="Try “adobe”, a serial number, a person, “renews march”…" value={q} onChange={(e) => setQ(e.target.value)} />
          {r.loading && <Spinner className="absolute top-1/2 end-3 -translate-y-1/2" />}
        </div>
      </PageHeader>
      <div className="mx-auto w-full max-w-4xl space-y-6 px-4 sm:px-6 py-6">
        {!debounced.trim() ? (
          <EmptyState icon={<Search />} title="Search everything" description="Names, vendors, serials, phone numbers, license tiers, owners, teams — any field except restricted ones." />
        ) : r.empty ? (
          <EmptyState icon={<Inbox />} title={`Nothing found for “${debounced}”`} description="Try fewer or shorter words. Restricted fields such as license keys aren’t searchable." />
        ) : (
          <>
            <Section
              title="Assets"
              hits={r.assets}
              more={
                <Link to="/assets" search={{ q: debounced }} className="text-xs text-accent-fg hover:underline">
                  Open in the asset table
                </Link>
              }
            />
            <Section title="Requests" hits={r.requests} />
            <Section title="Teams & units" hits={r.units} />
            <Section title="People" hits={r.people} />
            <Section title="Asset types" hits={r.types} />
          </>
        )}
      </div>
    </>
  );
}
