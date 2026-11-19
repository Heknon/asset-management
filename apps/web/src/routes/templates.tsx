import type { AssetType } from '@am/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { CalendarClock, LayoutTemplate, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader, SectionTitle } from '@/components/ui/display';
import { api, ApiError } from '@/lib/api';
import { keys } from '@/lib/queries';

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

  const active = (types.data ?? []).filter((t) => !t.archived);
  const archived = (types.data ?? []).filter((t) => t.archived);

  return (
    <>
      <PageHeader
        title="Templates"
        description="Asset types define the fields, statuses and tracked dates of everything you manage."
        actions={
          <Link to="/templates/$typeId" params={{ typeId: 'new' }}>
            <Button variant="primary" icon={<Plus className="size-4" />}>
              New template
            </Button>
          </Link>
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
              <EmptyState icon={<LayoutTemplate />} title="No templates yet" description="Start from a blank template or one of the starters below." />
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
    </>
  );
}
