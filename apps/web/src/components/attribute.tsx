import type { AttributeValue as Value, FieldDefinition, LoginValue } from '@am/core';
import { Link } from '@tanstack/react-router';
import { Copy, Eye, EyeOff, ExternalLink, KeyRound, Link2, Lock, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { useState, type ReactNode } from 'react';
import { useAsset, useAssets } from '@/lib/queries';
import { cn, formatDate, formatMoney, relativeDays } from '@/lib/utils';
import { Badge } from './ui/display';
import { Checkbox, Input, Select, TagInput, Textarea } from './ui/form';
import { PersonName, PersonPicker } from './pickers';
import { intlLocale, t } from '@/lib/i18n';

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
          {(value as number).toLocaleString(intlLocale())}
          {field.config.unit && <span className="ms-0.5 text-subtle">{field.config.unit}</span>}
        </span>
      );
    case 'date':
      return (
        <span className="tabular-nums">
          {formatDate(value as string, compact)}
          {!compact && <span className="ms-1.5 text-xs text-subtle">{relativeDays(value as string)}</span>}
        </span>
      );
    case 'boolean':
      return <span>{value ? t('Yes') : t('No')}</span>;
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
    case 'login':
      return <LoginView field={field} value={value as LoginValue} compact={compact} />;
    case 'assetRef':
      return Array.isArray(value) ? (
        <span className={compact ? 'block max-w-64 truncate' : 'flex flex-wrap gap-x-2 gap-y-1'}>
          {value.map((v, i) => (
            <span key={v}>
              <AssetRefValue id={v} />
              {compact && i < value.length - 1 && ', '}
            </span>
          ))}
        </span>
      ) : (
        <AssetRefValue id={value as string} />
      );
    case 'list':
      return compact ? (
        <span className="block max-w-64 truncate font-mono text-xs">{(value as string[]).join(', ')}</span>
      ) : (
        <span className="flex flex-wrap gap-1">
          {(value as string[]).map((v) => (
            <code key={v} className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">
              {v}
            </code>
          ))}
        </span>
      );
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
      <button type="button" className="text-subtle hover:text-fg" onClick={(e) => (e.stopPropagation(), setShown((s) => !s))} aria-label={shown ? t('Hide') : t('Reveal')}>
        {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </span>
  );
}

const secretLabels = (): Record<'password' | 'key' | 'token', string> => ({ password: t('Password'), key: t('Key'), token: t('Token') });

function copy(text: string, what: string) {
  void navigator.clipboard?.writeText(text).then(
    () => toast.success(t('{what} copied', { what })),
    () => toast.error(t('Could not copy')),
  );
}

/**
 * A login as one block: open the address, copy the user name, reveal or copy
 * the password. People who may not see the password see that there is one.
 */
function LoginView({ field, value, compact }: { field: Extract<FieldDefinition, { kind: 'login' }>; value: LoginValue; compact?: boolean }) {
  const [shown, setShown] = useState(false);
  const label = secretLabels()[field.config.secretLabel];
  const host = (() => {
    try {
      return value.url ? new URL(value.url).host : null;
    } catch {
      return value.url ?? null;
    }
  })();
  if (compact) return <span className="block max-w-64 truncate">{[value.username, host].filter(Boolean).join(' · ') || '—'}</span>;
  const row = 'flex min-w-0 items-center gap-2';
  const icon = 'shrink-0 text-subtle hover:text-fg';
  return (
    <span className="flex min-w-0 flex-col gap-1">
      {value.url && (
        <a href={value.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} className="inline-flex max-w-full items-center gap-1 truncate text-accent-fg hover:underline">
          {host}
          <ExternalLink className="size-3 shrink-0" />
        </a>
      )}
      {value.username && (
        <span className={row}>
          <span className="truncate">{value.username}</span>
          <button type="button" className={icon} aria-label={t('Copy the user name')} onClick={(e) => (e.stopPropagation(), copy(value.username!, t('User name')))}>
            <Copy className="size-3.5" />
          </button>
        </span>
      )}
      {value.secret !== undefined ? (
        <span className={cn(row, 'font-mono text-xs')}>
          <span className={shown ? 'break-all' : 'truncate'}>{shown ? value.secret : '••••••••'}</span>
          <button type="button" className={icon} onClick={(e) => (e.stopPropagation(), setShown((x) => !x))} aria-label={shown ? t('Hide') : t('Reveal')}>
            {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
          <button type="button" className={icon} aria-label={t('Copy the {what}', { what: label.toLowerCase() })} onClick={(e) => (e.stopPropagation(), copy(value.secret!, label))}>
            <Copy className="size-3.5" />
          </button>
        </span>
      ) : value.hasSecret ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted">
          <Lock className="size-3" /> {t('{what} hidden: only people who may see secrets', { what: label })}
        </span>
      ) : null}
    </span>
  );
}

/** A login's three parts. Whoever may not see the password keeps it as it is. */
function LoginInput({ field, value, onChange, id }: { field: Extract<FieldDefinition, { kind: 'login' }>; value: LoginValue | undefined; onChange: (v: LoginValue) => void; id: string }) {
  const v = value ?? {};
  const label = secretLabels()[field.config.secretLabel];
  const set = (p: Partial<LoginValue>) => onChange({ ...v, ...p });
  // Each part keeps an icon, so filled-in boxes still say which is which.
  const part = (icon: ReactNode, input: ReactNode) => (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 start-2.5 -translate-y-1/2 text-subtle [&>svg]:size-3.5">{icon}</span>
      {input}
    </div>
  );
  return (
    <div className="space-y-1.5">
      {part(<Link2 />, <Input id={id} type="url" className="ps-8" placeholder={t('Address, e.g. https://admin.example.com')} value={v.url ?? ''} onChange={(e) => set({ url: e.target.value || undefined })} />)}
      {part(<UserRound />, <Input aria-label={t('User name or email')} autoComplete="off" className="ps-8" placeholder={t('User name or email')} value={v.username ?? ''} onChange={(e) => set({ username: e.target.value || undefined })} />)}
      {v.hasSecret && v.secret === undefined ? (
        <p className="flex items-center gap-1 text-xs text-muted">
          <Lock className="size-3" /> {t('{what} set; only people who may see secrets can change it', { what: label })}
        </p>
      ) : (
        part(<KeyRound />, <Input aria-label={label} type="password" autoComplete="new-password" className="ps-8 font-mono" placeholder={label} value={v.secret ?? ''} onChange={(e) => set({ secret: e.target.value || undefined })} />)
      )}
    </div>
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
    case 'login':
      return <LoginInput field={field} id={id} value={value as LoginValue | undefined} onChange={onChange} />;
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
            className={field.kind === 'currency' ? 'ps-12' : undefined}
            value={value === undefined || value === null ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          />
          {field.kind === 'currency' && <span className="pointer-events-none absolute top-1/2 start-2.5 -translate-y-1/2 text-xs text-subtle">{field.config.currency}</span>}
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
      return field.config.multiple ? (
        <AssetRefsInput id={id} typeId={field.config.assetTypeId} value={(value as string[]) ?? []} onChange={(v) => onChange(v.length ? v : undefined)} />
      ) : (
        <AssetRefInput id={id} typeId={field.config.assetTypeId} value={(value as string) ?? ''} onChange={(v) => onChange(v || undefined)} />
      );
    case 'list': {
      const re = field.config.pattern ? new RegExp(field.config.pattern) : null;
      return (
        <TagInput
          id={id}
          value={(value as string[]) ?? []}
          onChange={(v) => onChange(v.length ? v : undefined)}
          placeholder={field.config.placeholder ?? t('Type and press Enter; paste several at once')}
          validate={(v) => !re || re.test(v)}
        />
      );
    }
  }
}

/** Several linked items, e.g. the machines that use a license. */
function AssetRefsInput({ id, typeId, value, onChange }: { id: string; typeId?: string; value: string[]; onChange: (v: string[]) => void }) {
  const assets = useAssets({ assetTypeId: typeId, limit: 500, sort: 'name', order: 'asc' });
  const byId = new Map((assets.data?.items ?? []).map((a) => [a.id, a]));
  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((v) => (
            <li key={v} className="inline-flex items-center gap-1 rounded-md bg-surface-2 py-0.5 pe-1 ps-2 text-xs">
              {byId.get(v)?.name ?? '…'}
              <button type="button" aria-label={t('Remove')} className="text-subtle hover:text-fg" onClick={() => onChange(value.filter((x) => x !== v))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <Select id={id} value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
        <option value="">{t('Add…')}</option>
        {(assets.data?.items ?? [])
          .filter((a) => !value.includes(a.id))
          .map((a) => (
            <option key={a.id} value={a.id}>
              {a.reference} · {a.name}
            </option>
          ))}
      </Select>
    </div>
  );
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
