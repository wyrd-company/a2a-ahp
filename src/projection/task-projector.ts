import type {
  Artifact,
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatus,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import type { ModelSelection, StateAction, URI } from '@microsoft/agent-host-protocol';
import { randomUUID } from 'node:crypto';

import {
  assistantMessageFor,
  errorMessageFromAction,
  isTerminalTaskState,
  toArtifactEvent,
  toStatusEvent,
  type ProjectionEvent,
} from '../mappers/ahp-to-a2a.js';
import type { A2aTaskStore } from './task-store.js';

export interface TaskCorrelation {
  readonly taskId: string;
  readonly contextId: string;
  readonly sessionUri: URI;
  activeTurnId?: string;
}

export interface TaskRoute {
  readonly provider: string;
  readonly model?: ModelSelection;
}

export interface TaskRecordMetadata {
  readonly createdAt: string;
  updatedAt: string;
  sequence: number;
  terminal: boolean;
}

export interface StoredProjectionEvent {
  readonly sequence: number;
  readonly timestamp: string;
  readonly event: ProjectionEvent;
}

export interface TaskRecord {
  readonly correlation: TaskCorrelation;
  readonly task: Task;
  readonly route?: TaskRoute;
  metadata: TaskRecordMetadata;
  streamEvents: StoredProjectionEvent[];
  currentAssistantMessageId: string;
}

export interface CreateTaskOptions {
  readonly taskId?: string;
  readonly contextId?: string;
  readonly sessionUri?: URI;
  readonly userMessage?: Message;
  readonly route?: TaskRoute;
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

export interface TaskProjectorOptions {
  readonly store?: A2aTaskStore;
  readonly records?: TaskRecord[];
  readonly streamHistoryLimit?: number;
}

export class TaskProjector {
  private readonly byTaskId = new Map<string, TaskRecord>();
  private readonly byContextId = new Map<string, TaskRecord>();
  private readonly bySessionUri = new Map<URI, TaskRecord>();
  private readonly store?: A2aTaskStore;
  private readonly streamHistoryLimit: number;

  constructor(options: TaskProjectorOptions = {}) {
    this.store = options.store;
    this.streamHistoryLimit = options.streamHistoryLimit ?? 100;
    for (const record of options.records ?? []) {
      this.importRecord(record);
    }
  }

  ensureTask(options: CreateTaskOptions): TaskRecord {
    const existing = this.find(options);
    if (existing) {
      if (options.userMessage) this.addUserMessage(existing, options.userMessage);
      this.touch(existing);
      return existing;
    }

    const taskId = options.taskId ?? randomUUID();
    const contextId = options.contextId ?? options.userMessage?.contextId ?? randomUUID();
    const sessionUri = options.sessionUri ?? sessionUriForTask(taskId);
    const now = new Date().toISOString();
    const record: TaskRecord = {
      correlation: { taskId, contextId, sessionUri },
      ...(options.route ? { route: options.route } : {}),
      metadata: {
        createdAt: now,
        updatedAt: now,
        sequence: 0,
        terminal: false,
      },
      streamEvents: [],
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

  importRecord(record: TaskRecord): TaskRecord {
    const snapshot = cloneRecord(record);
    snapshot.streamEvents = snapshot.streamEvents ?? [];
    snapshot.metadata = snapshot.metadata ?? {
      createdAt: snapshot.task.status.timestamp ?? new Date().toISOString(),
      updatedAt: snapshot.task.status.timestamp ?? new Date().toISOString(),
      sequence: 0,
      terminal: isTerminalTaskState(snapshot.task.status.state),
    };
    this.index(snapshot);
    return snapshot;
  }

  getByTaskId(taskId: string): TaskRecord | undefined {
    return this.byTaskId.get(taskId);
  }

  getByContextId(contextId: string): TaskRecord | undefined {
    return this.byContextId.get(contextId);
  }

  getBySessionUri(sessionUri: URI): TaskRecord | undefined {
    return this.bySessionUri.get(sessionUri);
  }

  async loadByTaskId(taskId: string): Promise<TaskRecord | undefined> {
    return this.byTaskId.get(taskId) ?? this.loadRecord(await this.store?.getByTaskId(taskId));
  }

  async loadByContextId(contextId: string): Promise<TaskRecord | undefined> {
    return this.byContextId.get(contextId) ?? this.loadRecord(await this.store?.getByContextId(contextId));
  }

  async loadBySessionUri(sessionUri: URI): Promise<TaskRecord | undefined> {
    return this.bySessionUri.get(sessionUri) ?? this.loadRecord(await this.store?.getBySessionUri(sessionUri));
  }

  async save(record: TaskRecord): Promise<void> {
    await this.store?.save(cloneRecord(record));
  }

  projectAction(sessionUri: URI, action: StateAction): ProjectionEvent[] {
    const record = this.bySessionUri.get(sessionUri);
    if (!record) return [];

    let events: ProjectionEvent[] = [];
    switch (action.type) {
      case 'session/turnStarted':
        record.correlation.activeTurnId = (action as { turnId: string }).turnId;
        record.currentAssistantMessageId = randomUUID();
        this.setStatus(record, 'working');
        events = [toStatusEvent(record)];
        break;

      case 'session/responsePart':
        record.currentAssistantMessageId = record.currentAssistantMessageId || randomUUID();
        assistantMessageFor(record);
        this.setStatus(record, 'working');
        events = [toStatusEvent(record)];
        break;

      case 'session/delta': {
        const delta = action as { content?: string };
        const message = assistantMessageFor(record);
        appendText(message, delta.content ?? '');
        this.setStatus(record, 'working', message);
        events = [toStatusEvent(record)];
        break;
      }

      case 'session/inputRequested':
        this.setStatus(record, 'input-required');
        events = [toStatusEvent(record)];
        break;

      case 'session/turnComplete':
        this.setStatus(record, 'completed', assistantMessageFor(record));
        record.correlation.activeTurnId = undefined;
        events = [toStatusEvent(record, true)];
        break;

      case 'session/turnCancelled':
        this.setStatus(record, 'canceled');
        record.correlation.activeTurnId = undefined;
        events = [toStatusEvent(record, true)];
        break;

      case 'session/error':
        this.setStatus(record, 'failed', makeAgentMessage(record, errorMessageFromAction(action)));
        record.correlation.activeTurnId = undefined;
        events = [toStatusEvent(record, true)];
        break;

      default:
        return [];
    }

    this.recordEvents(record, events);
    return events;
  }

  updateStatus(input: StatusUpdateInput): TaskStatusUpdateEvent {
    const record = this.requireBySessionUri(input.sessionUri);
    if (input.turnId) record.correlation.activeTurnId = input.turnId;
    const state = input.state ?? record.task.status.state;
    const message = input.text ? makeAgentMessage(record, input.text) : record.task.status.message;
    this.setStatus(record, state, message, input.activity);
    const event = toStatusEvent(record, isTerminalTaskState(state));
    this.recordEvents(record, [event]);
    return event;
  }

  requestInput(input: InputRequestInput): TaskStatusUpdateEvent {
    const record = this.requireBySessionUri(input.sessionUri);
    if (input.turnId) record.correlation.activeTurnId = input.turnId;
    this.setStatus(record, 'input-required', makeAgentMessage(record, input.prompt));
    const event = toStatusEvent(record);
    this.recordEvents(record, [event]);
    return event;
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
    this.touch(record);
    const event = toArtifactEvent(record, artifact);
    this.recordEvents(record, [event]);
    return event;
  }

  taskWithHistoryLimit(record: TaskRecord, historyLength?: number): Task {
    if (historyLength === undefined || historyLength < 0 || !record.task.history) return cloneTask(record.task);
    return {
      ...cloneTask(record.task),
      history: record.task.history.slice(-historyLength),
    };
  }

  replayableStreamEvents(record: TaskRecord): ProjectionEvent[] {
    return cloneEvents(record.streamEvents.map(entry => entry.event));
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

  private loadRecord(record: TaskRecord | undefined): TaskRecord | undefined {
    return record ? this.importRecord(record) : undefined;
  }

  private addUserMessage(record: TaskRecord, message: Message): void {
    if (record.task.history?.some(existing => existing.messageId === message.messageId)) return;
    const normalized: Message = {
      ...message,
      taskId: record.task.id,
      contextId: record.task.contextId,
    };
    record.task.history = [...(record.task.history ?? []), normalized];
    this.touch(record);
  }

  private setStatus(record: TaskRecord, state: TaskState, message?: Message, activity?: string): void {
    record.task.status = this.status(state, message, activity);
    this.touch(record);
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

  private recordEvents(record: TaskRecord, events: ProjectionEvent[]): void {
    if (events.length === 0) return;
    const timestamp = new Date().toISOString();
    const entries = cloneEvents(events).map((event, index) => ({
      sequence: record.metadata.sequence + index,
      timestamp,
      event,
    }));
    record.streamEvents = [...record.streamEvents, ...entries].slice(-this.streamHistoryLimit);
  }

  private touch(record: TaskRecord): void {
    record.metadata.sequence += 1;
    record.metadata.updatedAt = new Date().toISOString();
    record.metadata.terminal = isTerminalTaskState(record.task.status.state);
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

function cloneRecord(record: TaskRecord): TaskRecord {
  return JSON.parse(JSON.stringify(record)) as TaskRecord;
}

function cloneEvents(events: ProjectionEvent[]): ProjectionEvent[] {
  return JSON.parse(JSON.stringify(events)) as ProjectionEvent[];
}
