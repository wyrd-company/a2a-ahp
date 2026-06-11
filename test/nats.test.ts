import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentCard, MessageSendParams, Task } from '@a2a-js/sdk';
import { NATS_TRANSPORT_PROTOCOL_NAME, NatsA2AClientTransport } from '@wyrd-company/a2a-nats';
import type { AgentInfo } from '@microsoft/agent-host-protocol';

import { serveA2aAhpOverNats } from '../src/nats.js';
import { FakeAhpRuntime } from './fake-runtime.js';
import { FakeNatsBroker } from './fake-nats.js';

test('serves discovered AHP provider-model routes over NATS', async () => {
  const broker = new FakeNatsBroker();
  const runtime = new FakeAhpRuntime([echoAgent()]);
  const registry = new CapturingRegistry();
  const serving = await serveA2aAhpOverNats({
    runtime,
    connection: broker,
    namespace: 'wyrd.a2a',
    registry,
  });

  await serving.ready();

  assert.equal(serving.agents.length, 1);
  assert.equal(serving.agents[0]?.subject, 'wyrd_a2a.agent.echo-echo.rpc');
  assert.equal(serving.agents[0]?.agent.agentCard.preferredTransport, NATS_TRANSPORT_PROTOCOL_NAME);
  assert.equal(serving.agents[0]?.agent.agentCard.url, 'nats://wyrd_a2a.agent.echo-echo.rpc');
  assert.equal(registry.published[0]?.agentId, 'echo-echo');

  const client = new NatsA2AClientTransport({
    connection: broker,
    subject: serving.agents[0]!.subject,
    createInbox: () => broker.createInbox(),
  });
  const result = await client.sendMessage(sendParams('task-1', 'ctx-1', 'Hello'));

  assert.equal((result as Task).kind, 'task');
  assert.equal(runtime.createdSessions[0]?.provider, 'echo');
  assert.deepEqual(runtime.createdSessions[0]?.model, { id: 'echo' });
  assert.equal(runtime.dispatchedTurns[0]?.message.text, 'Hello');

  serving.close();
});

class CapturingRegistry {
  readonly published: Array<{ agentId: string; card: AgentCard }> = [];

  async publish(options: { readonly agentId: string; readonly card: AgentCard }): Promise<void> {
    this.published.push(options);
  }
}

function echoAgent(): AgentInfo {
  return {
    provider: 'echo',
    displayName: 'Echo Agent',
    description: 'Echo test agent.',
    models: [
      {
        id: 'echo',
        provider: 'echo',
        name: 'Echo',
      },
    ],
  };
}

function sendParams(taskId: string, contextId: string, text: string): MessageSendParams {
  return {
    message: {
      kind: 'message',
      role: 'user',
      messageId: `${taskId}-message`,
      taskId,
      contextId,
      parts: [{ kind: 'text', text }],
    },
  };
}
