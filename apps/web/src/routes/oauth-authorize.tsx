import { useMutation, useQuery } from '@tanstack/react-query';
import { Bot, Check, ShieldCheck, Shapes } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/display';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/queries';
import { LanguageLinks } from '@/components/language';
import { t } from '@/lib/i18n';
import { tj } from '@/lib/i18n-react';

interface OAuthRequest {
  client: { id: string; name: string };
  redirectHost: string;
  resource: string;
}

/** The authorization request exactly as the client sent it (the router would turn "123" into a number). */
function requestParams(): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(window.location.search));
}

/**
 * The accept screen an MCP client (Claude, an IDE, any OAuth client) sends
 * people to. Accepting lets that app act as them, with exactly their access;
 * it shows up under Profile → Signed-in devices, where it can be signed out.
 */
export function OAuthAuthorizePage() {
  const me = useMe();
  const params = requestParams();
  const request = useQuery({ queryKey: ['oauth-request', window.location.search], queryFn: () => api.get<OAuthRequest>('/api/identity/oauth/request', params), retry: false });
  const decide = useMutation({
    mutationFn: (accept: boolean) => api.post<{ redirectTo: string }>('/api/identity/oauth/decision', { params, accept }),
    onSuccess: ({ redirectTo }) => window.location.assign(redirectTo),
  });

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-surface text-fg shadow-pop ring-1 ring-border">
            <Bot className="size-5" />
          </div>
          <span className="h-px w-8 bg-border" aria-hidden />
          <div className="flex size-11 items-center justify-center rounded-xl bg-accent text-white shadow-pop">
            <Shapes className="size-5" />
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-pop">
          {request.isPending ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : request.error ? (
            <div role="alert">
              <h1 className="text-lg font-semibold tracking-tight">{t('This connection request isn’t valid')}</h1>
              <p className="mt-2 text-[13px] text-muted">{request.error instanceof ApiError ? request.error.message : t('Something went wrong.')} {t('Start connecting again from the app you came from.')}</p>
            </div>
          ) : (
            <>
              <h1 className="text-lg font-semibold tracking-tight">
                {tj('Allow {app} to use Assets as you?', { app: <span className="text-accent">{request.data.client.name}</span> })}
              </h1>
              <p className="mt-1 text-[13px] text-muted">
                {tj('Signed in as {name}', { name: <span className="font-medium text-fg">{me.data?.displayName ?? me.data?.username}</span> })}
              </p>
              <ul className="mt-5 space-y-2.5 text-[13px]">
                {[t('Find and read the assets, dates and requests you can see'), t('Create requests and make changes you are allowed to make'), t('Nothing more than your own access')].map((line) => (
                  <li key={line} className="flex gap-2.5">
                    <Check className="mt-0.5 size-4 shrink-0 text-success" />
                    {line}
                  </li>
                ))}
              </ul>
              <p className="mt-5 flex gap-2 rounded-xl bg-bg px-3 py-2.5 text-[12px] text-muted">
                <ShieldCheck className="mt-px size-4 shrink-0" />
                <span>
                  {tj('You’ll be sent back to {host}. You can disconnect it any time under Profile → Signed-in devices.', { host: <span className="font-medium text-fg">{request.data.redirectHost}</span> })}
                </span>
              </p>
              {decide.error && (
                <p role="alert" className="mt-4 text-[13px] text-danger">
                  {decide.error instanceof ApiError ? decide.error.message : t('Could not complete the request')}
                </p>
              )}
              <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="secondary" disabled={decide.isPending} onClick={() => decide.mutate(false)}>
                  {t('Deny')}
                </Button>
                <Button variant="primary" autoFocus disabled={decide.isPending} onClick={() => decide.mutate(true)}>
                  {decide.isPending && decide.variables ? t('Connecting…') : t('Accept')}
                </Button>
              </div>
            </>
          )}
        </div>
        <LanguageLinks className="mt-6" />
      </div>
    </div>
  );
}
