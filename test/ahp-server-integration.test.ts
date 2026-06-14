import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import type { Message as A2aMessage } from '@a2a-js/sdk';
import type { AgentInfo, Message, StateAction } from '@microsoft/agent-host-protocol';
import {
  AhpServer,
  FileSystemSessionStore,
  createInProcessAhpClientTransport,
  type AgentProvider,
  type AgentSession,
  type AgentSessionContext,
  type AgentTurnSink,
  type ProviderResumeState,
  type ResumableAgentProvider,
  type ResumableAgentSessionContext,
} from '@wyrd-company/ahp-server';

import { AhpClientRuntime, A2aAhpRequestHandler, InMemoryA2aTaskStore, createA2aAhpAgents } from '../src/index.js';

test('uses an existing in-process AHP server instance as the adapter runtime', async () => {
  const server = new AhpServer({ providers: [createEchoProvider()] });
  const inProcess = createInProcessAhpClientTransport(server);
  const runtime = new AhpClientRuntime(inProcess.transport, {
    clientId: 'a2a-ahp-test',
    requestTimeoutMs: 1_000,
  });

  try {
    const agents = await createA2aAhpAgents({
      runtime,
      baseUrl: 'https://agents.example',
    });

    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.id, 'echo-echo');

    const result = await agents[0]!.requestHandler.sendMessage({
      message: userMessage('task-1', 'ctx-1', 'Hello AHP'),
      configuration: { blocking: true },
    });

    assert.equal((result as A2aMessage).kind, 'message');
    assert.equal((result as A2aMessage).role, 'agent');
    const part = (result as A2aMessage).parts[0];
    assert.equal(part?.kind, 'text');
    assert.equal(part?.kind === 'text' ? part.text : '', 'Echo: Hello AHP');
  } finally {
    await runtime.shutdown();
    await inProcess.close();
  }
});

test('handles forwarded AHP active-client status tools end to end', async () => {
  const provider = createStatusToolProvider();
  const server = new AhpServer({ providers: [provider] });
  const inProcess = createInProcessAhpClientTransport(server);
  const runtime = new AhpClientRuntime(inProcess.transport, {
    clientId: 'a2a-ahp-test',
    requestTimeoutMs: 1_000,
  });

  try {
    const agents = await createA2aAhpAgents({
      runtime,
      baseUrl: 'https://agents.example',
    });
    const stream = agents[0]!.requestHandler.sendMessageStream({
      message: userMessage('task-tools', 'ctx-tools', 'Report progress'),
    });

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    const status = events.find(event =>
      event.kind === 'status-update' &&
      event.status.state === 'working' &&
      event.status.message?.parts[0]?.kind === 'text' &&
      event.status.message.parts[0].text.includes('Installing dependencies')
    );

    assert.ok(status);
    assert.equal(provider.session?.toolResult?.success, true);
    assert.equal(provider.session?.toolResult?.pastTenseMessage, 'Handled post_status');
  } finally {
    await runtime.shutdown();
    await inProcess.close();
  }
});

test('continues an existing A2A task through ahp-server persisted session resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a2a-ahp-resume-'));
  const taskStore = new InMemoryA2aTaskStore();

  try {
    const firstServer = new AhpServer({
      providers: [createEchoProvider({ nativeSessionId: 'a2a-native-session-1' })],
      store: new FileSystemSessionStore({ directory }),
    });
    const firstTransport = createInProcessAhpClientTransport(firstServer);
    const firstRuntime = new AhpClientRuntime(firstTransport.transport, {
      clientId: 'a2a-ahp-test',
      requestTimeoutMs: 1_000,
    });
    const firstHandler = new A2aAhpRequestHandler({
      runtime: firstRuntime,
      taskStore,
      route: { provider: 'echo', model: { id: 'echo' } },
    });

    await firstHandler.sendMessage({
      message: userMessage('task-resume-server', 'ctx-resume-server', 'First'),
      configuration: { blocking: true },
    });
    await firstRuntime.shutdown();
    await firstTransport.close();

    const provider = createResumableEchoProvider({ nativeSessionId: 'a2a-native-session-2' });
    const secondServer = new AhpServer({
      providers: [provider],
      store: new FileSystemSessionStore({ directory }),
    });
    const secondTransport = createInProcessAhpClientTransport(secondServer);
    const secondRuntime = new AhpClientRuntime(secondTransport.transport, {
      clientId: 'a2a-ahp-test',
      requestTimeoutMs: 1_000,
    });
    const secondHandler = new A2aAhpRequestHandler({
      runtime: secondRuntime,
      taskStore,
    });

    const result = await secondHandler.sendMessage({
      message: userMessage('task-resume-server', 'ctx-resume-server', 'Second'),
      configuration: { blocking: true },
    });

    assert.equal(provider.resumedSessionUri, 'ahp-session:/a2a/task-resume-server');
    assert.deepEqual(provider.resumedResumeState, { nativeSessionId: 'a2a-native-session-1' });
    const part = (result as A2aMessage).parts[0];
    assert.equal(part?.kind, 'text');
    assert.equal(part?.kind === 'text' ? part.text : '', 'Resumed Echo: Second');

    const persisted = new FileSystemSessionStore({ directory }).getSession('ahp-session:/a2a/task-resume-server');
    assert.deepEqual(persisted?.providerResumeState, { nativeSessionId: 'a2a-native-session-2' });

    await secondRuntime.shutdown();
    await secondTransport.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function createEchoProvider(resumeState?: ProviderResumeState): AgentProvider {
  const agent: AgentInfo = {
    provider: 'echo',
    displayName: 'Echo Agent',
    description: 'Test agent that echoes user messages.',
    models: [
      {
        id: 'echo',
        provider: 'echo',
        name: 'Echo',
      },
    ],
  };

  return {
    agent,
    createSession(): AgentSession {
      return {
        async sendUserMessage(message: Message, sink: AgentTurnSink, _signal: AbortSignal, turnId = 'turn-1'): Promise<void> {
          sink.emit({
            type: 'session/responsePart',
            turnId,
            part: {
              kind: 'markdown',
              id: 'part-1',
              content: '',
            },
          } as StateAction);
          sink.emit({
            type: 'session/delta',
            turnId,
            partId: 'part-1',
            content: `Echo: ${message.text}`,
          } as StateAction);
          sink.emit({
            type: 'session/turnComplete',
            turnId,
          } as StateAction);
        },
        getResumeState() {
          return resumeState;
        },
      };
    },
  };
}

function createResumableEchoProvider(resumeState?: ProviderResumeState): ResumableEchoProvider {
  return new ResumableEchoProvider(resumeState);
}

class ResumableEchoProvider implements ResumableAgentProvider {
  readonly agent: AgentInfo = {
    provider: 'echo',
    displayName: 'Echo Agent',
    description: 'Test resumable echo provider.',
    models: [
      {
        id: 'echo',
        provider: 'echo',
        name: 'Echo',
      },
    ],
  };

  resumedSessionUri: string | undefined;
  resumedResumeState: ProviderResumeState | undefined;

  constructor(private readonly resumeState?: ProviderResumeState) {}

  createSession(): AgentSession {
    return createEchoSession('Echo', this.resumeState);
  }

  resumeSession(context: ResumableAgentSessionContext): AgentSession {
    this.resumedSessionUri = context.sessionUri;
    this.resumedResumeState = context.resumeState;
    return createEchoSession('Resumed Echo', this.resumeState);
  }
}

function createEchoSession(prefix: string, resumeState?: ProviderResumeState): AgentSession {
  return {
    async sendUserMessage(message: Message, sink: AgentTurnSink, _signal: AbortSignal, turnId = 'turn-1'): Promise<void> {
      sink.emit({
        type: 'session/responsePart',
        turnId,
        part: {
          kind: 'markdown',
          id: 'part-1',
          content: '',
        },
      } as StateAction);
      sink.emit({
        type: 'session/delta',
        turnId,
        partId: 'part-1',
        content: `${prefix}: ${message.text}`,
      } as StateAction);
      sink.emit({
        type: 'session/turnComplete',
        turnId,
      } as StateAction);
    },
    getResumeState() {
      return resumeState;
    },
  };
}

class StatusToolProvider implements AgentProvider {
  readonly agent: AgentInfo = {
    provider: 'status-tools',
    displayName: 'Status Tools',
    description: 'Test provider that invokes active-client status tools.',
    models: [
      {
        id: 'status-tools',
        provider: 'status-tools',
        name: 'Status Tools',
      },
    ],
  };

  session: StatusToolSession | undefined;

  createSession(context: AgentSessionContext): AgentSession {
    this.session = new StatusToolSession(context);
    return this.session;
  }
}

class StatusToolSession implements AgentSession {
  toolResult: Awaited<ReturnType<AgentSessionContext['activeClientToolSink']['reportInvocation']>> | undefined;

  constructor(private readonly context: AgentSessionContext) {}

  async sendUserMessage(_message: Message, sink: AgentTurnSink, _signal: AbortSignal, turnId = 'turn-1'): Promise<void> {
    this.toolResult = await this.context.activeClientToolSink.reportInvocation({
      turnId,
      toolCallId: 'status-tool-call-1',
      toolName: 'post_status',
      displayName: 'Post Status',
      invocationMessage: 'Post Status',
      toolInput: JSON.stringify({
        state: 'working',
        message: 'Installing dependencies',
      }),
    });
    sink.emit({
      type: 'session/responsePart',
      turnId,
      part: {
        kind: 'markdown',
        id: 'part-1',
        content: '',
      },
    } as StateAction);
    sink.emit({
      type: 'session/delta',
      turnId,
      partId: 'part-1',
      content: 'Done',
    } as StateAction);
    sink.emit({
      type: 'session/turnComplete',
      turnId,
    } as StateAction);
  }
}

function createStatusToolProvider(): StatusToolProvider {
  return new StatusToolProvider();
}

function userMessage(taskId: string, contextId: string, text: string): A2aMessage {
  return {
    kind: 'message',
    role: 'user',
    messageId: `${taskId}-message`,
    taskId,
    contextId,
    parts: [{ kind: 'text', text }],
  };
}
