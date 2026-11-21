import {
  validateWorkflow,
  type Workflow,
  dateBehaviors,
  type DateBehavior,
  type DateKind,
  type DateKindInput,
  roleKeys,
  roles,
  type Group,
  type SignedInSession,
  type User,
} from '@am/core';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { Bot, Building2, CalendarDays, KeyRound, Monitor, Smartphone, MoreHorizontal, Pencil, Plus, RefreshCcw, Trash2, UserX, Users } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { accessLabel } from '@/components/access';
import { LanguageSetting } from '@/components/language';
import { GrantsEditor } from '@/components/access-grants';
import { DurationInput, DurationListEditor } from '@/components/duration-editor';
import { ColorPicker, PersonName, PersonPicker, UnitPath, UnitPicker } from '@/components/pickers';
import { Button } from '@/components/ui/button';
import { Avatar, Badge, Card, EmptyState, PageHeader, Spinner, Tabs } from '@/components/ui/display';
import { WorkflowEditor } from '@/components/workflow-editor';
import { Field, Input, Segmented, Switch } from '@/components/ui/form';
import { ConfirmDialog, Dialog, Menu, MenuItem } from '@/components/ui/overlay';
import { useMediaQuery } from '@/lib/hooks';
import { api, ApiError } from '@/lib/api';
import { keys, useOrgWorkflow, usePurchaseUnit, useDateKinds, useGroupMembers, useGroups, useLookups, useMe, useProviders, useUsers } from '@/lib/queries';
import { useMyOrg } from '@/lib/org';
import { formatDateTime, formatDurations, slugKey } from '@/lib/utils';
import { intlLocale, plural, t, tMaybe } from '@/lib/i18n';

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
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('Something went wrong')),
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
  recurring: t('Repeats — completing it rolls the date forward'),
  milestone: t('One-off — completing it closes the item'),
  informational: t('Shown for context; never reminds'),
};

const behaviorLabel: Record<DateBehavior, string> = {
  recurring: t('Recurring'),
  milestone: t('Milestone'),
  informational: t('Informational'),
};

export function DateKindsPage() {
  const kinds = useDateKinds();
  const [editing, setEditing] = useState<DateKind | 'new' | null>(null);
  return (
    <>
      <PageHeader
        title={t('Date kinds')}
        description={t('The meanings a date field can have. Templates pick one per date; reminders and actions follow from it.')}
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>{t('New date kind')}</Button>}
      />
      <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 py-6">
        <Card padded={false}>
          <ul className="divide-y divide-border">
            {(kinds.data ?? []).map((k) => (
              <Row
                key={k.id}
                lead={<Dot color={k.color} />}
                title={
                  <span className="flex items-center gap-2">
                    {tMaybe(k.name)}
                    {k.archived && <Badge>{t('Archived')}</Badge>}
                  </span>
                }
                subtitle={`${behaviorText[k.behavior]}${k.behavior !== 'informational' ? ` · ${formatDurations(k.defaultReminders)}` : ''}`}
                meta={<Badge tone="accent">{tMaybe(k.actionLabel)}</Badge>}
                actions={<Button size="icon" variant="ghost" aria-label={t('Edit')} icon={<Pencil className="size-3.5" />} onClick={() => setEditing(k)} />}
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
    kind ?? { key: '', name: '', color: '#6366f1', behavior: 'milestone', actionLabel: t('Complete'), defaultReminders: [{ amount: 30, unit: 'day' }, { amount: 7, unit: 'day' }], archived: false },
  );
  const save = useSave(() => (kind ? api.put(`/api/registry/date-kinds/${kind.id}`, d) : api.post('/api/registry/date-kinds', d)), [keys.dateKinds], kind ? t('Date kind saved') : t('Date kind created'), onClose);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={kind ? t('Edit {name}', { name: tMaybe(kind.name) }) : t('New date kind')}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!d.name} onClick={() => save.mutate(undefined)}>
            {t('Save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Name')} required>
            {(id) => <Input id={id} value={d.name} placeholder={t('e.g. Audit due')} onChange={(e) => setD({ ...d, name: e.target.value, ...(!kind && { key: slugKey(e.target.value) }) })} />}
          </Field>
          <Field label={t('Action label')} hint={t('Button text, e.g. Renew, Pay')}>
            {(id) => <Input id={id} value={d.actionLabel} onChange={(e) => setD({ ...d, actionLabel: e.target.value })} />}
          </Field>
        </div>
        <Field label={t('Behaviour')} hint={behaviorText[d.behavior]}>
          {() => <Segmented value={d.behavior} onChange={(behavior) => setD({ ...d, behavior, ...(behavior === 'recurring' && !d.defaultRecurrence && { defaultRecurrence: { amount: 1, unit: 'year' } }) })} options={dateBehaviors.map((b) => ({ value: b, label: behaviorLabel[b] }))} />}
        </Field>
        {d.behavior === 'recurring' && <Field label={t('Repeats every')}>{(id) => <DurationInput id={id} value={d.defaultRecurrence ?? { amount: 1, unit: 'year' }} onChange={(defaultRecurrence) => setD({ ...d, defaultRecurrence })} />}</Field>}
        {d.behavior !== 'informational' && <Field label={t('Default reminders')}>{() => <DurationListEditor value={d.defaultReminders} onChange={(defaultReminders) => setD({ ...d, defaultReminders })} />}</Field>}
        <Field label={t('Color')}>{() => <ColorPicker value={d.color} onChange={(color) => setD({ ...d, color })} />}</Field>
        {kind && <Switch checked={d.archived} onChange={(archived) => setD({ ...d, archived })} label={t('Archived')} description={t('Hidden from the template builder; existing dates keep working')} />}
      </div>
    </Dialog>
  );
}

// ─── Request workflow ────────────────────────────────────────────────────────

export function WorkflowsPage() {
  const saved = useOrgWorkflow();
  const [draft, setDraft] = useState<Workflow | null>(null);
  const wf = draft ?? saved.data;
  const save = useSave(() => api.put<Workflow>('/api/registry/workflows/default', wf), [keys.workflow, keys.requests], t('Workflow saved'), () => setDraft(null));
  return (
    <>
      <PageHeader
        title={t('Request workflow')}
        description={t('The statuses purchase and renewal requests go through, and who moves them. Templates can have their own, and add more workflows (Templates → a template → Workflows).')}
        actions={
          draft && (
            <>
              <Button onClick={() => setDraft(null)}>{t('Discard')}</Button>
              <Button variant="primary" loading={save.isPending} disabled={validateWorkflow(draft).length > 0} onClick={() => save.mutate(undefined)}>
                {t('Save workflow')}
              </Button>
            </>
          )
        }
      />
      <div className="mx-auto w-full max-w-4xl space-y-6 px-4 sm:px-6 py-6">
        <PurchaseUnitCard />
        {wf ? <WorkflowEditor value={wf} onChange={setDraft} lockedKeys={saved.data?.statuses.map((s) => s.key)} /> : <Spinner />}
      </div>
    </>
  );
}

/** The unit responsible for purchases: its members handle every request, and requests show it next to the purchase status. */
function PurchaseUnitCard() {
  const unit = usePurchaseUnit();
  const save = useSave((unitId: string | null) => api.put('/api/registry/workflows/purchase-unit', { unitId }), [keys.purchaseUnit, keys.requests], t('Saved'));
  return (
    <Card className="space-y-2">
      <Field label={t('Responsible for purchases')} hint={t('Its members handle every purchase and renewal request, besides people who may renew items. Templates and team variants can add workflows with their own responsible unit.')}>
        {(id) => <UnitPicker id={id} value={unit.data?.unitId ?? null} onChange={(v) => save.mutate(v)} allowClear clearLabel={t('No one unit (people who may renew items)')} placeholder={t('No one unit (people who may renew items)')} />}
      </Field>
    </Card>
  );
}

// ─── People & groups ─────────────────────────────────────────────────────────

const sourceLabel = { local: t('Local'), ldap: 'LDAP', oidc: 'ADFS' };

export function PeoplePage() {
  const [tab, setTab] = useState('users');
  const [q, setQ] = useState('');
  const users = useUsers(q);
  const groups = useGroups();
  const me = useMe().data!;
  const [group, setGroup] = useState<Group | 'new' | null>(null);
  const phone = useMediaQuery('(max-width: 639px)');
  const providers = useProviders();
  // Manual accounts (passwords kept here) are on when the "local" sign-in method is.
  const manual = !!providers.data?.some((p) => p.id === 'local');
  const directory = !!providers.data?.some((p) => p.id === 'ldap' || p.id === 'oidc');
  // With Google sign-in, people are added here by email (Google accounts are never created on their own).
  const google = !!providers.data?.some((p) => p.id === 'google');
  const [adding, setAdding] = useState(false);
  const [settingPassword, setSettingPassword] = useState<User | null>(null);
  const update = useSave((v: { id: string; patch: Partial<Pick<User, 'isAdmin' | 'active'>> }) => api.patch(`/api/identity/users/${v.id}`, v.patch), [['users']], t('User updated'));

  return (
    <>
      <PageHeader
        title={t('People & groups')}
        description={
          google && !directory
            ? t('Add the people who use Assets with their Google email. Groups gather people for access.')
            : manual && !directory
            ? t('Add the people who use Assets; each gets a sign-in name and a password you give them. Groups gather people for access.')
            : manual
              ? t('People from the company directory appear on first sign-in; you can also add people with their own password here. Directory groups sync automatically.')
              : t('People are provisioned on first sign-in through LDAP or ADFS. Directory groups sync automatically and can be granted access.')
        }
        actions={
          (manual || google) && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
              {t('Add person')}
            </Button>
          )
        }
      >
        <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'users', label: t('People'), count: users.data?.total }, { value: 'groups', label: t('Groups'), count: groups.data?.length }]} />
      </PageHeader>
      <div className="mx-auto w-full max-w-4xl px-4 sm:px-6 py-6">
        {tab === 'users' ? (
          <Card padded={false}>
            <div className="border-b border-border p-3">
              <Input placeholder={t('Search people…')} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <ul className="divide-y divide-border">
              {(users.data?.items ?? []).map((u) => (
                <Row
                  key={u.id}
                  lead={<Avatar name={u.displayName} size={30} />}
                  title={
                    <span className="flex items-center gap-2">
                      {u.displayName}
                      {!u.active && <Badge tone="danger">{t('Disabled')}</Badge>}
                      {u.isAdmin && <Badge tone="accent">{t('Admin')}</Badge>}
                    </span>
                  }
                  subtitle={`${u.email ?? u.username} · ${sourceLabel[u.source]}${u.groups.length ? ` · ${u.groups.map((g) => g.name).join(', ')}` : ''}`}
                  meta={<span className="hidden text-xs text-subtle md:block">{u.lastLoginAt ? t('Last seen {when}', { when: formatDateTime(u.lastLoginAt) }) : t('Never signed in')}</span>}
                  actions={
                    u.id !== me.userId && (
                      phone ? (
                        <Menu trigger={<Button size="icon" variant="ghost" aria-label={t('Actions for {name}', { name: u.displayName })} icon={<MoreHorizontal className="size-4" />} />}>
                          <MenuItem icon={<KeyRound />} onSelect={() => update.mutate({ id: u.id, patch: { isAdmin: !u.isAdmin } })}>
                            {u.isAdmin ? t('Remove admin') : t('Make admin')}
                          </MenuItem>
                          {u.source === 'local' && (
                            <MenuItem icon={<KeyRound />} onSelect={() => setSettingPassword(u)}>
                              {t('Set password')}
                            </MenuItem>
                          )}
                          <MenuItem icon={<UserX />} danger={u.active} onSelect={() => update.mutate({ id: u.id, patch: { active: !u.active } })}>
                            {u.active ? t('Disable') : t('Enable')}
                          </MenuItem>
                        </Menu>
                      ) : (
                        <>
                          {u.source === 'local' && (
                            <Button size="sm" variant="ghost" onClick={() => setSettingPassword(u)}>
                              {t('Set password')}
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: u.id, patch: { isAdmin: !u.isAdmin } })}>
                            {u.isAdmin ? t('Remove admin') : t('Make admin')}
                          </Button>
                          <Button size="sm" variant={u.active ? 'danger-ghost' : 'ghost'} onClick={() => update.mutate({ id: u.id, patch: { active: !u.active } })}>
                            {u.active ? t('Disable') : t('Enable')}
                          </Button>
                        </>
                      )
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
                {t('New group')}
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
                        <Badge>{g.externalId ? (g.source === 'oidc' ? 'ADFS' : t('Directory')) : t('Local')}</Badge>
                      </span>
                    }
                    subtitle={g.externalId ?? plural(g.memberCount, '{n} member', '{n} members')}
                    meta={<span className="text-xs text-subtle">{plural(g.memberCount, '{n} member', '{n} members')}</span>}
                    actions={<Button size="icon" variant="ghost" aria-label={t('Edit')} icon={<Pencil className="size-3.5" />} onClick={() => setGroup(g)} />}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState icon={<Users />} title={t('No groups')} description={t('Directory groups appear after members sign in. You can also pre-create a group by its DN or ADFS claim value.')} />
            )}
          </Card>
        )}
      </div>
      {group && <GroupDialog group={group === 'new' ? null : group} onClose={() => setGroup(null)} />}
      <AddPersonDialog open={adding} onOpenChange={setAdding} google={google} passwords={manual} />
      <SetPasswordDialog user={settingPassword} onClose={() => setSettingPassword(null)} />
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
    t('Group saved'),
    onClose,
  );
  const remove = useSave(() => api.delete(`/api/identity/groups/${group!.id}`), [keys.groups], t('Group deleted'), onClose);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={group ? t('Edit {name}', { name: group.name }) : t('New group')}
      footer={
        <>
          {group && (
            <Button variant="danger-ghost" className="me-auto" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirm(true)}>
              {t('Delete')}
            </Button>
          )}
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!name} onClick={() => save.mutate(undefined)}>
            {t('Save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('Name')} required>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label={t('Directory identifier')} hint={t('LDAP group DN or ADFS group claim value. Members are then synced at each sign-in.')}>
          {(id) => <Input id={id} className="font-mono text-xs" placeholder="CN=Procurement,OU=Groups,DC=corp,DC=example" value={externalId} onChange={(e) => setExternalId(e.target.value)} />}
        </Field>
        {!externalId && (
          <Field label={t('Members')}>
            {() => (
              <div className="space-y-2">
                <div className="flex gap-1.5">
                  <PersonPicker value={adding} onChange={setAdding} placeholder={t('Add a person')} />
                  <Button
                    disabled={!adding}
                    onClick={() => {
                      if (adding && !current.includes(adding)) setMemberIds([...current, adding]);
                      setAdding(null);
                      void qc.invalidateQueries({ queryKey: ['people'] });
                    }}
                  >
                    {t('Add')}
                  </Button>
                </div>
                <MemberList ids={current} onRemove={(id) => setMemberIds(current.filter((x) => x !== id))} />
              </div>
            )}
          </Field>
        )}
      </div>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} danger title={t('Delete group?')} description={t('Its access grants are removed too.')} confirmLabel={t('Delete')} onConfirm={() => remove.mutate(undefined)} loading={remove.isPending} />
    </Dialog>
  );
}

function MemberList({ ids, onRemove }: { ids: string[]; onRemove: (id: string) => void }) {
  if (!ids.length) return <p className="text-xs text-subtle">{t('No members yet.')}</p>;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {ids.map((id) => (
        <li key={id} className="flex items-center justify-between px-3 py-1.5 text-[13px]">
          <PersonName id={id} />
          <Button size="icon" variant="ghost" aria-label={t('Remove')} icon={<Trash2 className="size-3.5" />} onClick={() => onRemove(id)} />
        </li>
      ))}
    </ul>
  );
}

// ─── Access ──────────────────────────────────────────────────────────────────


export function AccessPage() {
  return (
    <>
      <PageHeader
        title={t('Access')}
        description={t('Most access comes from the organization chart: members get their unit’s default role, managers are Admins of everything beneath their unit. Add access here for what spans the whole company — e.g. Procurement as Admin, Finance as Viewer. Access adds up; changes apply within 15 minutes.')}
      />
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6">
        {/* The roles, as a legend: compact rows on phones (after the list), cards above it on wider screens. */}
        <Card padded={false} className="order-last divide-y divide-border sm:hidden">
          {roleKeys.map((r) => (
            <div key={r} className="flex items-baseline gap-3 px-4 py-2.5">
              <Badge tone={r === 'admin' ? 'accent' : 'neutral'} className="w-24 shrink-0 justify-center">
                {tMaybe(roles[r].label)}
              </Badge>
              <p className="text-xs text-muted">{tMaybe(roles[r].description)}</p>
            </div>
          ))}
        </Card>
        <div className="hidden gap-3 sm:grid sm:grid-cols-5">
          {roleKeys.map((r) => (
            <Card key={r}>
              <Badge tone={r === 'admin' ? 'accent' : 'neutral'}>{tMaybe(roles[r].label)}</Badge>
              <p className="mt-2 text-xs text-muted">{tMaybe(roles[r].description)}</p>
            </Card>
          ))}
        </div>
        <section>
          <h2 className="mb-1 text-[13px] font-semibold">{t('The whole organization')}</h2>
          <p className="mb-3 text-xs text-muted">{t('For a single unit, use the Access tab on its page.')}</p>
          <GrantsEditor unitId={null} />
        </section>
      </div>
    </>
  );
}
export function ProfilePage() {
  const me = useMe().data!;
  const qc = useQueryClient();
  const prefs = useSave((p: Partial<typeof me.preferences>) => api.patch('/api/identity/me/preferences', p), [keys.me], t('Preferences saved'));
  const rotate = useSave(() => api.post('/api/scheduler/calendar-feed/rotate'), [keys.calendarFeed], t('New calendar link created; the old one stops working'));
  const [feedUrl, setFeedUrl] = useState<string | null>(null);
  const lookups = useLookups();

  return (
    <>
      <PageHeader title={t('Profile & notifications')} icon={<Avatar name={me.displayName} size={40} />} description={me.email ?? me.username} />
      <div className="mx-auto w-full max-w-2xl space-y-6 px-4 sm:px-6 py-6">
        <Card>
          <LanguageSetting />
        </Card>
        <Card className="space-y-4">
          <h2 className="text-[13px] font-semibold">{t('Notifications')}</h2>
          <Switch
            checked={me.preferences.emailReminders}
            onChange={(emailReminders) => (qc.setQueryData(keys.me, { ...me, preferences: { ...me.preferences, emailReminders } }), prefs.mutate({ emailReminders }))}
            label={t('Email reminders')}
            description={t('A digest when renewals, deadlines or expiries you own are coming up')}
          />
          <Switch
            checked={me.preferences.outlookInvites}
            onChange={(outlookInvites) => (qc.setQueryData(keys.me, { ...me, preferences: { ...me.preferences, outlookInvites } }), prefs.mutate({ outlookInvites }))}
            label={t('Outlook calendar invites')}
            description={t('All-day entries on your calendar that move or cancel when the date changes')}
          />
        </Card>
        <Card className="space-y-3">
          <h2 className="text-[13px] font-semibold">{t('Calendar subscription')}</h2>
          <p className="text-xs text-muted">{t('Subscribe in Outlook (Add calendar → Subscribe from web) to see every item you own or are a contact for. Treat the link like a password.')}</p>
          {feedUrl ? (
            <Input readOnly value={feedUrl} onFocus={(e) => e.target.select()} className="font-mono text-xs" />
          ) : (
            <Button icon={<CalendarDays className="size-3.5" />} onClick={async () => setFeedUrl((await api.get<{ url: string }>('/api/scheduler/calendar-feed')).url)}>
              {t('Show my calendar link')}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<RefreshCcw className="size-3.5" />} loading={rotate.isPending} onClick={() => rotate.mutate(undefined, { onSuccess: () => setFeedUrl(null) })}>
            {t('Reset link')}
          </Button>
        </Card>
        <MyTeams />
        <Card className="space-y-3">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold">
            <KeyRound className="size-4 text-muted" /> {t('Your access')}
          </h2>
          {me.isAdmin ? (
            <p className="text-xs text-muted">{t('You are an administrator and can manage everything.')}</p>
          ) : me.grants.length ? (
            <ul className="space-y-1.5 text-[13px]">
              {me.grants.map((g, i) => (
                <li key={i} className="flex items-center justify-between">
                  <span>
                    {g.unitId ? lookups.unitPathNames(g.unitId).join(' › ') : t('Whole organization')} · {g.assetTypeId ? lookups.typeById.get(g.assetTypeId)?.name : t('All asset types')}
                  </span>
                  <Badge>{accessLabel(g.permissions)}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">{t('You don’t have access to any assets yet. Ask an administrator.')}</p>
          )}
        </Card>
        {/* Security last: everyday settings first. */}
        <SignedInDevices />
        {me.source === 'local' && <ChangePassword />}
      </div>
    </>
  );
}

function MyTeams() {
  const { mine } = useMyOrg();
  return (
    <Card className="space-y-3">
      <h2 className="flex items-center gap-2 text-[13px] font-semibold">
        <Building2 className="size-4 text-muted" /> {t('Your teams')}
      </h2>
      {mine.length ? (
        <ul className="space-y-1.5 text-[13px]">
          {mine.map(({ unit, role }) => (
            <li key={`${unit.id}-${role}`} className="flex items-center justify-between gap-2">
              <Link to="/units/$unitId" params={{ unitId: unit.id }} className="min-w-0 hover:underline">
                <UnitPath id={unit.id} />
              </Link>
              <Badge tone={role === 'manager' ? 'accent' : 'neutral'}>{role === 'manager' ? t('Manager') : t('Member')}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">{t('You aren’t in any team yet. Teams come from your directory groups when you sign in; an administrator can also add you.')}</p>
      )}
    </Card>
  );
}

/**
 * An admin adds someone with a manual account: a sign-in name and a first password to pass on.
 * With Google sign-in, their Google email is enough and the password is optional.
 */
function AddPersonDialog({ open, onOpenChange, google, passwords }: { open: boolean; onOpenChange: (o: boolean) => void; google: boolean; passwords: boolean }) {
  const blank = { displayName: '', username: '', email: '', password: '', isAdmin: false };
  const [form, setForm] = useState(blank);
  const [touchedUsername, setTouchedUsername] = useState(false);
  const create = useSave(
    () => api.post('/api/identity/users', { displayName: form.displayName.trim(), username: form.username.trim(), email: form.email.trim() || null, password: form.password || null, isAdmin: form.isAdmin }),
    [['users']],
    form.displayName ? t('{name} added', { name: form.displayName }) : t('Person added'),
    () => {
      onOpenChange(false);
      setForm(blank);
      setTouchedUsername(false);
    },
  );
  const suggestUsername = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());
  const passwordOk = google ? !form.password || form.password.length >= 12 : form.password.length >= 12;
  const ok = form.displayName.trim() && /^[a-zA-Z0-9._-]{2,64}$/.test(form.username) && passwordOk && (!google || email);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('Add a person')}
      description={google ? t('They sign in with Google at this email.') : t('They sign in with this name and password, and can change the password on their profile.')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!ok} loading={create.isPending} onClick={() => create.mutate(undefined)}>
            {t('Add person')}
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) create.mutate(undefined);
        }}
      >
        <Field label={t('Name')} required className="sm:col-span-2">
          {(id) => <Input id={id} value={form.displayName} placeholder={t('e.g. Dana Cohen')} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value, ...(!touchedUsername && { username: suggestUsername(e.target.value) }) }))} />}
        </Field>
        <Field label={t('Sign-in name')} required hint={t('Letters, digits, dots, dashes')}>
          {(id) => <Input id={id} value={form.username} autoComplete="off" onChange={(e) => (setTouchedUsername(true), setForm((f) => ({ ...f, username: e.target.value })))} />}
        </Field>
        <Field label={t('Email')} required={google} hint={google ? t('Their Google address; also for reminders') : t('For reminders')}>
          {(id) => <Input id={id} type="email" value={form.email} placeholder="dana@company.com" onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />}
        </Field>
        {passwords && (
          <Field label={t('First password')} required={!google} hint={google ? t('Optional: to sign in without Google. At least 12 characters') : t('At least 12 characters; they can change it')} className="sm:col-span-2">
            {(id) => <PasswordInput id={id} value={form.password} onChange={(password) => setForm((f) => ({ ...f, password }))} />}
          </Field>
        )}
        <div className="sm:col-span-2">
          <Switch checked={form.isAdmin} onChange={(isAdmin) => setForm((f) => ({ ...f, isAdmin }))} label={t('Administrator')} description={t('Full control: templates, the organization, access and every item')} />
        </div>
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}

/** An admin sets a new password for someone with a manual account (e.g. a forgotten one); they are signed out everywhere. */
function SetPasswordDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const save = useSave((_: void) => api.put(`/api/identity/users/${user!.id}/password`, { password }), [], user ? t('New password set for {name}', { name: user.displayName }) : t('New password set'), () => {
    setPassword('');
    onClose();
  });
  return (
    <Dialog
      open={!!user}
      onOpenChange={(o) => !o && onClose()}
      title={t('Set a password for {name}', { name: user?.displayName ?? '' })}
      description={t('They are signed out everywhere and sign in again with the new password. Pass it on privately.')}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={password.length < 12} loading={save.isPending} onClick={() => save.mutate()}>
            {t('Set password')}
          </Button>
        </>
      }
    >
      <Field label={t('New password')} hint={t('At least 12 characters')}>
        {(id) => <PasswordInput id={id} value={password} onChange={setPassword} />}
      </Field>
    </Dialog>
  );
}

/** On the profile, for manual accounts. */
/** "just now", "5 min ago", "3 h ago", "yesterday", then a date (in the page's language). */
function ago(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  const rel = new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto', style: 'short' });
  if (min < 2) return t('just now');
  if (min < 60) return rel.format(-min, 'minute');
  if (min < 24 * 60) return rel.format(-Math.round(min / 60), 'hour');
  if (min < 48 * 60) return rel.format(-1, 'day');
  return new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium' }).format(new Date(iso));
}

/** "Chrome on macOS" from a user agent; connected apps keep their own name. */
function deviceName(s: SignedInSession): string {
  if (s.connectedApp) return s.userAgent!.replace(/ \(connected app\)$/, '');
  const ua = s.userAgent ?? '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null;
  return browser && os ? t('{browser} on {os}', { browser, os }) : browser ?? os ?? t('A browser');
}

/** Browsers and connected apps (AI assistants via MCP) signed in as this person; each can be signed out. */
function SignedInDevices() {
  const sessions = useQuery({ queryKey: ['my-sessions'], queryFn: () => api.get<SignedInSession[]>('/api/identity/me/sessions') });
  const end = useSave((id: string) => api.delete(`/api/identity/me/sessions/${id}`), [['my-sessions']], t('Signed out'));
  const list = sessions.data ?? [];
  const apps = list.filter((s) => s.connectedApp);
  const allBrowsers = list.filter((s) => !s.connectedApp);
  const [showAll, setShowAll] = useState(false);
  const browsers = showAll ? allBrowsers : allBrowsers.slice(0, 4);
  const row = (s: SignedInSession) => (
    <li key={s.id} className="flex items-center gap-3 py-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
        {s.connectedApp ? <Bot className="size-4" /> : /iPhone|iPad|Android/.test(s.userAgent ?? '') ? <Smartphone className="size-4" /> : <Monitor className="size-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{deviceName(s)}</p>
        <p className="truncate text-xs text-muted" title={s.connectedApp ? t('Connected {when}', { when: formatDateTime(s.createdAt) }) : t('Signed in {when}', { when: formatDateTime(s.createdAt) })}>
          {t('Last used {when}', { when: ago(s.lastUsedAt) })}
        </p>
      </div>
      <Button size="sm" variant="ghost" disabled={end.isPending} onClick={() => end.mutate(s.id)}>
        {s.connectedApp ? t('Disconnect') : t('Sign out')}
      </Button>
    </li>
  );
  return (
    <Card className="space-y-2">
      <h2 className="text-[13px] font-semibold">{t('Signed-in devices')}</h2>
      <p className="text-xs text-muted">{t('Browsers and connected apps (such as AI assistants using MCP) that can act as you. Signing one out takes effect within the hour.')}</p>
      {sessions.isPending ? (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      ) : (
        <>
          {!!apps.length && (
            <div>
              <h3 className="pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{t('Connected apps')}</h3>
              <ul className="divide-y divide-border">{apps.map(row)}</ul>
            </div>
          )}
          <div>
            {!!apps.length && <h3 className="pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{t('Browsers')}</h3>}
            <ul className="divide-y divide-border">{browsers.map(row)}</ul>
            {allBrowsers.length > browsers.length && (
              <button type="button" className="pt-1 text-xs font-medium text-accent hover:underline" onClick={() => setShowAll(true)}>
                {t('Show all {count}', { count: allBrowsers.length })}
              </button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const save = useSave((_: void) => api.post('/api/identity/me/password', { current, password: next }), [], t('Password changed'), () => {
    setCurrent('');
    setNext('');
  });
  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-[13px] font-semibold">{t('Password')}</h2>
        <p className="text-xs text-muted">{t('Your account’s password is kept by Assets. Use at least 12 characters.')}</p>
      </div>
      <form
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (current && next.length >= 12) save.mutate();
        }}
      >
        <Field label={t('Current password')}>{(id) => <PasswordInput id={id} value={current} autoComplete="current-password" onChange={setCurrent} />}</Field>
        <Field label={t('New password')}>{(id) => <PasswordInput id={id} value={next} autoComplete="new-password" onChange={setNext} />}</Field>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={!current || next.length < 12} loading={save.isPending}>
            {t('Change password')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** A password field with a show/hide toggle. */
function PasswordInput({ id, value, onChange, autoComplete = 'new-password' }: { id: string; value: string; onChange: (v: string) => void; autoComplete?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input id={id} type={shown ? 'text' : 'password'} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} className="pe-16" />
      <button type="button" onClick={() => setShown((x) => !x)} className="absolute top-1/2 end-2 -translate-y-1/2 rounded px-1.5 text-xs text-accent-fg">
        {shown ? t('Hide') : t('Show')}
      </button>
    </div>
  );
}
