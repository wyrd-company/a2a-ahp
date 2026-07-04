import {
  Role,
  TaskState as A2aTaskState,
  type Artifact,
  type Message,
  type Part,
  type TaskArtifactUpdateEvent,
  type TaskState,
  type TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import type { StateAction } from '@microsoft/agent-host-protocol';

import type { TaskRecord } from '../projection/task-projector.js';

export type ProjectionEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

export function isTerminalTaskState(state: TaskState): boolean {
  return state === A2aTaskState.TASK_STATE_COMPLETED ||
    state === A2aTaskState.TASK_STATE_FAILED ||
    state === A2aTaskState.TASK_STATE_CANCELED ||
    state === A2aTaskState.TASK_STATE_REJECTED;
}

export function isInterruptedTaskState(state: TaskState): boolean {
  return state === A2aTaskState.TASK_STATE_INPUT_REQUIRED ||
    state === A2aTaskState.TASK_STATE_AUTH_REQUIRED;
}

export function toStatusEvent(record: TaskRecord, metadata?: Record<string, unknown>): TaskStatusUpdateEvent {
  return {
    taskId: record.task.id,
    contextId: record.task.contextId,
    status: record.task.status ? { ...record.task.status } : undefined,
    metadata,
  };
}

export function toArtifactEvent(
  record: TaskRecord,
  artifact: Artifact,
  append = true,
  metadata?: Record<string, unknown>,
): TaskArtifactUpdateEvent {
  return {
    taskId: record.task.id,
    contextId: record.task.contextId,
    artifact,
    append,
    lastChunk: false,
    metadata,
  };
}

export function assistantMessageFor(record: TaskRecord): Message {
  const existing = record.task.history.find(
    message => message.role === Role.ROLE_AGENT && message.messageId === record.currentAssistantMessageId,
  );
  if (existing) return existing;

  const message: Message = {
    role: Role.ROLE_AGENT,
    messageId: record.currentAssistantMessageId,
    taskId: record.task.id,
    contextId: record.task.contextId,
    parts: [textPart('')],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
  record.task.history = [...record.task.history, message];
  return message;
}

export function textPart(text: string): Part {
  return {
    content: { $case: 'text', value: text },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  };
}

export function errorMessageFromAction(action: StateAction): string {
  const error = (action as { error?: { message?: string } }).error;
  return error?.message ?? 'AHP turn failed';
}

export function errorMessageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
