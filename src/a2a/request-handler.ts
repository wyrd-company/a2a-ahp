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
import { ToolResultContentType, type ModelSelection, type StateAction, type ToolCallResult } from '@microsoft/agent-host-protocol';
import { a2aMessageToAhpMessage } from '../mappers/a2a-to-ahp.js';
import { isTerminalTaskState } from '../mappers/ahp-to-a2a.js';
import {
  StatusToolService,
  type PostStatusInput,
  type PublishArtifactInput,
  type RequestInputInput,
  type SetActivityInput,
} from '../mcp/status-server.js';
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
  private readonly activeToolCalls = new Map<string, StatusToolName>();

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
      await this.projectRuntimeEvent(event);
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
      for (const projected of await this.projectRuntimeEvent(event)) {
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
      for (const projected of await this.projectRuntimeEvent(event)) {
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

  private async projectRuntimeEvent(event: AhpRuntimeEvent): Promise<Array<TaskStatusUpdateEvent | TaskArtifactUpdateEvent>> {
    if (event.type !== 'action') return [];
    this.rememberStatusToolCall(event.sessionUri, event.action);
    const toolResult = await this.executeStatusToolCall(event.sessionUri, event.action);
    if (toolResult) {
      this.runtime.completeToolCall(event.sessionUri, toolResult.turnId, toolResult.toolCallId, toolResult.result);
      return toolResult.events;
    }
    return this.projector.projectAction(event.sessionUri, event.action);
  }

  private async executeStatusToolCall(
    sessionUri: string,
    action: StateAction,
  ): Promise<{
    readonly turnId: string;
    readonly toolCallId: string;
    readonly result: ToolCallResult;
    readonly events: Array<TaskStatusUpdateEvent | TaskArtifactUpdateEvent>;
  } | undefined> {
    const readyAction = action as unknown;
    if (!isToolCallReadyAction(readyAction)) return undefined;
    const toolName = this.activeToolCalls.get(toolCallKey(sessionUri, readyAction.toolCallId));
    if (!toolName) return undefined;

    const input = parseToolInput(readyAction.toolInput);
    const events: Array<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
    const service = new StatusToolService({
      projector: this.projector,
      contextResolver: {
        resolve: () => ({
          sessionUri,
          turnId: readyAction.turnId,
          toolCallId: readyAction.toolCallId,
        }),
      },
    });

    try {
      switch (toolName) {
        case 'post_status':
          events.push(await service.postStatus(input as PostStatusInput));
          break;
        case 'request_input':
          events.push(await service.requestInput(input as RequestInputInput));
          break;
        case 'publish_artifact':
          events.push(await service.publishArtifact(input as PublishArtifactInput));
          break;
        case 'set_activity':
          events.push(await service.setActivity(input as SetActivityInput));
          break;
      }
      this.activeToolCalls.delete(toolCallKey(sessionUri, readyAction.toolCallId));
      return {
        turnId: readyAction.turnId,
        toolCallId: readyAction.toolCallId,
        events,
        result: {
          success: true,
          pastTenseMessage: `Handled ${toolName}`,
          content: [{ type: ToolResultContentType.Text, text: JSON.stringify(events[0] ?? { ok: true }) }],
        },
      };
    } catch (error) {
      this.activeToolCalls.delete(toolCallKey(sessionUri, readyAction.toolCallId));
      return {
        turnId: readyAction.turnId,
        toolCallId: readyAction.toolCallId,
        events,
        result: {
          success: false,
          pastTenseMessage: `Failed to handle ${toolName}`,
          error: { message: error instanceof Error ? error.message : 'Status tool failed' },
        },
      };
    }
  }

  private rememberStatusToolCall(sessionUri: string, action: StateAction): void {
    const startAction = action as unknown;
    if (!isToolCallStartAction(startAction) || !isStatusToolName(startAction.toolName)) return;
    this.activeToolCalls.set(toolCallKey(sessionUri, startAction.toolCallId), startAction.toolName);
  }
}

type StatusToolName = 'post_status' | 'request_input' | 'publish_artifact' | 'set_activity';

interface ToolCallReadyActionLike {
  readonly type: 'session/toolCallReady';
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolInput?: string;
}

interface ToolCallStartActionLike {
  readonly type: 'session/toolCallStart';
  readonly toolCallId: string;
  readonly toolName: string;
}

function isToolCallReadyAction(action: unknown): action is ToolCallReadyActionLike {
  return isRecord(action) &&
    action.type === 'session/toolCallReady' &&
    typeof action.turnId === 'string' &&
    typeof action.toolCallId === 'string';
}

function isToolCallStartAction(action: unknown): action is ToolCallStartActionLike {
  return isRecord(action) &&
    action.type === 'session/toolCallStart' &&
    typeof action.toolName === 'string' &&
    typeof action.toolCallId === 'string';
}

function isStatusToolName(value: string): value is StatusToolName {
  return value === 'post_status' ||
    value === 'request_input' ||
    value === 'publish_artifact' ||
    value === 'set_activity';
}

function parseToolInput(input: string | undefined): unknown {
  if (!input) return {};
  return JSON.parse(input);
}

function toolCallKey(sessionUri: string, toolCallId: string): string {
  return `${sessionUri}\u0000${toolCallId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
