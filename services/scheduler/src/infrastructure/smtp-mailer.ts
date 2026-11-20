import nodemailer, { type Transporter } from 'nodemailer';
import type { Mailer } from '../application/ports.js';

/**
 * SMTP delivery (Exchange / Office 365 / any relay). Calendar invites are sent
 * as a text/calendar alternative with METHOD, which Outlook renders as a
 * meeting item and places on the recipient's calendar.
 */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }

  async send(m: Parameters<Mailer['send']>[0]): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: m.to,
      subject: m.subject,
      text: m.text,
      html: m.html,
      ...(m.calendar && {
        icalEvent: { method: m.calendar.method, filename: m.calendar.method === 'CANCEL' ? 'cancel.ics' : 'invite.ics', content: m.calendar.content },
      }),
    });
  }

  close(): void {
    this.transport.close();
  }
}
