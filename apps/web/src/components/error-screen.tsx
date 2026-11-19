import { RefreshCw, ServerCrash, TriangleAlert } from 'lucide-react';
import { isUnreachable } from '@/lib/api';
import { Button } from './ui/button';

/**
 * Shown instead of a blank page when the app cannot start: most often because
 * the services behind /api are not running or not routed (e.g. only the web
 * front end was deployed).
 */
export function ErrorScreen({ error, reset }: { error: unknown; reset?: () => void }) {
  const unreachable = isUnreachable(error);
  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 text-center shadow-pop">
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl bg-warning-soft text-warning">
          {unreachable ? <ServerCrash className="size-5" /> : <TriangleAlert className="size-5" />}
        </div>
        <h1 className="text-lg font-semibold tracking-tight">{unreachable ? 'Can’t reach the Assets server' : 'Something went wrong'}</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          {unreachable
            ? 'The page loaded, but the services it talks to aren’t answering. They may be restarting, or this address serves only the web app without its API.'
            : 'The page couldn’t be shown. Try again; if it keeps happening, tell whoever runs Assets.'}
        </p>
        {!unreachable && error instanceof Error && <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-left font-mono text-xs break-words text-muted">{error.message}</p>}
        <Button variant="primary" className="mt-5" icon={<RefreshCw className="size-3.5" />} onClick={() => (reset ? reset() : window.location.reload())}>
          Try again
        </Button>
      </div>
    </div>
  );
}
