import type { AppLocale } from '@am/core';
import { Languages } from 'lucide-react';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { getLocale, hasLocalChoice, locales, setLocale, t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Segmented } from './ui/form';

/** English · עברית, as small links (sign-in and consent pages, before anyone is signed in). */
export function LanguageLinks({ className }: { className?: string }) {
  const current = getLocale();
  return (
    <div className={cn('flex items-center justify-center gap-1 text-xs text-muted', className)}>
      <Languages className="size-3.5" aria-hidden />
      {locales.map((l, i) => (
        <span key={l.id} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden>·</span>}
          <button type="button" lang={l.id} onClick={() => setLocale(l.id)} className={cn('rounded px-1 hover:text-fg', l.id === current && 'font-semibold text-fg')} aria-pressed={l.id === current}>
            {l.native}
          </button>
        </span>
      ))}
    </div>
  );
}

/** The language setting on the profile: saved for the person, so it follows them to other devices. */
export function LanguageSetting() {
  const choose = async (next: AppLocale) => {
    await api.patch('/api/identity/me/preferences', { locale: next }).catch(() => undefined);
    setLocale(next);
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-[13px] font-medium">{t('Language')}</p>
        <p className="text-xs text-muted">{t('Also sets how dates and numbers are written.')}</p>
      </div>
      <Segmented value={getLocale()} onChange={(v) => void choose(v)} options={locales.map((l) => ({ value: l.id, label: <span lang={l.id}>{l.native}</span> }))} />
    </div>
  );
}

/** Applies the language saved on the person's profile, unless they picked one on this device. */
export function useProfileLocale(preferred: AppLocale | null | undefined) {
  useEffect(() => {
    if (preferred && !hasLocalChoice() && preferred !== getLocale()) setLocale(preferred);
  }, [preferred]);
}
