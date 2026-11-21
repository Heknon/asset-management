import { memberRoles, roles, type DirectoryApplyResult, type DirectoryPreview, type MemberRole, type OrgImportResult, type OrgRule, type OrgUnit, type OrgUnitInput } from '@am/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Building2, ChevronDown, ChevronRight, FileUp, FolderTree, MoreHorizontal, Plus, RefreshCcw, Search, UserRound, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ColorPicker, UnitPicker } from '@/components/pickers';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Segmented, Switch, TagInput, Textarea, type TagSuggestion } from '@/components/ui/form';
import { Dialog, Drawer, Menu, MenuItem } from '@/components/ui/overlay';
import { useMediaQuery } from '@/lib/hooks';
import { api, ApiError } from '@/lib/api';
import { useQuery } from '@tanstack/react-query';
import { keys, useLookups, useProviders, useUnitPeople } from '@/lib/queries';
import { PeopleTab } from './unit';
import { Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/display';
import { plural, t, tMaybe } from '@/lib/i18n';
import { cn, slugKey } from '@/lib/utils';

// Suggested level names; a unit's level is free text, stored as typed.
const LEVELS = [t('Company'), t('Division'), t('Department'), t('Team'), t('Squad'), t('Project'), t('Client')];

const memberRoleText = (r: MemberRole) => (r === 'none' ? t('Members get no access from membership alone (use the Access tab).') : r === 'viewer' ? t('{description}. Recommended.', { description: tMaybe(roles[r].description) }) : t('{description}.', { description: tMaybe(roles[r].description) }));

/**
 * The org chart: divisions, departments and teams, each linked to directory
 * groups (or attributes such as department=Platform) so membership follows
 * LDAP / ADFS automatically.
 */
export function OrganizationPage() {
  const { units, unitById, childrenOf } = useLookups();
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [readingDirectory, setReadingDirectory] = useState(false);
  const directoryImport = useQuery({ queryKey: ['directory-import'], queryFn: () => api.get<{ available: boolean }>('/api/identity/directory/import'), staleTime: 300_000 });
  const [newParent, setNewParent] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    // Desktop shows the editor beside the tree; smaller screens open it when a unit is picked.
    if (selected === null && units.length && matchMedia('(min-width: 1024px)').matches) setSelected(units.find((u) => !u.parentId)?.id ?? null);
    // Expand the first two levels on first load.
    if (!expanded.size && units.length) setExpanded(new Set(units.filter((u) => u.path.length <= 1).map((u) => u.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units.length]);

  const republish = useMutation({
    mutationFn: () => api.post<{ units: number }>('/api/identity/units/republish'),
    onSuccess: (r) => toast.success(plural(r.units, 'Re-sent {n} unit to all services', 'Re-sent {n} units to all services')),
  });

  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matching = useMemo(() => {
    if (!terms.length) return null;
    const hits = units.filter((u) => terms.every((term) => u.name.toLowerCase().includes(term) || u.directoryMembers.some((d) => d.toLowerCase().includes(term))));
    return new Set(hits.flatMap((u) => u.path));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, units]);

  const roots = childrenOf(null);
  const toggle = (id: string) => setExpanded((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));

  const Node = ({ unit, depth }: { unit: OrgUnit; depth: number }) => {
    const kids = childrenOf(unit.id).filter((k) => !matching || matching.has(k.id));
    const open = matching ? true : expanded.has(unit.id);
    return (
      <li>
        <div
          className={cn('group flex h-8 cursor-pointer items-center gap-1 rounded-md pe-1 text-[13px] transition-colors', selected === unit.id ? 'bg-accent-soft text-fg' : 'hover:bg-surface-2', unit.archived && 'opacity-50')}
          style={{ paddingInlineStart: depth * 16 + 4 }}
          onClick={() => setSelected(unit.id)}
        >
          <button type="button" aria-label={open ? t('Collapse') : t('Expand')} className={cn('flex size-5 items-center justify-center rounded text-subtle hover:bg-surface-3', !kids.length && 'invisible')} onClick={(e) => (e.stopPropagation(), toggle(unit.id))}>
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          <span className="size-2 shrink-0 rounded-full" style={{ background: unit.color }} />
          <span className="min-w-0 flex-1 truncate font-medium">{unit.name}</span>
          <span className="text-[11px] text-subtle">{tMaybe(unit.kind)}</span>
          {unit.memberCount > 0 && (
            <span className="flex items-center gap-0.5 text-[11px] text-subtle">
              <Users className="size-3" />
              {unit.memberCount}
            </span>
          )}
          <button
            type="button"
            aria-label={t('Add sub-unit')}
            className="rounded p-0.5 text-subtle opacity-0 group-hover:opacity-100 touch:opacity-100 hover:bg-surface-3 hover:text-fg"
            onClick={(e) => {
              e.stopPropagation();
              setNewParent(unit.id);
              setSelected('new');
              setExpanded((s) => new Set([...s, unit.id]));
            }}
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        {open && kids.length > 0 && (
          <ul>
            {kids.map((k) => (
              <Node key={k.id} unit={k} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    );
  };

  const wide = useMediaQuery('(min-width: 1024px)');
  const editor = (plain: boolean) => (
    <UnitEditor
      key={selected === 'new' ? `new-${newParent}` : selected}
      plain={plain}
      unit={selected === 'new' ? null : (unitById.get(selected ?? '') ?? null)}
      parentId={selected === 'new' ? newParent : undefined}
      onSaved={(u) => {
        void qc.invalidateQueries({ queryKey: keys.units });
        setSelected(wide ? u.id : null);
        if (u.parentId) setExpanded((s) => new Set([...s, ...u.path.slice(0, -1)]));
      }}
    />
  );
  return (
    <>
      <PageHeader
        title={t('Organization')}
        description={directoryImport.data?.available ? t('Your company’s divisions, departments and teams. Import them from the directory: people are placed automatically, at every sign-in.') : t('Your company’s divisions, departments and teams, and who belongs to each.')}
        actions={
          <>
            {directoryImport.data?.available && (
              <Button icon={<FolderTree className="size-3.5" />} onClick={() => setReadingDirectory(true)}>
                {t('Import from directory')}
              </Button>
            )}
            <Button icon={<FileUp className="size-3.5" />} onClick={() => setImporting(true)}>
              {t('Import org chart')}
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => (setNewParent(null), setSelected('new'))}>
              {t('New unit')}
            </Button>
            <Menu trigger={<Button size="icon" aria-label={t('More')} icon={<MoreHorizontal className="size-4" />} />}>
              <MenuItem icon={<RefreshCcw />} onSelect={() => republish.mutate()}>
                {t('Re-sync all units to services')}
              </MenuItem>
            </Menu>
          </>
        }
      />
      <div className="grid grid-cols-1 gap-6 px-4 py-6 sm:px-6 lg:min-h-0 lg:flex-1 lg:grid-cols-[380px_minmax(0,1fr)]">
        <Card padded={false} className="flex min-h-0 flex-col lg:max-h-[calc(100vh-180px)]">
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 start-2.5 size-3.5 -translate-y-1/2 text-subtle" />
              <Input className="ps-8" placeholder={plural(units.length, 'Search {n} unit or directory links…', 'Search {n} units or directory links…')} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {roots.length ? (
              <ul>
                {roots
                  .filter((r) => !matching || matching.has(r.id))
                  .map((r) => (
                    <Node key={r.id} unit={r} depth={0} />
                  ))}
              </ul>
            ) : (
              <EmptyState icon={<Building2 />} title={t('No units yet')} description={t('Import your org chart or add the company as the first unit.')} />
            )}
          </div>
        </Card>
        {wide ? (
          selected && editor(false)
        ) : (
          <Drawer
            open={!!selected}
            onOpenChange={(o) => !o && setSelected(null)}
            title={selected === 'new' ? t('New unit') : (unitById.get(selected ?? '')?.name ?? t('Unit'))}
            description={selected && selected !== 'new' ? tMaybe(unitById.get(selected)?.kind) : undefined}
          >
            {selected && editor(true)}
          </Drawer>
        )}
      </div>
      <ImportDialog open={importing} onOpenChange={setImporting} />
      {readingDirectory && <DirectoryImportDialog onClose={() => setReadingDirectory(false)} />}
    </>
  );
}

function UnitEditor({ unit, parentId, onSaved, plain = false }: { unit: OrgUnit | null; parentId?: string | null; onSaved: (u: OrgUnit) => void; /** Inside a drawer, which shows the name. */ plain?: boolean }) {
  const { unitById } = useLookups();
  const parent = parentId ? unitById.get(parentId) : undefined;
  const [d, setD] = useState<OrgUnitInput>(() =>
    unit
      ? { ...unit, description: unit.description }
      : {
          key: '',
          name: '',
          kind: parent ? (LEVELS[Math.min(parent.path.length, 3)] ?? LEVELS[3]!) : LEVELS[0]!,
          description: null,
          parentId: parentId ?? null,
          color: parent?.color ?? '#6366f1',
          memberRole: 'viewer',
          directoryMembers: [],
          directoryManagers: [],
          archived: false,
        },
  );
  const save = useMutation({
    mutationFn: () => {
      const body = { ...d, key: d.key || slugKey([...(parent ? [parent.key] : []), d.name].join(' ')) };
      return unit ? api.put<OrgUnit>(`/api/identity/units/${unit.id}`, body) : api.post<OrgUnit>('/api/identity/units', body);
    },
    onSuccess: (u) => {
      toast.success(unit ? t('Unit saved') : t('{name} created', { name: u.name }), { description: d.directoryMembers.length || d.directoryManagers.length ? t('Directory members were re-synced.') : undefined });
      onSaved(u);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('Could not save')),
  });
  const set = (patch: Partial<OrgUnitInput>) => setD((x) => ({ ...x, ...patch }));
  // Directory links only mean something when people sign in through LDAP or ADFS.
  const providers = useProviders();
  const directory = !!providers.data?.some((p) => p.id === 'ldap' || p.id === 'oidc');
  const people = useUnitPeople(unit?.id ?? null);
  const suggest = (q: string): Promise<TagSuggestion[]> =>
    api.get<Array<{ link: string; label: string; people: number }>>('/api/identity/directory/links', { q }).then((rows) => rows.map((r) => ({ value: r.link, label: r.label, detail: plural(r.people, '{n} person', '{n} people') })));

  return (
    <Card className={cn('space-y-5 self-start', plain && 'border-0 bg-transparent p-0 shadow-none')}>
      <div className="flex items-start justify-between gap-3">
        <div>
          {!plain && <h2 className="text-[15px] font-semibold">{unit ? unit.name : parent ? t('New unit in {name}', { name: parent.name }) : t('New top-level unit')}</h2>}
          {plain && !unit && <p className="text-xs text-muted">{parent ? t('In {name}', { name: parent.name }) : t('At the top of the organization')}</p>}
          {unit && (
            <p className="mt-0.5 text-xs text-muted">
              {plural(unit.memberCount, '{n} member', '{n} members')} · {plural(unit.managerCount, '{n} manager', '{n} managers')} ·{' '}
              <Link to="/units/$unitId" params={{ unitId: unit.id }} className="text-accent-fg hover:underline">
                {t('Open team page')}
              </Link>
            </p>
          )}
        </div>
        <Button variant="primary" disabled={!d.name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
          {unit ? t('Save') : t('Create')}
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('Name')} required>
          {(id) => <Input id={id} autoFocus={!unit} value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('e.g. Editor Platform')} />}
        </Field>
        <Field label={t('Level')} hint={t('Any label your company uses.')}>
          {(id) => (
            <>
              <Input id={id} list="unit-levels" value={d.kind} onChange={(e) => set({ kind: e.target.value })} />
              <datalist id="unit-levels">
                {LEVELS.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label={t('Part of')} className="sm:col-span-2" hint={t('Moving a unit moves everything beneath it; access and reports follow instantly.')}>
          {(id) => (
            <UnitPicker
              id={id}
              value={d.parentId}
              onChange={(parentId) => set({ parentId })}
              allowClear
              clearLabel={t('Nothing — this is a top-level unit')}
              filter={(u) => !unit || !u.path.includes(unit.id)}
            />
          )}
        </Field>
      </div>
      <Field label={t('What members can do')}>
        {() => (
          <div className="space-y-1.5">
            <Segmented value={d.memberRole} onChange={(memberRole) => set({ memberRole })} options={memberRoles.map((r) => ({ value: r, label: r === 'none' ? t('Nothing') : tMaybe(roles[r].label) }))} />
            <p className="text-xs text-subtle">{memberRoleText(d.memberRole)} {t('Managers are always Admins of the unit and everything below it. Give anyone else access in the unit’s Access tab.')}</p>
          </div>
        )}
      </Field>
      {directory && (
        <div className="space-y-4 rounded-xl border border-border p-4">
          <div>
            <p className="text-[13px] font-semibold">{t('Directory links')}</p>
            <p className="text-xs text-muted">{t('People are placed in this unit when they sign in, if they match any of these. Start typing: groups and attributes the directory has are suggested.')}</p>
          </div>
          <Field label={t('Members')}>
            {(id) => <TagInput id={id} value={d.directoryMembers} onChange={(directoryMembers) => set({ directoryMembers })} suggest={suggest} placeholder={t('A group, or e.g. department=Platform')} />}
          </Field>
          <Field label={t('Managers')}>
            {(id) => <TagInput id={id} value={d.directoryManagers} onChange={(directoryManagers) => set({ directoryManagers })} suggest={suggest} placeholder={t('A group of the unit’s leads')} />}
          </Field>
        </div>
      )}
      {unit ? (
        <div className="space-y-3 rounded-xl border border-border p-4">
          <div>
            <p className="text-[13px] font-semibold">{t('People')}</p>
            <p className="text-xs text-muted">{directory ? t('People the directory places here, and anyone added by hand.') : t('Add the people of this unit, and its managers.')}</p>
          </div>
          <PeopleTab unitId={unit.id} people={people.data ?? []} editable bare directory={directory} />
        </div>
      ) : (
        !directory && <p className="text-xs text-muted">{t('Add its people once it is created.')}</p>
      )}
      <Field label={t('Color')}>{() => <ColorPicker value={d.color} onChange={(color) => set({ color })} />}</Field>
      {unit && <Switch checked={d.archived} onChange={(archived) => set({ archived })} label={t('Archived')} description={t('Hidden from pickers; nothing new can be added to it. Existing assets keep working.')} />}
    </Card>
  );
}

const EXAMPLE = `# ${t('One unit per line. Parents are created automatically.')}
# ${t('Path | member directory ids (;-separated) | manager directory ids')}
Wix
Wix / R&D | CN=rnd,OU=Groups,DC=wix,DC=com
Wix / R&D / Editor / Platform | department=Editor Platform | CN=editor-platform-leads,OU=Groups,DC=wix,DC=com
Wix / Marketing / Brand | CN=brand,OU=Groups,DC=wix,DC=com`;

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [text, setText] = useState('');
  const [kinds, setKinds] = useState(LEVELS.slice(0, 4).join(', '));
  const [result, setResult] = useState<OrgImportResult | null>(null);
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => api.post<OrgImportResult>('/api/identity/units/import', { text, kinds: kinds.split(',').map((k) => k.trim()).filter(Boolean) }),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: keys.units });
      if (!r.errors.length) toast.success(t('Imported: {created} created, {updated} updated', { created: r.created, updated: r.updated }));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('Import failed')),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (onOpenChange(o), !o && setResult(null))}
      title={t('Import org chart')}
      description={t('Paste from a spreadsheet or HR export. Existing units are matched by their path and kept; new ones are added.')}
      className="max-w-2xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('Close')}</Button>
          <Button variant="primary" disabled={!text.trim()} loading={run.isPending} onClick={() => run.mutate()}>
            {t('Import')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Textarea rows={10} className="font-mono text-xs" placeholder={EXAMPLE} value={text} onChange={(e) => setText(e.target.value)} />
        <Button size="xs" variant="ghost" onClick={() => setText(EXAMPLE.split('\n').filter((l) => !l.startsWith('#')).join('\n'))}>
          {t('Use the example')}
        </Button>
        <Field label={t('Level names by depth')} hint={t('Used for new units: the first level is the company, then divisions, and so on.')}>
          {(id) => <Input id={id} value={kinds} onChange={(e) => setKinds(e.target.value)} />}
        </Field>
        {result && (
          <div className="rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
            <p className="font-medium">
              {t('{created} created · {updated} updated', { created: result.created, updated: result.updated })}
            </p>
            {result.errors.map((e) => (
              <p key={e.line} className="text-xs text-danger">
                {t('Line {line}: {message}', { line: e.line, message: e.message })}
              </p>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Import from directory: reads everyone, suggests how the company is organised
 * (best guess first), shows the tree with heads, and applies it. Only what the
 * directory does not say is left to do by hand: people it cannot place, units
 * without a clear head.
 */
function DirectoryImportDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [rule, setRule] = useState<OrgRule | undefined>(undefined);
  const [excluded, setExcluded] = useState<string[][]>([]);
  const [managers, setManagers] = useState(true);
  const [leavers, setLeavers] = useState(true);
  const preview = useQuery({
    queryKey: ['directory-preview', rule ?? null],
    queryFn: () => api.post<DirectoryPreview>('/api/identity/directory/import/preview', rule ? { rule } : {}),
    staleTime: Infinity,
    retry: false,
  });
  const p = preview.data;
  const isExcluded = (path: string[]) => excluded.some((x) => x.length <= path.length && x.every((s, i) => s === path[i]));
  const apply = useMutation({
    mutationFn: () => api.post<DirectoryApplyResult>('/api/identity/directory/import/apply', { rule: p!.rule, exclude: excluded, managers, deactivateLeavers: leavers }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: keys.units });
      void qc.invalidateQueries();
      toast.success(t('Imported from the directory'), {
        description: [
          plural(r.unitsCreated, '{n} unit created', '{n} units created'),
          plural(r.usersCreated + r.usersUpdated, '{n} person', '{n} people'),
          r.managersSet ? plural(r.managersSet, '{n} head', '{n} heads') : null,
          r.usersDeactivated ? plural(r.usersDeactivated, '{n} leaver deactivated', '{n} leavers deactivated') : null,
          r.unplaced ? plural(r.unplaced, '{n} to place by hand', '{n} to place by hand') : null,
        ]
          .filter(Boolean)
          .join(' · '),
      });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('Could not import')),
  });
  const ruleKey = (r: OrgRule) => JSON.stringify(r);
  const units = (p?.units ?? []).filter((u) => !isExcluded(u.path));
  const missingHeads = units.filter((u) => !u.manager).length;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('Import from directory')}
      description={t('Everyone in the directory gets an account and their unit. Their places follow the directory from now on, at every sign-in and every import.')}
      className="sm:max-w-3xl"
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!p || !units.length} loading={apply.isPending} onClick={() => apply.mutate()}>
            {p ? t('Import {units} units and {people} people', { units: units.length, people: p.people }) : t('Import')}
          </Button>
        </>
      }
    >
      {preview.isLoading ? (
        <div className="flex items-center gap-3 py-10 text-[13px] text-muted">
          <Spinner /> {t('Reading the directory… a large one takes a minute.')}
        </div>
      ) : preview.error ? (
        <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">{preview.error instanceof ApiError ? preview.error.message : t('Could not read the directory')}</p>
      ) : p ? (
        <div className="space-y-5">
          <p className="text-[13px]">
            {t('{people} people', { people: p.people })} · {plural(units.length, '{n} unit', '{n} units')} · {t('{create} new accounts, {update} up to date', { create: p.users.create, update: p.users.update })}
            {!p.complete && <span className="ms-1 text-warning">{t('(the directory has more people than one import reads)')}</span>}
          </p>
          {p.options.length > 1 && (
            <Field label={t('Organised by')} hint={t('Our best guess comes first; pick another if it fits your company better.')}>
              {() => (
                <div className="flex flex-wrap gap-1.5">
                  {p.options.map((o) => (
                    <button
                      key={ruleKey(o.rule)}
                      type="button"
                      onClick={() => (setRule(o.rule), setExcluded([]))}
                      className={cn('rounded-lg border px-2.5 py-1.5 text-start text-[13px]', ruleKey(o.rule) === ruleKey(p.rule) ? 'border-accent bg-accent-soft text-accent-fg' : 'border-border hover:border-border-strong')}
                    >
                      <span className="block font-medium">{o.rule.kind === 'ou' ? t('Folders (OU)') : o.label}</span>
                      <span className="block text-xs text-muted">{t('{placed} placed · {units} units', { placed: o.placed, units: o.units })}</span>
                    </button>
                  ))}
                </div>
              )}
            </Field>
          )}
          <div>
            <p className="mb-1.5 text-[13px] font-semibold">{t('Units')}</p>
            <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {(p.units ?? []).map((u) => {
                const off = isExcluded(u.path);
                return (
                  <li key={u.path.join('/')} className={cn('flex items-center gap-2 py-1.5 pe-3 text-[13px]', off && 'opacity-50')} style={{ paddingInlineStart: `${0.75 + (u.path.length - 1) * 1.1}rem` }}>
                    <Checkbox
                      checked={!off}
                      disabled={off && !excluded.some((x) => x.join('/') === u.path.join('/'))}
                      onChange={(on) => setExcluded((xs) => (on ? xs.filter((x) => x.join('/') !== u.path.join('/')) : [...xs, u.path]))}
                      label={<span className="font-medium">{u.path.at(-1)}</span>}
                    />
                    {u.existingId ? <Badge>{t('Exists')}</Badge> : <Badge tone="accent">{t('New')}</Badge>}
                    <span className="ms-auto flex shrink-0 items-center gap-3 text-xs text-muted">
                      {u.manager ? (
                        <span className="inline-flex items-center gap-1" title={t('Suggested head')}>
                          <UserRound className="size-3" /> {u.manager.name}
                        </span>
                      ) : (
                        <span className="text-subtle">{t('No clear head')}</span>
                      )}
                      <span className="tabular-nums">{plural(u.people, '{n} person', '{n} people')}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="space-y-2">
            <Switch checked={managers} onChange={setManagers} label={t('Make the suggested heads managers of their units')} description={missingHeads ? plural(missingHeads, '{n} unit has no clear head: add one by hand later if it needs one.', '{n} units have no clear head: add one by hand later if they need one.') : undefined} />
            <Switch
              checked={leavers}
              onChange={setLeavers}
              disabled={!p.complete}
              label={plural(p.users.deactivate, 'Deactivate {n} person who left the directory', 'Deactivate {n} people who left the directory')}
              description={p.users.deactivateSample.length ? p.users.deactivateSample.join(', ') : t('Deactivated, never deleted: their items keep their history.')}
            />
          </div>
          {p.unplaced.count > 0 && (
            <div className="rounded-lg bg-warning-soft px-3 py-2 text-[13px]">
              <p className="font-medium text-warning">{plural(p.unplaced.count, '{n} person the directory does not place', '{n} people the directory does not place')}</p>
              <p className="text-xs text-muted">{t('They get an account; add them to a unit by hand (a unit’s People).')} {p.unplaced.sample.slice(0, 8).map((x) => x.name).join(', ')}{p.unplaced.count > 8 ? '…' : ''}</p>
            </div>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
