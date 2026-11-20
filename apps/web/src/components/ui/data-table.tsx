import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronLeft, ChevronRight, Download, Minus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { downloadCsv } from '@/lib/download';
import { useFeatures } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Skeleton } from './display';
import { Select } from './form';
import { useMediaQuery } from '@/lib/hooks';
import { useShortcut } from '@/lib/shortcuts';
import type { Table } from '@tanstack/react-table';

export interface SortState {
  sort: string;
  order: 'asc' | 'desc';
}

export interface ColumnMeta<T> {
  /** Sort key sent to the API (server mode) or used for local sorting (client mode). */
  sortKey?: string;
  /** Client mode: the value a column sorts by. Strings compare naturally and case-insensitively. */
  sortValue?: (row: T) => string | number | null | undefined;
  /** CSV export value (defaults to sortValue). Columns with neither are left out of client exports. */
  csvValue?: (row: T) => unknown;
  align?: 'right';
  width?: number;
  /** Phones show each row as a card: the first column is its title, the next few its details. `false` leaves a column off the card. */
  phone?: boolean;
}

/** Details shown under a card's title on phones. */
const PHONE_DETAILS = 3;
export type DataColumn<T> = ColumnDef<T, unknown> & { meta?: ColumnMeta<T> };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function compare(a: string | number | null | undefined, b: string | number | null | undefined): number {
  if (a == null || a === '') return b == null || b === '' ? 0 : 1;
  if (b == null || b === '') return -1;
  return typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b));
}

/**
 * Sorting is either server-driven (pass `sort` + `onSortChange`; the API orders and pages)
 * or client-side (omit them; columns with `meta.sortValue` sort the loaded rows).
 * Either way a header click sorts ascending, then descending; empty values stay last.
 */
export function DataTable<T>({
  columns,
  data,
  loading,
  onRowClick,
  sort,
  onSortChange,
  page,
  empty,
  rowKey,
  selection,
}: {
  columns: Array<DataColumn<T>>;
  data: T[];
  loading?: boolean;
  onRowClick?: (row: T) => void;
  sort?: SortState;
  onSortChange?: (s: SortState) => void;
  page?: { offset: number; limit: number; total: number; onChange: (offset: number) => void };
  empty?: ReactNode;
  rowKey: (row: T) => string;
  /** Checkboxes on rows (Shift-click for a range, X for the highlighted row); the caller acts on what is selected. */
  selection?: { selected: ReadonlySet<string>; onChange: (next: Set<string>) => void };
}) {
  const serverMode = !!onSortChange;
  const [localSort, setLocalSort] = useState<SortState | undefined>(sort);
  const activeSort = serverMode ? sort : localSort;
  const sortable = (meta?: ColumnMeta<T>) => !!meta?.sortKey && (serverMode || !!meta.sortValue);

  const rows = useMemo(() => {
    if (serverMode || !localSort) return data;
    const col = columns.find((c) => c.meta?.sortKey === localSort.sort)?.meta?.sortValue;
    if (!col) return data;
    const dir = localSort.order === 'asc' ? 1 : -1;
    return [...data].sort((a, b) => {
      const va = col(a);
      const vb = col(b);
      // Empty values sink regardless of direction.
      if (va == null || va === '' || vb == null || vb === '') return compare(va, vb);
      return dir * compare(va, vb);
    });
  }, [serverMode, localSort, data, columns]);

  const changeSort = (key: string) => {
    const next: SortState = { sort: key, order: activeSort?.sort === key && activeSort.order === 'asc' ? 'desc' : 'asc' };
    if (serverMode) onSortChange(next);
    else setLocalSort(next);
  };

  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel(), manualSorting: true, getRowId: rowKey });
  const phone = useMediaQuery('(max-width: 639px)');
  // J / K move a row cursor, Enter opens it: whole lists without the mouse.
  const [cursor, setCursor] = useState<number | null>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const keyboard = !!onRowClick && !phone;
  const moveCursor = (d: 1 | -1) =>
    setCursor((c) => {
      const n = Math.max(0, Math.min(rows.length - 1, c === null ? (d === 1 ? 0 : rows.length - 1) : c + d));
      bodyRef.current?.children[n]?.scrollIntoView({ block: 'nearest' });
      return n;
    });
  useShortcut('j', keyboard && rows.length ? () => moveCursor(1) : null);
  useShortcut('k', keyboard && rows.length ? () => moveCursor(-1) : null);
  useShortcut('enter', keyboard && cursor !== null ? () => rows[cursor] && onRowClick(rows[cursor]) : null);
  useEffect(() => setCursor(null), [data]);
  const lastToggled = useRef<number | null>(null);
  const toggle = (i: number, range = false) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    const on = !next.has(rowKey(rows[i]!));
    const [a, b] = range && lastToggled.current !== null ? [Math.min(lastToggled.current, i), Math.max(lastToggled.current, i)] : [i, i];
    for (let k = a; k <= b; k++) (on ? next.add(rowKey(rows[k]!)) : next.delete(rowKey(rows[k]!)));
    lastToggled.current = i;
    selection.onChange(next);
  };
  useShortcut('x', selection && cursor !== null ? () => toggle(cursor) : null);
  const pageKeys = rows.map(rowKey);
  const allOnPage = !!selection && pageKeys.length > 0 && pageKeys.every((k) => selection.selected.has(k));
  const someOnPage = !!selection && pageKeys.some((k) => selection.selected.has(k));
  const selectCell = 'w-10 border-b border-border px-0 pl-4 sm:pl-6';

  return (
    <div className="flex min-h-0 flex-col">
      {phone ? (
        <PhoneList table={table} columns={columns} loading={loading} empty={empty} onRowClick={onRowClick} selection={selection} activeSort={activeSort} sortable={sortable} onSort={(key, order) => (serverMode ? onSortChange({ sort: key, order }) : setLocalSort({ sort: key, order }))} />
      ) : (
      <div className="min-h-0 overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead className="sticky top-0 z-10 bg-bg">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {selection && (
                  <th className={cn('h-9 bg-bg text-left', selectCell)}>
                    <RowCheck
                      label="Select all on this page"
                      checked={allOnPage}
                      mixed={someOnPage && !allOnPage}
                      onChange={() => {
                        const next = new Set(selection.selected);
                        pageKeys.forEach((k) => (allOnPage ? next.delete(k) : next.add(k)));
                        selection.onChange(next);
                      }}
                    />
                  </th>
                )}
                {hg.headers.map((h) => {
                  const meta = (h.column.columnDef as DataColumn<T>).meta;
                  const active = !!activeSort && meta?.sortKey === activeSort.sort;
                  const Arrow = !active ? ArrowUpDown : activeSort.order === 'asc' ? ArrowUp : ArrowDown;
                  return (
                    <th
                      key={h.id}
                      style={{ width: meta?.width }}
                      aria-sort={active ? (activeSort.order === 'asc' ? 'ascending' : 'descending') : undefined}
                      className={cn('h-9 border-b border-border bg-bg px-3 text-left max-lg:first:sticky max-lg:first:left-0 max-lg:first:z-[1] text-xs font-medium whitespace-nowrap text-muted first:pl-4 last:pr-4 sm:first:pl-6 sm:last:pr-6', meta?.align === 'right' && 'text-right')}
                    >
                      {sortable(meta) ? (
                        <button
                          type="button"
                          title={`Sort by ${typeof h.column.columnDef.header === 'string' ? h.column.columnDef.header.toLowerCase() : 'this column'}`}
                          className={cn('group/sort -mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-surface-2 hover:text-fg', meta?.align === 'right' && 'flex-row-reverse', active && 'text-fg')}
                          onClick={() => changeSort(meta!.sortKey!)}
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          <Arrow className={cn('size-3 shrink-0', !active && 'opacity-0 transition-opacity group-hover/sort:opacity-60')} />
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody ref={bodyRef}>
            {loading && !rows.length
              ? Array.from({ length: 6 }, (_, i) => (
                  <tr key={i}>
                    {selection && <td className={selectCell} />}
                    {columns.map((_, j) => (
                      <td key={j} className="h-11 border-b border-border px-3 first:pl-4 last:pr-4 sm:first:pl-6 sm:last:pr-6">
                        <Skeleton className="h-3.5 w-3/4" />
                      </td>
                    ))}
                  </tr>
                ))
              : table.getRowModel().rows.map((row, i) => (
                  <tr key={row.id} onClick={onRowClick ? () => onRowClick(row.original) : undefined} data-cursor={cursor === i || undefined} data-selected={selection?.selected.has(row.id) || undefined} className={cn('group', onRowClick && 'cursor-pointer')}>
                    {selection && (
                      <td className={cn('h-11 transition-colors group-hover:bg-surface-2/60 group-data-[selected]:bg-accent-soft', selectCell)} onMouseDown={(e) => e.shiftKey && e.preventDefault()} onClick={(e) => (e.stopPropagation(), toggle(i, e.shiftKey))}>
                        <RowCheck label="Select" checked={selection.selected.has(row.id)} onChange={() => undefined} />
                      </td>
                    )}
                    {row.getVisibleCells().map((cell) => {
                      const meta = (cell.column.columnDef as DataColumn<T>).meta;
                      return (
                        <td key={cell.id} className={cn('h-11 border-b border-border px-3 whitespace-nowrap transition-colors max-lg:first:sticky max-lg:first:left-0 max-lg:first:z-[1] max-lg:first:max-w-[62vw] max-lg:first:overflow-hidden max-lg:first:bg-bg max-lg:first:shadow-[1px_0_0_var(--border)] first:pl-4 last:pr-4 sm:first:pl-6 sm:last:pr-6 group-hover:bg-surface-2/60 group-data-[selected]:bg-accent-soft group-data-[cursor]:bg-accent-soft/50 group-data-[cursor]:first:shadow-[inset_2px_0_0_var(--accent)]', meta?.align === 'right' && 'text-right tabular-nums')}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      );
                    })}
                  </tr>
                ))}
          </tbody>
        </table>
        {!loading && !rows.length && empty}
      </div>
      )}
      {page && page.total > page.limit && (
        <div className="flex items-center justify-between border-t border-border px-4 sm:px-6 py-2 text-xs text-muted">
          <span>
            {page.offset + 1}–{Math.min(page.offset + page.limit, page.total)} of {page.total}
          </span>
          <div className="flex gap-1">
            <Button size="icon" variant="ghost" aria-label="Previous page" disabled={page.offset === 0} onClick={() => page.onChange(Math.max(0, page.offset - page.limit))} icon={<ChevronLeft className="size-4" />} />
            <Button size="icon" variant="ghost" aria-label="Next page" disabled={page.offset + page.limit >= page.total} onClick={() => page.onChange(page.offset + page.limit)} icon={<ChevronRight className="size-4" />} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "Export CSV" for any table. Hidden when the deployment turns exports off.
 * Server tables pass a download URL; client tables use `exportRows`.
 */
export function ExportButton({ onExport, disabled }: { onExport: () => void; disabled?: boolean }) {
  const features = useFeatures();
  if (!features.data?.csvExport) return null;
  return (
    <Button variant="ghost" icon={<Download className="size-3.5" />} disabled={disabled} onClick={onExport} title="Download what this table shows — every page, with your filters and sorting — as a spreadsheet file">
      Export CSV
    </Button>
  );
}

/** Client-side export of loaded rows, using each column's header and csvValue/sortValue. */
export function exportRows<T>(title: string, columns: Array<DataColumn<T>>, rows: T[]): void {
  const cols = columns.filter((c) => c.meta?.csvValue || c.meta?.sortValue);
  downloadCsv(
    title,
    cols.map((c) => (typeof c.header === 'string' ? c.header : (c.id ?? ''))),
    rows.map((r) => cols.map((c) => (c.meta!.csvValue ?? c.meta!.sortValue)!(r))),
  );
}

/** A table's rows as cards, for phones: title from the first column, a line of details from the next ones, and a sort menu. */
function PhoneList<T>({
  table,
  columns,
  loading,
  empty,
  onRowClick,
  activeSort,
  sortable,
  onSort,
  selection,
}: {
  selection?: { selected: ReadonlySet<string>; onChange: (next: Set<string>) => void };
  table: Table<T>;
  columns: Array<DataColumn<T>>;
  loading?: boolean;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  activeSort?: SortState;
  sortable: (meta?: ColumnMeta<T>) => boolean;
  onSort: (key: string, order: SortState['order']) => void;
}) {
  const sortColumns = columns.filter((c) => sortable(c.meta) && typeof c.header === 'string');
  const rows = table.getRowModel().rows;
  // Phones: "Select" turns taps into ticks; it ends when nothing is selected any more.
  const [picking, setPicking] = useState(false);
  const selecting = !!selection && (picking || selection.selected.size > 0);
  const tick = (id: string) => {
    const next = new Set(selection!.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (!next.size) setPicking(false);
    selection!.onChange(next);
  };
  return (
    <div>
      {(sortColumns.length > 0 || selection) && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted">
          {selection && rows.length > 0 && (
            <button type="button" className="order-last ml-auto h-8 rounded-md px-2 text-[13px] font-medium text-accent-fg" onClick={() => (selecting ? (setPicking(false), selection.onChange(new Set())) : setPicking(true))}>
              {selecting ? 'Cancel' : 'Select'}
            </button>
          )}
          <span>Sort by</span>
          {sortColumns.length > 0 && (
          <Select
            aria-label="Sort by"
            className="w-auto"
            value={activeSort ? `${activeSort.sort}:${activeSort.order}` : ''}
            onChange={(e) => {
              const [key, order] = e.target.value.split(':');
              if (key) onSort(key, order as SortState['order']);
            }}
          >
            {!activeSort && <option value="">Default</option>}
            {sortColumns.flatMap((c) => [
              <option key={`${c.meta!.sortKey}:asc`} value={`${c.meta!.sortKey}:asc`}>
                {String(c.header)} ↑
              </option>,
              <option key={`${c.meta!.sortKey}:desc`} value={`${c.meta!.sortKey}:desc`}>
                {String(c.header)} ↓
              </option>,
            ])}
          </Select>
          )}
        </div>
      )}
      {loading && !rows.length ? (
        <div className="space-y-3 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : !rows.length ? (
        empty
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => {
            const cells = row.getVisibleCells().filter((c) => (c.column.columnDef as DataColumn<T>).meta?.phone !== false);
            const [title, ...rest] = cells;
            return (
              <li key={row.id}>
                <div
                  role={onRowClick ? 'button' : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={selecting ? () => tick(row.id) : onRowClick ? () => onRowClick(row.original) : undefined}
                  onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(row.original) : undefined}
                  aria-pressed={selecting ? selection!.selected.has(row.id) : undefined}
                  className={cn('flex gap-3 px-4 py-3 text-[13px]', (onRowClick || selecting) && 'cursor-pointer active:bg-surface-2', selecting && selection!.selected.has(row.id) && 'bg-accent-soft/40')}
                >
                  {selecting && <RowCheck label="Select" checked={selection!.selected.has(row.id)} onChange={() => undefined} className="mt-0.5" />}
                  <div className="min-w-0 flex-1 space-y-1">
                  {title && <div className="min-w-0 font-medium [&_*]:max-w-full">{flexRender(title.column.columnDef.cell, title.getContext())}</div>}
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    {rest.slice(0, PHONE_DETAILS).map((c) => {
                      const def = c.column.columnDef as DataColumn<T>;
                      // Numbers mean nothing without their column's name.
                      const label = def.meta?.align === 'right' && typeof def.header === 'string' ? def.header : null;
                      return (
                        <span key={c.id} className="inline-flex min-w-0 max-w-full items-center gap-1 [&>*]:min-w-0">
                          {label && <span className="text-subtle">{label}</span>}
                          <span className={label ? 'font-medium text-fg tabular-nums' : 'contents'}>{flexRender(def.cell, c.getContext())}</span>
                        </span>
                      );
                    })}
                  </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A row's tick box. The row handles the click, so this only shows the state. */
function RowCheck({ checked, mixed, onChange, label, className }: { checked: boolean; mixed?: boolean; onChange: () => void; label: string; className?: string }) {
  return (
    <span
      role="checkbox"
      aria-checked={mixed ? 'mixed' : checked}
      aria-label={label}
      tabIndex={-1}
      onClick={onChange}
      className={cn('flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border transition-colors touch:size-5', checked || mixed ? 'border-accent bg-accent text-white' : 'border-border-strong bg-surface', className)}
    >
      {checked ? <Check className="size-3" strokeWidth={3} /> : mixed ? <Minus className="size-3" strokeWidth={3} /> : null}
    </span>
  );
}
