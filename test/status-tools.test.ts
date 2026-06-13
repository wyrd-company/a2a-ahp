import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  InMemoryA2aTaskStore,
  postStatusSchema,
  publishArtifactSchema,
  requestInputSchema,
  setActivitySchema,
  StatusToolService,
  statusToolDefinitions,
  TaskProjector,
  type ToolContextResolver,
} from '../src/index.js';

test('MCP post_status updates the projected A2A task status/activity', async () => {
  const { projector, service } = serviceForSession('ahp-session:/status-1');
  const record = projector.ensureTask({
    taskId: 'task-s1',
    contextId: 'ctx-s1',
    sessionUri: 'ahp-session:/status-1',
  });

  const event = await service.postStatus({ state: 'working', message: 'Running', activity: 'thinking' });

  assert.equal(event.status.state, 'working');
  assert.equal(record.task.status.message?.parts[0]?.kind, 'text');
  assert.equal(
    record.task.status.message?.parts[0]?.kind === 'text' ? record.task.status.message.parts[0].text : '',
    'Running',
  );
});

test('MCP publish_artifact adds an A2A artifact update', async () => {
  const { projector, service } = serviceForSession('ahp-session:/status-2');
  const record = projector.ensureTask({
    taskId: 'task-s2',
    contextId: 'ctx-s2',
    sessionUri: 'ahp-session:/status-2',
  });

  const event = await service.publishArtifact({ artifactId: 'artifact-1', text: 'artifact body' });

  assert.equal(event.kind, 'artifact-update');
  assert.equal(record.task.artifacts?.length, 1);
  assert.equal(record.task.artifacts?.[0]?.artifactId, 'artifact-1');
});

test('MCP request_input moves the projected task to input-required', async () => {
  const { service } = serviceForSession('ahp-session:/status-3');

  const event = await service.requestInput({ prompt: 'Need approval' });

  assert.equal(event.status.state, 'input-required');
});

test('status tool schemas do not require caller-supplied task or session correlation', () => {
  const schemas = [postStatusSchema, publishArtifactSchema, requestInputSchema, setActivitySchema];
  for (const schema of schemas) {
    const keys = Object.keys(schema.shape);
    assert.equal(keys.includes('taskId'), false);
    assert.equal(keys.includes('sessionId'), false);
    assert.equal(keys.includes('sessionUri'), false);
    assert.equal(keys.includes('contextId'), false);
  }
  assert.deepEqual(
    statusToolDefinitions().map(tool => tool.name),
    ['post_status', 'request_input', 'publish_artifact', 'set_activity'],
  );
});

test('status tools reject calls without trusted context unless isolated fallback resolves it', async () => {
  const projector = new TaskProjector();
  projector.ensureTask({ taskId: 'task-s4', contextId: 'ctx-s4', sessionUri: 'ahp-session:/status-4' });
  const missingContext: ToolContextResolver = { resolve: () => undefined };
  const service = new StatusToolService({ projector, contextResolver: missingContext });

  await assert.rejects(() => service.postStatus({ state: 'working' }), /Trusted AHP forwarding context/);

  const fallbackService = new StatusToolService({
    projector,
    contextResolver: missingContext,
    fallbackCorrelationResolver: {
      resolve: () => ({ sessionUri: 'ahp-session:/status-4' }),
    },
  });
  const event = await fallbackService.postStatus({ state: 'working' });
  assert.equal(event.status.state, 'working');
});

test('status tools hydrate task correlation from the task store by trusted session context', async () => {
  const store = new InMemoryA2aTaskStore();
  const writer = new TaskProjector({ store });
  const written = writer.ensureTask({
    taskId: 'task-s5',
    contextId: 'ctx-s5',
    sessionUri: 'ahp-session:/status-5',
  });
  await writer.save(written);

  const reader = new TaskProjector({ store });
  const service = new StatusToolService({
    projector: reader,
    contextResolver: { resolve: () => ({ sessionUri: 'ahp-session:/status-5', turnId: 'turn-5' }) },
  });

  const event = await service.postStatus({ state: 'working', message: 'Hydrated' });
  const saved = await store.getByTaskId('task-s5');

  assert.equal(event.taskId, 'task-s5');
  assert.equal(event.contextId, 'ctx-s5');
  assert.equal(saved?.correlation.activeTurnId, 'turn-5');
  assert.equal(saved?.task.status.state, 'working');
});

function serviceForSession(sessionUri: string): { projector: TaskProjector; service: StatusToolService } {
  const projector = new TaskProjector();
  projector.ensureTask({ taskId: `task-${sessionUri}`, contextId: `ctx-${sessionUri}`, sessionUri });
  return {
    projector,
    service: new StatusToolService({
      projector,
      contextResolver: { resolve: () => ({ sessionUri }) },
    }),
  };
}
