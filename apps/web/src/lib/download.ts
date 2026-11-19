import { CSV_BOM, csvFilename, csvLine } from '@am/core';
import { todayIso } from './utils';

/** Starts a browser download of a same-origin URL (the session cookie goes with it). */
export function downloadUrl(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** CSV built in the browser for tables whose rows are already loaded; same format as server exports. */
export function downloadCsv(title: string, header: string[], rows: unknown[][]): void {
  const body = CSV_BOM + csvLine(header) + rows.map(csvLine).join('');
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = csvFilename(title, todayIso());
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
