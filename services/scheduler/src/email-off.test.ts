import { describe, expect, it } from 'bun:test';
import { schedulerConfig } from './service.js';

describe('email sending', () => {
  it('is off unless explicitly turned on', () => {
    expect(schedulerConfig.EMAIL_SENDING.parse(undefined)).toBe('off');
    expect(() => schedulerConfig.EMAIL_SENDING.parse('yes')).toThrow();
    // No SMTP server is needed while it is off.
    expect(schedulerConfig.SMTP_URL.parse(undefined)).toBe('smtp://mail.invalid');
  });
});
