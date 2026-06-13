import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Message as A2aMessage } from '@a2a-js/sdk';
import type { AgentInfo, Message, StateAction } from '@microsoft/agent-host-protocol';
import {
  AhpServer,
  createInProcessAhpClientTransport,
  type AgentProvider,
  type AgentSession,
  type AgentTurnSink,
} from '@wyrd-company/ahp-server';

import { AhpClientRuntime, createA2aAhpAgents } from '../src/index.js';

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

function createEchoProvider(): AgentProvider {
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
      };
    },
  };
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
