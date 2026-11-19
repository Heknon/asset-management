import type { AttributeValue as Value, FieldDefinition } from '@am/core';
import { Link } from '@tanstack/react-router';
import { Eye, EyeOff, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { useAsset, useAssets } from '@/lib/queries';
import { formatDate, formatMoney, relativeDays } from '@/lib/utils';
import { Badge } from './ui/display';
import { Checkbox, Input, Select, Textarea } from './ui/form';
import { PersonName, PersonPicker } from './pickers';

/** Read-only rendering of any attribute value; used in tables, detail pages and previews. */
export function AttributeValue({ field, value, compact }: { field: FieldDefinition; value: Value | undefined; compact?: boolean }) {
  // Callers decide visibility of restricted fields; an empty value is simply empty.
  if (value === undefined || value === null || value === '') return <span className="text-subtle">—</span>;
  switch (field.kind) {
    case 'currency':
      return <span className="tabular-nums">{formatMoney(value as number, field.config.currency)}</span>;
    case 'number':
      return (
        <span className="tabular-nums">
          {(value as number).toLocaleString()}
          {field.config.unit && <span className="ml-0.5 text-subtle">{field.config.unit}</span>}
        </span>
      );
    case 'date':
      return (
        <span className="tabular-nums">
          {formatDate(value as string, compact)}
          {!compact && <span className="ml-1.5 text-xs text-subtle">{relativeDays(value as string)}</span>}
        </span>
      );
    case 'boolean':
      return <span>{value ? 'Yes' : 'No'}</span>;
    case 'select': {
      const o = field.config.options.find((x) => x.value === value);
      return <Badge color={o?.color ?? '#94a3b8'}>{o?.label ?? String(value)}</Badge>;
    }
    case 'multiSelect':
      return (
        <span className="inline-flex flex-wrap gap-1">
          {(value as string[]).map((v) => {
            const o = field.config.options.find((x) => x.value === v);
            return (
              <Badge key={v} color={o?.color ?? '#94a3b8'}>
                {o?.label ?? v}
              </Badge>
            );
          })}
        </span>
      );
    case 'user':
      return <PersonName id={value as string} />;
    case 'url':
      return (
        <a href={value as string} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} className="inline-flex max-w-full items-center gap-1 truncate text-accent-fg hover:underline">
          {new URL(value as string).host}
          <ExternalLink className="size-3 shrink-0" />
        </a>
      );
    case 'email':
      return (
        <a href={`mailto:${value}`} className="text-accent-fg hover:underline" onClick={(e) => e.stopPropagation()}>
          {value as string}
        </a>
      );
    case 'secret':
      return <SecretValue value={value as string} />;
    case 'assetRef':
      return <AssetRefValue id={value as string} />;
    case 'longText':
      return <span className={compact ? 'block max-w-64 truncate' : 'whitespace-pre-wrap'}>{value as string}</span>;
    default:
      return <span className={compact ? 'block max-w-64 truncate' : ''}>{String(value)}</span>;
  }
}

function SecretValue({ value }: { value: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs">
      {shown ? value : '••••••••'}
      <button type="button" className="text-subtle hover:text-fg" onClick={(e) => (e.stopPropagation(), setShown((s) => !s))} aria-label={shown ? 'Hide' : 'Reveal'}>
        {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </span>
  );
}

function AssetRefValue({ id }: { id: string }) {
  const a = useAsset(id);
  return (
    <Link to="/assets/$assetId" params={{ assetId: id }} className="text-accent-fg hover:underline" onClick={(e) => e.stopPropagation()}>
      {a.data?.name ?? '…'}
    </Link>
  );
}

/** Editing control for any field kind. */
export function AttributeInput({ field, value, onChange, id, invalid }: { field: FieldDefinition; value: unknown; onChange: (v: unknown) => void; id: string; invalid?: boolean }) {
  const common = { id, 'aria-invalid': invalid || undefined };
  switch (field.kind) {
    case 'text':
      return <Input {...common} value={(value as string) ?? ''} placeholder={field.config.placeholder} maxLength={field.config.maxLength} onChange={(e) => onChange(e.target.value)} />;
    case 'longText':
      return <Textarea {...common} value={(value as string) ?? ''} maxLength={field.config.maxLength} onChange={(e) => onChange(e.target.value)} />;
    case 'secret':
      return <Input {...common} type="password" autoComplete="off" className="font-mono" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'url':
      return <Input {...common} type="url" placeholder="https://" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'email':
      return <Input {...common} type="email" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'number':
    case 'currency':
      return (
        <div className="relative">
          <Input
            {...common}
            type="number"
            step={field.kind === 'currency' ? '0.01' : field.config.integer ? '1' : 'any'}
            className={field.kind === 'currency' ? 'pl-12' : undefined}
            value={value === undefined || value === null ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          />
          {field.kind === 'currency' && <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-xs text-subtle">{field.config.currency}</span>}
        </div>
      );
    case 'date':
      return <Input {...common} type="date" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)} />;
    case 'boolean':
      return <Checkbox checked={value === true} onChange={onChange} label={field.label} />;
    case 'select':
      return (
        <Select {...common} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">—</option>
          {field.config.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      );
    case 'multiSelect': {
      const selected = new Set((value as string[]) ?? []);
      return (
        <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
          {field.config.options.map((o) => (
            <Checkbox
              key={o.value}
              checked={selected.has(o.value)}
              label={o.label}
              onChange={(c) => {
                const next = new Set(selected);
                if (c) next.add(o.value);
                else next.delete(o.value);
                onChange([...next]);
              }}
            />
          ))}
        </div>
      );
    }
    case 'user':
      return <PersonPicker id={id} value={(value as string) ?? null} onChange={(v) => onChange(v ?? undefined)} />;
    case 'assetRef':
      return <AssetRefInput id={id} typeId={field.config.assetTypeId} value={(value as string) ?? ''} onChange={(v) => onChange(v || undefined)} />;
  }
}

function AssetRefInput({ id, typeId, value, onChange }: { id: string; typeId?: string; value: string; onChange: (v: string) => void }) {
  const assets = useAssets({ assetTypeId: typeId, limit: 500, sort: 'name', order: 'asc' });
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {(assets.data?.items ?? []).map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </Select>
  );
}
