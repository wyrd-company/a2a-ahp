import type {
  AgentCard,
  DeleteTaskPushNotificationConfigParams,
  GetTaskPushNotificationConfigParams,
  ListTaskPushNotificationConfigParams,
  Message,
  MessageSendParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskIdParams,
  TaskPushNotificationConfig,
  TaskQueryParams,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import type { A2ARequestHandler, ServerCallContext } from '@a2a-js/sdk/server';
import { A2AError } from '@a2a-js/sdk/server';
import { randomUUID } from 'node:crypto';

import type { AhpRuntime, AhpRuntimeEvent } from '../ahp/runtime.js';
import type { ModelSelection } from '@microsoft/agent-host-protocol';
import { a2aMessageToAhpMessage } from '../mappers/a2a-to-ahp.js';
import { isTerminalTaskState } from '../mappers/ahp-to-a2a.js';
import { sessionUriForTask, TaskProjector, type TaskRecord } from '../projection/task-projector.js';

export interface AhpSessionRoute {
  readonly provider: string;
  readonly model?: ModelSelection;
}

export interface A2aAhpRequestHandlerOptions {
  readonly runtime: AhpRuntime;
  readonly projector?: TaskProjector;
  readonly agentCard?: Partial<AgentCard>;
  readonly route?: AhpSessionRoute;
}

export class A2aAhpRequestHandler implements A2ARequestHandler {
  readonly projector: TaskProjector;
  private readonly runtime: AhpRuntime;
  private readonly agentCard: AgentCard;
  private readonly route?: AhpSessionRoute;

  constructor(options: A2aAhpRequestHandlerOptions) {
    this.runtime = options.runtime;
    this.projector = options.projector ?? new TaskProjector();
    this.agentCard = createAgentCard(options.agentCard);
    this.route = options.route;
  }

  async getAgentCard(): Promise<AgentCard> {
    return this.agentCard;
  }

  async getAuthenticatedExtendedAgentCard(_context?: ServerCallContext): Promise<AgentCard> {
    return this.agentCard;
  }

  async sendMessage(params: MessageSendParams, _context?: ServerCallContext): Promise<Message | Task> {
    const { record, subscription } = await this.setupTurn(params);
    if (!params.configuration?.blocking) {
      return this.projector.taskWithHistoryLimit(record, params.configuration?.historyLength);
    }

    for await (const event of subscription.events) {
      this.projectRuntimeEvent(event);
      if (record.task.status.state === 'completed') {
        return record.task.status.message ?? this.projector.taskWithHistoryLimit(record, params.configuration?.historyLength);
      }
      if (isTerminalTaskState(record.task.status.state)) {
        return this.projector.taskWithHistoryLimit(record, params.configuration?.historyLength);
      }
    }

    return this.projector.taskWithHistoryLimit(record, params.configuration?.historyLength);
  }

  async *sendMessageStream(
    params: MessageSendParams,
    _context?: ServerCallContext,
  ): AsyncGenerator<Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent, void, undefined> {
    const { record, subscription } = await this.setupTurn(params);
    yield this.projector.taskWithHistoryLimit(record, params.configuration?.historyLength);

    for await (const event of subscription.events) {
      for (const projected of this.projectRuntimeEvent(event)) {
        yield projected;
        if (projected.kind === 'status-update' && projected.final) return;
      }
    }
  }

  async getTask(params: TaskQueryParams, _context?: ServerCallContext): Promise<Task> {
    const record = this.projector.getByTaskId(params.id);
    if (!record) throw A2AError.taskNotFound(params.id);
    return this.projector.taskWithHistoryLimit(record, params.historyLength);
  }

  async cancelTask(params: TaskIdParams, _context?: ServerCallContext): Promise<Task> {
    const record = this.projector.getByTaskId(params.id);
    if (!record) throw A2AError.taskNotFound(params.id);
    const turnId = record.correlation.activeTurnId;
    if (!turnId || isTerminalTaskState(record.task.status.state)) throw A2AError.taskNotCancelable(params.id);
    this.runtime.cancelTurn(record.correlation.sessionUri, turnId);
    this.projector.projectAction(record.correlation.sessionUri, {
      type: 'session/turnCancelled',
      turnId,
    } as never);
    return this.projector.taskWithHistoryLimit(record);
  }

  async setTaskPushNotificationConfig(
    _params: TaskPushNotificationConfig,
    _context?: ServerCallContext,
  ): Promise<TaskPushNotificationConfig> {
    throw A2AError.pushNotificationNotSupported();
  }

  async getTaskPushNotificationConfig(
    _params: TaskIdParams | GetTaskPushNotificationConfigParams,
    _context?: ServerCallContext,
  ): Promise<TaskPushNotificationConfig> {
    throw A2AError.pushNotificationNotSupported();
  }

  async listTaskPushNotificationConfigs(
    _params: ListTaskPushNotificationConfigParams,
    _context?: ServerCallContext,
  ): Promise<TaskPushNotificationConfig[]> {
    throw A2AError.pushNotificationNotSupported();
  }

  async deleteTaskPushNotificationConfig(
    _params: DeleteTaskPushNotificationConfigParams,
    _context?: ServerCallContext,
  ): Promise<void> {
    throw A2AError.pushNotificationNotSupported();
  }

  async *resubscribe(
    params: TaskIdParams,
    _context?: ServerCallContext,
  ): AsyncGenerator<Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent, void, undefined> {
    const record = this.projector.getByTaskId(params.id);
    if (!record) throw A2AError.taskNotFound(params.id);
    yield this.projector.taskWithHistoryLimit(record);

    if (isTerminalTaskState(record.task.status.state)) return;

    const subscription = await this.runtime.subscribe(record.correlation.sessionUri);
    for await (const event of subscription.events) {
      for (const projected of this.projectRuntimeEvent(event)) {
        yield projected;
        if (projected.kind === 'status-update' && projected.final) return;
      }
    }
  }

  private async setupTurn(params: MessageSendParams): Promise<{
    record: TaskRecord;
    subscription: Awaited<ReturnType<AhpRuntime['subscribe']>>;
  }> {
    const message = params.message;
    const taskId = message.taskId ?? randomUUID();
    const contextId = message.contextId ?? randomUUID();
    const sessionUri = sessionUriForTask(taskId);
    const record = this.projector.ensureTask({ taskId, contextId, sessionUri, userMessage: message });

    await this.runtime.createSession({
      sessionUri: record.correlation.sessionUri,
      contextId: record.correlation.contextId,
      ...this.route,
    });
    const subscription = await this.runtime.subscribe(record.correlation.sessionUri);

    const turnId = randomUUID();
    record.correlation.activeTurnId = turnId;
    this.runtime.dispatchTurn({
      sessionUri: record.correlation.sessionUri,
      turnId,
      message: a2aMessageToAhpMessage(message),
    });

    return { record, subscription };
  }

  private projectRuntimeEvent(event: AhpRuntimeEvent): Array<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    if (event.type !== 'action') return [];
    return this.projector.projectAction(event.sessionUri, event.action);
  }
}

function createAgentCard(overrides: Partial<AgentCard> | undefined): AgentCard {
  return {
    protocolVersion: '0.3.0',
    name: 'A2A AHP Adapter',
    description: 'A2A server-side adapter backed by an AHP client runtime.',
    url: 'https://localhost/a2a',
    preferredTransport: 'JSONRPC',
    version: '0.1.0',
    capabilities: {
      streaming: true,
      stateTransitionHistory: true,
      pushNotifications: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'a2a-ahp-adapter',
        name: 'A2A to AHP adapter',
        description: 'Forwards A2A tasks into AHP sessions.',
        tags: ['a2a', 'ahp'],
      },
    ],
    ...overrides,
  };
}
