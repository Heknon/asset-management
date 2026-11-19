import type { Me } from '@am/core';
import * as RDialog from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Command } from 'cmdk';
import {
  Bookmark,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  FileUp,
  FolderOpen,
  Inbox,
  KeyRound,
  LayoutTemplate,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  Network,
  Plus,
  Search,
  Shapes,
  ShoppingCart,
  Sun,
  User,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useMyOrg } from '@/lib/org';
import { useAssetTypes, useRequestCounts, useSummary, useViews } from '@/lib/queries';
import { useUniversalSearch } from '@/lib/search';
import { cn } from '@/lib/utils';
import { useDebounced } from '@/lib/hooks';
import { Highlight } from './highlight';
import { HitIcon, hitLink } from './search-hit';
import { NewRequestProvider, useNewRequest } from './request-form';
import { TypeIcon } from './type-icon';
import { Avatar, Kbd } from './ui/display';
import { Menu, MenuItem, MenuSeparator } from './ui/overlay';

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

  const logout = async () => {
    await api.post('/api/identity/auth/logout');
    qc.clear();
    void navigate({ to: '/login' });
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
          <Plus className="size-4" /> Request something
        </button>
        <button type="button" onClick={() => (onNavigate?.(), onSearch())} className="flex h-9 w-full lg:h-8 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-[13px] text-subtle transition-colors hover:border-border-strong">
          <Search className="size-3.5" />
          Search anything
          <span className="ml-auto hidden gap-0.5 [@media(hover:hover)]:flex">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
      </div>
      <nav className="mt-3 flex-1 space-y-0.5 overflow-y-auto px-3 pb-4">
        <NavItem to="/" icon={<Inbox />} active={path === '/'} count={summary.data?.overdue}>
          Upcoming
        </NavItem>
        <NavItem to="/requests" icon={<ShoppingCart />} active={path.startsWith('/requests')} count={requestBadge} tone="accent">
          Requests
        </NavItem>
        <NavItem to="/assets" icon={<Shapes />} active={path === '/assets' && !typeParam}>
          All assets
        </NavItem>
        <NavItem to="/catalogs" icon={<FolderOpen />} active={path.startsWith('/catalogs')}>
          Catalogs
        </NavItem>
        <NavItem to="/calendar" icon={<CalendarDays />} active={path === '/calendar'}>
          Calendar
        </NavItem>

        {mine.length > 0 && (
          <>
            <Heading>My teams</Heading>
            {mine.slice(0, 8).map(({ unit, role }) => (
              <Link key={unit.id} to="/units/$unitId" params={{ unitId: unit.id }} className={navClass(path === `/units/${unit.id}`)}>
                <span className="flex size-4 items-center justify-center">
                  <span className="size-2 rounded-full" style={{ background: unit.color }} />
                </span>
                <span className="min-w-0 flex-1 truncate">{unit.name}</span>
                {role === 'manager' && <span className="text-[10px] font-semibold text-subtle uppercase">Lead</span>}
              </Link>
            ))}
          </>
        )}

        {!!views.data?.filter((v) => v.pinned).length && (
          <>
            <Heading>Saved views</Heading>
            {views.data
              .filter((v) => v.pinned)
              .map((v) => (
                <NavItem key={v.id} to="/views/$viewId" params={{ viewId: v.id }} icon={<Bookmark />} active={path === `/views/${v.id}`}>
                  {v.name}
                </NavItem>
              ))}
          </>
        )}

        <Heading>Asset types</Heading>
        {(types.data ?? []).map((t) => (
          <Link key={t.id} to="/assets" search={{ type: t.id }} className={navClass(typeParam === t.id)}>
            <TypeIcon icon={t.icon} color={t.color} size={18} />
            <span className="truncate">{t.name}</span>
          </Link>
        ))}
        {types.data?.length === 0 && <p className="px-2 text-xs text-subtle">{me.isAdmin || canManageOrganization ? 'Create a template to get started.' : 'No asset types yet.'}</p>}

        {(me.isAdmin || canManageOrganization) && (
          <>
            <Heading>Administration</Heading>
            {me.isAdmin && (
              <NavItem to="/settings/organization" icon={<Network />} active={path === '/settings/organization'}>
                Organization
              </NavItem>
            )}
            <NavItem to="/templates" icon={<LayoutTemplate />} active={path.startsWith('/templates')}>
              Templates
            </NavItem>
            <NavItem to="/settings/date-kinds" icon={<CalendarDays />} active={path === '/settings/date-kinds'}>
              Date kinds
            </NavItem>
            <NavItem to="/settings/workflow" icon={<Workflow />} active={path === '/settings/workflow'}>
              Request workflow
            </NavItem>
            {me.isAdmin && (
              <NavItem to="/settings/people" icon={<Users />} active={path === '/settings/people'}>
                People & groups
              </NavItem>
            )}
            <NavItem to="/settings/access" icon={<KeyRound />} active={path === '/settings/access'}>
              Access
            </NavItem>
          </>
        )}
      </nav>
      <div className="border-t border-border p-3">
        <Menu
          align="start"
          trigger={
            <button type="button" className="flex w-full items-center gap-2 rounded-lg p-1.5 text-left transition-colors hover:bg-surface-2">
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
            Profile & notifications
          </MenuItem>
          <MenuSeparator />
          {(
            [
              ['light', 'Light', <Sun key="l" />],
              ['dark', 'Dark', <Moon key="d" />],
              ['system', 'Match device', <Monitor key="s" />],
            ] as const
          ).map(([value, label, icon]) => (
            <MenuItem key={value} icon={icon} onSelect={() => setTheme(value)}>
              <span className="flex flex-1 items-center justify-between gap-6">
                {label}
                {theme === value && <Check className="size-3.5 text-accent-fg" />}
              </span>
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem icon={<LogOut />} onSelect={() => void logout()}>
            Sign out
          </MenuItem>
        </Menu>
      </div>
    </div>
  );
}

export function AppShell({ me }: { me: Me }) {
  const { canManageOrganization } = useMyOrg();
  const [paletteOpen, setPaletteOpen] = useState(false);
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
        <aside className="hidden w-64 shrink-0 border-r border-border bg-surface/60 lg:block">
          <Sidebar me={me} onSearch={() => setPaletteOpen(true)} />
        </aside>
        <TopBar me={me} onSearch={() => setPaletteOpen(true)} />
        <main className="flex min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto pb-[env(safe-area-inset-bottom)]">
          <Outlet />
        </main>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} isAdmin={me.isAdmin || canManageOrganization} />
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
        <RDialog.Trigger className={icon} aria-label="Menu">
          <MenuIcon />
        </RDialog.Trigger>
        <RDialog.Portal>
          <RDialog.Overlay className="animate-overlay fixed inset-0 z-40 bg-black/30 dark:bg-black/60" />
          <RDialog.Content className="animate-drawer fixed inset-y-0 left-0 z-50 w-[min(18rem,86vw)] border-r border-border bg-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-pop outline-none">
            <RDialog.Title className="sr-only">Navigation</RDialog.Title>
            <RDialog.Description className="sr-only">Pages, teams and asset types</RDialog.Description>
            <RDialog.Close className={cn(icon, 'absolute top-2 right-2 z-10')} aria-label="Close menu" style={{ marginTop: 'env(safe-area-inset-top)' }}>
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
      <button type="button" className={icon} aria-label="Search" onClick={onSearch}>
        <Search />
      </button>
      <button type="button" className={cn(icon, 'text-accent-fg')} aria-label="Request something" onClick={newRequest}>
        <Plus />
      </button>
    </header>
  );
}

/** ⌘K / "/": find anything, or jump anywhere. Enter on the query opens full results. */
function CommandPalette({ open, onOpenChange, isAdmin }: { open: boolean; onOpenChange: (o: boolean) => void; isAdmin: boolean }) {
  const [q, setQ] = useState('');
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
    { title: 'Assets', hits: r.assets },
    { title: 'Requests', hits: r.requests },
    { title: 'Teams', hits: r.units },
    { title: 'People', hits: r.people },
    { title: 'Asset types', hits: r.types },
  ];
  const jumps = [
    { label: 'Request something', icon: <Plus />, run: () => newRequest() },
    { label: 'Upcoming', icon: <Inbox />, run: () => void navigate({ to: '/' }) },
    { label: 'Requests', icon: <ShoppingCart />, run: () => void navigate({ to: '/requests' }) },
    { label: 'All assets', icon: <Shapes />, run: () => void navigate({ to: '/assets' }) },
    { label: 'Calendar', icon: <CalendarDays />, run: () => void navigate({ to: '/calendar' }) },
    { label: 'Catalogs', icon: <FolderOpen />, run: () => void navigate({ to: '/catalogs' }) },
    { label: 'Import a spreadsheet', icon: <FileUp />, run: () => void navigate({ to: '/import' }) },
    { label: 'Profile & notifications', icon: <User />, run: () => void navigate({ to: '/profile' }) },
    ...(isAdmin
      ? [
          { label: 'Organization', icon: <Building2 />, run: () => void navigate({ to: '/settings/organization' }) },
          { label: 'Templates', icon: <LayoutTemplate />, run: () => void navigate({ to: '/templates' }) },
          { label: 'Access', icon: <KeyRound />, run: () => void navigate({ to: '/settings/access' }) },
        ]
      : []),
  ].filter((x) => !q || x.label.toLowerCase().includes(q.toLowerCase()));

  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="animate-overlay fixed inset-0 z-40 bg-black/30 dark:bg-black/60" />
        <RDialog.Content className="animate-panel fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-pop">
          <RDialog.Title className="sr-only">Search</RDialog.Title>
          <RDialog.Description className="sr-only">Search assets, requests, teams and people, or jump to a page</RDialog.Description>
          <Command shouldFilter={false} loop>
            <div className="flex items-center gap-2 border-b border-border px-4">
              <Search className="size-4 text-subtle" />
              <Command.Input
                value={q}
                onValueChange={setQ}
                placeholder="Search anything, or jump to…"
                className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-subtle"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && q.trim()) go(() => void navigate({ to: '/search', search: { q } }));
                }}
              />
              {q && <span className="text-[11px] text-subtle">⌘↵ all results</span>}
            </div>
            <Command.List className="max-h-[60vh] overflow-y-auto pb-1">
              {r.empty && <div className="py-10 text-center text-[13px] text-muted">Nothing found for “{debounced}”</div>}
              {groups.map(
                (g) =>
                  g.hits.length > 0 && (
                    <Command.Group key={g.title} heading={g.title} className={group}>
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
                    See all results for “{q}”
                  </Command.Item>
                </Command.Group>
              )}
              {jumps.length > 0 && (
                <Command.Group heading="Go to" className={group}>
                  {jumps.map((x) => (
                    <Command.Item key={x.label} value={`jump-${x.label}`} className={item} onSelect={() => go(x.run)}>
                      {x.icon}
                      {x.label}
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
