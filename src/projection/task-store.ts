import type { URI } from '@microsoft/agent-host-protocol';

import type { TaskRecord } from './task-projector.js';

export interface A2aTaskStore {
  getByTaskId(taskId: string): Promise<TaskRecord | undefined>;
  getByContextId(contextId: string): Promise<TaskRecord | undefined>;
  getBySessionUri(sessionUri: URI): Promise<TaskRecord | undefined>;
  list(options?: A2aTaskStoreListOptions): Promise<TaskRecord[]>;
  save(record: TaskRecord): Promise<void>;
}

export interface A2aTaskStoreListOptions {
  readonly terminal?: boolean;
  readonly provider?: string;
  readonly updatedBefore?: string;
  readonly updatedAfter?: string;
}

export class InMemoryA2aTaskStore implements A2aTaskStore {
  private readonly byTaskId = new Map<string, TaskRecord>();
  private readonly byContextId = new Map<string, string>();
  private readonly bySessionUri = new Map<URI, string>();

  constructor(records: TaskRecord[] = []) {
    for (const record of records) {
      this.saveSync(record);
    }
  }

  async getByTaskId(taskId: string): Promise<TaskRecord | undefined> {
    return cloneRecord(this.byTaskId.get(taskId));
  }

  async getByContextId(contextId: string): Promise<TaskRecord | undefined> {
    const taskId = this.byContextId.get(contextId);
    return taskId ? cloneRecord(this.byTaskId.get(taskId)) : undefined;
  }

  async getBySessionUri(sessionUri: URI): Promise<TaskRecord | undefined> {
    const taskId = this.bySessionUri.get(sessionUri);
    return taskId ? cloneRecord(this.byTaskId.get(taskId)) : undefined;
  }

  async list(options: A2aTaskStoreListOptions = {}): Promise<TaskRecord[]> {
    return [...this.byTaskId.values()]
      .filter(record => options.terminal === undefined || record.metadata.terminal === options.terminal)
      .filter(record => options.provider === undefined || record.route?.provider === options.provider)
      .filter(record => options.updatedBefore === undefined || record.metadata.updatedAt < options.updatedBefore)
      .filter(record => options.updatedAfter === undefined || record.metadata.updatedAt > options.updatedAfter)
      .map(record => cloneRecord(record));
  }

  async save(record: TaskRecord): Promise<void> {
    this.saveSync(record);
  }

  private saveSync(record: TaskRecord): void {
    const snapshot = cloneRecord(record);
    this.byTaskId.set(snapshot.task.id, snapshot);
    this.byContextId.set(snapshot.task.contextId, snapshot.task.id);
    this.bySessionUri.set(snapshot.correlation.sessionUri, snapshot.task.id);
  }
}

function cloneRecord(record: TaskRecord): TaskRecord;
function cloneRecord(record: TaskRecord | undefined): TaskRecord | undefined;
function cloneRecord(record: TaskRecord | undefined): TaskRecord | undefined {
  return record ? JSON.parse(JSON.stringify(record)) as TaskRecord : undefined;
}
