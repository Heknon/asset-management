import { useEffect, useState, useSyncExternalStore } from 'react';

/** The value, once it has stopped changing for `ms` (search-as-you-type). */
export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Whether a CSS media query matches, kept in sync as the window resizes or rotates. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = matchMedia(query);
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}

/** Desktop layouts with side-by-side panes start at Tailwind's xl breakpoint. */
export const WIDE = '(min-width: 1280px)';
