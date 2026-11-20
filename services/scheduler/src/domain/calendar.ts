import { addDuration, type Duration, type IsoDate } from '@am/core';

/** iCalendar (RFC 5545) generation for Outlook invites and subscription feeds. */
export interface CalendarEntry {
  uid: string;
  sequence: number;
  date: IsoDate;
  summary: string;
  description: string;
  url: string;
  /** Alarm offset before the (all-day) event, if any. */
  alarm?: Duration;
  status: 'CONFIRMED' | 'CANCELLED';
}

const escapeText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const compactDate = (d: IsoDate) => d.replaceAll('-', '');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Lines longer than 75 octets are folded, as required by RFC 5545 §3.1. */
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

function fold(line: string): string {
  const bytes = utf8.encode(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (parts.length ? 74 : 75), bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--; // never split a UTF-8 sequence
    parts.push(fromUtf8.decode(bytes.subarray(start, end)));
    start = end;
  }
  return parts.join('\r\n ');
}

function alarmTrigger(d: Duration): string {
  const days = d.unit === 'day' ? d.amount : d.unit === 'week' ? d.amount * 7 : d.unit === 'month' ? d.amount * 30 : d.amount * 365;
  return `-P${days}D`;
}

function event(e: CalendarEntry, organizer: { name: string; email: string } | null, attendee: string | null, now: Date): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `SEQUENCE:${e.sequence}`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART;VALUE=DATE:${compactDate(e.date)}`,
    `DTEND;VALUE=DATE:${compactDate(addDuration(e.date, { amount: 1, unit: 'day' }))}`,
    `SUMMARY:${escapeText(e.summary)}`,
    `DESCRIPTION:${escapeText(`${e.description}\n\n${e.url}`)}`,
    `URL:${e.url}`,
    `STATUS:${e.status}`,
    'TRANSP:TRANSPARENT',
    'X-MICROSOFT-CDO-BUSYSTATUS:FREE',
    'X-MICROSOFT-CDO-ALLDAYEVENT:TRUE',
  ];
  if (organizer) lines.push(`ORGANIZER;CN=${escapeText(organizer.name)}:mailto:${organizer.email}`);
  if (attendee) lines.push(`ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${attendee}`);
  if (e.alarm && e.status === 'CONFIRMED') {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(e.summary)}`, `TRIGGER:${alarmTrigger(e.alarm)}`, 'END:VALARM');
  }
  lines.push('END:VEVENT');
  return lines;
}

function calendar(method: 'REQUEST' | 'CANCEL' | 'PUBLISH', events: string[][], name?: string): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Asset Management//Obligations//EN', 'CALSCALE:GREGORIAN', `METHOD:${method}`];
  if (name) lines.push(`X-WR-CALNAME:${escapeText(name)}`);
  for (const e of events) lines.push(...e);
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** A meeting-style invite Outlook places on the attendee's calendar (and later updates/cancels by UID). */
export function invite(entry: CalendarEntry, organizer: { name: string; email: string }, attendee: string, now = new Date()): { method: 'REQUEST' | 'CANCEL'; content: string } {
  const method = entry.status === 'CANCELLED' ? 'CANCEL' : 'REQUEST';
  return { method, content: calendar(method, [event(entry, organizer, attendee, now)]) };
}

/** A subscription feed (Outlook "Add calendar → From internet"). */
export function feed(name: string, entries: CalendarEntry[], now = new Date()): string {
  return calendar('PUBLISH', entries.map((e) => event(e, null, null, now)), name);
}
