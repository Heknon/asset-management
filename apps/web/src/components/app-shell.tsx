import type { Me } from '@am/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Command } from 'cmdk';
import { CalendarDays, ChevronDown, Inbox, KeyRound, LayoutTemplate, LogOut, Moon, Search, Settings2, Shapes, Sun, Tags, User, Users } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useAssets, useAssetTypes, useSummary } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { TypeIcon } from './type-icon';
import { Avatar, Kbd } from './ui/display';
import { Menu, MenuItem, MenuSeparator } from './ui/overlay';
import * as RDialog from '@radix-ui/react-dialog';

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

function NavItem({ to, search, icon, children, count, active }: { to: string; search?: Record<string, string>; icon: ReactNode; children: ReactNode; count?: number; active?: boolean }) {
  return (
    <Link
      to={to}
      search={search}
      className={cn(
        'flex h-8 items-center gap-2.5 rounded-lg px-2 text-[13px] font-medium transition-colors [&>svg]:size-4',
        active ? 'bg-surface-3 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {!!count && <span className="rounded-md bg-danger px-1.5 text-[11px] leading-[18px] font-semibold text-white">{count}</span>}
    </Link>
  );
}

export function AppShell({ me }: { me: Me }) {
  const types = useAssetTypes();
  const summary = useSummary();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useRouterState({ select: (s) => s.location });
  const path = location.pathname;
  const typeParam = (location.search as { type?: string }).type;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const logout = async () => {
    await api.post('/api/identity/auth/logout');
    qc.clear();
    void navigate({ to: '/login' });
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface/60">
        <div className="flex h-14 items-center gap-2 px-4">
          <div className="flex size-7 items-center justify-center rounded-lg bg-accent text-white">
            <Shapes className="size-4" />
          </div>
          <span className="text-[14px] font-semibold tracking-tight">Assets</span>
        </div>
        <div className="px-3">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-8 w-full items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-[13px] text-subtle transition-colors hover:border-border-strong"
          >
            <Search className="size-3.5" />
            Search
            <span className="ml-auto flex gap-0.5">
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </span>
          </button>
        </div>
        <nav className="mt-4 flex-1 space-y-0.5 overflow-y-auto px-3">
          <NavItem to="/" icon={<Inbox />} active={path === '/'} count={summary.data?.overdue}>
            Upcoming
          </NavItem>
          <NavItem to="/calendar" icon={<CalendarDays />} active={path === '/calendar'}>
            Calendar
          </NavItem>
          <NavItem to="/assets" icon={<Shapes />} active={path === '/assets' && !typeParam}>
            All assets
          </NavItem>

          <div className="px-2 pt-5 pb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">Asset types</div>
          {(types.data ?? []).map((t) => (
            <Link
              key={t.id}
              to="/assets"
              search={{ type: t.id }}
              className={cn('flex h-8 items-center gap-2.5 rounded-lg px-2 text-[13px] font-medium transition-colors', typeParam === t.id ? 'bg-surface-3 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg')}
            >
              <TypeIcon icon={t.icon} color={t.color} size={18} />
              <span className="truncate">{t.name}</span>
            </Link>
          ))}
          {types.data?.length === 0 && <p className="px-2 text-xs text-subtle">{me.isAdmin ? 'Create a template to get started.' : 'No asset types yet.'}</p>}

          {me.isAdmin && (
            <>
              <div className="px-2 pt-5 pb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">Administration</div>
              <NavItem to="/templates" icon={<LayoutTemplate />} active={path.startsWith('/templates')}>
                Templates
              </NavItem>
              <NavItem to="/settings/date-kinds" icon={<CalendarDays />} active={path === '/settings/date-kinds'}>
                Date kinds
              </NavItem>
              <NavItem to="/settings/purchase-classes" icon={<Tags />} active={path === '/settings/purchase-classes'}>
                Purchase classes
              </NavItem>
              <NavItem to="/settings/people" icon={<Users />} active={path === '/settings/people'}>
                People & groups
              </NavItem>
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
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <Outlet />
      </main>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} isAdmin={me.isAdmin} />
    </div>
  );
}

function CommandPalette({ open, onOpenChange, isAdmin }: { open: boolean; onOpenChange: (o: boolean) => void; isAdmin: boolean }) {
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const types = useAssetTypes();
  const assets = useAssets({ q: q || undefined, limit: 8, sort: 'updatedAt', order: 'desc' });
  const go = (fn: () => void) => {
    fn();
    onOpenChange(false);
    setQ('');
  };
  const item = 'flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px] data-[selected=true]:bg-surface-2 [&>svg]:size-4 [&>svg]:text-muted';
  const group = 'px-1 py-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-subtle [&_[cmdk-group-heading]]:uppercase';

  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="animate-overlay fixed inset-0 z-40 bg-black/30 dark:bg-black/60" />
        <RDialog.Content className="animate-panel fixed top-[14vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-pop">
          <RDialog.Title className="sr-only">Search</RDialog.Title>
          <RDialog.Description className="sr-only">Search assets and jump to pages</RDialog.Description>
          <Command shouldFilter={false}>
            <div className="flex items-center gap-2 border-b border-border px-4">
              <Search className="size-4 text-subtle" />
              <Command.Input value={q} onValueChange={setQ} placeholder="Search assets, or jump to…" className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-subtle" />
            </div>
            <Command.List className="max-h-[50vh] overflow-y-auto pb-1">
              <Command.Empty className="py-10 text-center text-[13px] text-muted">Nothing found</Command.Empty>
              {!!assets.data?.items.length && (
                <Command.Group heading={q ? 'Assets' : 'Recently updated'} className={group}>
                  {assets.data.items.map((a) => {
                    const t = types.data?.find((x) => x.id === a.assetTypeId);
                    return (
                      <Command.Item key={a.id} value={a.id} className={item} onSelect={() => go(() => void navigate({ to: '/assets/$assetId', params: { assetId: a.id } }))}>
                        {t && <TypeIcon icon={t.icon} color={t.color} size={20} />}
                        <span className="truncate">{a.name}</span>
                        <span className="ml-auto text-xs text-subtle">{t?.name}</span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              )}
              <Command.Group heading="Go to" className={group}>
                {[
                  { label: 'Upcoming', icon: <Inbox />, to: '/' },
                  { label: 'Calendar', icon: <CalendarDays />, to: '/calendar' },
                  { label: 'All assets', icon: <Shapes />, to: '/assets' },
                  { label: 'Profile & notifications', icon: <User />, to: '/profile' },
                  ...(isAdmin
                    ? [
                        { label: 'Templates', icon: <LayoutTemplate />, to: '/templates' },
                        { label: 'Access', icon: <Settings2 />, to: '/settings/access' },
                      ]
                    : []),
                ]
                  .filter((x) => !q || x.label.toLowerCase().includes(q.toLowerCase()))
                  .map((x) => (
                    <Command.Item key={x.to} value={x.to} className={item} onSelect={() => go(() => void navigate({ to: x.to }))}>
                      {x.icon}
                      {x.label}
                    </Command.Item>
                  ))}
              </Command.Group>
            </Command.List>
          </Command>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
