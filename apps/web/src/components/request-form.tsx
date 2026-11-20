import type { PurchaseRequest, RequestCreate } from '@am/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useMyOrg } from '@/lib/org';
import { keys, useAssetTypes } from '@/lib/queries';
import { AssetTypeSelect, UnitPicker } from './pickers';
import { Button } from './ui/button';
import { Field, Input, Textarea } from './ui/form';
import { Sheet } from './ui/overlay';
import { TypeIcon } from './type-icon';
import { cn } from '@/lib/utils';

interface Draft {
  title: string;
  description: string;
  unitId: string | null;
  assetTypeId: string | null;
  quantity: string;
  amount: string;
  currency: string;
  neededBy: string;
  link: string;
}

const empty = (unitId: string | null): Draft => ({ title: '', description: '', unitId, assetTypeId: null, quantity: '', amount: '', currency: 'USD', neededBy: '', link: '' });

/**
 * "I need something" — written for anyone in the company. Three questions
 * matter (what, for whom, why); the rest is optional and helps Procurement.
 */
export function RequestFormSheet({ open, onOpenChange, request }: { open: boolean; onOpenChange: (o: boolean) => void; request?: PurchaseRequest }) {
  const { requestTargets } = useMyOrg();
  const types = useAssetTypes();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [d, setD] = useState<Draft>(() => empty(requestTargets[0]?.unit.id ?? null));
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setD(
      request
        ? {
            title: request.title,
            description: request.description,
            unitId: request.unitId,
            assetTypeId: request.assetTypeId,
            quantity: request.quantity?.toString() ?? '',
            amount: request.estimatedCost?.amount.toString() ?? '',
            currency: request.estimatedCost?.currency ?? 'USD',
            neededBy: request.neededBy ?? '',
            link: request.link ?? '',
          }
        : empty(requestTargets[0]?.unit.id ?? null),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, request?.id]);

  const save = useMutation({
    mutationFn: () => {
      const body: RequestCreate = {
        title: d.title.trim(),
        description: d.description.trim(),
        unitId: d.unitId!,
        assetTypeId: d.assetTypeId,
        quantity: d.quantity ? Math.max(1, Math.trunc(Number(d.quantity))) : null,
        estimatedCost: d.amount ? { amount: Number(d.amount), currency: d.currency.toUpperCase() } : null,
        neededBy: d.neededBy || null,
        link: d.link.trim() || null,
      };
      return request ? api.patch<PurchaseRequest>(`/api/registry/requests/${request.id}`, body) : api.post<PurchaseRequest>('/api/registry/requests', body);
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: keys.requests });
      onOpenChange(false);
      toast.success(request ? 'Request updated' : `Request ${r.number} sent`, { description: request ? undefined : 'You’ll get an email as it moves along.' });
      if (!request) void navigate({ to: '/requests/$requestId', params: { requestId: r.id } });
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        const issues = (e.details?.issues as Array<{ path: string; message: string }>) ?? [];
        setErrors(Object.fromEntries(issues.map((i) => [i.path.split('.')[0]!, i.message])));
        toast.error(e.message);
      } else toast.error('Could not send the request');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (d.title.trim().length >= 3 && d.unitId) save.mutate();
  };
  const popular = (types.data ?? []).slice(0, 4);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={request ? `Edit ${request.number}` : 'Request something'}
      description={request ? undefined : 'Tell us what you need. Procurement takes it from here and keeps you posted.'}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="request-form" loading={save.isPending} disabled={d.title.trim().length < 3 || !d.unitId}>
            {request ? 'Save' : 'Send request'}
          </Button>
        </>
      }
    >
      <form id="request-form" onSubmit={submit} className="space-y-5">
        <Field label="What do you need?" required error={errors.title} hint="e.g. “10 Miro seats”, “Laptop for a new hire”, “Renew our Datadog contract”">
          {(id) => <Input id={id} autoFocus className="h-9 text-[14px]" value={d.title} maxLength={200} onChange={(e) => setD({ ...d, title: e.target.value })} />}
        </Field>

        <Field label="Who is it for?" required error={errors.unitId} hint="Your team, or a unit above it if it’s shared (department, division, the whole company).">
          {(id) => (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {requestTargets.slice(0, 4).map(({ unit, hint }) => (
                  <button
                    key={unit.id}
                    type="button"
                    onClick={() => setD({ ...d, unitId: unit.id })}
                    className={cn(
                      'rounded-lg border px-2.5 py-1.5 text-start transition-colors',
                      d.unitId === unit.id ? 'border-accent bg-accent-soft' : 'border-border hover:border-border-strong hover:bg-surface-2',
                    )}
                  >
                    <span className="block text-[13px] font-medium">{unit.name}</span>
                    <span className="block text-[11px] text-subtle">{hint}</span>
                  </button>
                ))}
              </div>
              <UnitPicker id={id} value={d.unitId} onChange={(unitId) => setD({ ...d, unitId })} suggested={requestTargets} placeholder="Or search for another team" />
            </div>
          )}
        </Field>

        <Field label="Why, and any details" error={errors.description} hint="Who will use it, for what, anything Procurement should know.">
          {(id) => <Textarea id={id} rows={4} value={d.description} maxLength={4000} onChange={(e) => setD({ ...d, description: e.target.value })} />}
        </Field>

        <Field label="What kind of thing is it?" hint="Optional — helps route it to the right people.">
          {(id) => (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {popular.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setD({ ...d, assetTypeId: d.assetTypeId === t.id ? null : t.id })}
                    className={cn('inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[13px] transition-colors', d.assetTypeId === t.id ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-2')}
                  >
                    <TypeIcon icon={t.icon} color={t.color} size={18} />
                    {t.name}
                  </button>
                ))}
              </div>
              <AssetTypeSelect id={id} includeAll allLabel="Not sure / something else" value={d.assetTypeId} onChange={(assetTypeId) => setD({ ...d, assetTypeId })} />
            </div>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="How many?" error={errors.quantity}>
            {(id) => <Input id={id} type="number" min={1} value={d.quantity} onChange={(e) => setD({ ...d, quantity: e.target.value })} />}
          </Field>
          <Field label="Needed by" error={errors.neededBy}>
            {(id) => <Input id={id} type="date" value={d.neededBy} onChange={(e) => setD({ ...d, neededBy: e.target.value })} />}
          </Field>
          <Field label="Rough budget" error={errors.estimatedCost} hint="If you know it.">
            {(id) => (
              <div className="flex gap-1.5">
                <Input id={id} type="number" min={0} step="0.01" value={d.amount} onChange={(e) => setD({ ...d, amount: e.target.value })} />
                <Input aria-label="Currency" className="w-16 uppercase" maxLength={3} value={d.currency} onChange={(e) => setD({ ...d, currency: e.target.value })} />
              </div>
            )}
          </Field>
          <Field label="Link" error={errors.link} hint="Product or quote page.">
            {(id) => <Input id={id} type="url" placeholder="https://" value={d.link} onChange={(e) => setD({ ...d, link: e.target.value })} />}
          </Field>
        </div>
      </form>
    </Sheet>
  );
}

const NewRequestContext = createContext<() => void>(() => undefined);

/** Lets any screen (sidebar, home, a team page) open the request form. */
export function NewRequestProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <NewRequestContext.Provider value={() => setOpen(true)}>
      {children}
      <RequestFormSheet open={open} onOpenChange={setOpen} />
    </NewRequestContext.Provider>
  );
}

export const useNewRequest = () => useContext(NewRequestContext);
