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

interface TemplateSummary {
  key: string;
  name: string;
  description?: string;
  icon: string;
  color: string;
  fieldCount: number;
  trackedDates: string[];
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
              {type.fields.length} fields · v{type.version}
            </p>
          </div>
          {type.archived && <Badge className="ml-auto">Archived</Badge>}
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
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: keys.assetTypes });
      toast.success(`${t.name} added`, { description: 'Adjust its fields to fit how you work.' });
      void navigate({ to: '/templates/$typeId', params: { typeId: t.id } });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not create template'),
  });

  const { new: startNew } = useSearch({ strict: false }) as { new?: string };
  const [starting, setStarting] = useState(!!startNew);
  useShortcut('n', () => setStarting(true));
  const active = (types.data ?? []).filter((t) => !t.archived);
  const archived = (types.data ?? []).filter((t) => t.archived);

  return (
    <>
      <PageHeader
        title="Templates"
        description="Asset types define the fields, statuses and tracked dates of everything you manage."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setStarting(true)}>
            New template
          </Button>
        }
      />
      <div className="mx-auto w-full max-w-5xl space-y-8 px-4 sm:px-6 py-6">
        <section>
          <SectionTitle>Your templates</SectionTitle>
          {active.length ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {active.map((t) => (
                <TypeCard key={t.id} type={t} />
              ))}
            </div>
          ) : (
            <Card>
              <EmptyState
                icon={<LayoutTemplate />}
                title="No templates yet"
                description="A template says what you track about a kind of thing: its fields, statuses and the dates that need reminders."
                action={
                  <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setStarting(true)}>
                    Create your first template
                  </Button>
                }
              />
            </Card>
          )}
        </section>

        <section>
          <SectionTitle>Start from a template</SectionTitle>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(gallery.data ?? []).map((g) => (
              <Card key={g.key} className="flex items-start gap-3">
                <TypeIcon icon={g.icon} color={g.color} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{g.name}</p>
                  <p className="mt-0.5 text-xs text-muted">{g.description}</p>
                  <p className="mt-2 text-xs text-subtle">
                    {g.fieldCount} fields{g.trackedDates.length ? ` · tracks ${g.trackedDates.join(', ').toLowerCase()}` : ''}
                  </p>
                </div>
                <Button size="sm" loading={create.isPending && create.variables === g.key} onClick={() => create.mutate(g.key)}>
                  Use
                </Button>
              </Card>
            ))}
          </div>
        </section>

        {archived.length > 0 && (
          <section>
            <SectionTitle>Archived</SectionTitle>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {archived.map((t) => (
                <TypeCard key={t.id} type={t} />
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
    <Dialog open={open} onOpenChange={onOpenChange} title="New template" description="What kind of thing will you track?">
      <div className="space-y-5">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            blank();
          }}
        >
          <Field label="Name" className="flex-1">
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Laptops, Domains, Contracts" />}
          </Field>
          <Button type="submit" variant="primary" icon={<ArrowRight className="size-4" />}>
            {name.trim() ? 'Build it' : 'Start blank'}
          </Button>
        </form>
        <div>
          <SectionTitle>Or adapt a starter</SectionTitle>
          <div className="divide-y divide-border rounded-xl border border-border">
            {gallery.map((g) => (
              <button key={g.key} type="button" disabled={!!starting} onClick={() => onStarter(g.key)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-surface-2 disabled:opacity-60">
                <TypeIcon icon={g.icon} color={g.color} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">{g.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {g.fieldCount} fields{g.trackedDates.length ? ` · tracks ${g.trackedDates.join(', ').toLowerCase()}` : ''}
                  </span>
                </span>
                <span className="text-xs text-accent-fg">{starting === g.key ? 'Adding…' : 'Use'}</span>
              </button>
            ))}
          </div>
        </div>
        <Link to="/import" onClick={() => onOpenChange(false)} className="flex items-center gap-3 rounded-xl border border-dashed border-border-strong px-3 py-3 transition-colors hover:bg-surface-2">
          <span className="flex size-[30px] items-center justify-center rounded-lg bg-surface-2 text-muted">
            <FileUp className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">From a spreadsheet</span>
            <span className="block text-xs text-muted">Its columns become the fields, and its rows the first items.</span>
          </span>
          <ArrowRight className="size-4 text-subtle" />
        </Link>
      </div>
    </Dialog>
  );
}
