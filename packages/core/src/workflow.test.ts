import { describe, expect, it } from 'bun:test';
import { allowedMoves, combineStatuses, defaultWorkflow, initialStatus, statusIn, validateExtraWorkflow, validateExtraWorkflows, validateWorkflow, workflowPresets, type Workflow } from './workflow.js';

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

describe('added workflows', () => {
  const machines = { ...workflowPresets.machines, key: 'machines', responsibleUnitId: null };

  it('accepts the presets, and needs no Closed status', () => {
    expect(validateExtraWorkflow(machines)).toEqual([]);
    expect(validateExtraWorkflow({ ...workflowPresets.swap, key: 'swap', responsibleUnitId: null })).toEqual([]);
    expect(validateExtraWorkflow({ ...machines, statuses: machines.statuses.filter((s) => s.key !== 'retired'), transitions: machines.transitions.filter((x) => x.from !== 'retired' && x.to !== 'retired') })).toEqual([]);
  });

  it('starts items with the item, and keeps keys unique across template and variant', () => {
    expect(validateExtraWorkflow({ ...machines, startsWhen: 'purchase_done' })[0]!.message).toMatch(/start when the item is added/);
    const messages = validateExtraWorkflows([machines, machines], new Set(['machines'])).map((i) => i.message);
    expect(messages).toContain('Two workflows are called "machines"');
    expect(messages).toContain('The template already has a workflow "machines"');
  });

  it('combines every status into one', () => {
    const purchase = (category: 'todo' | 'active' | 'done' | 'closed') => ({ key: 'purchase', category, started: true });
    expect(combineStatuses([purchase('active'), { key: 'swap', category: 'todo', started: false }])).toEqual({ category: 'active', waitingOn: ['purchase'] });
    expect(combineStatuses([purchase('done'), { key: 'swap', category: 'todo', started: true }])).toEqual({ category: 'todo', waitingOn: ['swap'] });
    expect(combineStatuses([purchase('done'), { key: 'swap', category: 'done', started: true }])).toEqual({ category: 'done', waitingOn: [] });
    expect(combineStatuses([purchase('closed'), { key: 'swap', category: 'active', started: true }])).toEqual({ category: 'closed', waitingOn: [] });
  });
});
