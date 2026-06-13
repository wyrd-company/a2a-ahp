import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Message, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { StateAction } from '@microsoft/agent-host-protocol';

import { A2aAhpRequestHandler, InMemoryA2aTaskStore, sessionUriForTask } from '../src/index.js';
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

test('tasks/get hydrates task projection from a durable task store', async () => {
  const store = new InMemoryA2aTaskStore();
  const runtime = new FakeAhpRuntime();
  const writer = new A2aAhpRequestHandler({
    runtime,
    taskStore: store,
    route: { provider: 'provider-a', model: { id: 'model-a' } },
  });
  await writer.sendMessage({ message: userMessage('task-store-1', 'ctx-store-1', 'Persist') });

  const reader = new A2aAhpRequestHandler({ runtime: new FakeAhpRuntime(), taskStore: store });
  const task = await reader.getTask({ id: 'task-store-1' });
  const record = reader.projector.getByTaskId('task-store-1');

  assert.equal(task.id, 'task-store-1');
  assert.equal(task.contextId, 'ctx-store-1');
  assert.equal(record?.route?.provider, 'provider-a');
  assert.equal(record?.route?.model?.id, 'model-a');
});

test('tasks/resubscribe replays persisted stream updates before future events', async () => {
  const store = new InMemoryA2aTaskStore();
  const runtime = new FakeAhpRuntime();
  const writer = new A2aAhpRequestHandler({ runtime, taskStore: store });
  const stream = writer.sendMessageStream({ message: userMessage('task-store-2', 'ctx-store-2', 'Stream persist') });

  await stream.next();
  await waitFor(() => runtime.dispatchedTurns.length === 1);
  const dispatch = runtime.dispatchedTurns[0]!;
  runtime.emit(dispatch.sessionUri, responsePart(dispatch.turnId));
  runtime.emit(dispatch.sessionUri, delta(dispatch.turnId, 'persisted chunk'));
  const projected = await stream.next();
  assert.equal(projected.done, false);

  const reader = new A2aAhpRequestHandler({ runtime: new FakeAhpRuntime(), taskStore: store });
  const resumed = reader.resubscribe({ id: 'task-store-2' });

  const task = await resumed.next();
  const replay = await resumed.next();

  assert.equal(task.done, false);
  assert.equal((task.value as Task).id, 'task-store-2');
  assert.equal(replay.done, false);
  assert.equal((replay.value as TaskStatusUpdateEvent).kind, 'status-update');
  assert.equal((replay.value as TaskStatusUpdateEvent).status.state, 'working');
});

test('active-client status tool calls update projection and complete through AHP', async () => {
  const runtime = new FakeAhpRuntime();
  const handler = new A2aAhpRequestHandler({ runtime });
  const stream = handler.sendMessageStream({ message: userMessage('task-7', 'ctx-7', 'Tool status') });

  const initial = await stream.next();
  assert.equal(initial.done, false);
  await waitFor(() => runtime.dispatchedTurns.length === 1);
  const dispatch = runtime.dispatchedTurns[0]!;

  runtime.emit(dispatch.sessionUri, {
    type: 'session/toolCallStart',
    turnId: dispatch.turnId,
    toolCallId: 'tool-call-1',
    toolName: 'post_status',
    displayName: 'Post Status',
    contributor: { kind: 'client', clientId: 'a2a-ahp-test' },
  } as StateAction);
  runtime.emit(dispatch.sessionUri, {
    type: 'session/toolCallReady',
    turnId: dispatch.turnId,
    toolCallId: 'tool-call-1',
    invocationMessage: 'Post Status',
    toolInput: JSON.stringify({ state: 'working', message: 'Installing dependencies' }),
    confirmed: 'not-needed',
  } as StateAction);

  let update = await stream.next();
  while (
    !update.done &&
    !(
      (update.value as TaskStatusUpdateEvent).kind === 'status-update' &&
      (update.value as TaskStatusUpdateEvent).status.message?.parts[0]?.kind === 'text'
    )
  ) {
    update = await stream.next();
  }

  assert.equal(update.done, false);
  assert.equal((update.value as TaskStatusUpdateEvent).status.state, 'working');
  const message = (update.value as TaskStatusUpdateEvent).status.message;
  assert.equal(message?.parts[0]?.kind, 'text');
  assert.equal(message?.parts[0]?.kind === 'text' ? message.parts[0].text : '', 'Installing dependencies');
  assert.equal(runtime.completedToolCalls.length, 1);
  assert.equal(runtime.completedToolCalls[0]?.toolCallId, 'tool-call-1');
  assert.equal(runtime.completedToolCalls[0]?.result.success, true);
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
