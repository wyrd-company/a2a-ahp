import type {
  AgentInfo,
  Message as AhpMessage,
  ModelSelection,
  RootState,
  SessionModelInfo,
  StateAction,
  ToolDefinition,
  URI,
} from '@microsoft/agent-host-protocol';
import { AhpClient, type AhpTransport, type SubscriptionEvent } from '@microsoft/agent-host-protocol/client';

export type AhpAgentInfo = AgentInfo;
export type AhpModelInfo = SessionModelInfo;

export interface AhpRuntimeOptions {
  readonly clientId: string;
  readonly protocolVersions?: readonly string[];
  readonly provider?: string;
  readonly model?: ModelSelection;
  readonly workingDirectory?: URI;
  readonly requestTimeoutMs?: number;
  readonly statusTools?: readonly ToolDefinition[];
}

export interface CreateSessionOptions {
  readonly sessionUri: URI;
  readonly contextId: string;
  readonly provider?: string;
  readonly model?: ModelSelection;
}

export interface TurnDispatch {
  readonly sessionUri: URI;
  readonly turnId: string;
  readonly message: AhpMessage;
}

export interface AhpSessionSubscription {
  readonly sessionUri: URI;
  readonly events: AsyncIterableIterator<AhpRuntimeEvent>;
}

export type AhpRuntimeEvent =
  | { readonly type: 'action'; readonly sessionUri: URI; readonly action: StateAction }
  | { readonly type: 'unknown'; readonly sessionUri: URI; readonly event: unknown };

export interface AhpRuntime {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  listAgents(): Promise<readonly AhpAgentInfo[]>;
  createSession(options: CreateSessionOptions): Promise<void>;
  subscribe(sessionUri: URI): Promise<AhpSessionSubscription>;
  dispatchTurn(dispatch: TurnDispatch): void;
  cancelTurn(sessionUri: URI, turnId: string): void;
}

export class AhpClientRuntime implements AhpRuntime {
  private readonly client: AhpClient;
  private readonly options: Required<Pick<AhpRuntimeOptions, 'clientId' | 'protocolVersions'>> & AhpRuntimeOptions;
  private initialized = false;
  private agents: readonly AhpAgentInfo[] = [];
  private readonly createdSessions = new Set<URI>();
  private readonly subscribedSessions = new Set<URI>();

  constructor(transport: AhpTransport, options: AhpRuntimeOptions) {
    this.client = new AhpClient(transport, { requestTimeoutMs: options.requestTimeoutMs });
    this.options = {
      ...options,
      protocolVersions: options.protocolVersions ?? ['0.3.0'],
    };
  }

  async start(): Promise<void> {
    if (this.initialized) return;
    this.client.connect();
    const result = await this.client.initialize({
      clientId: this.options.clientId,
      protocolVersions: this.options.protocolVersions,
      initialSubscriptions: ['ahp-root://'],
    });
    this.agents = agentsFromInitializeSnapshots(result.snapshots);
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    await this.client.shutdown();
  }

  async listAgents(): Promise<readonly AhpAgentInfo[]> {
    await this.start();
    return this.agents;
  }

  async createSession(options: CreateSessionOptions): Promise<void> {
    await this.start();
    if (this.createdSessions.has(options.sessionUri)) return;
    await this.client.request('createSession', {
      channel: options.sessionUri,
      ...(options.provider ?? this.options.provider ? { provider: options.provider ?? this.options.provider } : {}),
      ...(options.model ?? this.options.model ? { model: options.model ?? this.options.model } : {}),
      ...(this.options.workingDirectory ? { workingDirectory: this.options.workingDirectory } : {}),
      ...(this.options.statusTools && this.options.statusTools.length > 0
        ? {
            activeClient: {
              clientId: this.options.clientId,
              displayName: 'A2A AHP Adapter',
              tools: [...this.options.statusTools],
            },
          }
        : {}),
      config: { a2aContextId: options.contextId },
    });
    this.createdSessions.add(options.sessionUri);
  }

  async subscribe(sessionUri: URI): Promise<AhpSessionSubscription> {
    await this.start();
    const { subscription } = this.subscribedSessions.has(sessionUri)
      ? { subscription: this.client.attachSubscription(sessionUri) }
      : await this.client.subscribe(sessionUri);
    this.subscribedSessions.add(sessionUri);

    return {
      sessionUri,
      events: mapSubscriptionEvents(sessionUri, subscription),
    };
  }

  dispatchTurn(dispatch: TurnDispatch): void {
    this.client.dispatch(dispatch.sessionUri, {
      type: 'session/turnStarted',
      turnId: dispatch.turnId,
      message: dispatch.message,
    } as StateAction);
  }

  cancelTurn(sessionUri: URI, turnId: string): void {
    this.client.dispatch(sessionUri, {
      type: 'session/turnCancelled',
      turnId,
    } as StateAction);
  }
}

function agentsFromInitializeSnapshots(snapshots: readonly { state?: unknown }[]): readonly AhpAgentInfo[] {
  const rootSnapshot = snapshots.find(snapshot => {
    const state = snapshot.state as Partial<RootState> | undefined;
    return Array.isArray(state?.agents);
  });
  const state = rootSnapshot?.state as Partial<RootState> | undefined;
  return state?.agents ?? [];
}

async function* mapSubscriptionEvents(
  sessionUri: URI,
  events: AsyncIterableIterator<SubscriptionEvent>,
): AsyncIterableIterator<AhpRuntimeEvent> {
  for await (const event of events) {
    if (event.type === 'action') {
      yield {
        type: 'action',
        sessionUri,
        action: event.params.action,
      };
      continue;
    }
    yield { type: 'unknown', sessionUri, event };
  }
}
