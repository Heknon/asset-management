import { defineService, envList, registerBackup, type BaseConfig } from '@am/platform';
import { z } from 'zod';
import { CollaborationNotifier } from './application/collaboration-notifier.js';
import { ObligationService } from './application/obligation-service.js';
import { ReminderDispatcher } from './application/reminder-dispatcher.js';
import { RequestNotifier } from './application/request-notifier.js';
import { todayIn } from './domain/obligation.js';
import { PgSchedulerStore } from './infrastructure/pg-scheduler-store.js';
import { migrations, type SchedulerDB } from './infrastructure/schema.js';
import type { Mailer } from './application/ports.js';
import { registerRoutes } from './http/routes.js';

export const schedulerConfig = {
  /** smtp://user:pass@host:587 or smtps://... (Exchange / Office 365 relay). */
  SMTP_URL: z.string().url(),
  MAIL_FROM: z.string().default('Asset Management <assets@example.com>'),
  /** Calendar day boundaries for reminders ("due today") use this IANA zone. */
  REMINDER_TIMEZONE: z.string().default('UTC'),
  /** Cron for reminder runs (pg-boss guarantees one run per tick across replicas). */
  DISPATCH_CRON: z.string().default('*/15 * * * *'),
  /** Shared mailboxes told about every new request, e.g. procurement@corp.com. */
  REQUEST_INBOX_EMAILS: envList,
};

const DISPATCH_QUEUE = 'scheduler.dispatch';

export type { Mailer } from './application/ports.js';

export type SchedulerConfig = BaseConfig & z.infer<z.ZodObject<typeof schedulerConfig>>;

/** How mail leaves: SMTP on the server; a mailbox kept in the browser in the browser runtime. */
export interface SchedulerAdapters {
  mailer(config: SchedulerConfig): Mailer & { close?(): Promise<void> | void };
}

/** Obligations, reminders, Outlook invites, calendar feeds and every email. */
export const defineSchedulerService = (adapters: SchedulerAdapters) =>
  defineService<SchedulerDB, typeof schedulerConfig>({
    name: 'scheduler',
    config: schedulerConfig,
    migrations,
    async register({ config, database, app, bus, logger, onClose }) {
      Intl.DateTimeFormat(undefined, { timeZone: config.REMINDER_TIMEZONE }); // fail fast on an invalid zone
      const appUrl = config.PUBLIC_URL.replace(/\/$/, '');
      const store = new PgSchedulerStore(database.db);
      const clock = { today: () => todayIn(config.REMINDER_TIMEZONE) };
      const mailer = adapters.mailer(config);
      onClose(() => mailer.close?.());
      const fromAddress = /<([^>]+)>/.exec(config.MAIL_FROM)?.[1] ?? config.MAIL_FROM;

      const obligations = new ObligationService(store, clock, appUrl);
      const dispatcher = new ReminderDispatcher(store, mailer, clock, logger, appUrl, { name: 'Asset Management', email: fromAddress });
      registerRoutes(app, obligations, dispatcher);
      await registerBackup(app, { name: 'scheduler', database, logger, enabled: config.BACKUP_ENABLED, bus });

      await bus.subscribe('scheduler', 'asset.changed', (e) => obligations.onAssetChanged(e));
      await bus.subscribe('scheduler', 'asset.deleted', (e) => obligations.onAssetDeleted(e.assetId));
      await bus.subscribe('scheduler', 'user.changed', (e) => obligations.onUserChanged(e));
      await bus.subscribe('scheduler', 'unit.changed', (e) => obligations.onUnitChanged(e));
      await bus.subscribe('scheduler', 'catalog.changed', (e) => obligations.onCatalogChanged(e));
      const collaboration = new CollaborationNotifier(store, mailer, clock, logger, appUrl, config.REQUEST_INBOX_EMAILS);
      await bus.subscribe('scheduler', 'renewal.check', (e) => collaboration.onRenewalCheck(e));
      await bus.subscribe('scheduler', 'asset.commented', (e) => collaboration.onAssetCommented(e));
      const notifier = new RequestNotifier(store, mailer, logger, appUrl, config.REQUEST_INBOX_EMAILS);
      await bus.subscribe('scheduler', 'request.changed', (e) => notifier.onRequestChanged(e));

      await bus.schedule(DISPATCH_QUEUE, config.DISPATCH_CRON, async () => {
        const checksAsked = await obligations.autoAsk();
        const result = await dispatcher.run();
        logger.info({ ...result, checksAsked }, 'reminder run complete');
      });
    },
  });
