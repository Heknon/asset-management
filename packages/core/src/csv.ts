/**
 * CSV for spreadsheets (RFC 4180, CRLF). Shared by the server-side export and
 * client-side table exports so both behave the same.
 */

/** Excel needs a byte-order mark to read UTF-8 (names in Hebrew, accents…). */
export const CSV_BOM = '﻿';

/**
 * Quotes when needed, and neutralises cells a spreadsheet would run as a
 * formula (=, +, -, @, tab, CR at the start: "CSV injection").
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (cells: readonly unknown[]) => `${cells.map(csvCell).join(',')}\r\n`;

/** A file name safe on every OS: "Software licenses 2026-11-19.csv". */
export function csvFilename(title: string, date: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'export';
  return `${base} ${date}.csv`;
}
