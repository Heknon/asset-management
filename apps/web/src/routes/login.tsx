import type { AuthProviderInfo, Me, PasswordLogin } from '@am/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Building2, Shapes } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/display';
import { Field, Input, Segmented } from '@/components/ui/form';
import { api, ApiError, isUnreachable } from '@/lib/api';
import { keys, useProviders } from '@/lib/queries';
import { inBrowser } from '@/lib/run-mode';
import { LocalSignIn } from '@/components/local-sign-in';
import { LanguageLinks } from '@/components/language';

export function LoginPage() {
  const providers = useProviders();
  const search = useSearch({ strict: false }) as { error?: string; returnTo?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const passwordProviders = (providers.data ?? []).filter((p) => p.flow === 'password');
  const redirect = (providers.data ?? []).find((p) => p.flow === 'redirect');
  const [provider, setProvider] = useState<AuthProviderInfo['id'] | null>(null);
  const active = provider ?? passwordProviders.find((p) => p.id === 'ldap')?.id ?? passwordProviders[0]?.id;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const returnTo = search.returnTo?.startsWith('/') && !search.returnTo.startsWith('//') ? search.returnTo : '/';

  const login = useMutation({
    mutationFn: (body: PasswordLogin) => api.post<Me>('/api/identity/auth/login', body),
    onSuccess: (me) => {
      // Replaces any cached 401 so the app shell does not bounce back here.
      qc.setQueryData(keys.me, me);
      void navigate({ to: returnTo });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (active === 'local' || active === 'ldap') login.mutate({ provider: active, username, password });
  };
  const error = login.error instanceof ApiError ? login.error.message : login.error ? 'Sign-in failed' : search.error;

  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-accent text-white shadow-pop">
            <Shapes className="size-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Sign in to Assets</h1>
          <p className="mt-1 text-[13px] text-muted">Licenses, contracts and everything you renew.</p>
        </div>
        {isUnreachable(providers.error) && (
          <p role="alert" className="mb-4 rounded-xl bg-warning-soft px-4 py-3 text-[13px] text-warning">
            Can’t reach the Assets server, so signing in won’t work right now. It may be restarting, or this address serves only the web app.
          </p>
        )}
        {/* In the browser, one-click sign-in comes first; the form below is for any other account. */}
        {inBrowser && <LocalSignIn busy={login.isPending} onSignIn={(u, p) => login.mutate({ provider: 'local', username: u, password: p })} />}
        <div className="space-y-4 rounded-2xl border border-border bg-surface p-6 shadow-pop">
          {redirect && (
            <a href={`/api/identity/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`} className="block">
              <Button variant={passwordProviders.length ? 'secondary' : 'primary'} className="w-full justify-center" icon={<Building2 className="size-4" />}>
                {redirect.label}
              </Button>
            </a>
          )}
          {redirect && passwordProviders.length > 0 && (
            <div className="flex items-center gap-3 text-xs text-subtle">
              <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
            </div>
          )}
          {passwordProviders.length > 0 && (
            <form onSubmit={submit} className="space-y-4">
              {passwordProviders.length > 1 && (
                <Segmented className="w-full [&>button]:flex-1" value={active!} onChange={setProvider} options={passwordProviders.map((p) => ({ value: p.id, label: p.label }))} />
              )}
              <Field label="Username">
                {(id) => <Input id={id} autoFocus autoComplete="username" value={username} placeholder={active === 'ldap' ? 'jdoe or CORP\\jdoe' : 'admin'} onChange={(e) => setUsername(e.target.value)} />}
              </Field>
              <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
              {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
              <Button type="submit" variant="primary" className="w-full justify-center" loading={login.isPending} disabled={!username || !password}>
                Sign in
              </Button>
            </form>
          )}
          {providers.isSuccess && !providers.data.length && <p className="text-center text-[13px] text-muted">No sign-in method is configured.</p>}
          {providers.isLoading && (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          )}
        </div>
        <LanguageLinks className="mt-6" />
      </div>
    </div>
  );
}
