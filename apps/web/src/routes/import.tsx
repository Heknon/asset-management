import {
  coerceCell,
  detectDateFormat,
  fieldKindMeta,
  foldText,
  inferField,
  parseTables,
  suggestMapping,
  templateFit,
  type AssetType,
  type DateFormat,
  type FieldDefinition,
  type ImportBatch,
  type ImportRequest,
  type ImportResult,
  type ImportRow,
  type ImportTarget,
  type OrgUnit,
  type ParsedTable,
  type TypeVariant,
  type UserSummary,
} from '@am/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, FileSpreadsheet, FileUp, Sparkles, Undo2, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { CatalogSelect } from '@/components/catalogs';
import { UnitPicker } from '@/components/pickers';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { Badge, Card, CompactSteps, PageHeader } from '@/components/ui/display';
import { Field, Input, Segmented, Select, Textarea } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { downloadCsv } from '@/lib/download';
import { useMyOrg } from '@/lib/org';
import { keys, useLookups } from '@/lib/queries';
import { cn, formatDateTime, inSentence } from '@/lib/utils';
import { intlLocale, plural, t, tMaybe } from '@/lib/i18n';

type Step = 'source' | 'destination' | 'columns' | 'review' | 'done';
const steps: Array<{ key: Step; label: string }> = [
  { key: 'source', label: t('Table') },
  { key: 'destination', label: t('Where it goes') },
  { key: 'columns', label: t('Columns') },
  { key: 'review', label: t('Check') },
  { key: 'done', label: t('Done') },
];
const CHUNK = 500;
const MAX_ROWS = 20_000;

interface Destination {
  typeId: string | null;
  variantId: string | null;
  unitMode: 'one' | 'column';
  unitId: string | null;
  catalogId: string | null;
  mode: 'create' | 'upsert';
  matchBy: ImportRequest['matchBy'];
}

/**
 * Import wizard: a table (file or paste) → which template, team and catalog →
 * which column is which field → a full dry run → import, with undo.
 * Every step has sensible defaults, so most imports are four clicks.
 */
export function ImportPage() {
  const search = useSearch({ strict: false }) as { type?: string; unit?: string; catalog?: string };
  const lookups = useLookups();
  const [step, setStep] = useState<Step>('source');
  const [fileName, setFileName] = useState(() => t('pasted table'));
  const [tables, setTables] = useState<ParsedTable[]>([]);
  const [tableIndex, setTableIndex] = useState(0);
  const [headerRow, setHeaderRow] = useState(true);
  const [dest, setDest] = useState<Destination>({ typeId: search.type ?? null, variantId: null, unitMode: 'one', unitId: search.unit ?? null, catalogId: search.catalog ?? null, mode: 'create', matchBy: 'name' });
  const [mapping, setMapping] = useState<ImportTarget[]>([]);
  const [dateFormats, setDateFormats] = useState<Record<number, DateFormat>>({});
  const [unitMap, setUnitMap] = useState<Record<string, string | null>>({});
  const [optionMaps, setOptionMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [review, setReview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);

  const raw = tables[tableIndex];
  const table = useMemo(() => {
    if (!raw) return null;
    return headerRow ? raw : { ...raw, headers: raw.headers.map((_, i) => t('Column {n}', { n: i + 1 })), rows: [raw.headers, ...raw.rows] };
  }, [raw, headerRow]);
  const type = dest.typeId ? lookups.typeById.get(dest.typeId) : undefined;
  const schema = type ? (lookups.schemaOf(type.id, dest.variantId) ?? type) : undefined;

  // Defaults whenever the table or the template changes: auto-mapping and date formats.
  useEffect(() => {
    if (!table || !schema) return;
    const m = suggestMapping(table.headers, schema.fields).map((t) => (t === 'unit' && dest.unitMode === 'one' ? 'skip' : t));
    setMapping(m);
    const formats: Record<number, DateFormat> = {};
    m.forEach((t, i) => {
      const f = t.startsWith('field:') ? schema.fields.find((x) => x.key === t.slice(6)) : undefined;
      if (f?.kind === 'date') formats[i] = detectDateFormat(table.rows.map((r) => r[i] ?? '')).format;
    });
    setDateFormats(formats);
    if (m.includes('unit')) setDest((d) => ({ ...d, unitMode: 'column' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, schema?.fields.length, dest.typeId, dest.variantId]);

  const go = (s: Step) => setStep(s);
  const index = steps.findIndex((s) => s.key === step);

  return (
    <>
      <PageHeader title={t('Import')} description={t('Bring in what you already track in spreadsheets: CSV, TSV, Excel or Sheets (copy & paste), and Markdown tables.')} />
      <div className="mx-auto w-full max-w-5xl space-y-6 px-4 sm:px-6 py-6">
        <CompactSteps className="sm:hidden" index={index} total={steps.length} label={steps[index]!.label} done={index === steps.length - 1} />
        <ol className="hidden flex-wrap items-center gap-2 text-[13px] sm:flex" aria-label={t('Steps')}>
          {steps.map((s, i) => (
            <li key={s.key} className="flex items-center gap-2">
              <span className={cn('flex size-6 items-center justify-center rounded-full text-xs font-medium', i < index ? 'bg-success text-white' : i === index ? 'bg-accent text-white' : 'bg-surface-2 text-muted')}>{i < index ? <Check className="size-3.5" /> : i + 1}</span>
              <span className={i === index ? 'font-medium' : 'text-muted'}>{s.label}</span>
              {i < steps.length - 1 && <span className="mx-1 h-px w-6 bg-border" />}
            </li>
          ))}
        </ol>

        {step === 'source' && (
          <SourceStep
            tables={tables}
            tableIndex={tableIndex}
            headerRow={headerRow}
            fileName={fileName}
            onLoad={(text, name) => {
              const parsed = parseTables(text);
              if (!parsed.length) return toast.error(t('No table found'), { description: t('Use a CSV/TSV file, a Markdown table, or paste cells copied from a spreadsheet.') });
              setTables(parsed);
              setTableIndex(0);
              setFileName(name);
              setReview(null);
            }}
            onPick={setTableIndex}
            onHeaderRow={setHeaderRow}
            table={table}
            onNext={() => go('destination')}
          />
        )}
        {step === 'destination' && table && <DestinationStep table={table} dest={dest} setDest={setDest} unitMap={unitMap} setUnitMap={setUnitMap} mapping={mapping} setMapping={setMapping} onBack={() => go('source')} onNext={() => go('columns')} />}
        {step === 'columns' && table && schema && type && (
          <ColumnsStep
            table={table}
            type={type}
            schema={schema}
            dest={dest}
            setDest={setDest}
            mapping={mapping}
            setMapping={setMapping}
            dateFormats={dateFormats}
            setDateFormats={setDateFormats}
            optionMaps={optionMaps}
            setOptionMaps={setOptionMaps}
            onBack={() => go('destination')}
            onNext={() => go('review')}
          />
        )}
        {step === 'review' && table && schema && type && (
          <ReviewStep
            key={`${tableIndex}-${dest.typeId}-${dest.variantId}`}
            table={table}
            fileName={fileName}
            type={type}
            schema={schema}
            dest={dest}
            mapping={mapping}
            dateFormats={dateFormats}
            optionMaps={optionMaps}
            unitMap={unitMap}
            review={review}
            setReview={setReview}
            onBack={() => go('columns')}
            onDone={(r) => (setDone(r), go('done'))}
          />
        )}
        {step === 'done' && done && type && (
          <DoneStep
            result={done}
            type={type}
            onAgain={() => {
              setTables([]);
              setReview(null);
              setDone(null);
              go('source');
            }}
          />
        )}
      </div>
    </>
  );
}

function Nav({ onBack, onNext, nextLabel = t('Continue'), disabled, hint }: { onBack?: () => void; onNext?: () => void; nextLabel?: ReactNode; disabled?: boolean; hint?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      {onBack ? (
        <Button variant="ghost" icon={<ArrowLeft className="size-3.5" />} onClick={onBack}>
          {t('Back')}
        </Button>
      ) : (
        <span />
      )}
      <span className="flex items-center gap-3">
        {hint && <span className="text-xs text-muted">{hint}</span>}
        {onNext && (
          <Button variant="primary" disabled={disabled} onClick={onNext}>
            {nextLabel}
            <ArrowRight className="ms-1 size-3.5" />
          </Button>
        )}
      </span>
    </div>
  );
}

function Preview({ table, rows = 6 }: { table: ParsedTable; rows?: number }) {
  return (
    <div className="overflow-auto rounded-lg border border-border">
      <table className="w-full text-xs">
        <thead className="bg-surface-2 text-start">
          <tr>
            {table.headers.map((h, i) => (
              <th key={i} className="px-2 py-1.5 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.slice(0, rows).map((r, i) => (
            <tr key={i} className="border-t border-border">
              {table.headers.map((_, j) => (
                <td key={j} className="max-w-48 truncate px-2 py-1.5 whitespace-nowrap text-muted">
                  {r[j]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── 1. Source ───────────────────────────────────────────────────────────────

function SourceStep({
  tables,
  tableIndex,
  headerRow,
  fileName,
  table,
  onLoad,
  onPick,
  onHeaderRow,
  onNext,
}: {
  tables: ParsedTable[];
  tableIndex: number;
  headerRow: boolean;
  fileName: string;
  table: ParsedTable | null;
  onLoad: (text: string, name: string) => void;
  onPick: (i: number) => void;
  onHeaderRow: (v: boolean) => void;
  onNext: () => void;
}) {
  const [pasted, setPasted] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const readFile = async (f: File | undefined) => {
    if (!f) return;
    if (/\.(xlsx?|numbers)$/i.test(f.name)) return toast.error(t('Save the sheet as CSV first'), { description: t('Or select the cells in Excel / Google Sheets, copy, and paste them here.') });
    if (f.size > 25 * 1_048_576) return toast.error(t('That file is over 25 MB'));
    onLoad(await f.text(), f.name);
  };

  return (
    <>
      <Card padded={false}>
        <div
          onDragOver={(e) => (e.preventDefault(), setDragging(true))}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void readFile(e.dataTransfer.files[0]);
          }}
          className={cn('flex flex-col items-center gap-2 border-b border-border px-4 sm:px-6 py-8 text-center transition-colors', dragging && 'bg-accent-soft')}
        >
          <FileUp className="size-6 text-muted" />
          <p className="text-[13px] font-medium">{t('Drop a CSV, TSV or Markdown file')}</p>
          <p className="text-xs text-muted">{t('Several tables in one Markdown file? You choose which one next.')}</p>
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.md,.markdown,text/csv,text/plain,text/markdown" className="hidden" onChange={(e) => void readFile(e.target.files?.[0])} />
          <Button size="sm" onClick={() => fileRef.current?.click()}>
            {t('Choose a file')}
          </Button>
        </div>
        <div className="space-y-2 p-4">
          <Textarea
            rows={4}
            wrap="off"
            className="font-mono text-xs touch:text-sm"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder={t('…or paste a table here: cells copied from Excel or Google Sheets, CSV text, or a Markdown table')}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text');
              if (text.includes('\t') || text.includes('|') || text.split('\n').length > 1) {
                e.preventDefault();
                onLoad(text, t('pasted table'));
              }
            }}
            onBlur={(e) => e.target.value.trim() && onLoad(e.target.value, t('pasted table'))}
          />
          {pasted.trim() && (
            <div className="flex justify-end">
              <Button size="sm" variant="primary" onClick={() => onLoad(pasted, t('pasted table'))}>
                {t('Use this table')}
              </Button>
            </div>
          )}
        </div>
      </Card>

      {tables.length > 1 && (
        <Card>
          <p className="mb-2 text-[13px] font-medium">{plural(tables.length, '{n} table in {file} — which one?', '{n} tables in {file} — which one?', { file: fileName })}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {tables.map((tb, i) => (
              <button key={i} type="button" onClick={() => onPick(i)} className={cn('rounded-lg border px-3 py-2 text-start', i === tableIndex ? 'border-accent bg-accent-soft' : 'border-border hover:border-border-strong')}>
                <span className="block text-[13px] font-medium">{tb.name}</span>
                <span className="block text-xs text-muted">
                  {plural(tb.rows.length, '{n} row · {columns}', '{n} rows · {columns}', { columns: tb.headers.slice(0, 3).join(', ') + (tb.headers.length > 3 ? '…' : '') })}
                </span>
              </button>
            ))}
          </div>
        </Card>
      )}

      {table && (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-[13px]">
              <FileSpreadsheet className="size-4 text-muted" />
              <span className="font-medium">{fileName}</span>
              <span className="text-muted">
                · {plural(table.rows.length, '{n} row', '{n} rows')} · {plural(table.headers.length, '{n} column', '{n} columns')} · {raw(table.format)}
              </span>
            </p>
            <Segmented value={headerRow ? 'yes' : 'no'} onChange={(v) => onHeaderRow(v === 'yes')} options={[{ value: 'yes', label: t('First row is column names') }, { value: 'no', label: t('No header row') }]} />
          </div>
          <Preview table={table} />
          {table.rows.length > MAX_ROWS && <p className="text-xs text-danger">{t('Only the first {n} rows are imported at a time; split larger files.', { n: MAX_ROWS.toLocaleString(intlLocale()) })}</p>}
        </Card>
      )}
      <Nav onNext={onNext} disabled={!table || !table.rows.length} />
      <RecentImports />
    </>
  );
}

const raw = (f: ParsedTable['format']) => ({ csv: 'CSV', tsv: t('tab-separated'), semicolon: t('semicolon-separated'), pipe: t('pipe-separated'), markdown: t('Markdown table') })[f];

function RecentImports() {
  const qc = useQueryClient();
  const { typeById } = useLookups();
  const list = useQuery({ queryKey: ['imports'], queryFn: () => api.get<ImportBatch[]>('/api/registry/imports') });
  const undo = useMutation({
    mutationFn: (id: string) => api.delete<{ removed: number }>(`/api/registry/imports/${id}`),
    onSuccess: (r) => {
      toast.success(plural(r.removed, 'Undone — {n} item removed', 'Undone — {n} items removed'));
      void qc.invalidateQueries({ queryKey: ['imports'] });
      void qc.invalidateQueries({ queryKey: keys.assets });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('Undo failed')),
  });
  if (!list.data?.length) return null;
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-semibold">{t('Your recent imports')}</h2>
      <Card padded={false} className="divide-y divide-border">
        {list.data.map((b) => (
          <div key={b.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{b.fileName}</span>
              <span className="block text-xs text-muted">
                {t(b.undoneAt ? '{type} · {created} added, {updated} updated · {date} · undone' : '{type} · {created} added, {updated} updated · {date}', {
                  type: typeById.get(b.assetTypeId)?.name ?? '',
                  created: b.created.toLocaleString(intlLocale()),
                  updated: b.updated.toLocaleString(intlLocale()),
                  date: formatDateTime(b.createdAt),
                })}
              </span>
            </span>
            {!b.undoneAt && b.created > 0 && (
              <Link to="/assets" search={{ import: b.id, type: b.assetTypeId }} className="text-xs text-accent-fg hover:underline">
                {t('See items')}
              </Link>
            )}
            {b.undoable > 0 && (
              <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} loading={undo.isPending} onClick={() => undo.mutate(b.id)}>
                {t('Undo ({n})', { n: b.undoable.toLocaleString(intlLocale()) })}
              </Button>
            )}
          </div>
        ))}
      </Card>
    </section>
  );
}

// ─── 2. Destination ──────────────────────────────────────────────────────────

/** "R&D / Editor / Platform", "Platform", "r&d › editor": a unit by name or path. */
function matchUnit(value: string, units: OrgUnit[], unitById: Map<string, OrgUnit>): OrgUnit | undefined {
  const parts = value.split(/\s*[/>›\\]\s*/).map(foldText).filter(Boolean);
  if (!parts.length) return undefined;
  const candidates = units.filter((u) => !u.archived && foldText(u.name) === parts[parts.length - 1]);
  if (candidates.length <= 1) return candidates[0];
  return candidates.find((u) => {
    const names = u.path.map((id) => foldText(unitById.get(id)?.name ?? ''));
    return parts.every((p) => names.includes(p));
  });
}

function DestinationStep({
  table,
  dest,
  setDest,
  unitMap,
  setUnitMap,
  mapping,
  setMapping,
  onBack,
  onNext,
}: {
  table: ParsedTable;
  dest: Destination;
  setDest: (fn: (d: Destination) => Destination) => void;
  unitMap: Record<string, string | null>;
  setUnitMap: (m: Record<string, string | null>) => void;
  mapping: ImportTarget[];
  setMapping: (m: ImportTarget[]) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { types, units, unitById, variantsFor } = useLookups();
  const { can, canManageOrganization } = useMyOrg();
  const qc = useQueryClient();
  const ranked = useMemo(
    () =>
      types
        .filter((t) => !t.archived)
        .map((t) => ({ t, fit: templateFit(table.headers, t), count: suggestMapping(table.headers, t.fields).filter((m) => m.startsWith('field:')).length }))
        .sort((a, b) => b.fit - a.fit),
    [types, table],
  );
  const best = ranked[0];
  useEffect(() => {
    if (!dest.typeId && best && best.fit > 0) setDest((d) => ({ ...d, typeId: best.t.id }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const unitColumn = mapping.indexOf('unit');
  const unitValues = useMemo(() => (unitColumn >= 0 ? [...new Set(table.rows.map((r) => (r[unitColumn] ?? '').trim()).filter(Boolean))] : []), [table, unitColumn]);
  useEffect(() => {
    if (dest.unitMode !== 'column') return;
    const next = { ...unitMap };
    for (const v of unitValues) if (!(v in next)) next[v] = matchUnit(v, units, unitById)?.id ?? null;
    setUnitMap(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitValues, dest.unitMode]);

  const newTemplate = useMutation({
    mutationFn: async () => {
      const nameCol = Math.max(0, mapping.indexOf('name'));
      const keys = new Set<string>();
      const fields = table.headers
        .map((h, i) => ({ h, i }))
        .filter(({ i }) => i !== nameCol && !['unit', 'owner', 'status', 'reference'].includes(mapping[i]!))
        .map(({ h, i }) => {
          const f = inferField(h, table.rows.slice(0, 200).map((r) => r[i] ?? ''), keys);
          keys.add(f.key);
          return { ...f, showInTable: keys.size <= 5 };
        });
      const name = table.name.startsWith('Table ') ? t('Imported items') : table.name;
      return api.post<AssetType>('/api/registry/asset-types', { key: foldText(name).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 't_$1').slice(0, 50) || 'imported', name, icon: 'box', color: '#6366f1', sections: [], fields });
    },
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: keys.assetTypes });
      setDest((d) => ({ ...d, typeId: created.id, variantId: null }));
      toast.success(plural(created.fields.length, 'Template “{name}” created from {n} column', 'Template “{name}” created from {n} columns', { name: created.name }), { description: t('Fine-tune it later in Templates; dates can get reminders there.') });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('Could not create the template')),
  });

  const variants = dest.typeId && dest.unitMode === 'one' && dest.unitId ? variantsFor(dest.typeId, dest.unitId) : [];
  const unmatchedUnits = unitValues.filter((v) => !unitMap[v]);
  const unitOk = dest.unitMode === 'one' ? !!dest.unitId : unitColumn >= 0 && unmatchedUnits.length === 0;
  const unit = dest.unitId ? unitById.get(dest.unitId) : undefined;

  return (
    <>
      <Card className="space-y-3">
        <h2 className="text-[13px] font-semibold">{t('What are these?')}</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {ranked.map(({ t: tp, fit, count }) => (
            <button
              key={tp.id}
              type="button"
              onClick={() => setDest((d) => ({ ...d, typeId: tp.id, variantId: null }))}
              className={cn('flex items-start gap-3 rounded-lg border px-3 py-2.5 text-start', dest.typeId === tp.id ? 'border-accent bg-accent-soft' : 'border-border hover:border-border-strong')}
            >
              <TypeIcon icon={tp.icon} color={tp.color} size={28} />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">{tp.name}</span>
                <span className="block text-xs text-muted">{count ? t('{count} of {total} columns match', { count, total: table.headers.length }) : t('No matching columns')}</span>
              </span>
              {tp.id === best?.t.id && fit > 0 && <Badge tone="accent">{t('Best match')}</Badge>}
            </button>
          ))}
          {canManageOrganization && (
            <button type="button" onClick={() => newTemplate.mutate()} disabled={newTemplate.isPending} className="flex items-start gap-3 rounded-lg border border-dashed border-border px-3 py-2.5 text-start hover:border-border-strong">
              <span className="flex size-7 items-center justify-center rounded-md bg-surface-2 text-muted">
                <Wand2 className="size-4" />
              </span>
              <span>
                <span className="block text-[13px] font-medium">{newTemplate.isPending ? t('Creating…') : t('New template from these columns')}</span>
                <span className="block text-xs text-muted">{t('Field types are guessed from the values')}</span>
              </span>
            </button>
          )}
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-[13px] font-semibold">{t('Which team owns them?')}</h2>
        <Segmented
          value={dest.unitMode}
          onChange={(unitMode) => {
            setDest((d) => ({ ...d, unitMode, variantId: null, catalogId: unitMode === 'column' ? null : d.catalogId }));
            if (unitMode === 'one') setMapping(mapping.map((t) => (t === 'unit' ? 'skip' : t)));
          }}
          options={[
            { value: 'one', label: t('One team for every row') },
            { value: 'column', label: t('A column says which team') },
          ]}
        />
        {dest.unitMode === 'one' ? (
          <div className="max-w-md">
            <UnitPicker value={dest.unitId} onChange={(unitId) => setDest((d) => ({ ...d, unitId, variantId: null, catalogId: null }))} filter={(u) => !dest.typeId || can(u.id, 'create', dest.typeId)} />
          </div>
        ) : (
          <div className="space-y-2">
            <Field label={t('Team column')}>
              {(id) => (
                <Select id={id} className="max-w-xs" value={unitColumn >= 0 ? String(unitColumn) : ''} onChange={(e) => setMapping(mapping.map((m, i) => (i === Number(e.target.value) ? 'unit' : m === 'unit' ? 'skip' : m)))}>
                  <option value="">{t('Choose…')}</option>
                  {table.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {unitValues.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-[13px]">
                  <tbody>
                    {unitValues.slice(0, 200).map((v) => (
                      <tr key={v} className="border-t border-border first:border-0">
                        <td className="w-1/3 px-3 py-1.5">{v}</td>
                        <td className="px-3 py-1.5">
                          <UnitPicker value={unitMap[v] ?? null} onChange={(id) => setUnitMap({ ...unitMap, [v]: id })} placeholder={t('Choose the team')} />
                        </td>
                        <td className="w-8 px-2">{unitMap[v] ? <Check className="size-4 text-success" /> : <AlertTriangle className="size-4 text-warning" />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {unmatchedUnits.length > 0 && <p className="text-xs text-warning">{plural(unmatchedUnits.length, '{n} team name did not match a unit — choose it above.', '{n} team names did not match a unit — choose them above.')}</p>}
          </div>
        )}
        {variants.length > 0 && (
          <Field label={t('Kind')} hint={t('{unit} has its own versions of this template', { unit: unit?.name ?? '' })}>
            {(id) => (
              <Select id={id} className="max-w-xs" value={dest.variantId ?? ''} onChange={(e) => setDest((d) => ({ ...d, variantId: e.target.value || null }))}>
                <option value="">{t('Standard')}</option>
                {variants.map((v: TypeVariant) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {dest.unitMode === 'one' && unit && (
          <Field label={t('Put them in a catalog')} hint={t('Optional — everyone the catalog is shared with will see them')}>
            {(id) => (
              <div className="max-w-xs">
                <CatalogSelect id={id} value={dest.catalogId} unitPath={unit.path} onChange={(catalogId) => setDest((d) => ({ ...d, catalogId }))} />
              </div>
            )}
          </Field>
        )}
      </Card>

      <Card className="space-y-3">
        <h2 className="text-[13px] font-semibold">{t('Some of them may already exist')}</h2>
        <Segmented
          value={dest.mode}
          onChange={(mode) => setDest((d) => ({ ...d, mode }))}
          options={[
            { value: 'create', label: t('Add every row as a new item') },
            { value: 'upsert', label: t('Update items that already exist') },
          ]}
        />
        {dest.mode === 'upsert' && (
          <Field label={t('Recognise existing items by')} hint={t('Rows that match nothing are added as new items')}>
            {(id) => (
              <Select id={id} className="max-w-xs" value={dest.matchBy} onChange={(e) => setDest((d) => ({ ...d, matchBy: e.target.value as Destination['matchBy'] }))}>
                <option value="name">{t('Same name (in the same team)')}</option>
                <option value="reference">{t('Their ID (LIC-42) — map an ID column')}</option>
                {(dest.typeId ? (types.find((x) => x.id === dest.typeId)?.fields ?? []) : [])
                  .filter((f) => ['text', 'number', 'email', 'url'].includes(f.kind))
                  .map((f) => (
                    <option key={f.key} value={`field:${f.key}`}>
                      {t('Same {field}', { field: inSentence(f.label) })}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        )}
      </Card>
      <Nav onBack={onBack} onNext={onNext} disabled={!dest.typeId || !unitOk} hint={!dest.typeId ? t('Choose a template') : !unitOk ? t('Choose the team') : undefined} />
    </>
  );
}

// ─── 3. Columns ──────────────────────────────────────────────────────────────

const targetLabel: Record<string, string> = { name: t('Name'), reference: t('ID (to match existing items)'), owner: t('Owner'), unit: t('Team'), status: t('Status') };

function ColumnsStep({
  table,
  type,
  schema,
  dest,
  setDest,
  mapping,
  setMapping,
  dateFormats,
  setDateFormats,
  optionMaps,
  setOptionMaps,
  onBack,
  onNext,
}: {
  table: ParsedTable;
  type: AssetType;
  schema: AssetType;
  dest: Destination;
  setDest: (fn: (d: Destination) => Destination) => void;
  mapping: ImportTarget[];
  setMapping: (m: ImportTarget[]) => void;
  dateFormats: Record<number, DateFormat>;
  setDateFormats: (m: Record<number, DateFormat>) => void;
  optionMaps: Record<string, Record<string, string | null>>;
  setOptionMaps: (m: Record<string, Record<string, string | null>>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { unitById } = useLookups();
  const { canManageOrganization, unitPermissionsOn } = useMyOrg();
  const [extending, setExtending] = useState(false);
  const fieldOf = (t: ImportTarget) => (t.startsWith('field:') ? schema.fields.find((f) => f.key === t.slice(6)) : undefined);
  const setTarget = (col: number, target: ImportTarget) => {
    const next = mapping.map((x, i) => (i === col ? target : x === target && target !== 'skip' ? 'skip' : x));
    setMapping(next);
    const f = target.startsWith('field:') ? schema.fields.find((x) => x.key === target.slice(6)) : undefined;
    if (f?.kind === 'date') setDateFormats({ ...dateFormats, [col]: detectDateFormat(table.rows.map((r) => r[col] ?? '')).format });
  };
  const skipped = mapping.map((m, i) => ({ m, i })).filter((x) => x.m === 'skip' && table.rows.some((r) => (r[x.i] ?? '').trim()));
  const canExtend = dest.unitMode === 'one' && !!dest.unitId && (canManageOrganization || unitPermissionsOn(dest.unitId).has('manage'));

  return (
    <>
      <Card padded={false}>
        <div className="border-b border-border px-4 py-2.5">
          <h2 className="text-[13px] font-semibold">{t('Which column is which?')}</h2>
          <p className="text-xs text-muted">{t('Matched by column names; change anything that is wrong. Problems are checked again before anything is saved.')}</p>
        </div>
        <div className="divide-y divide-border">
          {table.headers.map((h, col) => {
            const target = mapping[col] ?? 'skip';
            const f = fieldOf(target);
            const samples = table.rows.map((r) => r[col] ?? '').filter((v) => v.trim()).slice(0, 3);
            return (
              <div key={col} className="grid grid-cols-1 items-start gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_24px_minmax(0,1fr)]">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">{h}</p>
                  <p className="truncate text-xs text-muted">{samples.join(' · ') || t('empty')}</p>
                </div>
                <ArrowRight className="mt-2 hidden size-4 text-subtle sm:block" />
                <div className="space-y-2">
                  <Select value={target} onChange={(e) => setTarget(col, e.target.value as ImportTarget)} aria-label={t('Column {name}', { name: h })} className={cn(target === 'skip' && 'text-muted')}>
                    <option value="skip">{t('— Don’t import —')}</option>
                    <optgroup label={t('Every item')}>
                      {(['name', 'reference', 'owner', 'status', ...(dest.unitMode === 'column' ? ['unit'] : [])] as const).map((k) => (
                        <option key={k} value={k}>
                          {targetLabel[k]}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label={schema.name}>
                      {schema.fields.map((x) => (
                        <option key={x.key} value={`field:${x.key}`}>
                          {x.label}
                        </option>
                      ))}
                    </optgroup>
                  </Select>
                  {f?.kind === 'date' && (
                    <Select value={dateFormats[col] ?? 'iso'} onChange={(e) => setDateFormats({ ...dateFormats, [col]: e.target.value as DateFormat })} aria-label={t('Date format')} className="text-xs">
                      <option value="dmy">{t('Day first (31/01/2026)')}</option>
                      <option value="mdy">{t('Month first (01/31/2026)')}</option>
                      <option value="iso">{t('Year first (2026-01-31)')}</option>
                    </Select>
                  )}
                  {f && (f.kind === 'select' || f.kind === 'multiSelect') && <OptionMapper field={f} values={table.rows.map((r) => r[col] ?? '')} map={optionMaps[f.key] ?? {}} onChange={(m) => setOptionMaps({ ...optionMaps, [f.key]: m })} />}
                  <ColumnCheck field={f} target={target} values={table.rows.map((r) => r[col] ?? '')} dateFormat={dateFormats[col] ?? 'iso'} optionMap={f ? optionMaps[f.key] : undefined} type={type} />
                </div>
              </div>
            );
          })}
        </div>
      </Card>
      {skipped.length > 0 && (
        <Card className="flex flex-wrap items-center gap-3 text-[13px]">
          <AlertTriangle className="size-4 text-warning" />
          <span className="min-w-0 flex-1">
            {t('Not imported: {columns}.', { columns: skipped.map((s) => table.headers[s.i]).join(', ') })}{' '}
            {canExtend ? t('Keep them as {unit}’s own fields?', { unit: unitById.get(dest.unitId!)?.name ?? '' }) : t('Ask a template manager to add these fields, or your unit’s managers to create a team variant.')}
          </span>
          {canExtend && (
            <Button size="sm" icon={<Sparkles className="size-3.5" />} onClick={() => setExtending(true)}>
              {t('Add as team fields…')}
            </Button>
          )}
        </Card>
      )}
      {extending && (
        <ExtendDialog
          table={table}
          type={type}
          columns={skipped.map((s) => s.i)}
          unitId={dest.unitId!}
          variantId={dest.variantId}
          onClose={() => setExtending(false)}
          onDone={(variant, keyByColumn) => {
            setDest((d) => ({ ...d, variantId: variant.id }));
            setMapping(mapping.map((m, i) => (keyByColumn.has(i) ? (`field:${keyByColumn.get(i)}` as ImportTarget) : m)));
            setExtending(false);
          }}
        />
      )}
      <Nav onBack={onBack} onNext={onNext} disabled={!mapping.includes('name')} hint={!mapping.includes('name') ? t('One column must be the name') : undefined} />
    </>
  );
}

/** "✓ 412 ok · 3 problems" under a column, from the same conversion the import uses. */
function ColumnCheck({ field, target, values, dateFormat, optionMap, type }: { field?: FieldDefinition; target: ImportTarget; values: string[]; dateFormat: DateFormat; optionMap?: Record<string, string | null>; type: AssetType }) {
  const stats = useMemo(() => {
    let ok = 0;
    let bad = 0;
    let example = '';
    for (const v of values) {
      if (!v.trim()) continue;
      let good = true;
      if (field && field.kind !== 'user' && field.kind !== 'assetRef') {
        const r = coerceCell(field, v, { dateFormat, people: new Map(), assets: new Map(), options: new Map([[field.key, new Map(Object.entries(optionMap ?? {}))]]) });
        good = !('error' in r);
        if ('error' in r && !example) example = r.error;
      } else if (target === 'status') {
        good = type.statuses.some((s) => foldText(s.label) === foldText(v) || s.value === v);
        if (!good && !example) example = t('“{value}” is not a status of {type}', { value: v, type: type.name });
      }
      if (good) ok++;
      else bad++;
    }
    return { ok, bad, example };
  }, [field, target, values, dateFormat, optionMap, type]);
  if (target === 'skip') return null;
  if (field?.kind === 'user' || target === 'owner') return <p className="text-xs text-muted">{t('People are matched by email, username or full name in the next step.')}</p>;
  if (field?.kind === 'assetRef') return <p className="text-xs text-muted">{t('Items are matched by ID (HW-12) or exact name in the next step.')}</p>;
  return (
    <p className={cn('text-xs', stats.bad ? 'text-warning' : 'text-muted')}>
      {stats.bad
        ? t('{ok} ok · {bad} won’t fit — e.g. {example}', { ok: stats.ok.toLocaleString(intlLocale()), bad: stats.bad.toLocaleString(intlLocale()), example: tMaybe(stats.example) })
        : t('{ok} ok', { ok: stats.ok.toLocaleString(intlLocale()) })}
    </p>
  );
}

function OptionMapper({ field, values, map, onChange }: { field: Extract<FieldDefinition, { kind: 'select' | 'multiSelect' }>; values: string[]; map: Record<string, string | null>; onChange: (m: Record<string, string | null>) => void }) {
  const unknown = useMemo(() => {
    const out = new Set<string>();
    for (const v of values)
      for (const part of field.kind === 'multiSelect' ? v.split(/\s*[;,|]\s*/) : [v]) {
        const p = part.trim();
        if (p && !field.config.options.some((o) => foldText(o.label) === foldText(p) || o.value === p) && !(p in map)) out.add(p);
      }
    return [...out].slice(0, 30);
  }, [values, field, map]);
  const mapped = Object.keys(map);
  if (!unknown.length && !mapped.length) return null;
  return (
    <div className="space-y-1 rounded-lg bg-surface-2/60 p-2">
      <p className="text-xs text-muted">{t('Values that are not options of “{field}”:', { field: field.label })}</p>
      {[...unknown, ...mapped].map((v) => (
        <div key={v} className="flex items-center gap-2 text-xs">
          <span className="w-32 truncate">{v}</span>
          <Select
            className="h-7 text-xs"
            value={v in map ? (map[v] ?? '') : '__'}
            onChange={(e) => {
              const { [v]: _drop, ...rest } = map;
              onChange(e.target.value === '__' ? rest : { ...rest, [v]: e.target.value || null });
            }}
          >
            <option value="__">{t('Choose…')}</option>
            <option value="">{t('Leave empty')}</option>
            {field.config.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      ))}
    </div>
  );
}

/** Turn columns the template lacks into a team variant's fields (new variant, or added to the chosen one). */
function ExtendDialog({ table, type, columns, unitId, variantId, onClose, onDone }: { table: ParsedTable; type: AssetType; columns: number[]; unitId: string; variantId: string | null; onClose: () => void; onDone: (v: TypeVariant, keyByColumn: Map<number, string>) => void }) {
  const { unitById, variantById } = useLookups();
  const qc = useQueryClient();
  const current = variantId ? variantById.get(variantId) : undefined;
  const [name, setName] = useState(current?.name ?? `${unitById.get(unitId)?.name} ${type.name.toLowerCase()}`);
  const proposed = useMemo(() => {
    const taken = new Set([...type.fields, ...(current?.fields ?? [])].map((f) => f.key));
    return columns.map((i) => {
      const f = inferField(table.headers[i]!, table.rows.slice(0, 200).map((r) => r[i] ?? ''), taken);
      taken.add(f.key);
      return { col: i, field: { ...f, showInTable: true } };
    });
  }, [columns, table, type, current]);
  const save = useMutation({
    mutationFn: () => {
      const fields = [...(current?.fields ?? []), ...proposed.map((p) => p.field)];
      return current
        ? api.put<TypeVariant>(`/api/registry/variants/${current.id}`, { name: current.name, description: current.description, sections: current.sections, fields, version: current.version })
        : api.post<TypeVariant>(`/api/registry/asset-types/${type.id}/variants`, { unitId, name, description: t('Created while importing'), sections: [], fields });
    },
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: keys.variants });
      toast.success(current ? plural(proposed.length, 'Added {n} field to “{name}”', 'Added {n} fields to “{name}”', { name: v.name }) : t('“{name}” created', { name: v.name }), { description: t('Edit it any time from the unit’s Templates tab.') });
      onDone(v, new Map(proposed.map((p) => [p.col, p.field.key])));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('Could not save the team fields')),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={current ? t('Add fields to “{name}”', { name: current.name }) : t('Keep these columns as team fields')}
      description={t('A team variant of {type} for {unit}: the template stays the same for everyone else.', { type: type.name, unit: unitById.get(unitId)?.name ?? '' })}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>
            {current ? t('Add fields') : t('Create variant')}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        {!current && <Field label={t('Name of the variant')}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>}
        <ul className="divide-y divide-border rounded-lg border border-border">
          {proposed.map((p) => (
            <li key={p.col} className="flex items-center justify-between px-3 py-2">
              <span>{p.field.label}</span>
              <Badge>{tMaybe(fieldKindMeta[p.field.kind]?.label ?? p.field.kind)}</Badge>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}

// ─── 4. Review (dry run) ─────────────────────────────────────────────────────

function useRows({
  table,
  schema,
  type,
  dest,
  mapping,
  dateFormats,
  optionMaps,
  unitMap,
}: {
  table: ParsedTable;
  schema: AssetType;
  type: AssetType;
  dest: Destination;
  mapping: ImportTarget[];
  dateFormats: Record<number, DateFormat>;
  optionMaps: Record<string, Record<string, string | null>>;
  unitMap: Record<string, string | null>;
}) {
  const col = (t: ImportTarget) => mapping.indexOf(t);
  const peopleCols = mapping.map((t, i) => ({ t, i })).filter(({ t }) => t === 'owner' || (t.startsWith('field:') && schema.fields.find((f) => f.key === t.slice(6))?.kind === 'user'));
  const assetCols = mapping.map((t, i) => ({ t, i })).filter(({ t }) => t.startsWith('field:') && schema.fields.find((f) => f.key === t.slice(6))?.kind === 'assetRef');
  const peopleValues = useMemo(() => [...new Set(peopleCols.flatMap(({ i }) => table.rows.map((r) => (r[i] ?? '').trim())).filter(Boolean))], [table, peopleCols.map((c) => c.i).join()]);
  const assetValues = useMemo(() => [...new Set(assetCols.flatMap(({ i }) => table.rows.flatMap((r) => (r[i] ?? '').split(/\s*[\n;|,]\s*/).map((x) => x.trim()))).filter(Boolean))].slice(0, 300), [table, assetCols.map((c) => c.i).join()]);
  const people = useQuery({
    queryKey: ['import-people', peopleValues],
    queryFn: () => api.post<Record<string, UserSummary | null>>('/api/identity/people/resolve', { values: peopleValues.slice(0, 2000) }),
    enabled: peopleValues.length > 0,
    staleTime: Infinity,
  });
  const assets = useQuery({
    queryKey: ['import-assets', assetValues],
    queryFn: async () => {
      const out: Record<string, string | null> = {};
      for (const v of assetValues) {
        const page = await api.get<{ items: Array<{ id: string; name: string; reference: string }> }>('/api/registry/assets', { q: v, limit: 5, sort: 'relevance', order: 'desc' });
        const hit = page.items.find((a) => a.reference.toLowerCase() === v.toLowerCase()) ?? page.items.find((a) => a.name.toLowerCase() === v.toLowerCase());
        out[v] = hit?.id ?? null;
      }
      return out;
    },
    enabled: assetValues.length > 0,
    staleTime: Infinity,
  });
  const ready = (!peopleValues.length || !!people.data) && (!assetValues.length || !!assets.data);

  const rows = useMemo((): ImportRow[] => {
    if (!ready) return [];
    const peopleMap = new Map(Object.entries(people.data ?? {}).map(([k, v]) => [k, v?.id ?? null]));
    const assetMap = new Map(Object.entries(assets.data ?? {}));
    const options = new Map(Object.entries(optionMaps).map(([k, m]) => [k, new Map(Object.entries(m).filter(([, v]) => v !== undefined))]));
    const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
    return table.rows.slice(0, MAX_ROWS).map((r, n): ImportRow => {
      const issues: Record<string, string> = {};
      const attributes: Record<string, unknown> = {};
      mapping.forEach((t, i) => {
        if (!t.startsWith('field:')) return;
        const f = schema.fields.find((x) => x.key === t.slice(6));
        if (!f) return;
        const res = coerceCell(f, r[i] ?? '', { dateFormat: dateFormats[i] ?? 'iso', people: peopleMap, assets: assetMap, options });
        if ('error' in res) issues[f.key] = res.error;
        else if ('value' in res) attributes[f.key] = res.value;
      });
      const ownerCell = cell(r, col('owner'));
      const ownerId = ownerCell ? peopleMap.get(ownerCell) : undefined;
      if (ownerCell && !ownerId) issues.owner = t('No person matches “{value}”', { value: ownerCell });
      const statusCell = cell(r, col('status'));
      const status = statusCell ? type.statuses.find((s) => foldText(s.label) === foldText(statusCell) || s.value === statusCell)?.value : undefined;
      if (statusCell && !status) issues.status = t('“{value}” is not a status of {type}', { value: statusCell, type: type.name });
      const unitId = dest.unitMode === 'one' ? dest.unitId : (unitMap[cell(r, col('unit'))] ?? null);
      return {
        line: n + 2,
        name: cell(r, col('name')),
        unitId,
        ...(ownerCell ? { ownerId: ownerId ?? null } : {}),
        ...(status && { status }),
        ...(col('reference') >= 0 && { reference: cell(r, col('reference')) }),
        attributes,
        issues,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, table, schema, mapping, dateFormats, optionMaps, unitMap, dest, people.data, assets.data]);
  return { rows, ready };
}

async function sendInChunks(rows: ImportRow[], base: Omit<ImportRequest, 'rows' | 'batchId'>, onProgress: (done: number) => void): Promise<ImportResult> {
  const total: ImportResult = { batchId: null, rows: [], counts: { create: 0, update: 0, unchanged: 0, error: 0 } };
  for (let i = 0; i < rows.length; i += CHUNK) {
    const r = await api.post<ImportResult>('/api/registry/imports', { ...base, ...(total.batchId && { batchId: total.batchId }), rows: rows.slice(i, i + CHUNK) });
    total.batchId = r.batchId ?? total.batchId;
    total.rows.push(...r.rows);
    for (const k of Object.keys(total.counts) as Array<keyof ImportResult['counts']>) total.counts[k] += r.counts[k];
    onProgress(Math.min(rows.length, i + CHUNK));
  }
  return total;
}

function ReviewStep(props: {
  table: ParsedTable;
  fileName: string;
  type: AssetType;
  schema: AssetType;
  dest: Destination;
  mapping: ImportTarget[];
  dateFormats: Record<number, DateFormat>;
  optionMaps: Record<string, Record<string, string | null>>;
  unitMap: Record<string, string | null>;
  review: ImportResult | null;
  setReview: (r: ImportResult | null) => void;
  onBack: () => void;
  onDone: (r: ImportResult) => void;
}) {
  const { table, fileName, type, schema, dest, review, setReview, onBack, onDone } = props;
  const { rows, ready } = useRows(props);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState<'check' | 'import' | null>(null);
  const [skipProblems, setSkipProblems] = useState(true);
  const qc = useQueryClient();
  const base = { assetTypeId: type.id, variantId: dest.variantId, catalogId: dest.catalogId, mode: dest.mode, matchBy: dest.matchBy, fileName };

  const check = async () => {
    setRunning('check');
    setProgress(0);
    try {
      setReview(await sendInChunks(rows, { ...base, dryRun: true }, setProgress));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t('The check failed'));
    } finally {
      setRunning(null);
    }
  };
  useEffect(() => {
    if (ready && rows.length && !review && !running) void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, rows.length]);

  const problems = review?.rows.filter((r) => r.action === 'error') ?? [];
  const byLine = new Map(rows.map((r) => [r.line, r]));
  const problem = (k: string, m: string) =>
    k === 'row' ? m : t('{label}: {message}', { label: k === 'owner' ? t('Owner') : k === 'status' ? t('Status') : k === 'name' ? t('Name') : (schema.fields.find((f) => f.key === k)?.label ?? k), message: m });
  const good = review ? review.counts.create + review.counts.update + review.counts.unchanged : 0;

  const run = async () => {
    setRunning('import');
    setProgress(0);
    try {
      const okLines = new Set(review!.rows.filter((r) => r.action !== 'error').map((r) => r.line));
      const toSend = skipProblems ? rows.filter((r) => okLines.has(r.line)) : rows;
      const result = await sendInChunks(toSend, { ...base, dryRun: false }, setProgress);
      void qc.invalidateQueries({ queryKey: keys.assets });
      void qc.invalidateQueries({ queryKey: ['imports'] });
      setTimeout(() => void qc.invalidateQueries({ queryKey: keys.obligations }), 2000);
      onDone(result);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t('The import failed'));
    } finally {
      setRunning(null);
    }
  };

  return (
    <>
      <Card className="space-y-4">
        {!ready || running === 'check' || !review ? (
          <div className="space-y-2">
            <p className="text-[13px] font-medium">{!ready ? t('Matching people and linked items…') : t('Checking every row — {done} of {total}', { done: progress.toLocaleString(intlLocale()), total: rows.length.toLocaleString(intlLocale()) })}</p>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full bg-accent transition-all" style={{ width: `${rows.length ? (progress / rows.length) * 100 : 5}%` }} />
            </div>
            <p className="text-xs text-muted">{t('Nothing is saved yet: this runs the real import and throws it away, so what you see is exactly what will happen.')}</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <Summary tone="success" value={review.counts.create} label={t('new items')} />
              <Summary tone="accent" value={review.counts.update} label={t('updated')} />
              <Summary value={review.counts.unchanged} label={t('already up to date')} />
              <Summary tone={problems.length ? 'warning' : undefined} value={problems.length} label={t('with problems')} />
            </div>
            {problems.length > 0 && (
              <>
                <div className="max-h-80 overflow-auto rounded-lg border border-border">
                  <table className="w-full text-[13px]">
                    <thead className="sticky top-0 bg-surface-2 text-start text-xs text-muted">
                      <tr>
                        <th className="px-3 py-1.5 font-medium">{t('Row')}</th>
                        <th className="px-3 py-1.5 font-medium">{t('Name')}</th>
                        <th className="px-3 py-1.5 font-medium">{t('Problem')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {problems.slice(0, 300).map((p) => (
                        <tr key={p.line} className="border-t border-border align-top">
                          <td className="px-3 py-1.5 text-muted tabular-nums">{p.line}</td>
                          <td className="px-3 py-1.5">{byLine.get(p.line)?.name || <span className="text-muted">—</span>}</td>
                          <td className="px-3 py-1.5 text-warning">
                            {Object.entries(p.errors ?? {}).map(([k, m]) => (
                              <span key={k} className="block">
                                {problem(k, m)}
                              </span>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Segmented
                    value={skipProblems ? 'skip' : 'stop'}
                    onChange={(v) => setSkipProblems(v === 'skip')}
                    options={[
                      { value: 'skip', label: plural(good, 'Import the {n} good row', 'Import the {n} good rows') },
                      { value: 'stop', label: t('Fix the file first') },
                    ]}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      downloadCsv(
                        t('{file} problems', { file: fileName.replace(/\.[^.]+$/, '') }),
                        [t('Row'), ...table.headers, t('Problems')],
                        problems.map((p) => [p.line, ...(table.rows[p.line - 2] ?? []), Object.entries(p.errors ?? {}).map(([k, m]) => problem(k, m)).join(' | ')]),
                      )
                    }
                  >
                    {t('Download problem rows (CSV)')}
                  </Button>
                </div>
              </>
            )}
            {running === 'import' && (
              <div className="space-y-1">
                <p className="text-[13px] font-medium">{plural(progress, 'Importing — {n} row done', 'Importing — {n} rows done')}</p>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full bg-success transition-all" style={{ width: `${(progress / Math.max(1, skipProblems ? good : rows.length)) * 100}%` }} />
                </div>
              </div>
            )}
          </>
        )}
      </Card>
      <Nav
        onBack={running ? undefined : onBack}
        onNext={review && (good > 0 || (!skipProblems && rows.length)) && !running ? (skipProblems || !problems.length ? run : undefined) : undefined}
        nextLabel={plural(skipProblems ? good : rows.length, 'Import {n} {type}', 'Import {n} {type}s', { type: inSentence(type.name) })}
        hint={review ? t(dest.catalogId ? 'Into {type}, in the chosen catalog' : 'Into {type}', { type: schema.name }) : undefined}
      />
    </>
  );
}

function Summary({ value, label, tone }: { value: number; label: string; tone?: 'success' | 'accent' | 'warning' }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <p className={cn('text-xl font-semibold tabular-nums', tone === 'success' && 'text-success', tone === 'accent' && 'text-accent', tone === 'warning' && 'text-warning')}>{value.toLocaleString(intlLocale())}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}

// ─── 5. Done ─────────────────────────────────────────────────────────────────

function DoneStep({ result, type, onAgain }: { result: ImportResult; type: AssetType; onAgain: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [undone, setUndone] = useState(false);
  const undo = useMutation({
    mutationFn: () => api.delete<{ removed: number }>(`/api/registry/imports/${result.batchId}`),
    onSuccess: (r) => {
      setUndone(true);
      toast.success(plural(r.removed, 'Undone — {n} item removed', 'Undone — {n} items removed'));
      void qc.invalidateQueries({ queryKey: keys.assets });
      void qc.invalidateQueries({ queryKey: ['imports'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('Undo failed')),
  });
  return (
    <Card className="space-y-4 text-center">
      <CheckCircle2 className="mx-auto size-8 text-success" />
      <div>
        <p className="text-[15px] font-semibold">{undone ? t('Import undone') : t('Imported')}</p>
        <p className="text-[13px] text-muted">
          {t(result.counts.error ? '{added} added · {updated} updated · {unchanged} unchanged · {skipped} skipped' : '{added} added · {updated} updated · {unchanged} unchanged', {
            added: result.counts.create.toLocaleString(intlLocale()),
            updated: result.counts.update.toLocaleString(intlLocale()),
            unchanged: result.counts.unchanged.toLocaleString(intlLocale()),
            skipped: result.counts.error.toLocaleString(intlLocale()),
          })}
        </p>
        <p className="mt-1 text-xs text-muted">{t('Their dates are being picked up for reminders now. Each item’s history shows it came from this import.')}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {!undone && result.counts.create > 0 && (
          <Button variant="primary" onClick={() => void navigate({ to: '/assets', search: { type: type.id, import: result.batchId ?? undefined } })}>
            {t('See the new items')}
          </Button>
        )}
        {!undone && result.counts.create > 0 && (
          <Button icon={<Undo2 className="size-3.5" />} loading={undo.isPending} onClick={() => undo.mutate()}>
            {t('Undo import')}
          </Button>
        )}
        <Button variant="ghost" onClick={onAgain}>
          {t('Import another table')}
        </Button>
      </div>
    </Card>
  );
}
