import type { AgentInfo, StateAction, URI } from '@microsoft/agent-host-protocol';

import type {
  AhpRuntime,
  AhpRuntimeEvent,
  AhpSessionSubscription,
  CreateSessionOptions,
  ToolCallCompletion,
  TurnDispatch,
} from '../src/ahp/runtime.js';
import { AsyncTopic } from '../src/util/async-queue.js';

export class FakeAhpRuntime implements AhpRuntime {
  readonly createdSessions: CreateSessionOptions[] = [];
  readonly dispatchedTurns: TurnDispatch[] = [];
  readonly canceledTurns: Array<{ sessionUri: URI; turnId: string }> = [];
  readonly completedToolCalls: ToolCallCompletion[] = [];
  private readonly topics = new Map<URI, AsyncTopic<AhpRuntimeEvent>>();
  started = false;
  shutdownCalled = false;

  constructor(readonly agents: readonly AgentInfo[] = []) {}

  async start(): Promise<void> {
    this.started = true;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalled = true;
  }

  async listAgents(): Promise<readonly AgentInfo[]> {
    return this.agents;
  }

  async createSession(options: CreateSessionOptions): Promise<void> {
    this.createdSessions.push(options);
    this.topic(options.sessionUri);
  }

  async subscribe(sessionUri: URI): Promise<AhpSessionSubscription> {
    return {
      sessionUri,
      events: this.topic(sessionUri).subscribe(),
    };
  }

  dispatchTurn(dispatch: TurnDispatch): void {
    this.dispatchedTurns.push(dispatch);
    this.emit(dispatch.sessionUri, {
      type: 'session/turnStarted',
      turnId: dispatch.turnId,
      message: dispatch.message,
    } as StateAction);
  }

  cancelTurn(sessionUri: URI, turnId: string): void {
    this.canceledTurns.push({ sessionUri, turnId });
    this.emit(sessionUri, {
      type: 'session/turnCancelled',
      turnId,
    } as StateAction);
  }

  completeToolCall(sessionUri: URI, turnId: string, toolCallId: string, result: ToolCallCompletion['result']): void {
    this.completedToolCalls.push({ sessionUri, turnId, toolCallId, result });
    this.emit(sessionUri, {
      type: 'session/toolCallComplete',
      turnId,
      toolCallId,
      result,
    } as StateAction);
  }

  emit(sessionUri: URI, action: StateAction): void {
    this.topic(sessionUri).publish({ type: 'action', sessionUri, action });
  }

  private topic(sessionUri: URI): AsyncTopic<AhpRuntimeEvent> {
    let topic = this.topics.get(sessionUri);
    if (!topic) {
      topic = new AsyncTopic<AhpRuntimeEvent>();
      this.topics.set(sessionUri, topic);
    }
    return topic;
  }
}
