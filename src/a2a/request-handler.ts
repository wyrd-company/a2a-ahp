import type {
  AgentCard,
  CancelTaskRequest,
  DeleteTaskPushNotificationConfigRequest,
  GetExtendedAgentCardRequest,
  GetTaskPushNotificationConfigRequest,
  ListTaskPushNotificationConfigsRequest,
  ListTaskPushNotificationConfigsResponse,
  ListTasksRequest,
  ListTasksResponse,
  Message,
  SendMessageRequest,
  StreamResponse,
  Task,
  TaskArtifactUpdateEvent,
  TaskPushNotificationConfig,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import { TaskState } from '@a2a-js/sdk';
import type { A2ARequestHandler, ServerCallContext } from '@a2a-js/sdk/server';
import {
  PushNotificationNotSupportedError,
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
} from '@a2a-js/sdk/server';
import { randomUUID } from 'node:crypto';

import type { AhpRuntime, AhpRuntimeEvent } from '../ahp/runtime.js';
import { ToolResultContentType, type ModelSelection, type StateAction, type ToolCallResult } from '@microsoft/agent-host-protocol';
import { a2aMessageToAhpMessage, textFromA2aParts } from '../mappers/a2a-to-ahp.js';
import { isInterruptedTaskState, isTerminalTaskState } from '../mappers/ahp-to-a2a.js';
import {
  StatusToolService,
  type PostStatusInput,
  type PublishArtifactInput,
  type RequestInputInput,
  type SetActivityInput,
} from '../mcp/status-server.js';
import type { A2aTaskStore } from '../projection/task-store.js';
import { sessionUriForTask, TaskProjector, type TaskRecord } from '../projection/task-projector.js';
import {
  renderStructuredAnswer,
  structuredAnswerFromMessage,
  type StructuredAnswer,
} from '../structured-ask.js';

export interface AhpSessionRoute {
  readonly provider: string;
  readonly model?: ModelSelection;
}

export interface A2aAhpRequestHandlerOptions {
  readonly runtime: AhpRuntime;
  readonly projector?: TaskProjector;
  readonly taskStore?: A2aTaskStore;
  readonly agentCard?: Partial<AgentCard>;
  readonly route?: AhpSessionRoute;
}

export class A2aAhpRequestHandler implements A2ARequestHandler {
  readonly projector: TaskProjector;
  private readonly runtime: AhpRuntime;
  private readonly agentCard: AgentCard;
  private readonly route?: AhpSessionRoute;
  private readonly activeToolCalls = new Map<string, StatusToolName>();
  private readonly pendingInputRequests = new Map<string, PendingInputRequest>();

  constructor(options: A2aAhpRequestHandlerOptions) {
    this.runtime = options.runtime;
    this.projector = options.projector ?? new TaskProjector({ store: options.taskStore });
    this.agentCard = createAgentCard(options.agentCard);
    this.route = options.route;
  }

  async getAgentCard(): Promise<AgentCard> {
    return this.agentCard;
  }

  async getAuthenticatedExtendedAgentCard(_params: GetExtendedAgentCardRequest, _context?: ServerCallContext): Promise<AgentCard> {
    return this.agentCard;
  }

  async sendMessage(params: SendMessageRequest, _context?: ServerCallContext): Promise<Message | Task> {
    const { record, subscription } = await this.setupTurn(params);
    if (params.configuration?.returnImmediately) {
      return this.projector.taskWithHistoryLimit(record, params.configuration?.historyLength);
    }

    for await (const event of subscription.events) {
      await this.projectRuntimeEvent(event);
      if (record.task.status?.state === TaskState.TASK_STATE_COMPLETED) {
        return record.task.status.message ?? this.projector.taskWithHistoryLimit(record, params.configuration?.historyLength);
      }
      if (record.task.status && (isTerminalTaskState(record.task.status.state) || isInterruptedTaskState(record.task.status.state))) {
        return this.projector.taskWithHistoryLimit(record, params.configuration?.historyLength);
      }
    }

    return this.projector.taskWithHistoryLimit(record, params.configuration?.historyLength);
  }

  async *sendMessageStream(
    params: SendMessageRequest,
    _context?: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    const { record, subscription } = await this.setupTurn(params);
    yield streamResponse('task', this.projector.taskWithHistoryLimit(record, params.configuration?.historyLength));

    for await (const event of subscription.events) {
      for (const projected of await this.projectRuntimeEvent(event)) {
        yield streamResponseForProjection(projected);
        if (isStoppingStatusUpdate(projected)) return;
      }
    }
  }

  async getTask(params: { id: string; historyLength?: number }, _context?: ServerCallContext): Promise<Task> {
    const record = await this.projector.loadByTaskId(params.id);
    if (!record) throw new TaskNotFoundError(`Task not found: ${params.id}`);
    return this.projector.taskWithHistoryLimit(record, params.historyLength);
  }

  async cancelTask(params: CancelTaskRequest, _context?: ServerCallContext): Promise<Task> {
    const record = await this.projector.loadByTaskId(params.id);
    if (!record) throw new TaskNotFoundError(`Task not found: ${params.id}`);
    const turnId = record.correlation.activeTurnId;
    if (!turnId || (record.task.status && isTerminalTaskState(record.task.status.state))) {
      throw new TaskNotCancelableError(`Task is not cancelable: ${params.id}`);
    }
    this.runtime.cancelTurn(record.correlation.sessionUri, turnId);
    this.projector.projectAction(record.correlation.sessionUri, {
      type: 'session/turnCancelled',
      turnId,
    } as never);
    await this.projector.save(record);
    return this.projector.taskWithHistoryLimit(record);
  }

  async createTaskPushNotificationConfig(
    _params: TaskPushNotificationConfig,
    _context?: ServerCallContext,
  ): Promise<TaskPushNotificationConfig> {
    throw new PushNotificationNotSupportedError();
  }

  async getTaskPushNotificationConfig(
    _params: GetTaskPushNotificationConfigRequest,
    _context?: ServerCallContext,
  ): Promise<TaskPushNotificationConfig> {
    throw new PushNotificationNotSupportedError();
  }

  async listTaskPushNotificationConfigs(
    _params: ListTaskPushNotificationConfigsRequest,
    _context?: ServerCallContext,
  ): Promise<ListTaskPushNotificationConfigsResponse> {
    throw new PushNotificationNotSupportedError();
  }

  async deleteTaskPushNotificationConfig(
    _params: DeleteTaskPushNotificationConfigRequest,
    _context?: ServerCallContext,
  ): Promise<void> {
    throw new PushNotificationNotSupportedError();
  }

  async listTasks(params: ListTasksRequest, _context?: ServerCallContext): Promise<ListTasksResponse> {
    const all = this.projector.records()
      .filter(record => !params.contextId || record.task.contextId === params.contextId)
      .filter(record => params.status === TaskState.TASK_STATE_UNSPECIFIED || record.task.status?.state === params.status)
      .filter(record => !params.statusTimestampAfter || (record.task.status?.timestamp ?? '') >= params.statusTimestampAfter);
    const offset = params.pageToken ? Number(params.pageToken) : 0;
    const safeOffset = Number.isInteger(offset) && offset > 0 ? offset : 0;
    const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 100);
    const page = all.slice(safeOffset, safeOffset + pageSize)
      .map(record => {
        const task = this.projector.taskWithHistoryLimit(record, params.historyLength);
        return params.includeArtifacts ? task : { ...task, artifacts: [] };
      });
    const nextOffset = safeOffset + page.length;
    return {
      tasks: page,
      nextPageToken: nextOffset < all.length ? String(nextOffset) : '',
      pageSize,
      totalSize: all.length,
    };
  }

  async *resubscribe(
    params: { id: string },
    _context?: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    const record = await this.projector.loadByTaskId(params.id);
    if (!record) throw new TaskNotFoundError(`Task not found: ${params.id}`);
    yield streamResponse('task', this.projector.taskWithHistoryLimit(record));
    for (const event of this.projector.replayableStreamEvents(record)) {
      yield streamResponseForProjection(event);
      if (isStoppingStatusUpdate(event)) return;
    }

    if (record.task.status && isTerminalTaskState(record.task.status.state)) return;

    const subscription = await this.runtime.subscribe(record.correlation.sessionUri);
    for await (const event of subscription.events) {
      for (const projected of await this.projectRuntimeEvent(event)) {
        yield streamResponseForProjection(projected);
        if (isStoppingStatusUpdate(projected)) return;
      }
    }
  }

  private async setupTurn(params: SendMessageRequest): Promise<{
    record: TaskRecord;
    subscription: Awaited<ReturnType<AhpRuntime['subscribe']>>;
  }> {
    const message = params.message;
    if (!message) throw new RequestMalformedError('message is required');
    const taskId = message.taskId || randomUUID();
    const contextId = message.contextId || randomUUID();
    const sessionUri = sessionUriForTask(taskId);
    const stored = await this.projector.loadByTaskId(taskId) ??
      await this.projector.loadByContextId(contextId) ??
      await this.projector.loadBySessionUri(sessionUri);
    const record = stored ?? this.projector.ensureTask({ taskId, contextId, sessionUri, userMessage: message, route: this.route });
    if (stored) {
      this.projector.ensureTask({ taskId, contextId, sessionUri: stored.correlation.sessionUri, userMessage: message, route: this.route });
    }
    await this.projector.save(record);

    const sessionOptions = {
      sessionUri: record.correlation.sessionUri,
      contextId: record.correlation.contextId,
      provider: record.route?.provider ?? this.route?.provider,
      model: record.route?.model ?? this.route?.model,
    };
    const subscription = stored
      ? await this.runtime.resumeSession(sessionOptions)
      : await this.createAndSubscribe(sessionOptions);

    if (this.completePendingInputRequest(record, message)) {
      await this.projector.save(record);
      return { record, subscription };
    }

    const turnId = randomUUID();
    record.correlation.activeTurnId = turnId;
    await this.projector.save(record);
    this.runtime.dispatchTurn({
      sessionUri: record.correlation.sessionUri,
      turnId,
      message: a2aMessageToAhpMessage(message),
    });

    return { record, subscription };
  }

  private async createAndSubscribe(options: {
    readonly sessionUri: string;
    readonly contextId: string;
    readonly provider?: string;
    readonly model?: ModelSelection;
  }): Promise<Awaited<ReturnType<AhpRuntime['subscribe']>>> {
    await this.runtime.createSession(options);
    return this.runtime.subscribe(options.sessionUri);
  }

  private async projectRuntimeEvent(event: AhpRuntimeEvent): Promise<Array<TaskStatusUpdateEvent | TaskArtifactUpdateEvent>> {
    return this.handleRuntimeEvent(event);
  }

  async handleRuntimeEvent(event: AhpRuntimeEvent): Promise<Array<TaskStatusUpdateEvent | TaskArtifactUpdateEvent>> {
    if (event.type !== 'action') return [];
    const record = await this.projector.loadBySessionUri(event.sessionUri);
    this.rememberStatusToolCall(event.sessionUri, event.action);
    const toolResult = await this.executeStatusToolCall(event.sessionUri, event.action);
    if (toolResult) {
      if (toolResult.result) {
        this.runtime.completeToolCall(event.sessionUri, toolResult.turnId, toolResult.toolCallId, toolResult.result);
      }
      return toolResult.events;
    }
    const events = this.projector.projectAction(event.sessionUri, event.action);
    if (record) await this.projector.save(record);
    return events;
  }

  private async executeStatusToolCall(
    sessionUri: string,
    action: StateAction,
  ): Promise<{
    readonly turnId: string;
    readonly toolCallId: string;
    readonly result?: ToolCallResult;
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
          this.pendingInputRequests.set(sessionUri, {
            turnId: readyAction.turnId,
            toolCallId: readyAction.toolCallId,
          });
          this.activeToolCalls.delete(toolCallKey(sessionUri, readyAction.toolCallId));
          return {
            turnId: readyAction.turnId,
            toolCallId: readyAction.toolCallId,
            events,
            result: undefined,
          };
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

  private completePendingInputRequest(record: TaskRecord, message: Message): boolean {
    const pending = this.pendingInputRequests.get(record.correlation.sessionUri);
    if (!pending) return false;

    const answer = structuredAnswerFromMessage(message, textFromA2aParts(message.parts));
    this.runtime.completeToolCall(
      record.correlation.sessionUri,
      pending.turnId,
      pending.toolCallId,
      toolResultFromStructuredAnswer(answer),
    );
    this.pendingInputRequests.delete(record.correlation.sessionUri);
    record.correlation.activeTurnId = pending.turnId;
    return true;
  }
}

type StatusToolName = 'post_status' | 'request_input' | 'publish_artifact' | 'set_activity';

interface PendingInputRequest {
  readonly turnId: string;
  readonly toolCallId: string;
}

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
  const base: AgentCard = {
    name: 'A2A AHP Adapter',
    description: 'A2A server-side adapter backed by an AHP client runtime.',
    supportedInterfaces: [{
      url: 'https://localhost/a2a',
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
      tenant: '',
    }],
    provider: undefined,
    version: '0.1.0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [],
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'a2a-ahp-adapter',
        name: 'A2A to AHP adapter',
        description: 'Forwards A2A tasks into AHP sessions.',
        tags: ['a2a', 'ahp'],
        examples: [],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
  return {
    ...base,
    ...overrides,
    skills: overrides?.skills ?? base.skills,
  };
}

function streamResponseForProjection(event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent): StreamResponse {
  return eventHasStatus(event)
    ? streamResponse('statusUpdate', event)
    : streamResponse('artifactUpdate', event);
}

function streamResponse<TCase extends NonNullable<StreamResponse['payload']>['$case']>(
  $case: TCase,
  value: Extract<NonNullable<StreamResponse['payload']>, { $case: TCase }>['value'],
): StreamResponse {
  return { payload: { $case, value } } as StreamResponse;
}

function isStoppingStatusUpdate(event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent): boolean {
  return eventHasStatus(event) &&
    event.status !== undefined &&
    (isTerminalTaskState(event.status.state) || isInterruptedTaskState(event.status.state));
}

function eventHasStatus(event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent): event is TaskStatusUpdateEvent {
  return 'status' in event;
}

function toolResultFromStructuredAnswer(answer: StructuredAnswer): ToolCallResult {
  return {
    success: true,
    pastTenseMessage: 'Answered request_input',
    content: [{ type: ToolResultContentType.Text, text: renderStructuredAnswer(answer) }],
    structuredContent: { answer },
  };
}
