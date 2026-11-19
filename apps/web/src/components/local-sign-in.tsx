import { LOCAL_ADMIN } from '@am/browser-runtime/accounts';
import { DEMO_PASSWORD, demoPersonas } from '@am/demo-seed';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Building2, Check, HardDrive, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { localServer } from '@/lib/run-mode';
import { Button } from './ui/button';
import { Avatar, Spinner } from './ui/display';

const titleCase = (u: string) => u.split('.').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');

/**
 * Browser mode, on the sign-in page: where the data lives, one-click sign-in,
 * and the demo company to explore every role with.
 */
export function LocalSignIn({ onSignIn, busy }: { onSignIn: (username: string, password: string) => void; busy: boolean }) {
  const demo = useQuery({ queryKey: ['local-demo'], queryFn: localServer.demo, refetchInterval: (q) => (q.state.data?.state === 'running' ? 1000 : false) });
  const start = useMutation({ mutationFn: localServer.startDemo, onSuccess: () => void demo.refetch(), onError: () => toast.error('Could not start loading the demo') });
  const state = demo.data?.state ?? 'idle';

  return (
    <div className="mb-4 space-y-4 rounded-2xl border border-border bg-surface p-5 text-[13px] shadow-pop">
      <div className="flex gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-fg">
          <HardDrive className="size-4" />
        </span>
        <div>
          <p className="font-medium">Running in this browser</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">The whole app, its database included, runs on this device. Data is kept in this browser and never sent anywhere.</p>
        </div>
      </div>

      <Button className="w-full justify-center" icon={<ShieldCheck className="size-4" />} disabled={busy} onClick={() => onSignIn(LOCAL_ADMIN.username, LOCAL_ADMIN.password)}>
        Continue as Administrator
      </Button>

      <div className="border-t border-border pt-4">
        {state === 'done' ? (
          <>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-success">
              <Check className="size-3.5" /> Demo company loaded. Sign in as:
            </p>
            <ul className="space-y-1">
              {demoPersonas.map((p) => (
                <li key={p.username}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onSignIn(p.username, DEMO_PASSWORD)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2 disabled:opacity-50"
                  >
                    <Avatar name={titleCase(p.username)} size={26} />
                    <span className="min-w-0">
                      <span className="block font-medium">{titleCase(p.username)}</span>
                      <span className="block truncate text-xs text-muted">{p.role}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : state === 'running' ? (
          <div>
            <p className="flex items-center gap-2 font-medium">
              <Spinner className="size-3.5" /> Loading the demo company…
            </p>
            <ul className="mt-2 space-y-0.5 text-xs text-muted">
              {(demo.data?.log ?? []).map((l, i) => (
                <li key={i} className="flex items-center gap-1.5">
                  <Check className="size-3 text-success" /> {l}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            <Button variant="ghost" className="w-full justify-center" icon={<Building2 className="size-4" />} loading={start.isPending} onClick={() => start.mutate()}>
              Load the demo company
            </Button>
            <p className="mt-1 text-center text-xs text-muted">
              {state === 'failed' ? 'Loading failed — try again.' : '~200 teams, 60 people, 400 licenses and devices, requests and catalogs. Takes a minute or two.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
