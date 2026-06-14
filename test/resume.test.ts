import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { StateAction } from '@microsoft/agent-host-protocol';

import {
  InMemoryA2aTaskStore,
  resumeA2aAhpTasks,
  TaskProjector,
  type ResumeSessionOptions,
} from '../src/index.js';
import { FakeAhpRuntime } from './fake-runtime.js';

test('resumeA2aAhpTasks resumes non-terminal durable task sessions with original route identity', async () => {
  const store = new InMemoryA2aTaskStore();
  const writer = new TaskProjector({ store });
  const active = writer.ensureTask({
    taskId: 'task-resume-1',
    contextId: 'ctx-resume-1',
    sessionUri: 'ahp-session:/resume-1',
    route: { provider: 'codex', model: { id: 'gpt-5-codex' } },
  });
  const terminal = writer.ensureTask({
    taskId: 'task-resume-2',
    contextId: 'ctx-resume-2',
    sessionUri: 'ahp-session:/resume-2',
  });
  writer.projectAction(terminal.correlation.sessionUri, {
    type: 'session/turnComplete',
    turnId: 'turn-terminal',
  } as StateAction);
  await writer.save(active);
  await writer.save(terminal);

  const runtime = new FakeAhpRuntime();
  const result = await resumeA2aAhpTasks({ runtime, taskStore: store });

  assert.equal(result.resumed.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(result.resumed[0]?.subscription.result.snapshot?.resource, 'ahp-session:/resume-1');
  assert.equal(runtime.resumedSessions.length, 1);
  assert.deepEqual(runtime.resumedSessions[0], {
    sessionUri: 'ahp-session:/resume-1',
    contextId: 'ctx-resume-1',
    provider: 'codex',
    model: { id: 'gpt-5-codex' },
  });
});

test('resumeA2aAhpTasks projects live events from resumed subscriptions into the durable store', async () => {
  const store = new InMemoryA2aTaskStore();
  const writer = new TaskProjector({ store });
  const record = writer.ensureTask({
    taskId: 'task-resume-3',
    contextId: 'ctx-resume-3',
    sessionUri: 'ahp-session:/resume-3',
  });
  await writer.save(record);

  const runtime = new FakeAhpRuntime();
  await resumeA2aAhpTasks({ runtime, taskStore: store });

  runtime.emit(record.correlation.sessionUri, {
    type: 'session/responsePart',
    turnId: 'turn-resumed',
    part: { kind: 'markdown', id: 'part-1', content: '' },
  } as StateAction);
  runtime.emit(record.correlation.sessionUri, {
    type: 'session/delta',
    turnId: 'turn-resumed',
    partId: 'part-1',
    content: 'resumed text',
  } as StateAction);

  await waitFor(async () => {
    const saved = await store.getByTaskId('task-resume-3');
    return saved?.task.status.message?.parts[0]?.kind === 'text' &&
      saved.task.status.message.parts[0].text === 'resumed text';
  });
});

test('resumeA2aAhpTasks marks resume failures as durable failed task state', async () => {
  const store = new InMemoryA2aTaskStore();
  const writer = new TaskProjector({ store });
  const record = writer.ensureTask({
    taskId: 'task-resume-4',
    contextId: 'ctx-resume-4',
    sessionUri: 'ahp-session:/resume-4',
  });
  await writer.save(record);

  const result = await resumeA2aAhpTasks({
    runtime: new FailingResumeRuntime('AHP session cannot be resumed'),
    taskStore: store,
  });
  const saved = await store.getByTaskId('task-resume-4');

  assert.equal(result.resumed.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(saved?.task.status.state, 'failed');
  assert.match(
    saved?.task.status.message?.parts[0]?.kind === 'text' ? saved.task.status.message.parts[0].text : '',
    /AHP session cannot be resumed/,
  );
});

class FailingResumeRuntime extends FakeAhpRuntime {
  constructor(private readonly message: string) {
    super();
  }

  override async resumeSession(_options: ResumeSessionOptions): Promise<never> {
    throw new Error(this.message);
  }
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition was not met before timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
