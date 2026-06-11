import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentInfo } from '@microsoft/agent-host-protocol';
import type { Message } from '@a2a-js/sdk';

import { createA2aAhpAgents, idForProviderModel, pathForProviderModel } from '../src/index.js';
import { FakeAhpRuntime } from './fake-runtime.js';

test('derives one A2A agent per allowed AHP provider/model pair', async () => {
  const runtime = new FakeAhpRuntime([
    agent('codex', 'Codex', ['gpt-5-codex', 'gpt-5-mini']),
    agent('claude', 'Claude', ['sonnet-4']),
  ]);

  const agents = await createA2aAhpAgents({
    runtime,
    baseUrl: 'https://agents.example',
    policy: {
      allow: [
        { provider: 'codex', model: 'gpt-5-codex' },
        { provider: 'claude' },
      ],
      deny: [{ provider: 'claude', model: 'opus-4' }],
    },
  });

  assert.deepEqual(
    agents.map(instance => `${instance.provider}/${instance.model.id}`),
    ['codex/gpt-5-codex', 'claude/sonnet-4'],
  );
  assert.equal(agents[0]?.id, 'codex-gpt-5-codex');
  assert.equal(agents[0]?.path, '/a2a/codex/gpt-5-codex');
  assert.equal(agents[0]?.agentCard.url, 'https://agents.example/a2a/codex/gpt-5-codex');
  assert.equal(agents[0]?.agentCard.name, 'Codex - gpt-5-codex');
});

test('generated handlers route task session creation to their AHP provider/model', async () => {
  const runtime = new FakeAhpRuntime([agent('codex', 'Codex', ['gpt-5-codex'])]);
  const [instance] = await createA2aAhpAgents({
    runtime,
    baseUrl: 'https://agents.example/root/',
  });
  assert.ok(instance);

  await instance.requestHandler.sendMessage({ message: userMessage('task-factory-1', 'ctx-factory-1', 'Hello') });

  assert.equal(runtime.createdSessions.length, 1);
  assert.equal(runtime.createdSessions[0]?.provider, 'codex');
  assert.deepEqual(runtime.createdSessions[0]?.model, { id: 'gpt-5-codex' });
});

test('pathForProviderModel produces stable URL-safe paths', () => {
  assert.equal(pathForProviderModel('GitHub Copilot', 'GPT 5/Preview'), '/a2a/github-copilot/gpt-5-preview');
  assert.equal(idForProviderModel('GitHub Copilot', 'GPT 5/Preview'), 'github-copilot-gpt-5-preview');
});

test('supports transport-specific AgentCard URLs without an HTTP baseUrl', async () => {
  const runtime = new FakeAhpRuntime([agent('codex', 'Codex', ['gpt-5-codex'])]);

  const [agentInstance] = await createA2aAhpAgents({
    runtime,
    agentCardUrl: (_route, _agent, model) => `nats://a2a.agent.${model.id}.rpc`,
    agentCardOverrides: {
      preferredTransport: 'NATS',
    },
  });

  assert.equal(agentInstance?.agentCard.url, 'nats://a2a.agent.gpt-5-codex.rpc');
  assert.equal(agentInstance?.agentCard.preferredTransport, 'NATS');
});

function agent(provider: string, displayName: string, models: string[]): AgentInfo {
  return {
    provider,
    displayName,
    description: `${displayName} test provider`,
    models: models.map(id => ({
      id,
      provider,
      name: id,
    })),
  };
}

function userMessage(taskId: string, contextId: string, text: string): Message {
  return {
    kind: 'message',
    role: 'user',
    messageId: `${taskId}-message`,
    taskId,
    contextId,
    parts: [{ kind: 'text', text }],
  };
}
