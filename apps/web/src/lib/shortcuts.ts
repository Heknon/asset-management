import { useEffect, useRef } from 'react';
import { t } from './i18n';

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
  { key: 'u', label: t('Upcoming'), to: '/' },
  { key: 'r', label: t('Requests'), to: '/requests' },
  { key: 'a', label: t('All assets'), to: '/assets' },
  { key: 'c', label: t('Calendar'), to: '/calendar' },
  { key: 'l', label: t('Catalogs'), to: '/catalogs' },
  { key: 'i', label: t('Import'), to: '/import' },
  { key: 'p', label: t('Profile'), to: '/profile' },
  { key: 't', label: t('Templates'), to: '/templates', admin: true },
  { key: 'o', label: t('Organization'), to: '/settings/organization', admin: true },
];

export const shortcutHelp: ShortcutHelp[] = [
  { keys: ['⌘', 'K'], label: t('Search or run a command'), group: 'Actions' },
  { keys: ['/'], label: t('Search'), group: 'Actions' },
  { keys: ['N'], label: t('New item on this page (asset, template, catalog…)'), group: 'Actions' },
  { keys: ['R'], label: t('Request something'), group: 'Actions' },
  { keys: ['?'], label: t('Show these shortcuts'), group: 'Actions' },
  { keys: ['J'], label: t('Next row'), group: 'Lists' },
  { keys: ['K'], label: t('Previous row'), group: 'Lists' },
  { keys: ['↵'], label: t('Open the row'), group: 'Lists' },
  { keys: ['X'], label: t('Select the row'), group: 'Lists' },
  { keys: ['⇧', t('Click')], label: t('Select a range of rows'), group: 'Lists' },
  ...goTo.map((g) => ({ keys: ['G', g.key.toUpperCase()], label: g.label, group: 'Go to' as const })),
];

export function isTyping(e: KeyboardEvent): boolean {
  const el = e.target;
  return el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
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
