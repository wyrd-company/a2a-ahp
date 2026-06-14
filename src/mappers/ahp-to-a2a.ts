import type {
  Artifact,
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import type { StateAction } from '@microsoft/agent-host-protocol';

import type { TaskRecord } from '../projection/task-projector.js';

export type ProjectionEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

export function isTerminalTaskState(state: TaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'rejected';
}

export function toStatusEvent(record: TaskRecord, final = false): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId: record.task.id,
    contextId: record.task.contextId,
    status: { ...record.task.status },
    final,
  };
}

export function toArtifactEvent(record: TaskRecord, artifact: Artifact, append = true): TaskArtifactUpdateEvent {
  return {
    kind: 'artifact-update',
    taskId: record.task.id,
    contextId: record.task.contextId,
    artifact,
    append,
    lastChunk: false,
  };
}

export function assistantMessageFor(record: TaskRecord): Message {
  const existing = record.task.history?.find(
    message => message.role === 'agent' && message.messageId === record.currentAssistantMessageId,
  );
  if (existing) return existing;

  const message: Message = {
    kind: 'message',
    role: 'agent',
    messageId: record.currentAssistantMessageId,
    taskId: record.task.id,
    contextId: record.task.contextId,
    parts: [{ kind: 'text', text: '' }],
  };
  record.task.history = [...(record.task.history ?? []), message];
  return message;
}

export function errorMessageFromAction(action: StateAction): string {
  const error = (action as { error?: { message?: string } }).error;
  return error?.message ?? 'AHP turn failed';
}

export function errorMessageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
