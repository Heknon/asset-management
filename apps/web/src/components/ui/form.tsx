import { Check, X } from 'lucide-react';
import { forwardRef, useEffect, useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const control =
  'w-full rounded-lg border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-subtle transition-colors hover:border-border-strong focus:border-accent focus:outline-none focus:ring-3 focus:ring-[var(--ring)] disabled:opacity-60 aria-[invalid=true]:border-danger touch:text-base';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(control, 'h-8 touch:h-10', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(control, 'min-h-20 py-2 leading-relaxed', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        control,
        'h-8 cursor-pointer appearance-none touch:h-10 bg-[url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%2712%27%20height=%2712%27%20fill=%27none%27%20stroke=%27%238b919c%27%20stroke-width=%272%27%3E%3Cpath%20d=%27M3%204.5l3%203%203-3%27/%3E%3C/svg%3E")] bg-[position:right_8px_center] rtl:bg-[position:left_8px_center] bg-no-repeat pe-7',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cn('inline-flex cursor-pointer items-center gap-2 text-[13px] select-none', disabled && 'cursor-default opacity-60')}>
      <span
        className={cn(
          'flex size-4 items-center justify-center rounded border transition-colors',
          checked ? 'border-accent bg-accent text-white' : 'border-border-strong bg-surface',
        )}
      >
        {checked && <Check className="size-3" strokeWidth={3} />}
      </span>
      <input type="checkbox" className="sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cn('flex cursor-pointer items-start justify-between gap-4 select-none', disabled && 'cursor-default opacity-60')}>
      {(label || description) && (
        <span className="min-w-0">
          <span className="block text-[13px] font-medium">{label}</span>
          {description && <span className="block text-xs text-muted">{description}</span>}
        </span>
      )}
      <span className={cn('relative mt-0.5 inline-flex h-[18px] w-8 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-surface-3')}>
        <span className={cn('absolute top-[2px] size-3.5 rounded-full bg-white shadow transition-all', checked ? 'start-[16px]' : 'start-[2px]')} />
      </span>
      <input type="checkbox" role="switch" className="sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Label + control + hint/error. Every form row in the app goes through this. */
export function Field({ label, hint, error, required, children, className, aside }: { label: ReactNode; hint?: ReactNode; error?: string; required?: boolean; children: (id: string) => ReactNode; className?: string; aside?: ReactNode }) {
  const id = useId();
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-muted">
          {label}
          {required && <span className="ms-0.5 text-danger">*</span>}
        </label>
        {aside}
      </div>
      {children(id)}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs text-subtle">{hint}</p> : null}
    </div>
  );
}

/** Pill-style segmented control for small enums. */
export function Segmented<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode }>; className?: string }) {
  // Long choices ("Add every row as a new item") stack on phones instead of squeezing into two-line pills.
  const long = options.some((o) => typeof o.label === 'string' && o.label.length > 18);
  return (
    <div className={cn('inline-flex rounded-lg bg-surface-2 p-0.5', long && 'max-sm:flex max-sm:w-full max-sm:flex-col', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn('h-6 rounded-md px-2.5 text-xs font-medium transition-colors', long && 'max-sm:h-8 max-sm:text-start', value === o.value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Free-text values as removable chips (emails, directory group DNs, …). Enter or comma adds. */
export interface TagSuggestion {
  value: string;
  label: string;
  detail?: string;
}

export function TagInput({
  value,
  onChange,
  placeholder,
  validate,
  id,
  suggest,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  validate?: (v: string) => boolean;
  id?: string;
  /** Offers values while typing (and on focus): picked with a click, or Enter on the highlighted one. */
  suggest?: (q: string) => Promise<TagSuggestion[]>;
}) {
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [options, setOptions] = useState<TagSuggestion[]>([]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (!suggest || !focused) return;
    let live = true;
    const timer = setTimeout(() => {
      suggest(draft.trim())
        .then((list) => live && (setOptions(list.filter((o) => !value.some((x) => x.toLowerCase() === o.value.toLowerCase()))), setActive(0)))
        .catch(() => live && setOptions([]));
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [draft, focused, suggest, value]);
  const pick = (v: string) => {
    if (!value.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...value, v]);
    setDraft('');
  };
  const add = () => {
    const v = draft.trim().replace(/,$/, '');
    if (!v || (validate && !validate(v))) return;
    if (!value.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...value, v]);
    setDraft('');
  };
  const showing = !!suggest && focused && options.length > 0;
  return (
    <div className="relative">
    <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-lg border border-border bg-surface px-1.5 py-1 focus-within:border-accent focus-within:ring-3 focus-within:ring-[var(--ring)]">
      {value.map((v) => (
        <span key={v} className="inline-flex max-w-full items-center gap-1 rounded-md bg-surface-2 py-0.5 pe-1 ps-2 font-mono text-[11px]">
          <span className="truncate">{v}</span>
          <button type="button" aria-label={t('Remove {value}', { value: v })} className="rounded p-0.5 text-subtle hover:bg-surface-3 hover:text-fg" onClick={() => onChange(value.filter((x) => x !== v))}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        className="h-6 min-w-40 flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-subtle"
        placeholder={value.length ? '' : placeholder}
        value={draft}
        role={suggest ? 'combobox' : undefined}
        aria-expanded={suggest ? showing : undefined}
        aria-autocomplete={suggest ? 'list' : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          // A click on a suggestion lands before the list closes.
          setTimeout(() => setFocused(false), 150);
          add();
        }}
        onPaste={(e) => {
          // A pasted column (one per line) or list ("a, b; c") becomes several entries.
          const parts = e.clipboardData.getData('text').split(/[\n\r,;\t]+/).map((x) => x.trim()).filter(Boolean);
          if (parts.length < 2) return;
          e.preventDefault();
          const fresh = parts.filter((p) => (!validate || validate(p)) && !value.some((x) => x.toLowerCase() === p.toLowerCase()));
          onChange([...value, ...new Set(fresh)]);
          const rejected = parts.filter((p) => validate && !validate(p));
          setDraft(rejected.join(', '));
        }}
        onKeyDown={(e) => {
          if (showing && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
          } else if (showing && e.key === 'Enter' && options[active]) {
            e.preventDefault();
            pick(options[active]!.value);
          } else if (e.key === 'Escape') setFocused(false);
          else if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
        }}
      />
    </div>
      {showing && (
        <ul role="listbox" className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-pop">
          {options.map((o, i) => (
            <li key={o.value} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o.value)}
                onMouseEnter={() => setActive(i)}
                className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-[13px]', i === active && 'bg-surface-2')}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{o.label}</span>
                  {o.label !== o.value && <span className="block truncate font-mono text-[11px] text-subtle">{o.value}</span>}
                </span>
                {o.detail && <span className="shrink-0 text-xs text-muted">{o.detail}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
