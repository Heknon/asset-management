/**
 * The backup file: a zip the web app assembles from each service's data and
 * takes apart again for a restore.
 *
 *   manifest.json            what is inside, and which version made it
 *   <service>/<table>.csv    one file per table, every value as Postgres text
 *   documents/<object key>   the stored documents (optional)
 */

export const BACKUP_FORMAT = 1;
export const BACKUP_APP = 'asset-management';
/** Each service backs up and restores its own data; the order is also the order they are restored in (sign-in data last). */
export const backupServices = ['registry', 'scheduler', 'files', 'identity'] as const;
export type BackupService = (typeof backupServices)[number];

export interface BackupColumn {
  name: string;
  /** As Postgres spells it (`uuid`, `text[]`, `timestamp with time zone`). */
  type: string;
}

export interface BackupTable {
  name: string;
  columns: BackupColumn[];
  rows: number;
}

/** One service's part: `GET /api/<service>/backup/info`, and per service in the manifest. */
export interface ServiceBackupInfo {
  service: string;
  /** Applied migrations, in order: the schema version. A backup is only restored into the same one. */
  migrations: string[];
  tables: BackupTable[];
}

export interface BackupManifest {
  format: number;
  app: string;
  createdAt: string;
  createdBy: string;
  /** Address of the installation it was taken from. */
  origin: string;
  services: Record<string, Omit<ServiceBackupInfo, 'service'>>;
  documents: {
    /** Whether the documents' bytes are in the file (their rows always are). */
    included: boolean;
    count: number;
    bytes: number;
    /** Documents storage no longer had when the backup was taken. */
    missing: number;
  };
}

export const backupTablePath = (service: string, table: string) => `${service}/${table}.csv`;
export const backupDocumentPath = (objectKey: string) => `documents/${objectKey}`;

/**
 * CSV as Postgres COPY writes it: an empty cell is NULL, `""` is an empty
 * text. Values are never altered (no spreadsheet-formula escaping), so a
 * restore gets back exactly what was stored.
 */
const backupCsvCell = (value: string | null) => (value === null ? '' : value === '' || /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export const backupCsvLine = (cells: readonly (string | null)[]) => `${cells.map(backupCsvCell).join(',')}\r\n`;

/** Rows of a backup CSV, header first. Tells NULL (empty) from empty text (`""`). */
export function* parseBackupCsv(text: string): Generator<(string | null)[]> {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  let row: (string | null)[] = [];
  while (i < n) {
    // One cell.
    if (text[i] === '"') {
      let value = '';
      i++;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q < 0) throw new Error('A quoted value is not closed');
        value += text.slice(i, q);
        i = q + 1;
        if (text[i] !== '"') break;
        value += '"';
        i++;
      }
      row.push(value);
    } else {
      let end = i;
      while (end < n && text[end] !== ',' && text[end] !== '\n' && text[end] !== '\r') end++;
      row.push(end === i ? null : text.slice(i, end));
      i = end;
    }
    // What follows it.
    if (text[i] === ',') {
      i++;
      // A comma at the very end of the text still opens a last, empty cell.
      if (i === n) row.push(null);
      continue;
    }
    if (text[i] === '\r') i++;
    if (text[i] === '\n') i++;
    else if (i < n && text[i - 1] !== '\r') throw new Error('Unexpected text after a quoted value');
    yield row;
    row = [];
  }
  if (row.length) yield row;
}
