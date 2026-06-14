import type { TaskStatusUpdateEvent } from '@a2a-js/sdk';

import type { AhpRuntime, AhpRuntimeEvent, AhpSessionSubscription } from '../ahp/runtime.js';
import { errorMessageFromUnknown, isTerminalTaskState } from '../mappers/ahp-to-a2a.js';
import type { A2aTaskStore } from '../projection/task-store.js';
import { TaskProjector, type TaskRecord } from '../projection/task-projector.js';
import { A2aAhpRequestHandler } from './request-handler.js';

export type A2aResumePolicy = 'non-terminal' | 'all';

export interface ResumeA2aAhpTasksOptions {
  readonly runtime: AhpRuntime;
  readonly taskStore: A2aTaskStore;
  readonly policy?: A2aResumePolicy | ResumeTaskPredicate;
  readonly projector?: TaskProjector;
  readonly requestHandler?: A2aAhpRequestHandler;
  readonly onTaskResumed?: (result: A2aTaskResumeResult) => void | Promise<void>;
  readonly onTaskResumeFailed?: (result: A2aTaskResumeFailure) => void | Promise<void>;
  readonly projectRuntimeEvent?: (event: AhpRuntimeEvent) => Promise<void> | void;
}

export type ResumeTaskPredicate = (record: TaskRecord) => boolean;

export interface A2aTaskResumeResult {
  readonly record: TaskRecord;
  readonly subscription: AhpSessionSubscription;
}

export interface A2aTaskResumeFailure {
  readonly record: TaskRecord;
  readonly error: unknown;
  readonly event: TaskStatusUpdateEvent;
}

export interface ResumeA2aAhpTasksResult {
  readonly resumed: A2aTaskResumeResult[];
  readonly failed: A2aTaskResumeFailure[];
}

export async function resumeA2aAhpTasks(options: ResumeA2aAhpTasksOptions): Promise<ResumeA2aAhpTasksResult> {
  await options.runtime.start();
  const projector = options.projector ?? new TaskProjector({ store: options.taskStore });
  const requestHandler = options.requestHandler ?? new A2aAhpRequestHandler({
    runtime: options.runtime,
    projector,
  });
  const projectRuntimeEvent = options.projectRuntimeEvent ??
    (async (event: AhpRuntimeEvent) => {
      await requestHandler.handleRuntimeEvent(event);
    });
  const records = await options.taskStore.list(listOptionsForPolicy(options.policy));
  const resumed: A2aTaskResumeResult[] = [];
  const failed: A2aTaskResumeFailure[] = [];

  for (const stored of records) {
    const record = projector.importRecord(stored);
    if (!shouldResume(record, options.policy)) continue;

    try {
      const subscription = await options.runtime.resumeSession({
        sessionUri: record.correlation.sessionUri,
        contextId: record.correlation.contextId,
        provider: record.route?.provider,
        model: record.route?.model,
      });
      const result = { record, subscription };
      resumed.push(result);
      void drainSubscription(subscription, projectRuntimeEvent);
      await options.onTaskResumed?.(result);
    } catch (error) {
      const event = projector.updateStatus({
        sessionUri: record.correlation.sessionUri,
        state: 'failed',
        text: `A2A task resume failed: ${errorMessageFromUnknown(error)}`,
      });
      await projector.save(record);
      const failure = { record, error, event };
      failed.push(failure);
      await options.onTaskResumeFailed?.(failure);
    }
  }

  return { resumed, failed };
}

function listOptionsForPolicy(policy: A2aResumePolicy | ResumeTaskPredicate | undefined): { terminal?: boolean } | undefined {
  return policy === 'all' || typeof policy === 'function' ? undefined : { terminal: false };
}

function shouldResume(record: TaskRecord, policy: A2aResumePolicy | ResumeTaskPredicate | undefined): boolean {
  if (typeof policy === 'function') return policy(record);
  if (policy === 'all') return true;
  return !isTerminalTaskState(record.task.status.state);
}

async function drainSubscription(
  subscription: AhpSessionSubscription,
  projectRuntimeEvent: ((event: AhpRuntimeEvent) => Promise<void> | void) | undefined,
): Promise<void> {
  if (!projectRuntimeEvent) return;
  try {
    for await (const event of subscription.events) {
      await projectRuntimeEvent(event);
    }
  } catch {
    // Resume failures are surfaced during subscription creation. Stream-level
    // failures will be represented by AHP actions when the runtime can emit them.
  }
}
