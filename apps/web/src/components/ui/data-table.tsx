import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Skeleton } from './display';

export interface SortState {
  sort: string;
  order: 'asc' | 'desc';
}

/** Server-driven table: sorting and paging are owned by the caller (and the API). */
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
  columns: Array<ColumnDef<T, unknown> & { meta?: { sortKey?: string; align?: 'right'; width?: number } }>;
  data: T[];
  loading?: boolean;
  onRowClick?: (row: T) => void;
  sort?: SortState;
  onSortChange?: (s: SortState) => void;
  page?: { offset: number; limit: number; total: number; onChange: (offset: number) => void };
  empty?: ReactNode;
  rowKey: (row: T) => string;
}) {
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel(), manualSorting: true, getRowId: rowKey });

  return (
    <div className="flex min-h-0 flex-col">
      <div className="min-h-0 overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead className="sticky top-0 z-10 bg-bg">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const meta = (h.column.columnDef as { meta?: { sortKey?: string; align?: 'right'; width?: number } }).meta;
                  const active = sort && meta?.sortKey === sort.sort;
                  return (
                    <th
                      key={h.id}
                      style={{ width: meta?.width }}
                      className={cn('h-9 border-b border-border px-3 text-left text-xs font-medium whitespace-nowrap text-muted first:pl-6 last:pr-6', meta?.align === 'right' && 'text-right')}
                    >
                      {meta?.sortKey && onSortChange ? (
                        <button
                          type="button"
                          className={cn('inline-flex items-center gap-1 hover:text-fg', active && 'text-fg')}
                          onClick={() => onSortChange({ sort: meta.sortKey!, order: active && sort.order === 'asc' ? 'desc' : 'asc' })}
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {active && (sort.order === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
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
            {loading && !data.length
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
                      const meta = (cell.column.columnDef as { meta?: { align?: 'right' } }).meta;
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
        {!loading && !data.length && empty}
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
