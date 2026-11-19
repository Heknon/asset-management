import { useEffect, useRef } from 'react';

/**
 * Keyboard shortcuts for people who live in the app. Single keys ("n", "?")
 * and two-key sequences ("g a") are ignored while typing or while a dialog is
 * open, so they never steal a keystroke meant for a field.
 */
export interface ShortcutHelp {
  keys: string[];
  label: string;
  group: 'Go to' | 'Actions' | 'Lists';
}

export const goTo: Array<{ key: string; label: string; to: string; admin?: boolean }> = [
  { key: 'u', label: 'Upcoming', to: '/' },
  { key: 'r', label: 'Requests', to: '/requests' },
  { key: 'a', label: 'All assets', to: '/assets' },
  { key: 'c', label: 'Calendar', to: '/calendar' },
  { key: 'l', label: 'Catalogs', to: '/catalogs' },
  { key: 'i', label: 'Import', to: '/import' },
  { key: 'p', label: 'Profile', to: '/profile' },
  { key: 't', label: 'Templates', to: '/templates', admin: true },
  { key: 'o', label: 'Organization', to: '/settings/organization', admin: true },
];

export const shortcutHelp: ShortcutHelp[] = [
  { keys: ['⌘', 'K'], label: 'Search or run a command', group: 'Actions' },
  { keys: ['/'], label: 'Search', group: 'Actions' },
  { keys: ['N'], label: 'New item on this page (asset, template, catalog…)', group: 'Actions' },
  { keys: ['R'], label: 'Request something', group: 'Actions' },
  { keys: ['?'], label: 'Show these shortcuts', group: 'Actions' },
  { keys: ['J'], label: 'Next row', group: 'Lists' },
  { keys: ['K'], label: 'Previous row', group: 'Lists' },
  { keys: ['↵'], label: 'Open the row', group: 'Lists' },
  { keys: ['X'], label: 'Select the row', group: 'Lists' },
  { keys: ['⇧', 'Click'], label: 'Select a range of rows', group: 'Lists' },
  ...goTo.map((g) => ({ keys: ['G', g.key.toUpperCase()], label: g.label, group: 'Go to' as const })),
];

export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target;
  return t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}

const blocked = (e: KeyboardEvent) => e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || !!document.querySelector('[role=dialog],[role=menu],[data-radix-popper-content-wrapper]');

/** A single-key shortcut while this component is mounted (pages register "n" for their own "New"). */
export function useShortcut(key: string, run: (() => void) | null | undefined) {
  const ref = useRef(run);
  ref.current = run;
  useEffect(() => {
    if (!run) return;
    const onKey = (e: KeyboardEvent) => {
      if (blocked(e) || e.key.toLowerCase() !== key || sequenceStarted()) return;
      // Enter on a focused button or link is that control's own.
      if (key === 'enter' && e.target !== document.body) return;
      e.preventDefault();
      ref.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key, !!run]);
}

let gAt = 0;
const sequenceStarted = () => Date.now() - gAt < 1200;

/** "g" then a letter: go somewhere. "?" shows help. */
export function useGlobalShortcuts({ navigate, isAdmin, onHelp, onRequest }: { navigate: (to: string) => void; isAdmin: boolean; onHelp: () => void; onRequest: () => void }) {
  const ref = useRef({ navigate, isAdmin, onHelp, onRequest });
  ref.current = { navigate, isAdmin, onHelp, onRequest };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (blocked(e)) return;
      const k = e.key.toLowerCase();
      if (sequenceStarted()) {
        gAt = 0;
        // The second key belongs to the sequence: no page shortcut sees it.
        e.stopPropagation();
        const target = goTo.find((g) => g.key === k && (!g.admin || ref.current.isAdmin));
        if (target) {
          e.preventDefault();
          ref.current.navigate(target.to);
        }
        return;
      }
      if (k === 'g') gAt = Date.now();
      else if (e.key === '?') {
        e.preventDefault();
        ref.current.onHelp();
      } else if (k === 'r') {
        e.preventDefault();
        ref.current.onRequest();
      }
    };
    // Capture: a sequence's second key must not also trigger a page's single-key shortcut.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}
