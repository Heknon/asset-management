import type { AssetType } from '@am/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowRight, CalendarClock, FileUp, LayoutTemplate, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader, SectionTitle } from '@/components/ui/display';
import { Field, Input } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { keys } from '@/lib/queries';
import { useShortcut } from '@/lib/shortcuts';
import { intlLocale, plural, t, tMaybe } from '@/lib/i18n';

interface TemplateSummary {
  key: string;
  name: string;
  description?: string;
  icon: string;
  color: string;
  fieldCount: number;
  trackedDates: string[];
}

/** "6 fields · tracks renewal date, cancellation deadline" for a starter. */
function starterSummary(g: TemplateSummary): string {
  const fields = plural(g.fieldCount, '{n} field', '{n} fields');
  if (!g.trackedDates.length) return fields;
  const dates = g.trackedDates.map((d) => tMaybe(d)).join(', ').toLocaleLowerCase(intlLocale());
  return t('{fields} · tracks {dates}', { fields, dates });
}

function TypeCard({ type }: { type: AssetType }) {
  const tracked = type.fields.filter((f) => f.kind === 'date' && f.config.tracking);
  return (
    <Link to="/templates/$typeId" params={{ typeId: type.id }} className="block">
      <Card className="h-full transition-colors hover:border-border-strong">
        <div className="flex items-start gap-3">
          <TypeIcon icon={type.icon} color={type.color} size={36} />
          <div className="min-w-0">
            <p className="truncate font-medium">{type.name}</p>
            <p className="text-xs text-muted">
              {t('{fields} · v{version}', { fields: plural(type.fields.length, '{n} field', '{n} fields'), version: type.version })}
            </p>
          </div>
          {type.archived && <Badge className="ms-auto">{t('Archived')}</Badge>}
        </div>
        {tracked.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {tracked.map((f) => (
              <Badge key={f.key} tone="accent">
                <CalendarClock className="size-3" />
                {f.label}
              </Badge>
            ))}
          </div>
        )}
      </Card>
    </Link>
  );
}

export function TemplatesPage() {
  const types = useQuery({ queryKey: [...keys.assetTypes, 'all'], queryFn: () => api.get<AssetType[]>('/api/registry/asset-types', { archived: true }) });
  const gallery = useQuery({ queryKey: keys.templates, queryFn: () => api.get<TemplateSummary[]>('/api/registry/templates') });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (key: string) => api.post<AssetType>(`/api/registry/templates/${key}/instantiate`),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: keys.assetTypes });
      toast.success(t('{name} added', { name: tMaybe(created.name) }), { description: t('Adjust its fields to fit how you work.') });
      void navigate({ to: '/templates/$typeId', params: { typeId: created.id } });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('Could not create template')),
  });

  const { new: startNew } = useSearch({ strict: false }) as { new?: string };
  const [starting, setStarting] = useState(!!startNew);
  useShortcut('n', () => setStarting(true));
  const active = (types.data ?? []).filter((x) => !x.archived);
  const archived = (types.data ?? []).filter((x) => x.archived);

  return (
    <>
      <PageHeader
        title={t('Templates')}
        description={t('Asset types define the fields, statuses and tracked dates of everything you manage.')}
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setStarting(true)}>
            {t('New template')}
          </Button>
        }
      />
      <div className="mx-auto w-full max-w-5xl space-y-8 px-4 sm:px-6 py-6">
        <section>
          <SectionTitle>{t('Your templates')}</SectionTitle>
          {active.length ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {active.map((x) => (
                <TypeCard key={x.id} type={x} />
              ))}
            </div>
          ) : (
            <Card>
              <EmptyState
                icon={<LayoutTemplate />}
                title={t('No templates yet')}
                description={t('A template says what you track about a kind of thing: its fields, statuses and the dates that need reminders.')}
                action={
                  <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setStarting(true)}>
                    {t('Create your first template')}
                  </Button>
                }
              />
            </Card>
          )}
        </section>

        <section>
          <SectionTitle>{t('Start from a template')}</SectionTitle>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(gallery.data ?? []).map((g) => (
              <Card key={g.key} className="flex items-start gap-3">
                <TypeIcon icon={g.icon} color={g.color} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{tMaybe(g.name)}</p>
                  <p className="mt-0.5 text-xs text-muted">{tMaybe(g.description)}</p>
                  <p className="mt-2 text-xs text-subtle">{starterSummary(g)}</p>
                </div>
                <Button size="sm" loading={create.isPending && create.variables === g.key} onClick={() => create.mutate(g.key)}>
                  {t('Use')}
                </Button>
              </Card>
            ))}
          </div>
        </section>

        {archived.length > 0 && (
          <section>
            <SectionTitle>{t('Archived')}</SectionTitle>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {archived.map((x) => (
                <TypeCard key={x.id} type={x} />
              ))}
            </div>
          </section>
        )}
      </div>
      <StartTemplate open={starting} onOpenChange={setStarting} gallery={gallery.data ?? []} onStarter={(k) => create.mutate(k)} starting={create.isPending ? create.variables : undefined} />
    </>
  );
}

/** The three ways to begin: name it and build it, adapt a starter, or let a spreadsheet's columns become the fields. */
function StartTemplate({ open, onOpenChange, gallery, onStarter, starting }: { open: boolean; onOpenChange: (o: boolean) => void; gallery: TemplateSummary[]; onStarter: (key: string) => void; starting?: string }) {
  const [name, setName] = useState('');
  const navigate = useNavigate();
  const blank = () => {
    onOpenChange(false);
    void navigate({ to: '/templates/$typeId', params: { typeId: 'new' }, search: { name: name.trim() || undefined } });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('New template')} description={t('What kind of thing will you track?')}>
      <div className="space-y-5">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            blank();
          }}
        >
          <Field label={t('Name')} className="flex-1">
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('e.g. Laptops, Domains, Contracts')} />}
          </Field>
          <Button type="submit" variant="primary" icon={<ArrowRight className="size-4" />}>
            {name.trim() ? t('Build it') : t('Start blank')}
          </Button>
        </form>
        <div>
          <SectionTitle>{t('Or adapt a starter')}</SectionTitle>
          <div className="divide-y divide-border rounded-xl border border-border">
            {gallery.map((g) => (
              <button key={g.key} type="button" disabled={!!starting} onClick={() => onStarter(g.key)} className="flex w-full items-center gap-3 px-3 py-2.5 text-start transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-surface-2 disabled:opacity-60">
                <TypeIcon icon={g.icon} color={g.color} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">{tMaybe(g.name)}</span>
                  <span className="block truncate text-xs text-muted">{starterSummary(g)}</span>
                </span>
                <span className="text-xs text-accent-fg">{starting === g.key ? t('Adding…') : t('Use')}</span>
              </button>
            ))}
          </div>
        </div>
        <Link to="/import" onClick={() => onOpenChange(false)} className="flex items-center gap-3 rounded-xl border border-dashed border-border-strong px-3 py-3 transition-colors hover:bg-surface-2">
          <span className="flex size-[30px] items-center justify-center rounded-lg bg-surface-2 text-muted">
            <FileUp className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">{t('From a spreadsheet')}</span>
            <span className="block text-xs text-muted">{t('Its columns become the fields, and its rows the first items.')}</span>
          </span>
          <ArrowRight className="size-4 text-subtle" />
        </Link>
      </div>
    </Dialog>
  );
}
