import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Skeleton } from './display';

export interface SortState {
  sort: string;
  order: 'asc' | 'desc';
}

export interface ColumnMeta<T> {
  /** Sort key sent to the API (server mode) or used for local sorting (client mode). */
  sortKey?: string;
  /** Client mode: the value a column sorts by. Strings compare naturally and case-insensitively. */
  sortValue?: (row: T) => string | number | null | undefined;
  align?: 'right';
  width?: number;
}
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

  return (
    <div className="flex min-h-0 flex-col">
      <div className="min-h-0 overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead className="sticky top-0 z-10 bg-bg">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const meta = (h.column.columnDef as DataColumn<T>).meta;
                  const active = !!activeSort && meta?.sortKey === activeSort.sort;
                  const Arrow = !active ? ArrowUpDown : activeSort.order === 'asc' ? ArrowUp : ArrowDown;
                  return (
                    <th
                      key={h.id}
                      style={{ width: meta?.width }}
                      aria-sort={active ? (activeSort.order === 'asc' ? 'ascending' : 'descending') : undefined}
                      className={cn('h-9 border-b border-border px-3 text-left text-xs font-medium whitespace-nowrap text-muted first:pl-6 last:pr-6', meta?.align === 'right' && 'text-right')}
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
          <tbody>
            {loading && !rows.length
              ? Array.from({ length: 6 }, (_, i) => (
                  <tr key={i}>
                    {columns.map((_, j) => (
                      <td key={j} className="h-11 border-b border-border px-3 first:pl-6 last:pr-6">
                        <Skeleton className="h-3.5 w-3/4" />
                      </td>
                    ))}
                  </tr>
                ))
              : table.getRowModel().rows.map((row) => (
                  <tr key={row.id} onClick={onRowClick ? () => onRowClick(row.original) : undefined} className={cn('group', onRowClick && 'cursor-pointer')}>
                    {row.getVisibleCells().map((cell) => {
                      const meta = (cell.column.columnDef as DataColumn<T>).meta;
                      return (
                        <td key={cell.id} className={cn('h-11 border-b border-border px-3 whitespace-nowrap transition-colors first:pl-6 last:pr-6 group-hover:bg-surface-2/60', meta?.align === 'right' && 'text-right tabular-nums')}>
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
      {page && page.total > page.limit && (
        <div className="flex items-center justify-between border-t border-border px-6 py-2 text-xs text-muted">
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
