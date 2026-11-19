import { daysBetween, type IsoDate } from '@am/core';

export interface DigestItem {
  assetName: string;
  assetTypeName: string;
  label: string;
  kindName: string;
  kindColor: string;
  actionLabel: string;
  dueDate: IsoDate;
  spend: { amount: number; currency: string } | null;
  url: string;
}

export interface Message {
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function relativeDue(due: IsoDate, today: IsoDate): string {
  const d = daysBetween(today, due);
  if (d === 0) return 'due today';
  if (d === 1) return 'due tomorrow';
  if (d > 1) return `due in ${d} days`;
  return d === -1 ? 'overdue by 1 day' : `overdue by ${-d} days`;
}

const money = (s: DigestItem['spend']) => (s ? new Intl.NumberFormat('en-US', { style: 'currency', currency: s.currency, maximumFractionDigits: 0 }).format(s.amount) : '');

/** One email per recipient per run, listing everything that needs attention. */
export function reminderDigest(recipientName: string, items: DigestItem[], today: IsoDate, appUrl: string): Message {
  const sorted = [...items].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const overdue = sorted.filter((i) => i.dueDate < today).length;
  const subject =
    sorted.length === 1
      ? `${sorted[0]!.kindName}: ${sorted[0]!.assetName} — ${relativeDue(sorted[0]!.dueDate, today)}`
      : `${sorted.length} items need attention${overdue ? ` (${overdue} overdue)` : ''}`;

  const text = [
    `Hi ${recipientName},`,
    '',
    'These items need attention:',
    '',
    ...sorted.map((i) => `• ${i.assetName} (${i.assetTypeName}) — ${i.label} ${i.dueDate}, ${relativeDue(i.dueDate, today)}${i.spend ? `, ${money(i.spend)}` : ''}\n  ${i.url}`),
    '',
    `Open the dashboard: ${appUrl}`,
  ].join('\n');

  const rows = sorted
    .map(
      (i) => `
      <tr>
        <td style="padding:14px 0;border-bottom:1px solid #eceef2">
          <div style="font-size:12px;color:${esc(i.kindColor)};font-weight:600;text-transform:uppercase;letter-spacing:.04em">${esc(i.kindName)}</div>
          <a href="${esc(i.url)}" style="font-size:15px;color:#0f172a;font-weight:600;text-decoration:none">${esc(i.assetName)}</a>
          <div style="font-size:13px;color:#64748b">${esc(i.assetTypeName)} · ${esc(i.label)} ${esc(i.dueDate)}${i.spend ? ` · ${esc(money(i.spend))}` : ''}</div>
        </td>
        <td style="padding:14px 0;border-bottom:1px solid #eceef2;text-align:right;white-space:nowrap">
          <span style="font-size:13px;font-weight:600;color:${i.dueDate < today ? '#e11d48' : '#0f172a'}">${esc(relativeDue(i.dueDate, today))}</span><br>
          <a href="${esc(i.url)}" style="font-size:13px;color:#4f46e5;text-decoration:none">${esc(i.actionLabel)} →</a>
        </td>
      </tr>`,
    )
    .join('');

  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Inter,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;padding:28px 32px;border:1px solid #eceef2">
    <tr><td colspan="2" style="font-size:18px;font-weight:600;color:#0f172a;padding-bottom:4px">Hi ${esc(recipientName)},</td></tr>
    <tr><td colspan="2" style="font-size:14px;color:#475569;padding-bottom:12px">${sorted.length === 1 ? 'This item needs' : 'These items need'} your attention.</td></tr>
    ${rows}
    <tr><td colspan="2" style="padding-top:20px"><a href="${esc(appUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;font-size:14px;font-weight:600;padding:10px 16px;border-radius:8px;text-decoration:none">Open dashboard</a></td></tr>
  </table>
  <div style="font-size:12px;color:#94a3b8;padding-top:16px">You receive these because you own or are a contact for these assets. Manage notifications in your profile.</div>
  </td></tr></table></body></html>`;

  return { subject, text, html };
}

export function inviteMessage(item: DigestItem, cancelled: boolean): Message {
  const subject = `${cancelled ? 'Cancelled: ' : ''}${item.kindName}: ${item.assetName}`;
  const text = cancelled
    ? `${item.label} for ${item.assetName} is no longer scheduled for ${item.dueDate}.`
    : `${item.label} for ${item.assetName} (${item.assetTypeName}) is on ${item.dueDate}.\n\n${item.url}`;
  return { subject, text, html: `<p>${esc(text).replace(/\n/g, '<br>')}</p>` };
}

export interface RequestNotice {
  number: string;
  title: string;
  status: string;
  actorName: string;
  note: string | null;
  kind: 'created' | 'status' | 'comment' | 'assigned' | 'fulfilled';
  url: string;
}

const statusWords: Record<string, string> = {
  submitted: 'submitted',
  in_review: 'in review',
  approved: 'approved',
  ordered: 'ordered',
  fulfilled: 'fulfilled',
  rejected: 'declined',
  cancelled: 'cancelled',
};

/** Short, human emails for request updates. */
export function requestMessage(n: RequestNotice, recipientName: string): Message {
  const headline = {
    created: `New request ${n.number}: ${n.title}`,
    status: `${n.number} is ${statusWords[n.status] ?? n.status}: ${n.title}`,
    comment: `${n.actorName} commented on ${n.number}: ${n.title}`,
    assigned: `${n.number} was assigned: ${n.title}`,
    fulfilled: `${n.number} is fulfilled: ${n.title}`,
  }[n.kind];
  const body = n.kind === 'created' ? `${n.actorName} asked for “${n.title}”.` : n.kind === 'comment' ? `${n.actorName} wrote:` : `${n.actorName} updated the request.`;
  const text = [`Hi ${recipientName},`, '', body, ...(n.note ? ['', n.note] : []), '', n.url].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Inter,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;padding:28px 32px;border:1px solid #eceef2">
    <tr><td style="font-size:12px;color:#64748b;font-weight:600;letter-spacing:.04em;text-transform:uppercase">${esc(n.number)}</td></tr>
    <tr><td style="font-size:17px;font-weight:600;color:#0f172a;padding:4px 0 12px">${esc(n.title)}</td></tr>
    <tr><td style="font-size:14px;color:#334155;line-height:1.55">Hi ${esc(recipientName)},<br>${esc(body)}</td></tr>
    ${n.note ? `<tr><td style="padding-top:12px"><div style="border-left:3px solid #e2e8f0;padding:4px 12px;color:#334155;font-size:14px;white-space:pre-wrap">${esc(n.note)}</div></td></tr>` : ''}
    <tr><td style="padding-top:20px"><a href="${esc(n.url)}" style="display:inline-block;background:#4f46e5;color:#fff;font-size:14px;font-weight:600;padding:10px 16px;border-radius:8px;text-decoration:none">Open request</a></td></tr>
  </table></td></tr></table></body></html>`;
  return { subject: headline, text, html };
}
