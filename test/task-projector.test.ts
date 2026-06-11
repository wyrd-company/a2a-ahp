import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { StateAction } from '@microsoft/agent-host-protocol';

import { TaskProjector } from '../src/index.js';

test('projects AHP response delta and completion into A2A task state', () => {
  const projector = new TaskProjector();
  const record = projector.ensureTask({ taskId: 'task-p1', contextId: 'ctx-p1' });

  projector.projectAction(record.correlation.sessionUri, {
    type: 'session/responsePart',
    turnId: 'turn-1',
    part: { kind: 'markdown', id: 'part-1', content: '' },
  } as StateAction);
  projector.projectAction(record.correlation.sessionUri, {
    type: 'session/delta',
    turnId: 'turn-1',
    partId: 'part-1',
    content: 'projected text',
  } as StateAction);
  const final = projector.projectAction(record.correlation.sessionUri, {
    type: 'session/turnComplete',
    turnId: 'turn-1',
  } as StateAction);

  assert.equal(record.task.status.state, 'completed');
  assert.equal(record.task.status.message?.parts[0]?.kind, 'text');
  assert.equal(
    record.task.status.message?.parts[0]?.kind === 'text' ? record.task.status.message.parts[0].text : '',
    'projected text',
  );
  assert.equal(final[0]?.kind, 'status-update');
  assert.equal(final[0]?.kind === 'status-update' ? final[0].final : false, true);
});

test('projects AHP error and cancellation into terminal A2A states', () => {
  const projector = new TaskProjector();
  const failed = projector.ensureTask({ taskId: 'task-p2', contextId: 'ctx-p2' });
  const canceled = projector.ensureTask({ taskId: 'task-p3', contextId: 'ctx-p3' });

  projector.projectAction(failed.correlation.sessionUri, {
    type: 'session/error',
    turnId: 'turn-1',
    error: { message: 'failed hard' },
  } as StateAction);
  projector.projectAction(canceled.correlation.sessionUri, {
    type: 'session/turnCancelled',
    turnId: 'turn-1',
  } as StateAction);

  assert.equal(failed.task.status.state, 'failed');
  assert.equal(canceled.task.status.state, 'canceled');
});
