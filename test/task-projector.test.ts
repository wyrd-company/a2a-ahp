import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TaskState } from '@a2a-js/sdk';
import type { StateAction } from '@microsoft/agent-host-protocol';

import { InMemoryA2aTaskStore, TaskProjector } from '../src/index.js';
import { textFromMessage } from './a2a-helpers.js';

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

  assert.equal(record.task.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(textFromMessage(record.task.status?.message), 'projected text');
  assert.equal('status' in final[0]! ? final[0].status?.state : undefined, TaskState.TASK_STATE_COMPLETED);
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

  assert.equal(failed.task.status?.state, TaskState.TASK_STATE_FAILED);
  assert.equal(canceled.task.status?.state, TaskState.TASK_STATE_CANCELED);
});

test('persists and hydrates task projection records through the task store', async () => {
  const store = new InMemoryA2aTaskStore();
  const writer = new TaskProjector({ store, streamHistoryLimit: 2 });
  const record = writer.ensureTask({
    taskId: 'task-store-1',
    contextId: 'ctx-store-1',
    route: { provider: 'provider-a', model: { id: 'model-a' } },
  });

  writer.projectAction(record.correlation.sessionUri, {
    type: 'session/responsePart',
    turnId: 'turn-1',
    part: { kind: 'markdown', id: 'part-1', content: '' },
  } as StateAction);
  writer.projectAction(record.correlation.sessionUri, {
    type: 'session/delta',
    turnId: 'turn-1',
    partId: 'part-1',
    content: 'stored text',
  } as StateAction);
  await writer.save(record);

  const reader = new TaskProjector({ store });
  const loaded = await reader.loadByTaskId('task-store-1');

  assert.ok(loaded);
  assert.equal(loaded.task.id, 'task-store-1');
  assert.equal(loaded.correlation.contextId, 'ctx-store-1');
  assert.equal(loaded.route?.provider, 'provider-a');
  assert.equal(loaded.route?.model?.id, 'model-a');
  assert.equal(loaded.metadata.terminal, false);
  assert.equal(typeof loaded.streamEvents[0]?.sequence, 'number');
  assert.equal(typeof loaded.streamEvents[0]?.timestamp, 'string');
  assert.equal(reader.replayableStreamEvents(loaded).length, 2);
});
