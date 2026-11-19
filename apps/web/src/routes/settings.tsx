import {
  dateBehaviors,
  type DateBehavior,
  type DateKind,
  type DateKindInput,
  type GrantInput,
  type GrantLevel,
  type Group,
  type PurchaseClass,
  type PurchaseClassInput,
  type User,
} from '@am/core';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { CalendarDays, KeyRound, Pencil, Plus, RefreshCcw, Shield, Tags, Trash2, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { DurationInput, DurationListEditor } from '@/components/duration-editor';
import { AssetTypeSelect, ColorPicker, PersonName, PersonPicker, PurchaseClassSelect } from '@/components/pickers';
import { Button } from '@/components/ui/button';
import { Avatar, Badge, Card, EmptyState, PageHeader, Tabs } from '@/components/ui/display';
import { Field, Input, Segmented, Select, Switch } from '@/components/ui/form';
import { ConfirmDialog, Dialog } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { keys, useDateKinds, useGrants, useGroupMembers, useGroups, useLookups, useMe, usePurchaseClasses, useUsers } from '@/lib/queries';
import { formatDateTime, formatDurations, slugKey } from '@/lib/utils';

/** Mutation with toast + invalidation; every settings screen saves through this. */
function useSave<TVars, TOut = unknown>(fn: (v: TVars) => Promise<TOut>, invalidate: QueryKey[], success: string, onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      invalidate.forEach((queryKey) => void qc.invalidateQueries({ queryKey }));
      toast.success(success);
      onDone?.();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Something went wrong'),
  });
}

function Row({ lead, title, subtitle, meta, actions }: { lead?: ReactNode; title: ReactNode; subtitle?: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <li className="group flex items-center gap-3 px-4 py-3">
      {lead}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{title}</div>
        {subtitle && <div className="truncate text-xs text-muted">{subtitle}</div>}
      </div>
      {meta}
      {actions && <div className="flex gap-1">{actions}</div>}
    </li>
  );
}

const Dot = ({ color }: { color: string }) => <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />;

// ─── Date kinds ──────────────────────────────────────────────────────────────

const behaviorText: Record<DateBehavior, string> = {
  recurring: 'Repeats — completing it rolls the date forward',
  milestone: 'One-off — completing it closes the item',
  informational: 'Shown for context; never reminds',
};

export function DateKindsPage() {
  const kinds = useDateKinds();
  const [editing, setEditing] = useState<DateKind | 'new' | null>(null);
  return (
    <>
      <PageHeader
        title="Date kinds"
        description="The meanings a date field can have. Templates pick one per date; reminders and actions follow from it."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>New date kind</Button>}
      />
      <div className="mx-auto w-full max-w-3xl px-6 py-6">
        <Card padded={false}>
          <ul className="divide-y divide-border">
            {(kinds.data ?? []).map((k) => (
              <Row
                key={k.id}
                lead={<Dot color={k.color} />}
                title={
                  <span className="flex items-center gap-2">
                    {k.name}
                    {k.archived && <Badge>Archived</Badge>}
                  </span>
                }
                subtitle={`${behaviorText[k.behavior]}${k.behavior !== 'informational' ? ` · ${formatDurations(k.defaultReminders)}` : ''}`}
                meta={<Badge tone="accent">{k.actionLabel}</Badge>}
                actions={<Button size="icon" variant="ghost" aria-label="Edit" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(k)} />}
              />
            ))}
          </ul>
        </Card>
      </div>
      {editing && <DateKindDialog kind={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function DateKindDialog({ kind, onClose }: { kind: DateKind | null; onClose: () => void }) {
  const [d, setD] = useState<DateKindInput & { archived: boolean }>(
    kind ?? { key: '', name: '', color: '#6366f1', behavior: 'milestone', actionLabel: 'Complete', defaultReminders: [{ amount: 30, unit: 'day' }, { amount: 7, unit: 'day' }], archived: false },
  );
  const save = useSave(() => (kind ? api.put(`/api/registry/date-kinds/${kind.id}`, d) : api.post('/api/registry/date-kinds', d)), [keys.dateKinds], kind ? 'Date kind saved' : 'Date kind created', onClose);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={kind ? `Edit ${kind.name}` : 'New date kind'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!d.name} onClick={() => save.mutate(undefined)}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required>
            {(id) => <Input id={id} value={d.name} placeholder="e.g. Audit due" onChange={(e) => setD({ ...d, name: e.target.value, ...(!kind && { key: slugKey(e.target.value) }) })} />}
          </Field>
          <Field label="Action label" hint="Button text, e.g. Renew, Pay">
            {(id) => <Input id={id} value={d.actionLabel} onChange={(e) => setD({ ...d, actionLabel: e.target.value })} />}
          </Field>
        </div>
        <Field label="Behaviour" hint={behaviorText[d.behavior]}>
          {() => <Segmented value={d.behavior} onChange={(behavior) => setD({ ...d, behavior, ...(behavior === 'recurring' && !d.defaultRecurrence && { defaultRecurrence: { amount: 1, unit: 'year' } }) })} options={dateBehaviors.map((b) => ({ value: b, label: b[0]!.toUpperCase() + b.slice(1) }))} />}
        </Field>
        {d.behavior === 'recurring' && <Field label="Repeats every">{(id) => <DurationInput id={id} value={d.defaultRecurrence ?? { amount: 1, unit: 'year' }} onChange={(defaultRecurrence) => setD({ ...d, defaultRecurrence })} />}</Field>}
        {d.behavior !== 'informational' && <Field label="Default reminders">{() => <DurationListEditor value={d.defaultReminders} onChange={(defaultReminders) => setD({ ...d, defaultReminders })} />}</Field>}
        <Field label="Color">{() => <ColorPicker value={d.color} onChange={(color) => setD({ ...d, color })} />}</Field>
        {kind && <Switch checked={d.archived} onChange={(archived) => setD({ ...d, archived })} label="Archived" description="Hidden from the template builder; existing dates keep working" />}
      </div>
    </Dialog>
  );
}

// ─── Purchase classes ────────────────────────────────────────────────────────

export function PurchaseClassesPage() {
  const classes = usePurchaseClasses();
  const [editing, setEditing] = useState<PurchaseClass | 'new' | null>(null);
  return (
    <>
      <PageHeader
        title="Purchase classes"
        description="Who or what a purchase is for — a department, client or project. Access is granted per purchase class."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>New purchase class</Button>}
      />
      <div className="mx-auto w-full max-w-3xl px-6 py-6">
        <Card padded={false}>
          {classes.data?.length ? (
            <ul className="divide-y divide-border">
              {classes.data.map((c) => (
                <Row
                  key={c.id}
                  lead={<Dot color={c.color} />}
                  title={
                    <span className="flex items-center gap-2">
                      {c.name}
                      {c.archived && <Badge>Archived</Badge>}
                    </span>
                  }
                  subtitle={c.description ?? c.key}
                  actions={<Button size="icon" variant="ghost" aria-label="Edit" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(c)} />}
                />
              ))}
            </ul>
          ) : (
            <EmptyState icon={<Tags />} title="No purchase classes" description="Create one per department, client or project you buy for." />
          )}
        </Card>
      </div>
      {editing && <PurchaseClassDialog pc={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function PurchaseClassDialog({ pc, onClose }: { pc: PurchaseClass | null; onClose: () => void }) {
  const [d, setD] = useState<PurchaseClassInput>(pc ?? { key: '', name: '', description: null, color: '#64748b', archived: false });
  const save = useSave(() => (pc ? api.put(`/api/identity/purchase-classes/${pc.id}`, d) : api.post('/api/identity/purchase-classes', d)), [keys.purchaseClasses], 'Purchase class saved', onClose);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={pc ? `Edit ${pc.name}` : 'New purchase class'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!d.name} onClick={() => save.mutate(undefined)}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          {(id) => <Input id={id} value={d.name} placeholder="e.g. Engineering, Client Acme" onChange={(e) => setD({ ...d, name: e.target.value, ...(!pc && { key: slugKey(e.target.value) }) })} />}
        </Field>
        <Field label="Description">{(id) => <Input id={id} value={d.description ?? ''} onChange={(e) => setD({ ...d, description: e.target.value || null })} />}</Field>
        <Field label="Color">{() => <ColorPicker value={d.color} onChange={(color) => setD({ ...d, color })} />}</Field>
        {pc && <Switch checked={d.archived} onChange={(archived) => setD({ ...d, archived })} label="Archived" description="No new assets can be created in it" />}
      </div>
    </Dialog>
  );
}

// ─── People & groups ─────────────────────────────────────────────────────────

const sourceLabel = { local: 'Local', ldap: 'LDAP', oidc: 'ADFS' };

export function PeoplePage() {
  const [tab, setTab] = useState('users');
  const [q, setQ] = useState('');
  const users = useUsers(q);
  const groups = useGroups();
  const me = useMe().data!;
  const [group, setGroup] = useState<Group | 'new' | null>(null);
  const update = useSave((v: { id: string; patch: Partial<Pick<User, 'isAdmin' | 'active'>> }) => api.patch(`/api/identity/users/${v.id}`, v.patch), [['users']], 'User updated');

  return (
    <>
      <PageHeader title="People & groups" description="People are provisioned on first sign-in through LDAP or ADFS. Directory groups sync automatically and can be granted access.">
        <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'users', label: 'People', count: users.data?.total }, { value: 'groups', label: 'Groups', count: groups.data?.length }]} />
      </PageHeader>
      <div className="mx-auto w-full max-w-4xl px-6 py-6">
        {tab === 'users' ? (
          <Card padded={false}>
            <div className="border-b border-border p-3">
              <Input placeholder="Search people…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <ul className="divide-y divide-border">
              {(users.data?.items ?? []).map((u) => (
                <Row
                  key={u.id}
                  lead={<Avatar name={u.displayName} size={30} />}
                  title={
                    <span className="flex items-center gap-2">
                      {u.displayName}
                      {!u.active && <Badge tone="danger">Disabled</Badge>}
                      {u.isAdmin && <Badge tone="accent">Admin</Badge>}
                    </span>
                  }
                  subtitle={`${u.email ?? u.username} · ${sourceLabel[u.source]}${u.groups.length ? ` · ${u.groups.map((g) => g.name).join(', ')}` : ''}`}
                  meta={<span className="hidden text-xs text-subtle md:block">{u.lastLoginAt ? `Last seen ${formatDateTime(u.lastLoginAt)}` : 'Never signed in'}</span>}
                  actions={
                    u.id !== me.userId && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: u.id, patch: { isAdmin: !u.isAdmin } })}>
                          {u.isAdmin ? 'Remove admin' : 'Make admin'}
                        </Button>
                        <Button size="sm" variant={u.active ? 'danger-ghost' : 'ghost'} onClick={() => update.mutate({ id: u.id, patch: { active: !u.active } })}>
                          {u.active ? 'Disable' : 'Enable'}
                        </Button>
                      </>
                    )
                  }
                />
              ))}
            </ul>
          </Card>
        ) : (
          <Card padded={false}>
            <div className="flex justify-end border-b border-border p-3">
              <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setGroup('new')}>
                New group
              </Button>
            </div>
            {groups.data?.length ? (
              <ul className="divide-y divide-border">
                {groups.data.map((g) => (
                  <Row
                    key={g.id}
                    lead={
                      <span className="flex size-8 items-center justify-center rounded-lg bg-surface-2 text-muted">
                        <Users className="size-4" />
                      </span>
                    }
                    title={
                      <span className="flex items-center gap-2">
                        {g.name}
                        <Badge>{g.externalId ? (g.source === 'oidc' ? 'ADFS' : 'Directory') : 'Local'}</Badge>
                      </span>
                    }
                    subtitle={g.externalId ?? `${g.memberCount} members`}
                    meta={<span className="text-xs text-subtle">{g.memberCount} members</span>}
                    actions={<Button size="icon" variant="ghost" aria-label="Edit" icon={<Pencil className="size-3.5" />} onClick={() => setGroup(g)} />}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState icon={<Users />} title="No groups" description="Directory groups appear after members sign in. You can also pre-create a group by its DN or ADFS claim value." />
            )}
          </Card>
        )}
      </div>
      {group && <GroupDialog group={group === 'new' ? null : group} onClose={() => setGroup(null)} />}
    </>
  );
}

function GroupDialog({ group, onClose }: { group: Group | null; onClose: () => void }) {
  const [name, setName] = useState(group?.name ?? '');
  const [externalId, setExternalId] = useState(group?.externalId ?? '');
  const members = useGroupMembers(group && !group.externalId ? group.id : null);
  const [memberIds, setMemberIds] = useState<string[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const qc = useQueryClient();
  const current = memberIds ?? members.data?.map((m) => m.id) ?? [];
  const save = useSave(
    async () => {
      const body = { name, externalId: externalId || null };
      const g = group ? await api.put<Group>(`/api/identity/groups/${group.id}`, body) : await api.post<Group>('/api/identity/groups', body);
      if (!body.externalId && memberIds) await api.put(`/api/identity/groups/${g.id}/members`, { userIds: memberIds });
    },
    [keys.groups],
    'Group saved',
    onClose,
  );
  const remove = useSave(() => api.delete(`/api/identity/groups/${group!.id}`), [keys.groups, keys.grants], 'Group deleted', onClose);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={group ? `Edit ${group.name}` : 'New group'}
      footer={
        <>
          {group && (
            <Button variant="danger-ghost" className="mr-auto" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirm(true)}>
              Delete
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!name} onClick={() => save.mutate(undefined)}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Directory identifier" hint="LDAP group DN or ADFS group claim value. Members are then synced at each sign-in.">
          {(id) => <Input id={id} className="font-mono text-xs" placeholder="CN=Procurement,OU=Groups,DC=corp,DC=example" value={externalId} onChange={(e) => setExternalId(e.target.value)} />}
        </Field>
        {!externalId && (
          <Field label="Members">
            {() => (
              <div className="space-y-2">
                <div className="flex gap-1.5">
                  <PersonPicker value={adding} onChange={setAdding} placeholder="Add a person" />
                  <Button
                    disabled={!adding}
                    onClick={() => {
                      if (adding && !current.includes(adding)) setMemberIds([...current, adding]);
                      setAdding(null);
                      void qc.invalidateQueries({ queryKey: ['people'] });
                    }}
                  >
                    Add
                  </Button>
                </div>
                <MemberList ids={current} onRemove={(id) => setMemberIds(current.filter((x) => x !== id))} />
              </div>
            )}
          </Field>
        )}
      </div>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} danger title="Delete group?" description="Its access grants are removed too." confirmLabel="Delete" onConfirm={() => remove.mutate(undefined)} loading={remove.isPending} />
    </Dialog>
  );
}

function MemberList({ ids, onRemove }: { ids: string[]; onRemove: (id: string) => void }) {
  if (!ids.length) return <p className="text-xs text-subtle">No members yet.</p>;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {ids.map((id) => (
        <li key={id} className="flex items-center justify-between px-3 py-1.5 text-[13px]">
          <PersonName id={id} />
          <Button size="icon" variant="ghost" aria-label="Remove" icon={<Trash2 className="size-3.5" />} onClick={() => onRemove(id)} />
        </li>
      ))}
    </ul>
  );
}

// ─── Access ──────────────────────────────────────────────────────────────────

const levelText: Record<GrantLevel, string> = {
  view: 'View assets, dates and documents',
  edit: 'Create and edit assets, upload documents, act on reminders',
  manage: 'Everything, plus delete and restricted fields',
};

export function AccessPage() {
  const grants = useGrants();
  const lookups = useLookups();
  const [adding, setAdding] = useState(false);
  const remove = useSave((id: string) => api.delete(`/api/identity/grants/${id}`), [keys.grants], 'Access removed');

  return (
    <>
      <PageHeader
        title="Access"
        description="Grant people or directory groups a level on a purchase class and/or asset type. The highest matching grant wins. Changes apply within 15 minutes."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Grant access</Button>}
      />
      <div className="mx-auto w-full max-w-4xl space-y-4 px-6 py-6">
        <div className="grid gap-3 sm:grid-cols-3">
          {(Object.keys(levelText) as GrantLevel[]).map((l) => (
            <Card key={l}>
              <Badge tone={l === 'manage' ? 'accent' : 'neutral'}>{l[0]!.toUpperCase() + l.slice(1)}</Badge>
              <p className="mt-2 text-xs text-muted">{levelText[l]}</p>
            </Card>
          ))}
        </div>
        <Card padded={false}>
          {grants.data?.length ? (
            <ul className="divide-y divide-border">
              {grants.data.map((g) => (
                <Row
                  key={g.id}
                  lead={g.principalType === 'user' ? <Avatar name={g.principalName} size={30} /> : <span className="flex size-[30px] items-center justify-center rounded-full bg-surface-2 text-muted"><Users className="size-4" /></span>}
                  title={g.principalName}
                  subtitle={
                    <>
                      {g.purchaseClassId ? lookups.classById.get(g.purchaseClassId)?.name ?? 'Unknown class' : 'All purchase classes'}
                      {' · '}
                      {g.assetTypeId ? lookups.typeById.get(g.assetTypeId)?.name ?? 'Unknown type' : 'All asset types'}
                    </>
                  }
                  meta={<Badge tone={g.level === 'manage' ? 'accent' : 'neutral'}>{g.level}</Badge>}
                  actions={<Button size="icon" variant="danger-ghost" aria-label="Remove" icon={<Trash2 className="size-3.5" />} onClick={() => remove.mutate(g.id)} />}
                />
              ))}
            </ul>
          ) : (
            <EmptyState icon={<Shield />} title="No grants yet" description="Only administrators can see assets until access is granted." />
          )}
        </Card>
      </div>
      {adding && <GrantDialog onClose={() => setAdding(false)} />}
    </>
  );
}

function GrantDialog({ onClose }: { onClose: () => void }) {
  const groups = useGroups();
  const [d, setD] = useState<Omit<GrantInput, 'principalId'> & { principalId: string | null }>({ principalType: 'group', principalId: null, purchaseClassId: null, assetTypeId: null, level: 'view' });
  const save = useSave(() => api.post('/api/identity/grants', d), [keys.grants], 'Access granted', onClose);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Grant access"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!d.principalId} onClick={() => save.mutate(undefined)}>
            Grant
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented value={d.principalType} onChange={(principalType) => setD({ ...d, principalType, principalId: null })} options={[{ value: 'group', label: 'Group' }, { value: 'user', label: 'Person' }]} />
        <Field label={d.principalType === 'group' ? 'Group' : 'Person'}>
          {(id) =>
            d.principalType === 'group' ? (
              <Select id={id} value={d.principalId ?? ''} onChange={(e) => setD({ ...d, principalId: e.target.value || null })}>
                <option value="">Select a group</option>
                {(groups.data ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            ) : (
              <PersonPicker id={id} value={d.principalId} onChange={(principalId) => setD({ ...d, principalId })} />
            )
          }
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Purchase class">{(id) => <PurchaseClassSelect id={id} includeAll value={d.purchaseClassId} onChange={(purchaseClassId) => setD({ ...d, purchaseClassId })} />}</Field>
          <Field label="Asset type">{(id) => <AssetTypeSelect id={id} includeAll value={d.assetTypeId} onChange={(assetTypeId) => setD({ ...d, assetTypeId })} />}</Field>
        </div>
        <Field label="Level" hint={levelText[d.level]}>
          {() => <Segmented value={d.level} onChange={(level) => setD({ ...d, level })} options={[{ value: 'view', label: 'View' }, { value: 'edit', label: 'Edit' }, { value: 'manage', label: 'Manage' }]} />}
        </Field>
      </div>
    </Dialog>
  );
}

// ─── Profile ─────────────────────────────────────────────────────────────────

export function ProfilePage() {
  const me = useMe().data!;
  const qc = useQueryClient();
  const prefs = useSave((p: Partial<typeof me.preferences>) => api.patch('/api/identity/me/preferences', p), [keys.me], 'Preferences saved');
  const rotate = useSave(() => api.post('/api/scheduler/calendar-feed/rotate'), [keys.calendarFeed], 'New calendar link created; the old one stops working');
  const [feedUrl, setFeedUrl] = useState<string | null>(null);
  const lookups = useLookups();

  return (
    <>
      <PageHeader title="Profile & notifications" icon={<Avatar name={me.displayName} size={40} />} description={me.email ?? me.username} />
      <div className="mx-auto w-full max-w-2xl space-y-6 px-6 py-6">
        <Card className="space-y-4">
          <h2 className="text-[13px] font-semibold">Notifications</h2>
          <Switch
            checked={me.preferences.emailReminders}
            onChange={(emailReminders) => (qc.setQueryData(keys.me, { ...me, preferences: { ...me.preferences, emailReminders } }), prefs.mutate({ emailReminders }))}
            label="Email reminders"
            description="A digest when renewals, deadlines or expiries you own are coming up"
          />
          <Switch
            checked={me.preferences.outlookInvites}
            onChange={(outlookInvites) => (qc.setQueryData(keys.me, { ...me, preferences: { ...me.preferences, outlookInvites } }), prefs.mutate({ outlookInvites }))}
            label="Outlook calendar invites"
            description="All-day entries on your calendar that move or cancel when the date changes"
          />
        </Card>
        <Card className="space-y-3">
          <h2 className="text-[13px] font-semibold">Calendar subscription</h2>
          <p className="text-xs text-muted">Subscribe in Outlook (Add calendar → Subscribe from web) to see every item you own or are a contact for. Treat the link like a password.</p>
          {feedUrl ? (
            <Input readOnly value={feedUrl} onFocus={(e) => e.target.select()} className="font-mono text-xs" />
          ) : (
            <Button icon={<CalendarDays className="size-3.5" />} onClick={async () => setFeedUrl((await api.get<{ url: string }>('/api/scheduler/calendar-feed')).url)}>
              Show my calendar link
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<RefreshCcw className="size-3.5" />} loading={rotate.isPending} onClick={() => rotate.mutate(undefined, { onSuccess: () => setFeedUrl(null) })}>
            Reset link
          </Button>
        </Card>
        <Card className="space-y-3">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold">
            <KeyRound className="size-4 text-muted" /> Your access
          </h2>
          {me.isAdmin ? (
            <p className="text-xs text-muted">You are an administrator and can manage everything.</p>
          ) : me.grants.length ? (
            <ul className="space-y-1.5 text-[13px]">
              {me.grants.map((g, i) => (
                <li key={i} className="flex items-center justify-between">
                  <span>
                    {g.purchaseClassId ? lookups.classById.get(g.purchaseClassId)?.name : 'All purchase classes'} · {g.assetTypeId ? lookups.typeById.get(g.assetTypeId)?.name : 'All asset types'}
                  </span>
                  <Badge>{g.level}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">You don’t have access to any assets yet. Ask an administrator.</p>
          )}
        </Card>
      </div>
    </>
  );
}
