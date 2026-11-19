import type { Me } from '@am/core';
import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, createRoute, createRouter, Navigate, Outlet, redirect, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { AppShell } from './components/app-shell';
import { ErrorScreen } from './components/error-screen';
import { Spinner } from './components/ui/display';
import { api, ApiError, sessionEvents } from './lib/api';
import { useMyOrg } from './lib/org';
import { keys, useLookups, useMe } from './lib/queries';
import { AssetDetailPage } from './routes/asset-detail';
import { AssetsPage, SavedViewPage } from './routes/assets';
import { CalendarPage } from './routes/calendar';
import { CatalogPage, CatalogsPage } from './routes/catalogs';
import { ImportPage } from './routes/import';
import { LoginPage } from './routes/login';
import { MailboxPage } from './routes/mailbox';
import { inBrowser } from './lib/run-mode';
import { OrganizationPage } from './routes/organization';
import { RequestDetailPage, RequestsPage } from './routes/requests';
import { SearchPage } from './routes/search';
import { AccessPage, DateKindsPage, PeoplePage, ProfilePage, WorkflowsPage } from './routes/settings';
import { UnitPage } from './routes/unit';
import { TemplateBuilderPage, VariantBuilderPage } from './routes/template-builder';
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

/** Templates, date kinds and organization-wide access: admins and people who manage the whole organization. */
function OrganizationManagers({ children }: { children: React.ReactNode }) {
  const { canManageOrganization } = useMyOrg();
  return canManageOrganization ? <>{children}</> : <Navigate to="/" />;
}

const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet, errorComponent: ({ error }) => <ErrorScreen error={error} /> });
const app = createRoute({
  getParentRoute: () => root,
  id: 'app',
  component: Authenticated,
  errorComponent: ({ error }) => <ErrorScreen error={error} />,
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
const orgManagers = (Component: () => React.ReactNode) => () => (
  <OrganizationManagers>
    <Component />
  </OrganizationManagers>
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
    createRoute({
      getParentRoute: () => app,
      path: '/assets',
      component: AssetsPage,
      validateSearch: (s: Record<string, unknown>) => ({ type: optionalString(s.type), q: optionalString(s.q), import: optionalString(s.import), new: optionalString(s.new) }),
    }),
    createRoute({
      getParentRoute: () => app,
      path: '/import',
      component: ImportPage,
      validateSearch: (s: Record<string, unknown>) => ({ type: optionalString(s.type), unit: optionalString(s.unit), catalog: optionalString(s.catalog) }),
    }),
    createRoute({ getParentRoute: () => app, path: '/search', component: SearchPage, validateSearch: (s: Record<string, unknown>) => ({ q: optionalString(s.q) }) }),
    createRoute({ getParentRoute: () => app, path: '/requests', component: RequestsPage }),
    createRoute({ getParentRoute: () => app, path: '/requests/$requestId', component: RequestDetailPage }),
    createRoute({ getParentRoute: () => app, path: '/units/$unitId', component: UnitPage }),
    createRoute({ getParentRoute: () => app, path: '/views/$viewId', component: SavedViewPage }),
    createRoute({ getParentRoute: () => app, path: '/assets/$assetId', component: AssetDetailPage, validateSearch: (s: Record<string, unknown>) => ({ check: optionalString(s.check) }) }),
    createRoute({ getParentRoute: () => app, path: '/catalogs', component: CatalogsPage }),
    createRoute({ getParentRoute: () => app, path: '/catalogs/$catalogId', component: CatalogPage }),
    createRoute({ getParentRoute: () => app, path: '/profile', component: ProfilePage }),
    ...(inBrowser ? [createRoute({ getParentRoute: () => app, path: '/mailbox', component: MailboxPage })] : []),
    createRoute({ getParentRoute: () => app, path: '/templates', component: orgManagers(TemplatesPage), validateSearch: (s: Record<string, unknown>) => ({ new: optionalString(s.new) }) }),
    createRoute({ getParentRoute: () => app, path: '/templates/$typeId', component: orgManagers(TemplateBuilderPage), validateSearch: (s: Record<string, unknown>) => ({ name: optionalString(s.name) }) }),
    // Team variants are managed by the unit's managers (checked by the server), not only template managers.
    createRoute({ getParentRoute: () => app, path: '/templates/$typeId/variants/$variantId', component: VariantBuilderPage, validateSearch: (s: Record<string, unknown>) => ({ unit: optionalString(s.unit) }) }),
    createRoute({ getParentRoute: () => app, path: '/settings/date-kinds', component: orgManagers(DateKindsPage) }),
    createRoute({ getParentRoute: () => app, path: '/settings/workflow', component: orgManagers(WorkflowsPage) }),
    createRoute({ getParentRoute: () => app, path: '/settings/organization', component: admin(OrganizationPage) }),
    createRoute({ getParentRoute: () => app, path: '/settings/people', component: admin(PeoplePage) }),
    createRoute({ getParentRoute: () => app, path: '/settings/access', component: orgManagers(AccessPage) }),
  ]),
]);

/** While the session is resolved before the first page: a quiet spinner, never a blank screen. */
function Pending() {
  return (
    <div className="flex h-full min-h-dvh items-center justify-center bg-bg">
      <Spinner />
    </div>
  );
}

export const createAppRouter = (queryClient: QueryClient) =>
  createRouter({ routeTree, context: { queryClient }, defaultPreload: 'intent', defaultPendingComponent: Pending, defaultPendingMs: 100, defaultPendingMinMs: 0 });

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
