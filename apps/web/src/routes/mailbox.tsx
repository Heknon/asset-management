import { useQuery } from '@tanstack/react-query';
import { CalendarPlus, Inbox, Mail } from 'lucide-react';
import { useState } from 'react';
import { Badge, Card, EmptyState, PageHeader, Skeleton } from '@/components/ui/display';
import { localServer, type SentMail } from '@/lib/run-mode';
import { cn, formatDateTime } from '@/lib/utils';

/**
 * Browser mode has no mail server: every email the app sends (reminders,
 * renewal asks, request updates, Outlook invites) lands here instead.
 */
export function MailboxPage() {
  const mail = useQuery({ queryKey: ['local-mail'], queryFn: localServer.mail, refetchInterval: 10_000 });
  const [openId, setOpenId] = useState<string | null>(null);
  const items = mail.data ?? [];
  const open = items.find((m) => m.id === openId) ?? null;

  return (
    <>
      <PageHeader title="Sent emails" description="Running in this browser, there is no mail server: every email Assets sends (reminders, renewal asks, request updates, calendar invites) is kept here." />
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <Card padded={false} className={cn('overflow-hidden', open && 'max-lg:hidden')}>
          {mail.isLoading ? (
            <div className="space-y-3 p-4">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : !items.length ? (
            <EmptyState icon={<Inbox />} title="Nothing sent yet" description="Ask an owner whether to renew, comment with an @mention, or submit a request, and the emails appear here." />
          ) : (
            <ul className="divide-y divide-border">
              {items.map((m) => (
                <li key={m.id}>
                  <button type="button" onClick={() => setOpenId(m.id)} className={cn('w-full px-4 py-3 text-left transition-colors hover:bg-surface-2/60', m.id === openId && 'bg-surface-2')}>
                    <span className="flex items-center justify-between gap-2 text-xs text-muted">
                      <span className="truncate">To {m.to}</span>
                      <span className="shrink-0">{formatDateTime(m.at)}</span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[13px] font-medium">
                      {m.calendar && <CalendarPlus className="size-3.5 shrink-0 text-accent-fg" />}
                      <span className="truncate">{m.subject}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {open ? <MailView mail={open} onBack={() => setOpenId(null)} /> : <Card className="hidden items-center justify-center text-[13px] text-muted lg:flex"><Mail className="mr-2 size-4" /> Pick an email to read it</Card>}
      </div>
    </>
  );
}

function MailView({ mail, onBack }: { mail: SentMail; onBack: () => void }) {
  return (
    <Card padded={false} className="overflow-hidden">
      <div className="space-y-1 border-b border-border px-4 py-3">
        <button type="button" onClick={onBack} className="mb-1 text-xs text-accent-fg lg:hidden">
          ← All emails
        </button>
        <p className="text-[15px] font-semibold">{mail.subject}</p>
        <p className="text-xs text-muted">
          To {mail.to} · {formatDateTime(mail.at)}
        </p>
        {mail.calendar && <Badge tone="accent">Calendar {mail.calendar.method === 'CANCEL' ? 'cancellation' : 'invite'}</Badge>}
      </div>
      {/* The message as recipients see it; sandboxed, no scripts. */}
      <iframe title={mail.subject} sandbox="" srcDoc={mail.html} className="h-[70vh] w-full bg-white" />
    </Card>
  );
}
