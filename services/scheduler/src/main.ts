import { main, runService } from '@am/platform/node';
import { SmtpMailer } from './infrastructure/smtp-mailer.js';
import { defineSchedulerService } from './service.js';

main(() => runService(defineSchedulerService({ mailer: (config) => new SmtpMailer(config.SMTP_URL, config.MAIL_FROM) })));
