import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TaskState, type Message, type Task, type TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { StateAction } from '@microsoft/agent-host-protocol';

import {
  A2aAhpRequestHandler,
  InMemoryA2aTaskStore,
  STRUCTURED_ASK_ANSWER_METADATA_KEY,
  STRUCTURED_ASK_METADATA_KEY,
  sessionUriForTask,
} from '../src/index.js';
import {
  cancelTaskRequest,
  sendMessageRequest,
  statusFromStream,
  taskFromStream,
  textFromMessage,
  userMessage,
} from './a2a-helpers.js';
import { FakeAhpRuntime } from './fake-runtime.js';

test('message/send creates an AHP session and dispatches an AHP user turn', async () => {
  const runtime = new FakeAhpRuntime();
  const handler = new A2aAhpRequestHandler({ runtime });
  const message = userMessage('task-1', 'ctx-1', 'Hello');

  const result = await handler.sendMessage(sendMessageRequest(message, { returnImmediately: true }));

  assert.equal((result as Task).id, 'task-1');
  assert.equal(runtime.createdSessions.length, 1);
  assert.equal(runtime.createdSessions[0]?.sessionUri, sessionUriForTask('task-1'));
  assert.equal(runtime.dispatchedTurns.length, 1);
  assert.equal(runtime.dispatchedTurns[0]?.message.text, 'Hello');
});

test('AHP response actions project into a blocking A2A message result', async () => {
  const runtime = new FakeAhpRuntime();
  const handler = new A2aAhpRequestHandler({ runtime });

  const pending = handler.sendMessage(sendMessageRequest(userMessage('task-2', 'ctx-2', 'Hello')));

  await waitFor(() => runtime.dispatchedTurns.length === 1);
  const dispatch = runtime.dispatchedTurns[0]!;
  runtime.emit(dispatch.sessionUri, responsePart(dispatch.turnId));
  runtime.emit(dispatch.sessionUri, delta(dispatch.turnId, 'Hello from AHP'));
  runtime.emit(dispatch.sessionUri, turnComplete(dispatch.turnId));

  const result = await pending;
  assert.equal(textFromMessage(result as Message), 'Hello from AHP');
});

test('message/stream yields projected updates from AHP session actions', async () => {
  const runtime = new FakeAhpRuntime();
  const handler = new A2aAhpRequestHandler({ runtime });
  const stream = handler.sendMessageStream(sendMessageRequest(userMessage('task-3', 'ctx-3', 'Stream')));

  const first = await stream.next();
  assert.equal(first.done, false);
  assert.equal(taskFromStream(first.value)?.id, 'task-3');

  await waitFor(() => runtime.dispatchedTurns.length === 1);
  const dispatch = runtime.dispatchedTurns[0]!;
  runtime.emit(dispatch.sessionUri, responsePart(dispatch.turnId));
  runtime.emit(dispatch.sessionUri, delta(dispatch.turnId, 'chunk'));
  runtime.emit(dispatch.sessionUri, turnComplete(dispatch.turnId));

  const statuses: TaskStatusUpdateEvent[] = [];
  for await (const event of stream) {
    const status = statusFromStream(event);
    if (status) statuses.push(status);
  }

  assert.ok(statuses.some(event => event.status?.state === TaskState.TASK_STATE_WORKING));
  assert.ok(statuses.some(event => event.status?.state === TaskState.TASK_STATE_COMPLETED));
});

test('tasks/get returns the local projected task state with history limit', async () => {
  const runtime = new FakeAhpRuntime();
  const handler = new A2aAhpRequestHandler({ runtime });
  await handler.sendMessage(sendMessageRequest(userMessage('task-4', 'ctx-4', 'Hello'), { returnImmediately: true }));

  const task = await handler.getTask({ id: 'task-4', historyLength: 1 });

  assert.equal(task.id, 'task-4');
  assert.equal(task.history?.length, 1);
});

test('tasks/cancel dispatches cancellation and updates projection', async () => {
  const runtime = new FakeAhpRuntime();
  const handler = new A2aAhpRequestHandler({ runtime });
  await handler.sendMessage(sendMessageRequest(userMessage('task-5', 'ctx-5', 'Cancel'), { returnImmediately: true }));

  const task = await handler.cancelTask(cancelTaskRequest('task-5'));

  assert.equal(runtime.canceledTurns.length, 1);
  assert.equal(task.status?.state, TaskState.TASK_STATE_CANCELED);
});

test('tasks/resubscribe streams future projected events', async () => {
  const runtime = new FakeAhpRuntime();
  const handler = new A2aAhpRequestHandler({ runtime });
  await handler.sendMessage(sendMessageRequest(userMessage('task-6', 'ctx-6', 'Resume'), { returnImmediately: true }));

  const stream = handler.resubscribe({ id: 'task-6' });
  const initial = await stream.next();
  assert.equal(initial.done, false);
  assert.equal(taskFromStream(initial.value)?.id, 'task-6');

  const dispatch = runtime.dispatchedTurns[0]!;
  const completedPromise = stream.next();
  await new Promise(resolve => setTimeout(resolve, 0));
  runtime.emit(dispatch.sessionUri, turnComplete(dispatch.turnId));
  const completed = await completedPromise;

  assert.equal(completed.done, false);
  assert.equal(statusFromStream(completed.value)?.status?.state, TaskState.TASK_STATE_COMPLETED);
});

test('tasks/get hydrates task projection from a durable task store', async () => {
  const store = new InMemoryA2aTaskStore();
  const runtime = new FakeAhpRuntime();
  const writer = new A2aAhpRequestHandler({
    runtime,
    taskStore: store,
    route: { provider: 'provider-a', model: { id: 'model-a' } },
  });
  await writer.sendMessage(sendMessageRequest(userMessage('task-store-1', 'ctx-store-1', 'Persist'), { returnImmediately: true }));

  const reader = new A2aAhpRequestHandler({ runtime: new FakeAhpRuntime(), taskStore: store });
  const task = await reader.getTask({ id: 'task-store-1' });
  const record = reader.projector.getByTaskId('task-store-1');

  assert.equal(task.id, 'task-store-1');
  assert.equal(task.contextId, 'ctx-store-1');
  assert.equal(record?.route?.provider, 'provider-a');
  assert.equal(record?.route?.model?.id, 'model-a');
});

test('message/send to an existing durable task resumes the AHP session instead of recreating it', async () => {
  const store = new InMemoryA2aTaskStore();
  const writerRuntime = new FakeAhpRuntime();
  const writer = new A2aAhpRequestHandler({
    runtime: writerRuntime,
    taskStore: store,
    route: { provider: 'provider-a', model: { id: 'model-a' } },
  });
  await writer.sendMessage(sendMessageRequest(userMessage('task-store-resume', 'ctx-store-resume', 'First'), { returnImmediately: true }));

  const runtime = new FakeAhpRuntime();
  const reader = new A2aAhpRequestHandler({ runtime, taskStore: store });
  await reader.sendMessage(sendMessageRequest(userMessage('task-store-resume', 'ctx-store-resume', 'Second'), { returnImmediately: true }));

  assert.equal(runtime.createdSessions.length, 0);
  assert.equal(runtime.resumedSessions.length, 1);
  assert.equal(runtime.resumedSessions[0]?.sessionUri, sessionUriForTask('task-store-resume'));
  assert.equal(runtime.resumedSessions[0]?.provider, 'provider-a');
  assert.deepEqual(runtime.resumedSessions[0]?.model, { id: 'model-a' });
  assert.equal(runtime.dispatchedTurns.length, 1);
});

test('tasks/resubscribe replays persisted stream updates before future events', async () => {
  const store = new InMemoryA2aTaskStore();
  const runtime = new FakeAhpRuntime();
  const writer = new A2aAhpRequestHandler({ runtime, taskStore: store });
  const stream = writer.sendMessageStream(sendMessageRequest(userMessage('task-store-2', 'ctx-store-2', 'Stream persist')));

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
  assert.equal(taskFromStream(task.value)?.id, 'task-store-2');
  assert.equal(replay.done, false);
  assert.equal(statusFromStream(replay.value)?.status?.state, TaskState.TASK_STATE_WORKING);
});

test('active-client status tool calls update projection and complete through AHP', async () => {
  const runtime = new FakeAhpRuntime();
  const handler = new A2aAhpRequestHandler({ runtime });
  const stream = handler.sendMessageStream(sendMessageRequest(userMessage('task-7', 'ctx-7', 'Tool status')));

  const initial = await stream.next();
  assert.equal(initial.done, false);
  await waitFor(() => runtime.dispatchedTurns.length === 1);
  const dispatch = runtime.dispatchedTurns[0]!;

  emitToolCall(runtime, dispatch, 'tool-call-1', 'post_status', { state: 'working', message: 'Installing dependencies' });

  let update = await stream.next();
  let status = update.done ? undefined : statusFromStream(update.value);
  while (!update.done && textFromMessage(status?.status?.message) === '') {
    update = await stream.next();
    status = update.done ? undefined : statusFromStream(update.value);
  }

  assert.equal(update.done, false);
  assert.equal(status?.status?.state, TaskState.TASK_STATE_WORKING);
  assert.equal(textFromMessage(status?.status?.message), 'Installing dependencies');
  assert.equal(runtime.completedToolCalls.length, 1);
  assert.equal(runtime.completedToolCalls[0]?.toolCallId, 'tool-call-1');
  assert.equal(runtime.completedToolCalls[0]?.result.success, true);
});

test('request_input with options emits INPUT_REQUIRED with structured ask metadata', async () => {
  const runtime = new FakeAhpRuntime();
  const handler = new A2aAhpRequestHandler({ runtime });
  const stream = handler.sendMessageStream(sendMessageRequest(userMessage('task-ask-1', 'ctx-ask-1', 'Ask')));

  await stream.next();
  await waitFor(() => runtime.dispatchedTurns.length === 1);
  const dispatch = runtime.dispatchedTurns[0]!;

  emitToolCall(runtime, dispatch, 'tool-call-ask-1', 'request_input', {
    prompt: 'Choose one',
    options: [{ id: 'approve', label: 'Approve', description: 'Continue' }],
    allowFreeText: false,
    role: 'reviewer',
  });

  const status = await nextStatusWithState(stream, TaskState.TASK_STATE_INPUT_REQUIRED);

  assert.equal(status.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  assert.deepEqual(status?.metadata?.[STRUCTURED_ASK_METADATA_KEY], {
    prompt: 'Choose one',
    options: [{ id: 'approve', label: 'Approve', description: 'Continue' }],
    allowFreeText: false,
    role: 'reviewer',
  });
  assert.equal(runtime.completedToolCalls.length, 0);
});

test('request_input answer metadata resolves pending tool call with optionId', async () => {
  const runtime = new FakeAhpRuntime();
  const handler = new A2aAhpRequestHandler({ runtime });
  const stream = handler.sendMessageStream(sendMessageRequest(userMessage('task-ask-2', 'ctx-ask-2', 'Ask')));

  await stream.next();
  await waitFor(() => runtime.dispatchedTurns.length === 1);
  const dispatch = runtime.dispatchedTurns[0]!;
  emitToolCall(runtime, dispatch, 'tool-call-ask-2', 'request_input', { prompt: 'Choose one' });
  await nextStatusWithState(stream, TaskState.TASK_STATE_INPUT_REQUIRED);

  await handler.sendMessage(sendMessageRequest(
    userMessage('task-ask-2', 'ctx-ask-2', 'Approved', {
      [STRUCTURED_ASK_ANSWER_METADATA_KEY]: { optionId: 'approve' },
    }),
    { returnImmediately: true },
  ));

  assert.equal(runtime.completedToolCalls.length, 1);
  assert.equal(runtime.completedToolCalls[0]?.toolCallId, 'tool-call-ask-2');
  assert.deepEqual(runtime.completedToolCalls[0]?.result.structuredContent, { answer: { optionId: 'approve' } });
  assert.equal(toolResultText(runtime.completedToolCalls[0]?.result), 'Selected option: approve');
});

test('plain-text request_input answer resolves pending tool call with text', async () => {
  const runtime = new FakeAhpRuntime();
  const handler = new A2aAhpRequestHandler({ runtime });
  const stream = handler.sendMessageStream(sendMessageRequest(userMessage('task-ask-3', 'ctx-ask-3', 'Ask')));

  await stream.next();
  await waitFor(() => runtime.dispatchedTurns.length === 1);
  const dispatch = runtime.dispatchedTurns[0]!;
  emitToolCall(runtime, dispatch, 'tool-call-ask-3', 'request_input', { prompt: 'Tell me' });
  await nextStatusWithState(stream, TaskState.TASK_STATE_INPUT_REQUIRED);

  await handler.sendMessage(sendMessageRequest(
    userMessage('task-ask-3', 'ctx-ask-3', 'Plain answer'),
    { returnImmediately: true },
  ));

  assert.equal(runtime.completedToolCalls.length, 1);
  assert.deepEqual(runtime.completedToolCalls[0]?.result.structuredContent, { answer: { text: 'Plain answer' } });
  assert.equal(toolResultText(runtime.completedToolCalls[0]?.result), 'Plain answer');
});

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

function emitToolCall(
  runtime: FakeAhpRuntime,
  dispatch: { sessionUri: string; turnId: string },
  toolCallId: string,
  toolName: string,
  toolInput: unknown,
): void {
  runtime.emit(dispatch.sessionUri, {
    type: 'session/toolCallStart',
    turnId: dispatch.turnId,
    toolCallId,
    toolName,
    displayName: toolName,
    contributor: { kind: 'client', clientId: 'a2a-ahp-test' },
  } as StateAction);
  runtime.emit(dispatch.sessionUri, {
    type: 'session/toolCallReady',
    turnId: dispatch.turnId,
    toolCallId,
    invocationMessage: toolName,
    toolInput: JSON.stringify(toolInput),
    confirmed: 'not-needed',
  } as StateAction);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not met before timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function nextStatusWithState(
  stream: AsyncGenerator<import('@a2a-js/sdk').StreamResponse, void, undefined>,
  state: TaskState,
): Promise<TaskStatusUpdateEvent> {
  for await (const response of stream) {
    const status = statusFromStream(response);
    if (status?.status?.state === state) return status;
  }
  throw new Error(`stream ended before status ${state}`);
}

function toolResultText(result: { content?: readonly unknown[] } | undefined): string {
  const first = result?.content?.[0];
  return isTextContent(first) ? first.text : '';
}

function isTextContent(value: unknown): value is { text: string } {
  return typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string';
}
