import type { Me } from '@am/core';
import * as RDialog from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Command } from 'cmdk';
import {
  Bookmark,
  Building2,
  CalendarDays,
  ChevronDown,
  FileUp,
  FolderOpen,
  Inbox,
  KeyRound,
  LayoutTemplate,
  LogOut,
  Moon,
  Network,
  Plus,
  Search,
  Shapes,
  ShoppingCart,
  Sun,
  User,
  Users,
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

export function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (document.documentElement.dataset.theme as 'light' | 'dark') ?? 'light');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* storage may be unavailable */
    }
  }, [theme]);
  return [theme, setTheme] as const;
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

function Sidebar({ me, onSearch }: { me: Me; onSearch: () => void }) {
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
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface/60">
      <div className="flex h-14 items-center gap-2 px-4">
        <div className="flex size-7 items-center justify-center rounded-lg bg-accent text-white">
          <Shapes className="size-4" />
        </div>
        <span className="text-[14px] font-semibold tracking-tight">Assets</span>
      </div>
      <div className="space-y-2 px-3">
        <button type="button" onClick={newRequest} className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-accent text-[13px] font-medium text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.12)] transition-colors hover:bg-accent-hover">
          <Plus className="size-4" /> Request something
        </button>
        <button type="button" onClick={onSearch} className="flex h-8 w-full items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-[13px] text-subtle transition-colors hover:border-border-strong">
          <Search className="size-3.5" />
          Search anything
          <span className="ml-auto flex gap-0.5">
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
          <MenuItem icon={<User />} onSelect={() => void navigate({ to: '/profile' })}>
            Profile & notifications
          </MenuItem>
          <MenuItem icon={theme === 'dark' ? <Sun /> : <Moon />} onSelect={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<LogOut />} onSelect={() => void logout()}>
            Sign out
          </MenuItem>
        </Menu>
      </div>
    </aside>
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
      <div className="flex h-full">
        <Sidebar me={me} onSearch={() => setPaletteOpen(true)} />
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <Outlet />
        </main>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} isAdmin={me.isAdmin || canManageOrganization} />
      </div>
    </NewRequestProvider>
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
