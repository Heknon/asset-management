import { derivationOrder, type AssetType } from './asset-type.js';
import { addDuration, isValidIsoDate, type Duration, type IsoDate } from './duration.js';
import { canSeeField, canSeeLoginSecret, isRestricted, type FieldDefinition } from './fields.js';

/** A Login field's value. `secret` is the password, key or token. */
export interface LoginValue {
  url?: string;
  username?: string;
  secret?: string;
  /** Only in what is sent to someone who may not see the password: there is one. */
  hasSecret?: boolean;
}
export type AttributeValue = string | number | boolean | string[] | LoginValue;

export const isLoginValue = (v: unknown): v is LoginValue => !!v && typeof v === 'object' && !Array.isArray(v);
export type Attributes = Record<string, AttributeValue>;

export interface AttributeIssue {
  field: string;
  message: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEmpty(v: unknown): boolean {
  if (isLoginValue(v)) return !v.url && !v.username && !v.secret;
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** Validates and normalises one value. Returns an error message or the normalised value. */
function checkValue(field: FieldDefinition, raw: unknown): { ok: true; value: AttributeValue } | { ok: false; message: string } {
  const fail = (message: string) => ({ ok: false as const, message });
  switch (field.kind) {
    case 'text':
    case 'longText':
    case 'secret': {
      if (typeof raw !== 'string') return fail('Must be text');
      const max = field.kind !== 'secret' ? field.config.maxLength : undefined;
      if (max && raw.length > max) return fail(`Must be at most ${max} characters`);
      if (field.kind === 'text' && field.config.pattern && !new RegExp(field.config.pattern).test(raw)) return fail('Does not match the required format');
      return { ok: true, value: raw };
    }
    case 'url': {
      if (typeof raw !== 'string') return fail('Must be a URL');
      try {
        const u = new URL(raw);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail('Must be an http(s) URL');
      } catch {
        return fail('Must be a valid URL');
      }
      return { ok: true, value: raw };
    }
    case 'email':
      return typeof raw === 'string' && EMAIL.test(raw) ? { ok: true, value: raw.toLowerCase() } : fail('Must be a valid email address');
    case 'number':
    case 'currency': {
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      if (typeof n !== 'number' || !Number.isFinite(n)) return fail('Must be a number');
      if (field.kind === 'number') {
        if (field.config.integer && !Number.isInteger(n)) return fail('Must be a whole number');
        if (field.config.min !== undefined && n < field.config.min) return fail(`Must be at least ${field.config.min}`);
        if (field.config.max !== undefined && n > field.config.max) return fail(`Must be at most ${field.config.max}`);
      } else if (n < 0) return fail('Must not be negative');
      return { ok: true, value: field.kind === 'currency' ? Math.round(n * 100) / 100 : n };
    }
    case 'date':
      return isValidIsoDate(raw) ? { ok: true, value: raw } : fail('Must be a valid date (YYYY-MM-DD)');
    case 'boolean':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : fail('Must be true or false');
    case 'select':
      return typeof raw === 'string' && field.config.options.some((o) => o.value === raw) ? { ok: true, value: raw } : fail('Not one of the allowed options');
    case 'multiSelect': {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) return fail('Must be a list of options');
      const allowed = new Set(field.config.options.map((o) => o.value));
      const bad = raw.filter((v) => !allowed.has(v));
      return bad.length ? fail(`Unknown options: ${bad.join(', ')}`) : { ok: true, value: [...new Set(raw as string[])] };
    }
    case 'user':
      return typeof raw === 'string' && UUID.test(raw) ? { ok: true, value: raw } : fail('Must be a valid reference');
    case 'assetRef': {
      if (!field.config.multiple) return typeof raw === 'string' && UUID.test(raw) ? { ok: true, value: raw } : fail('Must be a valid reference');
      const list = typeof raw === 'string' ? [raw] : raw;
      if (!Array.isArray(list) || list.some((v) => typeof v !== 'string' || !UUID.test(v))) return fail('Must be a list of linked items');
      return { ok: true, value: [...new Set(list as string[])] };
    }
    case 'login': {
      if (!isLoginValue(raw)) return fail('Must be a login (address, user name, password)');
      const out: LoginValue = {};
      for (const k of ['url', 'username', 'secret'] as const) {
        const v = raw[k];
        if (v === undefined || v === null || v === '') continue;
        if (typeof v !== 'string') return fail('Must be text');
        if (v.length > 2000) return fail('Too long');
        out[k] = k === 'secret' ? v : v.trim();
      }
      if (out.url) {
        try {
          const u = new URL(out.url);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail('The address must be an http(s) URL');
        } catch {
          return fail('The address must be a valid URL');
        }
      }
      return { ok: true, value: out };
    }
    case 'list': {
      const list = typeof raw === 'string' ? [raw] : raw;
      if (!Array.isArray(list) || list.some((v) => typeof v !== 'string')) return fail('Must be a list of values');
      const items = [...new Set((list as string[]).map((v) => v.trim()).filter(Boolean))];
      if (items.length > field.config.maxItems) return fail(`At most ${field.config.maxItems} entries`);
      if (field.config.pattern) {
        const re = new RegExp(field.config.pattern);
        const bad = items.filter((v) => !re.test(v));
        if (bad.length) return fail(`Not in the required format: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}`);
      }
      return { ok: true, value: items };
    }
  }
}

/**
 * Validates a complete attribute set against a type, drops unknown keys and
 * empty values, and fills in derived dates. Derived inputs are ignored: they are
 * always recomputed so that they can never drift from their source.
 */
/**
 * `optional`: fields whose "required" is not enforced here (a team's own
 * fields: whoever buys the item does not fill them; the team does, later).
 */
export function validateAttributes(type: Pick<AssetType, 'fields'>, input: Record<string, unknown>, opts: { optional?: ReadonlySet<string> } = {}): { values: Attributes; issues: AttributeIssue[] } {
  const values: Attributes = {};
  const issues: AttributeIssue[] = [];
  const required = (f: FieldDefinition) => f.required && !opts.optional?.has(f.key);
  for (const field of type.fields) {
    if (field.kind === 'date' && field.config.tracking?.derive) continue;
    const raw = input[field.key];
    if (isEmpty(raw)) {
      if (required(field)) issues.push({ field: field.key, message: 'Required' });
      continue;
    }
    const r = checkValue(field, raw);
    if (r.ok) values[field.key] = r.value;
    else issues.push({ field: field.key, message: r.message });
  }
  Object.assign(values, computeDerivedDates(type.fields, values));
  for (const field of type.fields) {
    if (required(field) && field.kind === 'date' && field.config.tracking?.derive && values[field.key] === undefined) {
      issues.push({ field: field.key, message: `Cannot be computed until "${field.config.tracking.derive.from}" is set` });
    }
  }
  return { values, issues };
}

/** Computes every derived date in dependency order. */
export function computeDerivedDates(fields: readonly FieldDefinition[], values: Attributes): Attributes {
  const out: Attributes = { ...values };
  const derived: Attributes = {};
  for (const field of derivationOrder(fields)) {
    if (field.kind !== 'date' || !field.config.tracking?.derive) continue;
    const d = field.config.tracking.derive;
    const source = out[d.from];
    const amount = 'fixed' in d.amount ? d.amount.fixed : out[d.amount.field];
    if (typeof source !== 'string' || typeof amount !== 'number' || amount < 0) {
      delete out[field.key];
      continue;
    }
    const value = addDuration(source, { amount: Math.trunc(amount), unit: d.unit }, d.direction === 'before' ? -1 : 1);
    out[field.key] = value;
    derived[field.key] = value;
  }
  return derived;
}

/**
 * Merges a partial update into existing values. Users without restricted access
 * cannot change restricted fields; their existing values are preserved.
 */
export function mergeAttributes(
  fields: readonly FieldDefinition[],
  existing: Attributes,
  patch: Record<string, unknown>,
  canTouchRestricted: boolean,
): { merged: Record<string, unknown>; blocked: string[] } {
  const merged: Record<string, unknown> = { ...existing };
  const blocked: string[] = [];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(patch)) {
    const field = byKey.get(key);
    if (!field) continue;
    if (isRestricted(field) && !canTouchRestricted) {
      blocked.push(key);
      continue;
    }
    // A login's password: only people who may change secrets change it; others edit the address and user name around it.
    if (field.kind === 'login' && !canTouchRestricted) {
      const before = isLoginValue(existing[key]) ? (existing[key] as LoginValue) : {};
      const next = isLoginValue(value) ? value : {};
      if ('secret' in next && next.secret !== before.secret && next.secret !== undefined) blocked.push(key);
      merged[key] = { ...next, ...(before.secret !== undefined ? { secret: before.secret } : { secret: undefined }) };
      continue;
    }
    merged[key] = value;
  }
  return { merged, blocked };
}

/** Removes restricted values for viewers that may not see them. */
export function redactAttributes(fields: readonly FieldDefinition[], values: Attributes, canSeeRestricted: boolean, isOwner = false): Attributes {
  if (canSeeRestricted) return values;
  const who = { canSeeRestricted, isOwner };
  const hidden = new Set(fields.filter((f) => !canSeeField(f, who)).map((f) => f.key));
  const known = new Set(fields.map((f) => f.key));
  // Values of removed fields are not shown: they may have been secret.
  const out = Object.fromEntries(Object.entries(values).filter(([k]) => known.has(k) && !hidden.has(k)));
  // Logins stay visible without their password, unless this person may see it.
  for (const f of fields) {
    const v = out[f.key];
    if (f.kind === 'login' && isLoginValue(v) && v.secret !== undefined && !canSeeLoginSecret(f, who)) {
      const { secret: _secret, ...rest } = v;
      out[f.key] = { ...rest, hasSecret: true };
    }
  }
  return out;
}

export function spendOf(fields: readonly FieldDefinition[], values: Attributes): { amount: number; currency: string } | null {
  let total = 0;
  let currency: string | null = null;
  for (const f of fields) {
    // A restricted cost stays with the secrets: it is not shown as spend to everyone.
    if (f.kind !== 'currency' || !f.config.countsTowardSpend || isRestricted(f)) continue;
    const v = values[f.key];
    if (typeof v !== 'number') continue;
    total += v;
    currency ??= f.config.currency;
  }
  return currency ? { amount: Math.round(total * 100) / 100, currency } : null;
}

export type { Duration, IsoDate };
