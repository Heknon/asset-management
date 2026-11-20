/**
 * Languages of the app. Strings are written in English in the code and
 * looked up by their English text (gettext style), so the source stays
 * readable and a missing translation falls back to English:
 *
 *   t('Save')                                  → "שמירה"
 *   t('Signed in as {name}', { name })         → interpolated
 *   plural(n, '{n} result', '{n} results')     → by the language's plural rules
 *
 * Hebrew is right-to-left: the page's `dir` follows the language, and the
 * layout uses logical classes (ps-/pe-/ms-/me-/start-/end-) that flip with it.
 */
import he from '../i18n/he.json';

export type Locale = 'en' | 'he';

export const locales: Array<{ id: Locale; label: string; native: string; dir: 'ltr' | 'rtl' }> = [
  { id: 'en', label: 'English', native: 'English', dir: 'ltr' },
  { id: 'he', label: 'Hebrew', native: 'עברית', dir: 'rtl' },
];

const dictionaries: Record<Locale, Record<string, string>> = { en: {}, he: he as Record<string, string> };
const STORAGE_KEY = 'locale';

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'he') return stored;
  } catch {
    /* storage unavailable */
  }
  return typeof navigator !== 'undefined' && /^(he|iw)\b/i.test(navigator.language) ? 'he' : 'en';
}

let current: Locale = initialLocale();

export const getLocale = (): Locale => current;
export const isRtl = (): boolean => current === 'he';
export const dir = (): 'ltr' | 'rtl' => (isRtl() ? 'rtl' : 'ltr');

/** The BCP 47 tag for Intl formatting: dates, numbers, currencies, sorting. */
export function intlLocale(): string {
  if (current === 'he') return 'he-IL';
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
  return /^en\b/i.test(nav) ? nav : 'en-US';
}

/** Sets <html lang/dir> to the current language (before first paint, and after a change). */
export function applyLocale(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = current;
  document.documentElement.dir = dir();
}

/**
 * Switches language. Formatters and labels are computed once per render
 * tree, so the page reloads in the new language (state lives in the URL
 * and the server, so nothing is lost).
 */
export function setLocale(next: Locale, { reload = true }: { reload?: boolean } = {}): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage unavailable */
  }
  applyLocale();
  if (reload) window.location.reload();
}

/** True when the person picked a language on this device (it then wins over their profile). */
export function hasLocalChoice(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function interpolate(text: string, vars?: Record<string, unknown>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? '') : m));
}

/** Translates an English UI string (and fills `{placeholders}`). */
export function t(text: string, vars?: Record<string, unknown>): string {
  return interpolate(dictionaries[current][text] ?? text, vars);
}

/** Like `t`, for text that may not be a known UI string (labels from data, server messages). */
export const tMaybe = (text: string | null | undefined): string => (text ? (dictionaries[current][text] ?? text) : '');

const pluralRules = new Map<string, Intl.PluralRules>();

/** Picks the singular or plural English form by the current language's rules, then translates it. `{n}` is the formatted count. */
export function plural(n: number, one: string, other: string, vars?: Record<string, unknown>): string {
  const tag = intlLocale();
  let rules = pluralRules.get(tag);
  if (!rules) pluralRules.set(tag, (rules = new Intl.PluralRules(tag)));
  const form = rules.select(n) === 'one' ? one : other;
  return t(form, { n: n.toLocaleString(tag), ...vars });
}

/** Number with the current language's grouping. */
export const formatNumber = (n: number): string => n.toLocaleString(intlLocale());

applyLocale();
