import { describe, expect, it } from 'vitest';
import { allowedMoves, defaultWorkflow, initialStatus, statusIn, validateWorkflow, type Workflow } from './workflow.js';

describe('request workflows', () => {
  it('accepts the default workflow', () => {
    expect(validateWorkflow(defaultWorkflow)).toEqual([]);
    expect(initialStatus(defaultWorkflow).key).toBe('submitted');
  });

  it('needs a to-do start, a done and a closed status, and a path to done', () => {
    const wf: Workflow = {
      statuses: [
        { key: 'waiting', label: 'Waiting', color: '#6366f1', category: 'active' },
        { key: 'bought', label: 'Bought', color: '#10b981', category: 'done' },
        { key: 'bought', label: 'Bought again', color: '#10b981', category: 'done' },
      ],
      transitions: [{ from: 'waiting', to: 'nowhere', by: 'handler' }],
    };
    const messages = validateWorkflow(wf).map((i) => i.message).join('\n');
    expect(messages).toMatch(/first status/);
    expect(messages).toMatch(/Closed/);
    expect(messages).toMatch(/Two statuses/);
    expect(messages).toMatch(/does not exist/);
    expect(messages).toMatch(/No path/);
  });

  it('gives requesters only their own moves', () => {
    expect(allowedMoves(defaultWorkflow, 'submitted', { isHandler: false, isRequester: true }).map((s) => s.key)).toEqual(['cancelled']);
    expect(allowedMoves(defaultWorkflow, 'submitted', { isHandler: false, isRequester: false })).toEqual([]);
    expect(allowedMoves(defaultWorkflow, 'submitted', { isHandler: true, isRequester: false }).map((s) => s.key)).toEqual(['in_review', 'approved', 'rejected', 'cancelled']);
  });

  it('describes statuses it no longer has instead of failing', () => {
    expect(statusIn(defaultWorkflow, 'legacy_step')).toMatchObject({ label: 'legacy step', category: 'active' });
  });
});
