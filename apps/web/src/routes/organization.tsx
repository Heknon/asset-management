import { memberAccessLevels, type OrgImportResult, type OrgUnit, type OrgUnitInput } from '@am/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Building2, ChevronDown, ChevronRight, FileUp, MoreHorizontal, Plus, RefreshCcw, Search, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ColorPicker, UnitPicker } from '@/components/pickers';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, PageHeader } from '@/components/ui/display';
import { Field, Input, Segmented, Switch, TagInput, Textarea } from '@/components/ui/form';
import { Dialog, Menu, MenuItem } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { keys, useLookups } from '@/lib/queries';
import { cn, slugKey } from '@/lib/utils';

const LEVELS = ['Company', 'Division', 'Department', 'Team', 'Squad', 'Project', 'Client'];

const accessText = {
  none: 'Members see nothing by default (use grants).',
  view: 'Members can see this unit’s assets and requests. Recommended.',
  edit: 'Members can also add and edit this unit’s assets.',
};

/**
 * The org chart: divisions, departments and teams, each linked to directory
 * groups (or attributes such as department=Platform) so membership follows
 * LDAP / ADFS automatically.
 */
export function OrganizationPage() {
  const { units, unitById, childrenOf } = useLookups();
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [newParent, setNewParent] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    if (selected === null && units.length) setSelected(units.find((u) => !u.parentId)?.id ?? null);
    // Expand the first two levels on first load.
    if (!expanded.size && units.length) setExpanded(new Set(units.filter((u) => u.path.length <= 1).map((u) => u.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units.length]);

  const republish = useMutation({
    mutationFn: () => api.post<{ units: number }>('/api/identity/units/republish'),
    onSuccess: (r) => toast.success(`Re-sent ${r.units} units to all services`),
  });

  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matching = useMemo(() => {
    if (!terms.length) return null;
    const hits = units.filter((u) => terms.every((t) => u.name.toLowerCase().includes(t) || u.directoryMembers.some((d) => d.toLowerCase().includes(t))));
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
          className={cn('group flex h-8 cursor-pointer items-center gap-1 rounded-md pr-1 text-[13px] transition-colors', selected === unit.id ? 'bg-accent-soft text-fg' : 'hover:bg-surface-2', unit.archived && 'opacity-50')}
          style={{ paddingLeft: depth * 16 + 4 }}
          onClick={() => setSelected(unit.id)}
        >
          <button type="button" aria-label={open ? 'Collapse' : 'Expand'} className={cn('flex size-5 items-center justify-center rounded text-subtle hover:bg-surface-3', !kids.length && 'invisible')} onClick={(e) => (e.stopPropagation(), toggle(unit.id))}>
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          <span className="size-2 shrink-0 rounded-full" style={{ background: unit.color }} />
          <span className="min-w-0 flex-1 truncate font-medium">{unit.name}</span>
          <span className="text-[11px] text-subtle">{unit.kind}</span>
          {unit.memberCount > 0 && (
            <span className="flex items-center gap-0.5 text-[11px] text-subtle">
              <Users className="size-3" />
              {unit.memberCount}
            </span>
          )}
          <button
            type="button"
            aria-label="Add sub-unit"
            className="rounded p-0.5 text-subtle opacity-0 group-hover:opacity-100 hover:bg-surface-3 hover:text-fg"
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

  return (
    <>
      <PageHeader
        title="Organization"
        description="Your company’s divisions, departments and teams. Link each to directory groups and people are placed in it automatically at sign-in."
        actions={
          <>
            <Button icon={<FileUp className="size-3.5" />} onClick={() => setImporting(true)}>
              Import org chart
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => (setNewParent(null), setSelected('new'))}>
              New unit
            </Button>
            <Menu trigger={<Button size="icon" aria-label="More" icon={<MoreHorizontal className="size-4" />} />}>
              <MenuItem icon={<RefreshCcw />} onSelect={() => republish.mutate()}>
                Re-sync all units to services
              </MenuItem>
            </Menu>
          </>
        }
      />
      <div className="grid min-h-0 flex-1 gap-6 px-6 py-6 lg:grid-cols-[380px_minmax(0,1fr)]">
        <Card padded={false} className="flex min-h-0 flex-col lg:max-h-[calc(100vh-180px)]">
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" />
              <Input className="pl-8" placeholder={`Search ${units.length} units or directory links…`} value={q} onChange={(e) => setQ(e.target.value)} />
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
              <EmptyState icon={<Building2 />} title="No units yet" description="Import your org chart or add the company as the first unit." />
            )}
          </div>
        </Card>
        {selected && (
          <UnitEditor
            key={selected === 'new' ? `new-${newParent}` : selected}
            unit={selected === 'new' ? null : (unitById.get(selected) ?? null)}
            parentId={selected === 'new' ? newParent : undefined}
            onSaved={(u) => {
              void qc.invalidateQueries({ queryKey: keys.units });
              setSelected(u.id);
              if (u.parentId) setExpanded((s) => new Set([...s, ...u.path.slice(0, -1)]));
            }}
          />
        )}
      </div>
      <ImportDialog open={importing} onOpenChange={setImporting} />
    </>
  );
}

function UnitEditor({ unit, parentId, onSaved }: { unit: OrgUnit | null; parentId?: string | null; onSaved: (u: OrgUnit) => void }) {
  const { unitById } = useLookups();
  const parent = parentId ? unitById.get(parentId) : undefined;
  const [d, setD] = useState<OrgUnitInput>(() =>
    unit
      ? { ...unit, description: unit.description }
      : {
          key: '',
          name: '',
          kind: parent ? (LEVELS[Math.min(parent.path.length, 3)] ?? 'Team') : 'Company',
          description: null,
          parentId: parentId ?? null,
          color: parent?.color ?? '#6366f1',
          memberAccess: 'view',
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
      toast.success(unit ? 'Unit saved' : `${u.name} created`, { description: d.directoryMembers.length || d.directoryManagers.length ? 'Directory members were re-synced.' : undefined });
      onSaved(u);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save'),
  });
  const set = (patch: Partial<OrgUnitInput>) => setD((x) => ({ ...x, ...patch }));

  return (
    <Card className="space-y-5 self-start">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">{unit ? unit.name : parent ? `New unit in ${parent.name}` : 'New top-level unit'}</h2>
          {unit && (
            <p className="mt-0.5 text-xs text-muted">
              {unit.memberCount} members · {unit.managerCount} managers ·{' '}
              <Link to="/units/$unitId" params={{ unitId: unit.id }} className="text-accent-fg hover:underline">
                Open team page
              </Link>
            </p>
          )}
        </div>
        <Button variant="primary" disabled={!d.name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
          {unit ? 'Save' : 'Create'}
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" required>
          {(id) => <Input id={id} autoFocus={!unit} value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Editor Platform" />}
        </Field>
        <Field label="Level" hint="Any label your company uses.">
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
        <Field label="Part of" className="sm:col-span-2" hint="Moving a unit moves everything beneath it; access and reports follow instantly.">
          {(id) => (
            <UnitPicker
              id={id}
              value={d.parentId}
              onChange={(parentId) => set({ parentId })}
              allowClear
              clearLabel="Nothing — this is a top-level unit"
              filter={(u) => !unit || !u.path.includes(unit.id)}
            />
          )}
        </Field>
      </div>
      <Field label="What members can do">
        {() => (
          <div className="space-y-1.5">
            <Segmented value={d.memberAccess} onChange={(memberAccess) => set({ memberAccess })} options={memberAccessLevels.map((l) => ({ value: l, label: l === 'none' ? 'Nothing' : l === 'view' ? 'View' : 'View & edit' }))} />
            <p className="text-xs text-subtle">{accessText[d.memberAccess]} Managers always manage the unit and everything below it.</p>
          </div>
        )}
      </Field>
      <div className="space-y-4 rounded-xl border border-border p-4">
        <div>
          <p className="text-[13px] font-semibold">Directory links</p>
          <p className="text-xs text-muted">People are placed in this unit when they sign in, if they match any of these. Use LDAP group DNs, ADFS group names, or attributes such as department=Platform.</p>
        </div>
        <Field label="Members">
          {(id) => <TagInput id={id} value={d.directoryMembers} onChange={(directoryMembers) => set({ directoryMembers })} placeholder="CN=editor-platform,OU=Groups,DC=corp,DC=com" />}
        </Field>
        <Field label="Managers">
          {(id) => <TagInput id={id} value={d.directoryManagers} onChange={(directoryManagers) => set({ directoryManagers })} placeholder="CN=editor-platform-leads,OU=Groups,DC=corp,DC=com" />}
        </Field>
      </div>
      <Field label="Color">{() => <ColorPicker value={d.color} onChange={(color) => set({ color })} />}</Field>
      {unit && <Switch checked={d.archived} onChange={(archived) => set({ archived })} label="Archived" description="Hidden from pickers; nothing new can be added to it. Existing assets keep working." />}
    </Card>
  );
}

const EXAMPLE = `# One unit per line. Parents are created automatically.
# Path | member directory ids (;-separated) | manager directory ids
Wix
Wix / R&D | CN=rnd,OU=Groups,DC=wix,DC=com
Wix / R&D / Editor / Platform | department=Editor Platform | CN=editor-platform-leads,OU=Groups,DC=wix,DC=com
Wix / Marketing / Brand | CN=brand,OU=Groups,DC=wix,DC=com`;

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [text, setText] = useState('');
  const [kinds, setKinds] = useState('Company, Division, Department, Team');
  const [result, setResult] = useState<OrgImportResult | null>(null);
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => api.post<OrgImportResult>('/api/identity/units/import', { text, kinds: kinds.split(',').map((k) => k.trim()).filter(Boolean) }),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: keys.units });
      if (!r.errors.length) toast.success(`Imported: ${r.created} created, ${r.updated} updated`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Import failed'),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (onOpenChange(o), !o && setResult(null))}
      title="Import org chart"
      description="Paste from a spreadsheet or HR export. Existing units are matched by their path and kept; new ones are added."
      className="max-w-2xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
          <Button variant="primary" disabled={!text.trim()} loading={run.isPending} onClick={() => run.mutate()}>
            Import
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Textarea rows={10} className="font-mono text-xs" placeholder={EXAMPLE} value={text} onChange={(e) => setText(e.target.value)} />
        <Button size="xs" variant="ghost" onClick={() => setText(EXAMPLE.split('\n').filter((l) => !l.startsWith('#')).join('\n'))}>
          Use the example
        </Button>
        <Field label="Level names by depth" hint="Used for new units: the first level is the company, then divisions, and so on.">
          {(id) => <Input id={id} value={kinds} onChange={(e) => setKinds(e.target.value)} />}
        </Field>
        {result && (
          <div className="rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
            <p className="font-medium">
              {result.created} created · {result.updated} updated
            </p>
            {result.errors.map((e) => (
              <p key={e.line} className="text-xs text-danger">
                Line {e.line}: {e.message}
              </p>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
