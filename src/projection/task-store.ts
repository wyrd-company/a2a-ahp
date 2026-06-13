import type { URI } from '@microsoft/agent-host-protocol';

import type { TaskRecord } from './task-projector.js';

export interface A2aTaskStore {
  getByTaskId(taskId: string): Promise<TaskRecord | undefined>;
  getByContextId(contextId: string): Promise<TaskRecord | undefined>;
  getBySessionUri(sessionUri: URI): Promise<TaskRecord | undefined>;
  save(record: TaskRecord): Promise<void>;
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
