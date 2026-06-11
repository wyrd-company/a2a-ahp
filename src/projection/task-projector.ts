import type {
  Artifact,
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatus,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import type { StateAction, URI } from '@microsoft/agent-host-protocol';
import { randomUUID } from 'node:crypto';

import {
  assistantMessageFor,
  errorMessageFromAction,
  isTerminalTaskState,
  toArtifactEvent,
  toStatusEvent,
  type ProjectionEvent,
} from '../mappers/ahp-to-a2a.js';

export interface TaskCorrelation {
  readonly taskId: string;
  readonly contextId: string;
  readonly sessionUri: URI;
  activeTurnId?: string;
}

export interface TaskRecord {
  readonly correlation: TaskCorrelation;
  readonly task: Task;
  currentAssistantMessageId: string;
}

export interface CreateTaskOptions {
  readonly taskId?: string;
  readonly contextId?: string;
  readonly sessionUri?: URI;
  readonly userMessage?: Message;
}

export interface StatusUpdateInput {
  readonly sessionUri: URI;
  readonly turnId?: string;
  readonly state?: TaskState;
  readonly text?: string;
  readonly activity?: string;
}

export interface ArtifactInput {
  readonly sessionUri: URI;
  readonly turnId?: string;
  readonly artifactId?: string;
  readonly name?: string;
  readonly description?: string;
  readonly text?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface InputRequestInput {
  readonly sessionUri: URI;
  readonly turnId?: string;
  readonly prompt: string;
}

export class TaskProjector {
  private readonly byTaskId = new Map<string, TaskRecord>();
  private readonly byContextId = new Map<string, TaskRecord>();
  private readonly bySessionUri = new Map<URI, TaskRecord>();

  ensureTask(options: CreateTaskOptions): TaskRecord {
    const existing = this.find(options);
    if (existing) {
      if (options.userMessage) this.addUserMessage(existing, options.userMessage);
      return existing;
    }

    const taskId = options.taskId ?? randomUUID();
    const contextId = options.contextId ?? options.userMessage?.contextId ?? randomUUID();
    const sessionUri = options.sessionUri ?? sessionUriForTask(taskId);
    const record: TaskRecord = {
      correlation: { taskId, contextId, sessionUri },
      currentAssistantMessageId: randomUUID(),
      task: {
        kind: 'task',
        id: taskId,
        contextId,
        status: this.status('submitted'),
        history: [],
        artifacts: [],
      },
    };

    if (options.userMessage) this.addUserMessage(record, options.userMessage);
    this.index(record);
    return record;
  }

  getByTaskId(taskId: string): TaskRecord | undefined {
    return this.byTaskId.get(taskId);
  }

  getBySessionUri(sessionUri: URI): TaskRecord | undefined {
    return this.bySessionUri.get(sessionUri);
  }

  projectAction(sessionUri: URI, action: StateAction): ProjectionEvent[] {
    const record = this.bySessionUri.get(sessionUri);
    if (!record) return [];

    switch (action.type) {
      case 'session/turnStarted':
        record.correlation.activeTurnId = (action as { turnId: string }).turnId;
        this.setStatus(record, 'working');
        return [toStatusEvent(record)];

      case 'session/responsePart':
        record.currentAssistantMessageId = record.currentAssistantMessageId || randomUUID();
        assistantMessageFor(record);
        this.setStatus(record, 'working');
        return [toStatusEvent(record)];

      case 'session/delta': {
        const delta = action as { content?: string };
        const message = assistantMessageFor(record);
        appendText(message, delta.content ?? '');
        this.setStatus(record, 'working', message);
        return [toStatusEvent(record)];
      }

      case 'session/inputRequested':
        this.setStatus(record, 'input-required');
        return [toStatusEvent(record)];

      case 'session/turnComplete':
        this.setStatus(record, 'completed', assistantMessageFor(record));
        record.correlation.activeTurnId = undefined;
        return [toStatusEvent(record, true)];

      case 'session/turnCancelled':
        this.setStatus(record, 'canceled');
        record.correlation.activeTurnId = undefined;
        return [toStatusEvent(record, true)];

      case 'session/error':
        this.setStatus(record, 'failed', makeAgentMessage(record, errorMessageFromAction(action)));
        record.correlation.activeTurnId = undefined;
        return [toStatusEvent(record, true)];

      default:
        return [];
    }
  }

  updateStatus(input: StatusUpdateInput): TaskStatusUpdateEvent {
    const record = this.requireBySessionUri(input.sessionUri);
    if (input.turnId) record.correlation.activeTurnId = input.turnId;
    const state = input.state ?? record.task.status.state;
    const message = input.text ? makeAgentMessage(record, input.text) : record.task.status.message;
    this.setStatus(record, state, message, input.activity);
    return toStatusEvent(record, isTerminalTaskState(state));
  }

  requestInput(input: InputRequestInput): TaskStatusUpdateEvent {
    const record = this.requireBySessionUri(input.sessionUri);
    if (input.turnId) record.correlation.activeTurnId = input.turnId;
    this.setStatus(record, 'input-required', makeAgentMessage(record, input.prompt));
    return toStatusEvent(record);
  }

  publishArtifact(input: ArtifactInput): TaskArtifactUpdateEvent {
    const record = this.requireBySessionUri(input.sessionUri);
    if (input.turnId) record.correlation.activeTurnId = input.turnId;
    const artifact: Artifact = {
      artifactId: input.artifactId ?? randomUUID(),
      ...(input.name ? { name: input.name } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      parts: [{ kind: 'text', text: input.text ?? '' }],
    };
    record.task.artifacts = upsertArtifact(record.task.artifacts ?? [], artifact);
    return toArtifactEvent(record, artifact);
  }

  taskWithHistoryLimit(record: TaskRecord, historyLength?: number): Task {
    if (historyLength === undefined || historyLength < 0 || !record.task.history) return cloneTask(record.task);
    return {
      ...cloneTask(record.task),
      history: record.task.history.slice(-historyLength),
    };
  }

  private find(options: CreateTaskOptions): TaskRecord | undefined {
    if (options.taskId) {
      const byTask = this.byTaskId.get(options.taskId);
      if (byTask) return byTask;
    }
    if (options.contextId) {
      const byContext = this.byContextId.get(options.contextId);
      if (byContext) return byContext;
    }
    if (options.sessionUri) return this.bySessionUri.get(options.sessionUri);
    return undefined;
  }

  private index(record: TaskRecord): void {
    this.byTaskId.set(record.task.id, record);
    this.byContextId.set(record.task.contextId, record);
    this.bySessionUri.set(record.correlation.sessionUri, record);
  }

  private addUserMessage(record: TaskRecord, message: Message): void {
    if (record.task.history?.some(existing => existing.messageId === message.messageId)) return;
    const normalized: Message = {
      ...message,
      taskId: record.task.id,
      contextId: record.task.contextId,
    };
    record.task.history = [...(record.task.history ?? []), normalized];
  }

  private setStatus(record: TaskRecord, state: TaskState, message?: Message, activity?: string): void {
    record.task.status = this.status(state, message, activity);
  }

  private status(state: TaskState, message?: Message, activity?: string): TaskStatus {
    return {
      state,
      timestamp: new Date().toISOString(),
      ...(message ? { message } : {}),
      ...(activity ? { metadata: { activity } } : {}),
    } as TaskStatus;
  }

  private requireBySessionUri(sessionUri: URI): TaskRecord {
    const record = this.bySessionUri.get(sessionUri);
    if (!record) throw new Error(`No A2A task is correlated with AHP session ${sessionUri}`);
    return record;
  }
}

export function sessionUriForTask(taskId: string): URI {
  return `ahp-session:/a2a/${encodeURIComponent(taskId)}`;
}

function appendText(message: Message, text: string): void {
  const firstText = message.parts.find(part => part.kind === 'text');
  if (firstText?.kind === 'text') {
    firstText.text += text;
    return;
  }
  message.parts.push({ kind: 'text', text });
}

function makeAgentMessage(record: TaskRecord, text: string): Message {
  const message = assistantMessageFor(record);
  const firstText = message.parts.find(part => part.kind === 'text');
  if (firstText?.kind === 'text') {
    firstText.text = text;
  } else {
    message.parts = [{ kind: 'text', text }];
  }
  return message;
}

function upsertArtifact(artifacts: Artifact[], next: Artifact): Artifact[] {
  const index = artifacts.findIndex(artifact => artifact.artifactId === next.artifactId);
  if (index < 0) return [...artifacts, next];
  const copy = [...artifacts];
  copy[index] = next;
  return copy;
}

function cloneTask(task: Task): Task {
  return JSON.parse(JSON.stringify(task)) as Task;
}
