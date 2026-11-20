import { type AssetComment, type Permission, type UserSummary } from '@am/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleHelp, MessagesSquare, MoreHorizontal, Pencil, Send, Trash2 } from 'lucide-react';
import { Fragment, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { keys, useComments, useMe, usePeople, usePeopleSearch } from '@/lib/queries';
import { cn, formatDateTime } from '@/lib/utils';
import { Button } from './ui/button';
import { Avatar, Card, SectionTitle } from './ui/display';
import { Textarea } from './ui/form';
import { Menu, MenuItem } from './ui/overlay';

/**
 * The conversation about an asset: questions to the owner, vendor updates,
 * renewal decisions. Everyone who can see the asset can read and write;
 * @mentioned people and the owner are emailed.
 */
export function Conversation({ assetId, permissions }: { assetId: string; permissions: readonly Permission[] }) {
  const comments = useComments(assetId);
  const me = useMe().data!;
  const qc = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const items = comments.data ?? [];
  const mentioned = usePeople(items.flatMap((c) => c.mentionIds));
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.comments(assetId) });
  const onError = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Something went wrong');

  const post = useMutation({ mutationFn: (body: { body: string; mentionIds: string[] }) => api.post(`/api/registry/assets/${assetId}/comments`, body), onSuccess: refresh, onError });
  const edit = useMutation({
    mutationFn: ({ id, ...body }: { id: string; body: string; mentionIds: string[] }) => api.put(`/api/registry/comments/${id}`, body),
    onSuccess: () => (setEditing(null), refresh()),
    onError,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/api/registry/comments/${id}`), onSuccess: refresh, onError });

  return (
    <Card padded={false}>
      <div id="conversation" className="scroll-mt-20 px-4 pt-3.5">
        <SectionTitle aside={<MessagesSquare className="size-4 text-subtle" />}>Conversation</SectionTitle>
      </div>
      {items.length > 0 && (
        <ol className="space-y-4 px-4 pb-2">
          {items.map((c) =>
            c.kind === 'renewal_check' ? (
              <li key={c.id} className="flex gap-2.5 text-[13px]">
                <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
                  <CircleHelp className="size-3.5" />
                </span>
                <div className="min-w-0">
                  <p>
                    <span className="font-medium">{c.authorName}</span> <span className="text-muted">{c.body}</span>
                  </p>
                  <p className="text-xs text-subtle">{formatDateTime(c.createdAt)}</p>
                </div>
              </li>
            ) : (
              <li key={c.id} className="group flex gap-2.5 text-[13px]">
                <Avatar name={c.authorName} size={26} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline gap-2">
                    <span className="font-medium">{c.authorName}</span>
                    <span className="text-xs text-subtle">
                      {formatDateTime(c.createdAt)}
                      {c.editedAt && !c.deleted && ' · edited'}
                    </span>
                    {!c.deleted && (c.authorId === me.userId || permissions.includes('delete')) && (
                      <span className="ms-auto opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 touch:opacity-100">
                        <Menu trigger={<Button size="icon" variant="ghost" aria-label="Message actions" icon={<MoreHorizontal className="size-3.5" />} />}>
                          {c.authorId === me.userId && (
                            <MenuItem icon={<Pencil />} onSelect={() => setEditing(c.id)}>
                              Edit
                            </MenuItem>
                          )}
                          <MenuItem danger icon={<Trash2 />} onSelect={() => remove.mutate(c.id)}>
                            Delete
                          </MenuItem>
                        </Menu>
                      </span>
                    )}
                  </p>
                  {c.deleted ? (
                    <p className="text-subtle italic">Message deleted</p>
                  ) : editing === c.id ? (
                    <Composer
                      initial={c}
                      people={mentioned}
                      submitLabel="Save"
                      pending={edit.isPending}
                      onCancel={() => setEditing(null)}
                      onSubmit={(body) => edit.mutate({ id: c.id, ...body })}
                    />
                  ) : (
                    <p className="whitespace-pre-wrap break-words">{withMentions(c.body, c.mentionIds.map((id) => mentioned.get(id)?.displayName).filter((n): n is string => !!n))}</p>
                  )}
                </div>
              </li>
            ),
          )}
        </ol>
      )}
      <div className={cn('px-4 pb-4', items.length ? 'border-t border-border pt-3' : 'pt-1')}>
        {!items.length && permissions.includes('comment') && <p className="mb-2 text-xs text-muted">Ask the owner a question, note a vendor update, or record a decision. Type @ to mention someone — they’ll get an email.</p>}
        {permissions.includes('comment') ? (
          <Composer key={items.length} people={mentioned} submitLabel="Send" pending={post.isPending} onSubmit={(body) => post.mutate(body)} />
        ) : (
          <p className="text-xs text-muted">You can read this conversation. Writing needs the “Comment” permission.</p>
        )}
      </div>
    </Card>
  );
}

/** Bolds "@Name" for the people a message mentions. */
function withMentions(body: string, names: string[]): ReactNode {
  if (!names.length) return body;
  const escaped = [...new Set(names)].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = body.split(new RegExp(`(@(?:${escaped.join('|')}))`, 'g'));
  return parts.map((p, i) => (i % 2 ? <span key={i} className="font-medium text-accent-fg">{p}</span> : <Fragment key={i}>{p}</Fragment>));
}

const MENTION = /(?:^|\s)@([\p{L}\p{N}._-]{0,30})$/u;

/** Textarea with @mention suggestions. Sends the ids of people still mentioned in the text. */
function Composer({
  initial,
  people,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  initial?: AssetComment;
  people: Map<string, UserSummary>;
  submitLabel: string;
  pending: boolean;
  onSubmit: (b: { body: string; mentionIds: string[] }) => void;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initial?.body ?? '');
  const [mentions, setMentions] = useState<Array<{ id: string; name: string }>>(() =>
    (initial?.mentionIds ?? []).flatMap((id) => (people.get(id) ? [{ id, name: people.get(id)!.displayName }] : [])),
  );
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const match = MENTION.exec(body.slice(0, caret));
  const term = useDebounced(match ? match[1]! : '', 120);
  const suggestions = usePeopleSearch(term);
  // People whose first or last name starts with what was typed come first.
  const options = useMemo(() => {
    if (!match || !term) return [];
    const t = term.toLowerCase();
    const rank = (p: UserSummary) => (p.displayName.toLowerCase().split(/\s+/).some((w) => w.startsWith(t)) ? 0 : p.username.toLowerCase().startsWith(t) ? 1 : 2);
    return [...(suggestions.data ?? [])].sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName)).slice(0, 6);
  }, [match, term, suggestions.data]);

  const pick = (p: UserSummary) => {
    const before = body.slice(0, caret).replace(MENTION, (m) => `${m.startsWith('@') ? '' : m[0]}@${p.displayName} `);
    const next = before + body.slice(caret);
    setBody(next);
    setMentions((m) => (m.some((x) => x.id === p.id) ? m : [...m, { id: p.id, name: p.displayName }]));
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(before.length, before.length);
      setCaret(before.length);
    });
  };
  const submit = () => {
    const text = body.trim();
    if (!text) return;
    onSubmit({ body: text, mentionIds: mentions.filter((m) => text.includes(`@${m.name}`)).map((m) => m.id) });
    if (!initial) {
      setBody('');
      setMentions([]);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(options[Math.min(highlight, options.length - 1)]!);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape' && onCancel) onCancel();
  };

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        rows={initial ? 3 : 2}
        value={body}
        placeholder="Write a message… (@ to mention, ⌘↵ to send)"
        onChange={(e) => {
          setBody(e.target.value);
          setCaret(e.target.selectionStart);
          setHighlight(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        aria-label="Message"
      />
      {options.length > 0 && (
        <ul role="listbox" className="absolute bottom-full start-0 z-20 mb-1 w-72 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-lg">
          {options.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlight}
                onMouseDown={(e) => (e.preventDefault(), pick(p))}
                className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-start text-[13px]', i === highlight && 'bg-surface-2')}
              >
                <Avatar name={p.displayName} size={20} />
                <span className="truncate">{p.displayName}</span>
                <span className="ms-auto truncate text-xs text-subtle">{p.username}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex justify-end gap-2">
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        <Button variant="primary" size="sm" icon={<Send className="size-3.5" />} disabled={!body.trim()} loading={pending} onClick={submit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
