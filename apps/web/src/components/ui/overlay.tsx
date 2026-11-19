import * as RDialog from '@radix-ui/react-dialog';
import * as RMenu from '@radix-ui/react-dropdown-menu';
import * as RPopover from '@radix-ui/react-popover';
import * as RTooltip from '@radix-ui/react-tooltip';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

interface PanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/**
 * Dialogs and side sheets share one implementation; only the placement differs.
 */
function Panel({ open, onOpenChange, title, description, children, footer, className, placement }: PanelProps & { placement: 'center' | 'side' }) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="animate-overlay fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px] dark:bg-black/60" />
        <RDialog.Content
          className={cn(
            'fixed z-50 flex flex-col border border-border bg-surface shadow-pop focus:outline-none',
            // Phones: dialogs rise from the bottom, sheets take the whole screen.
            placement === 'center'
              ? 'animate-dialog inset-x-0 bottom-0 max-h-[92dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)] sm:inset-x-auto sm:top-[12vh] sm:bottom-auto sm:left-1/2 sm:max-h-[76vh] sm:w-[calc(100vw-2rem)] sm:max-w-lg sm:-translate-x-1/2 sm:rounded-xl sm:pb-0'
              : 'animate-sheet inset-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:inset-y-2 sm:right-2 sm:left-auto sm:w-[calc(100vw-1rem)] sm:max-w-xl sm:rounded-xl sm:pt-0 sm:pb-0',
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-4 sm:px-5">
            <div className="min-w-0">
              <RDialog.Title className="text-[15px] font-semibold">{title}</RDialog.Title>
              {description ? <RDialog.Description className="mt-0.5 text-[13px] text-muted">{description}</RDialog.Description> : <RDialog.Description className="sr-only">{title}</RDialog.Description>}
            </div>
            <RDialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close" icon={<X className="size-4" />} />
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3 sm:px-5">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export const Dialog = (p: PanelProps) => <Panel {...p} placement="center" />;
export const Sheet = (p: PanelProps) => <Panel {...p} placement="side" />;

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = 'Confirm', danger, onConfirm, loading }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; loading?: boolean }) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[13px] text-muted">{description}</div>
    </Dialog>
  );
}

const popClass = 'animate-panel z-50 max-w-[calc(100vw-1rem)] max-h-[var(--radix-popper-available-height)] overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-pop';

export function Menu({ trigger, children, align = 'end' }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <RMenu.Root>
      <RMenu.Trigger asChild>{trigger}</RMenu.Trigger>
      <RMenu.Portal>
        <RMenu.Content align={align} sideOffset={4} collisionPadding={8} className={cn(popClass, 'min-w-44')}>
          {children}
        </RMenu.Content>
      </RMenu.Portal>
    </RMenu.Root>
  );
}

export function MenuItem({ children, onSelect, icon, danger, disabled }: { children: ReactNode; onSelect: () => void; icon?: ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <RMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] outline-none touch:h-10 data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2',
        danger && 'text-danger',
      )}
    >
      <span className="flex size-4 items-center justify-center text-muted [&>svg]:size-4">{icon}</span>
      {children}
    </RMenu.Item>
  );
}

export const MenuSeparator = () => <RMenu.Separator className="my-1 h-px bg-border" />;

export function Popover({ trigger, children, className, align = 'start', open, onOpenChange }: { trigger: ReactNode; children: ReactNode; className?: string; align?: 'start' | 'end' | 'center'; open?: boolean; onOpenChange?: (o: boolean) => void }) {
  return (
    <RPopover.Root open={open} onOpenChange={onOpenChange}>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content align={align} sideOffset={4} collisionPadding={8} className={cn(popClass, 'p-0', className)}>
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <RTooltip.Root delayDuration={300}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content sideOffset={4} className="z-50 rounded-md bg-fg px-2 py-1 text-xs text-bg shadow-pop">
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export const TooltipProvider = RTooltip.Provider;
