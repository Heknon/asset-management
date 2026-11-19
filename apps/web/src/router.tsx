import type { Me } from '@am/core';
import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, createRoute, createRouter, Navigate, Outlet, redirect, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { AppShell } from './components/app-shell';
import { Spinner } from './components/ui/display';
import { api, ApiError, sessionEvents } from './lib/api';
import { keys, useLookups, useMe } from './lib/queries';
import { AssetDetailPage } from './routes/asset-detail';
import { AssetsPage, SavedViewPage } from './routes/assets';
import { CalendarPage } from './routes/calendar';
import { LoginPage } from './routes/login';
import { OrganizationPage } from './routes/organization';
import { RequestDetailPage, RequestsPage } from './routes/requests';
import { SearchPage } from './routes/search';
import { AccessPage, DateKindsPage, PeoplePage, ProfilePage } from './routes/settings';
import { UnitPage } from './routes/unit';
import { TemplateBuilderPage } from './routes/template-builder';
import { TemplatesPage } from './routes/templates';
import { UpcomingPage } from './routes/upcoming';

function Authenticated() {
  const me = useMe();
  const lookups = useLookups();
  const navigate = useNavigate();
  const href = useRouterState({ select: (s) => s.location.href });
  const expired = me.error instanceof ApiError && me.error.status === 401;

  // Session ended while the app was open (refresh failed): go to sign-in once.
  useEffect(() => {
    const onExpired = () => void me.refetch();
    sessionEvents.addEventListener('expired', onExpired);
    return () => sessionEvents.removeEventListener('expired', onExpired);
  }, [me]);
  useEffect(() => {
    if (expired) void navigate({ to: '/login', search: { returnTo: href }, replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expired]);

  if (!me.data || !lookups.ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return <AppShell me={me.data} />;
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const me = useMe().data;
  return me?.isAdmin ? <>{children}</> : <Navigate to="/" />;
}

const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet });
const app = createRoute({
  getParentRoute: () => root,
  id: 'app',
  component: Authenticated,
  /** Auth guard: resolve the session before rendering any protected page. */
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData({ queryKey: keys.me, queryFn: () => api.get<Me>('/api/identity/me') });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw redirect({ to: '/login', search: { returnTo: location.href } });
      throw err;
    }
  },
});

const admin = (Component: () => React.ReactNode) => () => (
  <AdminOnly>
    <Component />
  </AdminOnly>
);
const optionalString = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const login = createRoute({
  getParentRoute: () => root,
  path: '/login',
  component: LoginPage,
  validateSearch: (s: Record<string, unknown>) => ({ error: optionalString(s.error), returnTo: optionalString(s.returnTo) }),
});

const routeTree = root.addChildren([
  login,
  app.addChildren([
    createRoute({ getParentRoute: () => app, path: '/', component: UpcomingPage }),
    createRoute({ getParentRoute: () => app, path: '/calendar', component: CalendarPage }),
    createRoute({ getParentRoute: () => app, path: '/assets', component: AssetsPage, validateSearch: (s: Record<string, unknown>) => ({ type: optionalString(s.type), q: optionalString(s.q) }) }),
    createRoute({ getParentRoute: () => app, path: '/search', component: SearchPage, validateSearch: (s: Record<string, unknown>) => ({ q: optionalString(s.q) }) }),
    createRoute({ getParentRoute: () => app, path: '/requests', component: RequestsPage }),
    createRoute({ getParentRoute: () => app, path: '/requests/$requestId', component: RequestDetailPage }),
    createRoute({ getParentRoute: () => app, path: '/units/$unitId', component: UnitPage }),
    createRoute({ getParentRoute: () => app, path: '/views/$viewId', component: SavedViewPage }),
    createRoute({ getParentRoute: () => app, path: '/assets/$assetId', component: AssetDetailPage }),
    createRoute({ getParentRoute: () => app, path: '/profile', component: ProfilePage }),
    createRoute({ getParentRoute: () => app, path: '/templates', component: admin(TemplatesPage) }),
    createRoute({ getParentRoute: () => app, path: '/templates/$typeId', component: admin(TemplateBuilderPage) }),
    createRoute({ getParentRoute: () => app, path: '/settings/date-kinds', component: admin(DateKindsPage) }),
    createRoute({ getParentRoute: () => app, path: '/settings/organization', component: admin(OrganizationPage) }),
    createRoute({ getParentRoute: () => app, path: '/settings/people', component: admin(PeoplePage) }),
    createRoute({ getParentRoute: () => app, path: '/settings/access', component: admin(AccessPage) }),
  ]),
]);

export const createAppRouter = (queryClient: QueryClient) => createRouter({ routeTree, context: { queryClient }, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
