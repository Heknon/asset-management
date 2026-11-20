import { SmtpMailer } from './infrastructure/smtp-mailer.js';
import type { SchedulerAdapters } from './service.js';

/** The scheduler on Node (server and serverless): mail over SMTP. */
export const nodeSchedulerAdapters: SchedulerAdapters = { mailer: (config) => new SmtpMailer(config.SMTP_URL, config.MAIL_FROM) };
