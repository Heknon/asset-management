import { useEffect, useSyncExternalStore } from 'react';

/** Things you opened lately, for the palette: per browser, newest first. */
export interface RecentItem {
  kind: 'asset' | 'request' | 'template' | 'unit' | 'catalog';
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;
  color?: string;
}

const KEY = 'recent-items';
const MAX = 8;
const listeners = new Set<() => void>();
let cache: RecentItem[] | null = null;

function read(): RecentItem[] {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? '[]') as RecentItem[];
  } catch {
    cache = [];
  }
  return cache;
}

export function remember(item: RecentItem) {
  const next = [item, ...read().filter((x) => !(x.kind === item.kind && x.id === item.id))].slice(0, MAX);
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode: keep it in memory */
  }
  listeners.forEach((l) => l());
}

export function forget(kind: RecentItem['kind'], id: string) {
  cache = read().filter((x) => !(x.kind === kind && x.id === id));
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function useRecent(): RecentItem[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    read,
  );
}

/** Records a page you opened once its title is known. */
export function useRemember(item: RecentItem | null | undefined) {
  const sig = item ? `${item.kind}:${item.id}:${item.title}:${item.subtitle ?? ''}` : '';
  useEffect(() => {
    if (item) remember(item);
  }, [sig]);
}
