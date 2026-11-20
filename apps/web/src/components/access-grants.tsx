import { roles, type GrantRecord, type Permission, type UnitAccess } from '@am/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Crown, Info } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useLookups } from '@/lib/queries';
import { AccessEditor, accessLabel, SubjectIcon, type AccessEntry } from './access';
import { UnitPath } from './pickers';
import { Badge } from './ui/display';

const accessKey = (unitId: string | null) => ['access', unitId ?? 'organization'] as const;

/**
 * Access on an organization unit (and everything beneath it) or, with
 * unitId null, on the whole organization. Shows what is given here, and —
 * read-only — what comes from above and from membership, so "why can she
 * see this?" always has an answer on one screen.
 */
export function GrantsEditor({ unitId }: { unitId: string | null }) {
  const qc = useQueryClient();
  const { typeById, unitById } = useLookups();
  const access = useQuery({
    queryKey: accessKey(unitId),
    queryFn: async (): Promise<UnitAccess> => {
      if (unitId) return api.get<UnitAccess>(`/api/identity/units/${unitId}/access`);
      const org = await api.get<{ grants: GrantRecord[]; canManage: boolean }>('/api/identity/access');
      return { unitId: '', direct: org.grants, inherited: [], memberRole: 'none', managers: [], canManage: org.canManage };
    },
  });
  const done = () => void qc.invalidateQueries({ queryKey: ['access'] });
  const onError = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Something went wrong');
  const changed = () => (done(), toast.success('Access updated', { description: 'Takes effect within 15 minutes, or at their next sign-in.' }));

  const add = useMutation({
    mutationFn: (v: { subject: { kind: string; id: string }; permissions: Permission[]; assetTypeId: string | null }) =>
      api.post('/api/identity/grants', { subject: { kind: v.subject.kind, id: v.subject.id }, unitId, assetTypeId: v.assetTypeId, access: { role: 'custom', permissions: v.permissions } }),
    onSuccess: changed,
    onError,
  });
  const update = useMutation({ mutationFn: (v: { id: string; permissions: Permission[] }) => api.patch(`/api/identity/grants/${v.id}`, { access: { role: 'custom', permissions: v.permissions } }), onSuccess: changed, onError });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/api/identity/grants/${id}`), onSuccess: changed, onError });

  const a = access.data;
  if (!a) return <p className="text-xs text-muted">{access.isLoading ? 'Loading…' : 'Access could not be loaded.'}</p>;
  const typeNote = (g: GrantRecord) => (g.assetTypeId ? `only ${typeById.get(g.assetTypeId)?.name ?? 'one type'}` : undefined);
  const entry = (g: GrantRecord): AccessEntry => ({ key: g.id, subject: g.subject, permissions: g.permissions, note: typeNote(g) });
  const unit = unitId ? unitById.get(unitId) : undefined;

  return (
    <AccessEditor
      canManage={a.canManage}
      allowTypeLimit
      pending={add.isPending}
      entries={a.direct.map(entry)}
      onAdd={(subject, permissions, assetTypeId) => add.mutate({ subject, permissions, assetTypeId })}
      onChange={(e, permissions) => update.mutate({ id: e.key, permissions })}
      onRemove={(e) => remove.mutate(e.key)}
      inherited={
        unitId && (
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-subtle">
              <Info className="size-3.5" />
              Also has access, from the organization chart
            </p>
            <ul className="divide-y divide-border rounded-lg border border-border bg-surface-2/40">
              <li className="flex items-center gap-2.5 px-3 py-2">
                <SubjectIcon kind="unit" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">Everyone in {unit?.name}</span>
                  <span className="block text-xs text-muted">Members’ default role · changed in Organization</span>
                </span>
                <Badge>{a.memberRole === 'none' ? 'No access' : roles[a.memberRole].label}</Badge>
              </li>
              {a.managers.length > 0 && (
                <li className="flex items-center gap-2.5 px-3 py-2">
                  <SubjectIcon kind="user" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{a.managers.map((m) => m.displayName).join(', ')}</span>
                    <span className="block text-xs text-muted">Managers of {unit?.name}</span>
                  </span>
                  <Badge tone="accent">
                    <Crown className="me-1 size-3" />
                    Admin
                  </Badge>
                </li>
              )}
              {a.inherited.map((g) => (
                <li key={g.id} className="flex items-center gap-2.5 px-3 py-2">
                  <SubjectIcon kind={g.subject.kind} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{g.subject.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {g.fromUnitId ? (
                        <>
                          From{' '}
                          <Link to="/units/$unitId" params={{ unitId: g.fromUnitId }} className="hover:underline">
                            <UnitPath id={g.fromUnitId} leafOnly />
                          </Link>
                        </>
                      ) : (
                        'The whole organization'
                      )}
                      {typeNote(g) && ` · ${typeNote(g)}`}
                    </span>
                  </span>
                  <Badge>{accessLabel(g.permissions)}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )
      }
    />
  );
}
