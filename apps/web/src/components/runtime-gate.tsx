import { Database, Shapes } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { startBrowserRuntime, type RuntimeStatus } from '@/lib/run-mode';
import { ErrorScreen } from './error-screen';
import { Spinner } from './ui/display';

/**
 * Browser mode: starts the in-browser server before the app renders. The
 * first visit downloads Postgres (WebAssembly) and creates the database,
 * which takes a few seconds; later visits start in about a second.
 */
export function RuntimeGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<RuntimeStatus>({ state: 'starting', step: 'Starting' });
  const [error, setError] = useState<Error | null>(null);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    startBrowserRuntime(setStatus).then(
      () => setStatus({ state: 'ready', step: 'Ready' }),
      (err: Error) => setError(err),
    );
    const t = setTimeout(() => setSlow(true), 1500);
    return () => clearTimeout(t);
  }, []);

  if (error) return <ErrorScreen error={error} />;
  if (status.state === 'ready') return <>{children}</>;
  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-4">
      <div className="flex w-full max-w-xs flex-col items-center text-center">
        <div className="mb-5 flex size-11 items-center justify-center rounded-xl bg-accent text-white shadow-pop">
          <Shapes className="size-5" />
        </div>
        <div className="flex items-center gap-2 text-[14px] font-medium">
          <Spinner className="size-4" /> {status.step}…
        </div>
        {slow && (
          <p className="mt-3 flex items-start gap-2 text-start text-xs leading-relaxed text-muted">
            <Database className="mt-0.5 size-3.5 shrink-0" />
            Assets runs entirely in this browser. The first start downloads its database engine and sets it up; next time it opens in a moment.
          </p>
        )}
      </div>
    </div>
  );
}
