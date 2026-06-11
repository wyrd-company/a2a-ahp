import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Message, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { StateAction } from '@microsoft/agent-host-protocol';

import { A2aAhpRequestHandler, sessionUriForTask } from '../src/index.js';
import { FakeAhpRuntime } from './fake-runtime.js';

test('message/send creates an AHP session and dispatches an AHP user turn', async () => {
  const runtime = new FakeAhpRuntime();
  const handler = new A2aAhpRequestHandler({ runtime });
  const message = userMessage('task-1', 'ctx-1', 'Hello');

  const result = await handler.sendMessage({ message });

  assert.equal((result as Task).kind, 'task');
  assert.equal(runtime.createdSessions.length, 1);
  assert.equal(runtime.createdSessions[0]?.sessionUri, sessionUriForTask('task-1'));
  assert.equal(runtime.dispatchedTurns.length, 1);
  assert.equal(runtime.dispatchedTurns[0]?.message.text, 'Hello');
});

test('AHP response actions project into a blocking A2A message result', async () => {
  const runtime = new FakeAhpRuntime();
  const handler = new A2aAhpRequestHandler({ runtime });

  const pending = handler.sendMessage({
    message: userMessage('task-2', 'ctx-2', 'Hello'),
    configuration: { blocking: true },
  });

  await waitFor(() => runtime.dispatchedTurns.length === 1);
  const dispatch = runtime.dispatchedTurns[0]!;
  runtime.emit(dispatch.sessionUri, responsePart(dispatch.turnId));
  runtime.emit(dispatch.sessionUri, delta(dispatch.turnId, 'Hello from AHP'));
  runtime.emit(dispatch.sessionUri, turnComplete(dispatch.turnId));

  const result = await pending;
  assert.equal((result as Message).kind, 'message');
  assert.equal((result as Message).role, 'agent');
  const part = (result as Message).parts[0];
  assert.equal(part?.kind, 'text');
  assert.equal(part?.kind === 'text' ? part.text : '', 'Hello from AHP');
});

test('message/stream yields projected updates from AHP session actions', async () => {
  const runtime = new FakeAhpRuntime();
  const handler = new A2aAhpRequestHandler({ runtime });
  const stream = handler.sendMessageStream({ message: userMessage('task-3', 'ctx-3', 'Stream') });

  const first = await stream.next();
  assert.equal(first.done, false);
  assert.equal((first.value as Task).kind, 'task');

  await waitFor(() => runtime.dispatchedTurns.length === 1);
  const dispatch = runtime.dispatchedTurns[0]!;
  runtime.emit(dispatch.sessionUri, responsePart(dispatch.turnId));
  runtime.emit(dispatch.sessionUri, delta(dispatch.turnId, 'chunk'));
  runtime.emit(dispatch.sessionUri, turnComplete(dispatch.turnId));

  const events: Array<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
  for await (const event of stream) {
    if (event.kind !== 'task' && event.kind !== 'message') events.push(event);
  }

  assert.ok(events.some(event => event.kind === 'status-update' && event.status.state === 'working'));
  assert.ok(events.some(event => event.kind === 'status-update' && event.status.state === 'completed' && event.final));
});

test('tasks/get returns the local projected task state with history limit', async () => {
  const runtime = new FakeAhpRuntime();
  const handler = new A2aAhpRequestHandler({ runtime });
  await handler.sendMessage({ message: userMessage('task-4', 'ctx-4', 'Hello') });

  const task = await handler.getTask({ id: 'task-4', historyLength: 1 });

  assert.equal(task.id, 'task-4');
  assert.equal(task.history?.length, 1);
});

test('tasks/cancel dispatches cancellation and updates projection', async () => {
  const runtime = new FakeAhpRuntime();
  const handler = new A2aAhpRequestHandler({ runtime });
  await handler.sendMessage({ message: userMessage('task-5', 'ctx-5', 'Cancel') });

  const task = await handler.cancelTask({ id: 'task-5' });

  assert.equal(runtime.canceledTurns.length, 1);
  assert.equal(task.status.state, 'canceled');
});

test('tasks/resubscribe streams future projected events', async () => {
  const runtime = new FakeAhpRuntime();
  const handler = new A2aAhpRequestHandler({ runtime });
  await handler.sendMessage({ message: userMessage('task-6', 'ctx-6', 'Resume') });

  const stream = handler.resubscribe({ id: 'task-6' });
  const initial = await stream.next();
  assert.equal(initial.done, false);
  assert.equal((initial.value as Task).id, 'task-6');

  const dispatch = runtime.dispatchedTurns[0]!;
  const completedPromise = stream.next();
  await new Promise(resolve => setTimeout(resolve, 0));
  runtime.emit(dispatch.sessionUri, turnComplete(dispatch.turnId));
  const completed = await completedPromise;

  assert.equal(completed.done, false);
  assert.equal((completed.value as TaskStatusUpdateEvent).status.state, 'completed');
});

function userMessage(taskId: string, contextId: string, text: string): Message {
  return {
    kind: 'message',
    role: 'user',
    messageId: `${taskId}-message`,
    taskId,
    contextId,
    parts: [{ kind: 'text', text }],
  };
}

function responsePart(turnId: string): StateAction {
  return {
    type: 'session/responsePart',
    turnId,
    part: { kind: 'markdown', id: 'part-1', content: '' },
  } as StateAction;
}

function delta(turnId: string, content: string): StateAction {
  return {
    type: 'session/delta',
    turnId,
    partId: 'part-1',
    content,
  } as StateAction;
}

function turnComplete(turnId: string): StateAction {
  return {
    type: 'session/turnComplete',
    turnId,
  } as StateAction;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not met before timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
