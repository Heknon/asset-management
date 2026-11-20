import { metrics } from '@am/platform';

/** Every email the scheduler sends, by channel and outcome. */
export const notificationsSent = metrics.counter({
  name: 'am_notifications_sent_total',
  help: 'Notifications sent by channel (reminder_email, calendar_invite, request_email) and outcome',
  labelNames: ['channel', 'outcome'],
});
