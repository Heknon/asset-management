import type { Me } from '@am/core';
import * as RDialog from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Command } from 'cmdk';
import {
  Bookmark,
  Building2,
  CalendarDays,
  DatabaseBackup,
  Check,
  ChevronDown,
  Clock,
  FileUp,
  Keyboard,
  FolderOpen,
  Inbox,
  KeyRound,
  Languages,
  LayoutTemplate,
  LogOut,
  Mail,
  Menu as MenuIcon,
  Monitor,
  Moon,
  Network,
  Plus,
  Search,
  Shapes,
  ShoppingCart,
  Sun,
  Trash2,
  User,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { getLocale, locales, setLocale, t, type Locale } from '@/lib/i18n';
import { useCreatableTypes, useMyOrg } from '@/lib/org';
import { useAssetTypes, useRequestCounts, useSummary, useViews } from '@/lib/queries';
import { useUniversalSearch } from '@/lib/search';
import { cn, inSentence } from '@/lib/utils';
import { useDebounced } from '@/lib/hooks';
import { useRecent, type RecentItem } from '@/lib/recent';
import { goTo, shortcutHelp, useGlobalShortcuts } from '@/lib/shortcuts';
import { Highlight } from './highlight';
import { HitIcon, hitLink } from './search-hit';
import { NewRequestProvider, useNewRequest } from './request-form';
import { TypeIcon } from './type-icon';
import { Avatar, Kbd } from './ui/display';
import { ConfirmDialog, Dialog, Menu, MenuItem, MenuSeparator, MenuSub } from './ui/overlay';
import { inBrowser, localServer } from '@/lib/run-mode';

export type ThemePref = 'light' | 'dark' | 'system';

const darkQuery = () => matchMedia('(prefers-color-scheme: dark)');

/** Applies a theme choice; "system" follows the device, including when it changes (e.g. at sunset). */
export function applyTheme(pref: ThemePref) {
  const dark = pref === 'dark' || (pref === 'system' && darkQuery().matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // Phone browsers tint their toolbar with this.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0d0e11' : '#fbfbfc');
}

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem('theme');
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readThemePref);
  useEffect(() => {
    applyTheme(pref);
    try {
      localStorage.setItem('theme', pref);
    } catch {
      /* storage may be unavailable */
    }
    if (pref !== 'system') return;
    const q = darkQuery();
    const follow = () => applyTheme('system');
    q.addEventListener('change', follow);
    return () => q.removeEventListener('change', follow);
  }, [pref]);
  return [pref, setPref] as const;
}

const navClass = (active: boolean) =>
  cn('flex h-8 items-center gap-2.5 rounded-lg px-2 text-[13px] font-medium transition-colors [&>svg]:size-4 [&>svg]:shrink-0', active ? 'bg-surface-3 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg');

function NavItem({ to, search, params, icon, children, count, tone = 'danger', active }: { to: string; search?: Record<string, string>; params?: Record<string, string>; icon: ReactNode; children: ReactNode; count?: number; tone?: 'danger' | 'accent'; active?: boolean }) {
  return (
    <Link to={to} search={search} params={params} className={navClass(!!active)}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {!!count && <span className={cn('rounded-md px-1.5 text-[11px] leading-[18px] font-semibold text-white', tone === 'danger' ? 'bg-danger' : 'bg-accent')}>{count}</span>}
    </Link>
  );
}

const Heading = ({ children }: { children: ReactNode }) => <div className="px-2 pt-5 pb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">{children}</div>;

function Sidebar({ me, onSearch, onNavigate }: { me: Me; onSearch: () => void; onNavigate?: () => void }) {
  const types = useAssetTypes();
  const summary = useSummary();
  const counts = useRequestCounts();
  const views = useViews();
  const { mine, canManageOrganization } = useMyOrg();
  const newRequest = useNewRequest();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [theme, setTheme] = useTheme();
  const location = useRouterState({ select: (s) => s.location });
  const path = location.pathname;
  const typeParam = (location.search as { type?: string }).type;
  const requestBadge = counts.data ? (counts.data.handle ? counts.data.unassigned || counts.data.handle : 0) : 0;

  const [resetting, setResetting] = useState(false);
  const reset = async () => {
    await localServer.reset();
    qc.clear();
    window.location.assign('/login');
  };
  const logout = async () => {
    await api.post('/api/identity/auth/logout');
    qc.clear();
    void navigate({ to: '/login' });
  };
  /** Also saved on the profile, so the language follows the person to other devices. */
  const chooseLocale = async (next: Locale) => {
    await api.patch('/api/identity/me/preferences', { locale: next }).catch(() => undefined);
    setLocale(next);
  };

  return (
    // Any click on a link inside closes the drawer on small screens.
    <div className="flex h-full flex-col" onClick={(e) => onNavigate && (e.target as HTMLElement).closest('a') && onNavigate()}>
      <div className="flex h-14 items-center gap-2 px-4">
        <div className="flex size-7 items-center justify-center rounded-lg bg-accent text-white">
          <Shapes className="size-4" />
        </div>
        <span className="text-[14px] font-semibold tracking-tight">Assets</span>
      </div>
      <div className="space-y-2 px-3">
        <button type="button" onClick={() => (onNavigate?.(), newRequest())} className="flex h-9 w-full lg:h-8 items-center justify-center gap-1.5 rounded-lg bg-accent text-[13px] font-medium text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.12)] transition-colors hover:bg-accent-hover">
          <Plus className="size-4" /> {t('Request something')}
        </button>
        <button type="button" onClick={() => (onNavigate?.(), onSearch())} className="flex h-9 w-full lg:h-8 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-[13px] text-subtle transition-colors hover:border-border-strong">
          <Search className="size-3.5" />
          {t('Search anything')}
          <span className="ms-auto hidden gap-0.5 [@media(hover:hover)]:flex">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
      </div>
      <nav className="mt-3 flex-1 space-y-0.5 overflow-y-auto px-3 pb-4">
        <NavItem to="/" icon={<Inbox />} active={path === '/'} count={summary.data?.overdue}>
          {t('Upcoming')}
        </NavItem>
        <NavItem to="/requests" icon={<ShoppingCart />} active={path.startsWith('/requests')} count={requestBadge} tone="accent">
          {t('Requests')}
        </NavItem>
        <NavItem to="/assets" icon={<Shapes />} active={path === '/assets' && !typeParam}>
          {t('All assets')}
        </NavItem>
        <NavItem to="/catalogs" icon={<FolderOpen />} active={path.startsWith('/catalogs')}>
          {t('Catalogs')}
        </NavItem>
        <NavItem to="/calendar" icon={<CalendarDays />} active={path === '/calendar'}>
          {t('Calendar')}
        </NavItem>
        {inBrowser && (
          <NavItem to="/mailbox" icon={<Mail />} active={path === '/mailbox'}>
            {t('Sent emails')}
          </NavItem>
        )}

        {mine.length > 0 && (
          <>
            <Heading>{t('My teams')}</Heading>
            {mine.slice(0, 8).map(({ unit, role }) => (
              <Link key={unit.id} to="/units/$unitId" params={{ unitId: unit.id }} className={navClass(path === `/units/${unit.id}`)}>
                <span className="flex size-4 items-center justify-center">
                  <span className="size-2 rounded-full" style={{ background: unit.color }} />
                </span>
                <span className="min-w-0 flex-1 truncate">{unit.name}</span>
                {role === 'manager' && <span className="text-[10px] font-semibold text-subtle uppercase">{t('Lead')}</span>}
              </Link>
            ))}
          </>
        )}

        {!!views.data?.filter((v) => v.pinned).length && (
          <>
            <Heading>{t('Saved views')}</Heading>
            {views.data
              .filter((v) => v.pinned)
              .map((v) => (
                <NavItem key={v.id} to="/views/$viewId" params={{ viewId: v.id }} icon={<Bookmark />} active={path === `/views/${v.id}`}>
                  {v.name}
                </NavItem>
              ))}
          </>
        )}

        <Heading>{t('Asset types')}</Heading>
        {(types.data ?? []).map((ty) => (
          <Link key={ty.id} to="/assets" search={{ type: ty.id }} className={navClass(typeParam === ty.id)}>
            <TypeIcon icon={ty.icon} color={ty.color} size={18} />
            <span className="truncate">{ty.name}</span>
          </Link>
        ))}
        {types.data?.length === 0 && <p className="px-2 text-xs text-subtle">{me.isAdmin || canManageOrganization ? t('Create a template to get started.') : t('No asset types yet.')}</p>}

        {(me.isAdmin || canManageOrganization) && (
          <>
            <Heading>{t('Administration')}</Heading>
            {me.isAdmin && (
              <NavItem to="/settings/organization" icon={<Network />} active={path === '/settings/organization'}>
                {t('Organization')}
              </NavItem>
            )}
            <NavItem to="/templates" icon={<LayoutTemplate />} active={path.startsWith('/templates')}>
              {t('Templates')}
            </NavItem>
            <NavItem to="/settings/date-kinds" icon={<CalendarDays />} active={path === '/settings/date-kinds'}>
              {t('Date kinds')}
            </NavItem>
            <NavItem to="/settings/workflow" icon={<Workflow />} active={path === '/settings/workflow'}>
              {t('Request workflow')}
            </NavItem>
            {me.isAdmin && (
              <NavItem to="/settings/people" icon={<Users />} active={path === '/settings/people'}>
                {t('People & groups')}
              </NavItem>
            )}
            <NavItem to="/settings/access" icon={<KeyRound />} active={path === '/settings/access'}>
              {t('Access')}
            </NavItem>
            {me.isAdmin && (
              <NavItem to="/settings/backup" icon={<DatabaseBackup />} active={path === '/settings/backup'}>
                {t('Backup & restore')}
              </NavItem>
            )}
          </>
        )}
      </nav>
      <div className="border-t border-border p-3">
        <Menu
          align="start"
          trigger={
            <button type="button" className="flex w-full items-center gap-2 rounded-lg p-1.5 text-start transition-colors hover:bg-surface-2">
              <Avatar name={me.displayName} size={26} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{me.displayName}</span>
                <span className="block truncate text-xs text-subtle">{me.email ?? me.username}</span>
              </span>
              <ChevronDown className="size-3.5 text-subtle" />
            </button>
          }
        >
          <MenuItem icon={<User />} onSelect={() => (onNavigate?.(), void navigate({ to: '/profile' }))}>
            {t('Profile & notifications')}
          </MenuItem>
          {!matchMedia('(pointer: coarse)').matches && (
            <MenuItem icon={<Keyboard />} onSelect={() => window.dispatchEvent(new Event('shortcuts:help'))}>
              {t('Keyboard shortcuts')}
            </MenuItem>
          )}
          <MenuSeparator />
          {(
            [
              ['light', t('Light'), <Sun key="l" />],
              ['dark', t('Dark'), <Moon key="d" />],
              ['system', t('Match device'), <Monitor key="s" />],
            ] as const
          ).map(([value, label, icon]) => (
            <MenuItem key={value} icon={icon} onSelect={() => setTheme(value)}>
              <span className="flex flex-1 items-center justify-between gap-6">
                {label}
                {theme === value && <Check className="size-3.5 text-accent-fg" />}
              </span>
            </MenuItem>
          ))}
          <MenuSub
            icon={<Languages />}
            label={
              <span className="flex flex-1 items-center justify-between gap-6">
                {t('Language')}
                <span className="text-xs text-subtle">{locales.find((l) => l.id === getLocale())?.native}</span>
              </span>
            }
          >
            {locales.map((l) => (
              <MenuItem key={l.id} onSelect={() => void chooseLocale(l.id)}>
                <span lang={l.id} className="flex flex-1 items-center justify-between gap-6">
                  {l.native}
                  {getLocale() === l.id && <Check className="size-3.5 text-accent-fg" />}
                </span>
              </MenuItem>
            ))}
          </MenuSub>
          <MenuSeparator />
          <MenuItem icon={<LogOut />} onSelect={() => void logout()}>
            {t('Sign out')}
          </MenuItem>
          {inBrowser && (
            <MenuItem icon={<Trash2 />} danger onSelect={() => setResetting(true)}>
              {t('Reset this browser’s data…')}
            </MenuItem>
          )}
        </Menu>
      </div>
      {inBrowser && (
        <ConfirmDialog
          open={resetting}
          onOpenChange={setResetting}
          danger
          title={t('Reset this browser’s data?')}
          description={t('Deletes everything Assets stored in this browser: items, people, requests, documents and sent emails. It starts again empty. This cannot be undone.')}
          confirmLabel={t('Delete everything')}
          onConfirm={() => void reset()}
        />
      )}
    </div>
  );
}

export function AppShell({ me }: { me: Me }) {
  const { canManageOrganization } = useMyOrg();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    const show = () => setHelpOpen(true);
    window.addEventListener('shortcuts:help', show);
    return () => window.removeEventListener('shortcuts:help', show);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName));
      if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <NewRequestProvider>
      <div className="flex h-full flex-col lg:flex-row">
        {/* Desktop and tablet landscape: the sidebar stays; smaller screens get a top bar and a drawer. */}
        <aside className="hidden w-64 shrink-0 border-e border-border bg-surface/60 lg:block">
          <Sidebar me={me} onSearch={() => setPaletteOpen(true)} />
        </aside>
        <TopBar me={me} onSearch={() => setPaletteOpen(true)} />
        <main className="flex min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:pb-[env(safe-area-inset-bottom)]">
          <Outlet />
        </main>
        <BottomNav />
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} isAdmin={me.isAdmin || canManageOrganization} onHelp={() => setHelpOpen(true)} />
        <GlobalShortcuts isAdmin={me.isAdmin || canManageOrganization} onHelp={() => setHelpOpen(true)} />
        <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} isAdmin={me.isAdmin || canManageOrganization} />
      </div>
    </NewRequestProvider>
  );
}

function TopBar({ me, onSearch }: { me: Me; onSearch: () => void }) {
  const [open, setOpen] = useState(false);
  const newRequest = useNewRequest();
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => setOpen(false), [path]);
  const icon = 'flex size-10 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg active:bg-surface-3 [&>svg]:size-5';
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-1 border-b border-border bg-surface/90 px-2 pt-[env(safe-area-inset-top)] backdrop-blur lg:hidden">
      <RDialog.Root open={open} onOpenChange={setOpen}>
        <RDialog.Trigger className={icon} aria-label={t('Menu')}>
          <MenuIcon />
        </RDialog.Trigger>
        <RDialog.Portal>
          <RDialog.Overlay className="animate-overlay fixed inset-0 z-40 bg-black/30 dark:bg-black/60" />
          <RDialog.Content className="animate-drawer fixed inset-y-0 start-0 z-50 w-[min(18rem,86vw)] border-e border-border bg-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-pop outline-none">
            <RDialog.Title className="sr-only">{t('Navigation')}</RDialog.Title>
            <RDialog.Description className="sr-only">{t('Pages, teams and asset types')}</RDialog.Description>
            <RDialog.Close className={cn(icon, 'absolute top-2 end-2 z-10')} aria-label={t('Close menu')} style={{ marginTop: 'env(safe-area-inset-top)' }}>
              <X />
            </RDialog.Close>
            <Sidebar me={me} onSearch={onSearch} onNavigate={() => setOpen(false)} />
          </RDialog.Content>
        </RDialog.Portal>
      </RDialog.Root>
      <Link to="/" className="flex items-center gap-2 px-1">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent text-white">
          <Shapes className="size-4" />
        </span>
        <span className="text-[15px] font-semibold tracking-tight">Assets</span>
      </Link>
      <span className="flex-1" />
      <button type="button" className={icon} aria-label={t('Search')} onClick={onSearch}>
        <Search />
      </button>
      <button type="button" className={cn(icon, 'text-accent-fg')} aria-label={t('Request something')} onClick={newRequest}>
        <Plus />
      </button>
    </header>
  );
}

/** ⌘K / "/": find anything, or jump anywhere. Enter on the query opens full results. */
function CommandPalette({ open, onOpenChange, isAdmin, onHelp }: { open: boolean; onOpenChange: (o: boolean) => void; isAdmin: boolean; onHelp: () => void }) {
  const [q, setQ] = useState('');
  const recent = useRecent();
  const creatable = useCreatableTypes();
  const debounced = useDebounced(q, 150);
  const navigate = useNavigate();
  const newRequest = useNewRequest();
  const r = useUniversalSearch(debounced, 6);
  const go = (fn: () => void) => {
    fn();
    onOpenChange(false);
    setQ('');
  };
  const item = 'flex min-h-10 cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] data-[selected=true]:bg-surface-2 [&>svg]:size-4 [&>svg]:text-muted';
  const group = 'px-1 py-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-subtle [&_[cmdk-group-heading]]:uppercase';
  const groups = [
    { key: 'assets', title: t('Assets'), hits: r.assets },
    { key: 'requests', title: t('Requests'), hits: r.requests },
    { key: 'units', title: t('Teams'), hits: r.units },
    { key: 'people', title: t('People'), hits: r.people },
    { key: 'types', title: t('Asset types'), hits: r.types },
  ];
  const needle = q.trim().toLowerCase();
  const matches = (label: string) => !needle || label.toLowerCase().includes(needle);
  const keyOf = (to: string) => goTo.find((g) => g.to === to)?.key;
  const creates = [
    { label: t('Request something'), icon: <Plus />, keys: ['R'], run: () => newRequest() },
    ...creatable.map((ty) => ({ label: t('New {type}', { type: inSentence(ty.name) }), icon: <TypeIcon icon={ty.icon} color={ty.color} size={20} />, keys: [] as string[], run: () => void navigate({ to: '/assets', search: { type: ty.id, new: '1' } }) })),
    ...(isAdmin ? [{ label: t('New template'), icon: <LayoutTemplate />, keys: [] as string[], run: () => void navigate({ to: '/templates', search: { new: '1' } }) }] : []),
    { label: t('Import a spreadsheet'), icon: <FileUp />, keys: ['G', 'I'], run: () => void navigate({ to: '/import' }) },
    ...(matchMedia('(pointer: coarse)').matches ? [] : [{ label: t('Keyboard shortcuts'), icon: <Keyboard />, keys: ['?'], run: onHelp }]),
  ].filter((x) => matches(x.label));
  const recents = needle ? recent.filter((x) => x.title.toLowerCase().includes(needle)).slice(0, 4) : recent.slice(0, 5);
  const jumps = [
    { label: t('Upcoming'), icon: <Inbox />, to: '/' },
    { label: t('Requests'), icon: <ShoppingCart />, to: '/requests' },
    { label: t('All assets'), icon: <Shapes />, to: '/assets' },
    { label: t('Calendar'), icon: <CalendarDays />, to: '/calendar' },
    { label: t('Catalogs'), icon: <FolderOpen />, to: '/catalogs' },
    { label: t('Profile & notifications'), icon: <User />, to: '/profile' },
    ...(isAdmin
      ? [
          { label: t('Organization'), icon: <Building2 />, to: '/settings/organization' },
          { label: t('Templates'), icon: <LayoutTemplate />, to: '/templates' },
          { label: t('Access'), icon: <KeyRound />, to: '/settings/access' },
        ]
      : []),
  ]
    .filter((x) => matches(x.label))
    .map((x) => ({ ...x, run: () => void navigate({ to: x.to }), keys: ((k) => (k ? ['G', k.toUpperCase()] : []))(keyOf(x.to)) }));

  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="animate-overlay fixed inset-0 z-40 bg-black/30 dark:bg-black/60" />
        <RDialog.Content className="animate-panel fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-pop">
          <RDialog.Title className="sr-only">{t('Search')}</RDialog.Title>
          <RDialog.Description className="sr-only">{t('Search assets, requests, teams and people, or jump to a page')}</RDialog.Description>
          <Command shouldFilter={false} loop>
            <div className="flex items-center gap-2 border-b border-border px-4">
              <Search className="size-4 text-subtle" />
              <Command.Input
                value={q}
                onValueChange={setQ}
                placeholder={t('Search anything, or jump to…')}
                className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-subtle"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && q.trim()) go(() => void navigate({ to: '/search', search: { q } }));
                }}
              />
              {q && <span className="text-[11px] text-subtle">{t('⌘↵ all results')}</span>}
            </div>
            <Command.List className="max-h-[60vh] overflow-y-auto pb-1">
              {r.empty && <div className="py-10 text-center text-[13px] text-muted">{t('Nothing found for “{query}”', { query: debounced })}</div>}
              {groups.map(
                (g) =>
                  g.hits.length > 0 && (
                    <Command.Group key={g.key} heading={g.title} className={group}>
                      {g.hits.map((h) => (
                        <Command.Item key={`${h.kind}-${h.id}`} value={`${h.kind}-${h.id}`} className={item} onSelect={() => go(() => void navigate(hitLink(h) as never))}>
                          <HitIcon hit={h} size={24} />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline gap-2">
                              <span className="truncate font-medium">{h.title}</span>
                              {h.subtitle && <span className="truncate text-xs text-subtle">{h.subtitle}</span>}
                            </span>
                            {h.snippet && <Highlight snippet={h.snippet} className="block truncate text-xs text-muted" />}
                          </span>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  ),
              )}
              {debounced.trim() && !r.empty && (
                <Command.Group className={group}>
                  <Command.Item value="all-results" className={item} onSelect={() => go(() => void navigate({ to: '/search', search: { q } }))}>
                    <Search />
                    {t('See all results for “{query}”', { query: q })}
                  </Command.Item>
                </Command.Group>
              )}
              {recents.length > 0 && (
                <Command.Group heading={t('Recent')} className={group}>
                  {recents.map((x) => (
                    <Command.Item key={`${x.kind}-${x.id}`} value={`recent-${x.kind}-${x.id}`} className={item} onSelect={() => go(() => void navigate(recentLink(x) as never))}>
                      {x.icon ? <TypeIcon icon={x.icon} color={x.color ?? '#64748b'} size={24} /> : x.kind === 'request' ? <ShoppingCart /> : x.kind === 'catalog' ? <FolderOpen /> : x.kind === 'unit' ? <Building2 /> : <Clock />}
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="truncate font-medium">{x.title}</span>
                        {x.subtitle && <span className="truncate text-xs text-subtle">{x.subtitle}</span>}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {creates.length > 0 && (
                <Command.Group heading={t('Create')} className={group}>
                  {creates.map((x) => (
                    <Command.Item key={x.label} value={`create-${x.label}`} className={item} onSelect={() => go(x.run)}>
                      {x.icon}
                      <span className="flex-1">{x.label}</span>
                      <Keys keys={x.keys} />
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {jumps.length > 0 && (
                <Command.Group heading={t('Go to')} className={group}>
                  {jumps.map((x) => (
                    <Command.Item key={x.label} value={`jump-${x.label}`} className={item} onSelect={() => go(x.run)}>
                      {x.icon}
                      <span className="flex-1">{x.label}</span>
                      <Keys keys={x.keys} />
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

function recentLink(x: RecentItem) {
  switch (x.kind) {
    case 'asset':
      return { to: '/assets/$assetId', params: { assetId: x.id } };
    case 'request':
      return { to: '/requests/$requestId', params: { requestId: x.id } };
    case 'template':
      return { to: '/templates/$typeId', params: { typeId: x.id } };
    case 'unit':
      return { to: '/units/$unitId', params: { unitId: x.id } };
    case 'catalog':
      return { to: '/catalogs/$catalogId', params: { catalogId: x.id } };
  }
}

/** Key hints, hidden on touch screens where they mean nothing. */
function Keys({ keys }: { keys: string[] }) {
  if (!keys.length) return null;
  return (
    <span className="ms-auto flex items-center gap-1 touch:hidden">
      {keys.map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  );
}

function GlobalShortcuts({ isAdmin, onHelp }: { isAdmin: boolean; onHelp: () => void }) {
  const navigate = useNavigate();
  const newRequest = useNewRequest();
  useGlobalShortcuts({ navigate: (to) => void navigate({ to }), isAdmin, onHelp, onRequest: newRequest });
  return null;
}

function ShortcutsHelp({ open, onOpenChange, isAdmin }: { open: boolean; onOpenChange: (o: boolean) => void; isAdmin: boolean }) {
  const hidden = new Set(goTo.filter((g) => g.admin && !isAdmin).map((g) => g.label));
  const list = shortcutHelp.filter((x) => !hidden.has(x.label));
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('Keyboard shortcuts')} description={t('Work without the mouse. Shortcuts pause while you type in a field.')}>
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        {(['Actions', 'Lists', 'Go to'] as const).map((g) => (
          <section key={g} className={g === 'Go to' ? 'sm:row-span-2 sm:col-start-2 sm:row-start-1' : undefined}>
            <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-subtle uppercase">{t(g)}</h3>
            <ul className="space-y-1.5">
              {list
                .filter((x) => x.group === g)
                .map((x) => (
                  <li key={x.label} className="flex items-center justify-between gap-3 text-[13px]">
                    <span>{t(x.label)}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {x.keys.map((k, i) => (
                        <Kbd key={i}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

/** Phones and tablets (no sidebar below desktop width): the main places one tap away, at the bottom where thumbs reach. The menu keeps the rest. */
function BottomNav() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const summary = useSummary();
  const counts = useRequestCounts();
  const requestBadge = counts.data ? (counts.data.handle ? counts.data.unassigned || counts.data.handle : 0) : 0;
  const items = [
    { to: '/', label: t('Upcoming'), icon: <Inbox />, active: path === '/', badge: summary.data?.overdue, danger: true },
    { to: '/requests', label: t('Requests'), icon: <ShoppingCart />, active: path.startsWith('/requests'), badge: requestBadge },
    { to: '/assets', label: t('Assets'), icon: <Shapes />, active: path.startsWith('/assets') || path.startsWith('/views') },
    { to: '/catalogs', label: t('Catalogs'), icon: <FolderOpen />, active: path.startsWith('/catalogs') },
    { to: '/calendar', label: t('Calendar'), icon: <CalendarDays />, active: path.startsWith('/calendar') },
  ] as const;
  return (
    <nav aria-label={t('Main')} className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      <ul className="mx-auto grid h-14 max-w-xl grid-cols-5">
        {items.map((x) => (
          <li key={x.to}>
            <Link
              to={x.to}
              aria-current={x.active ? 'page' : undefined}
              className={cn('relative flex h-full flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors [&>svg]:size-5', x.active ? 'text-accent-fg' : 'text-muted active:text-fg')}
            >
              {x.icon}
              {x.label}
              {!!('badge' in x && x.badge) && (
                <span className={cn('absolute top-1.5 left-1/2 ms-1.5 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-semibold text-white', 'danger' in x && x.danger ? 'bg-danger' : 'bg-accent')}>
                  {x.badge! > 99 ? '99+' : x.badge}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
