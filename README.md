# a2a-ahp

Agent2Agent (A2A) server adapter backed by an Agent Host Protocol (AHP)
client runtime.

External callers speak A2A to this package. The adapter speaks AHP to an AHP
server and owns the local projection between A2A task state and AHP
session/action state.

This is an A2A server-side adapter, not an AHP provider plugin.

## Current Scope

Implemented in the first slice:

- A2A `A2ARequestHandler` implementation
- AHP client runtime facade for session creation, subscription, turn dispatch,
  and cancellation
- Automatic A2A adapter instance generation from AHP provider/model discovery
- Allow/deny filtering for exposed AHP provider/model combinations
- Optional NATS serving composer for `@wyrd-company/a2a-nats`
- Local correlation between A2A task/context IDs and AHP session/turn IDs
- Text-first projection from AHP session actions into A2A tasks, messages, and
  stream events
- HTTPS Streamable HTTP MCP status tool server support
- Status tool core that can be used independently of the HTTP transport in
  tests or embedding code

Deferred:

- Push notification configuration
- Full file/data artifact fidelity
- Multi-host orchestration
- General MCP App support
- `complete_task`
- stdio MCP transport

## A2A Behavior

`A2aAhpRequestHandler` implements the A2A SDK `A2ARequestHandler` surface.

Provider/model selection is handled by generated A2A agent routing, not by
individual A2A task payloads. The adapter discovers AHP providers/models from
the AHP root state and can automatically create one A2A agent per externally
selectable AHP provider/model pair. Each generated agent exposes an AgentCard
and an `A2ARequestHandler`; transports such as Express or NATS mount that
handler.

Supported methods:

- `message/send`
  - Creates or finds the local task projection.
  - Creates the AHP session if needed.
  - Subscribes to the AHP session.
  - Dispatches `session/turnStarted` with the user message.
  - Returns a `Task` immediately unless `configuration.blocking` is set.
  - In blocking mode, returns the final assistant `Message` when completed, or
    the current `Task` for terminal non-completed states.
- `message/stream`
  - Uses the same setup path as `message/send`.
  - Yields the initial projected `Task`, then projected A2A update events.
  - Ends when a final status update is projected.
- `tasks/get`
  - Returns the local projected task.
  - Applies `historyLength` where available.
- `tasks/cancel`
  - Dispatches `session/turnCancelled` through the AHP runtime.
  - Updates the local A2A projection to `canceled`.
- `tasks/resubscribe`
  - Yields the current local task projection.
  - Reattaches to the AHP session and streams future projected updates.

Push notification methods currently return A2A push-notification-not-supported
errors.

## Projection Rules

The local `TaskProjector` treats AHP as the high-fidelity runtime and A2A as the
external task API.

Initial text-first mappings:

- `session/turnStarted` -> A2A `working`
- `session/responsePart` -> creates/selects an assistant message target
- `session/delta` -> appends text to the current assistant message
- `session/turnComplete` -> A2A `completed`
- `session/error` -> A2A `failed`
- `session/inputRequested` -> A2A `input-required`
- `session/turnCancelled` -> A2A `canceled`

Artifacts published by status tools are projected as text artifacts.

## MCP Status Tools

The MCP status tool surface is intentionally narrow:

- `post_status`
- `request_input`
- `publish_artifact`
- `set_activity`

There is no `complete_task` tool.

Tool inputs describe intent. They do not require caller-supplied `taskId`,
`sessionId`, `sessionUri`, or `contextId` when trusted AHP forwarding context is
available.

Correlation is resolved through `ToolContextResolver`, which is expected to
provide trusted AHP context:

- AHP session URI
- active turn ID
- tool call ID
- active client ID

For temporary integration paths, `StatusToolService` accepts an isolated
`fallbackCorrelationResolver`. Keep explicit correlation there so it can be
removed when active-client tool forwarding is available end to end.

## Usage

Install dependencies:

```bash
npm install
```

Create A2A agents automatically from the AHP server:

```typescript
import {
  AhpClientRuntime,
  createA2aAhpAgents,
} from '@wyrd-company/a2a-ahp';
import type { AhpTransport } from '@microsoft/agent-host-protocol/client';

declare const transport: AhpTransport;

const runtime = new AhpClientRuntime(transport, {
  clientId: 'a2a-ahp-adapter',
  workingDirectory: 'file:///workspaces/example',
});

const agents = await createA2aAhpAgents({
  runtime,
  baseUrl: 'https://agents.example',
  policy: {
    allow: [
      { provider: 'codex' },
      { provider: 'claude', model: 'claude-sonnet-4' },
    ],
    deny: [
      { provider: 'codex', model: 'experimental-model' },
    ],
  },
});

for (const agent of agents) {
  console.log(agent.id, agent.agentCard.name);
  // Mount agent.requestHandler with an A2A transport.
}
```

The factory calls `runtime.listAgents()`, derives AgentCards from the AHP
provider/model metadata, applies the allow/deny policy, and returns one
transport-neutral A2A agent per exposed provider/model.

Each generated agent contains:

- `id` - stable provider/model identifier
- `path` - stable HTTP path suggestion for URL-addressed transports
- `agentCard` - derived A2A AgentCard
- `requestHandler` - A2A server request handler

### Same-Process AHP Server Composition

When an application runs the A2A adapter and AHP server in the same process,
the host application should own the composition. `a2a-ahp` consumes an
`AhpTransport` or `AhpRuntime`; it does not create or configure the AHP server.

```typescript
import {
  AhpServer,
  createInProcessAhpClientTransport,
} from '@wyrd-company/ahp-server';
import {
  AhpClientRuntime,
  createA2aAhpAgents,
} from '@wyrd-company/a2a-ahp';

const ahpServer = new AhpServer({
  providers,
});

const inProcess = createInProcessAhpClientTransport(ahpServer);

const runtime = new AhpClientRuntime(inProcess.transport, {
  clientId: 'a2a-ahp-adapter',
  workingDirectory: 'file:///workspaces/example',
});

const agents = await createA2aAhpAgents({
  runtime,
  baseUrl: 'https://agents.example',
});

// Keep using `ahpServer` for direct AHP clients in the same process.
// Mount `agents` on whichever A2A transport you need.
```

In this shape, the host configures AHP, exposes AHP over its transports,
creates an in-process AHP client transport for this adapter, then exposes A2A
over its transports.

### Express Transport

Use the existing `@a2a-js/sdk/server/express` transport when you want HTTP:

```typescript
import express from 'express';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';

const app = express();

for (const agent of agents) {
  app.use(
    `${agent.path}/.well-known/agent-card.json`,
    agentCardHandler({ agentCardProvider: agent.requestHandler }),
  );
  app.use(
    agent.path,
    jsonRpcHandler({
      requestHandler: agent.requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
}
```

### NATS Transport

Use the optional `./nats` subpath when you want the adapter to derive NATS
subjects, NATS AgentCard URLs, and optionally publish cards to a registry:

```typescript
import { JetStreamKvAgentCardRegistry } from '@wyrd-company/a2a-nats';
import { serveA2aAhpOverNats } from '@wyrd-company/a2a-ahp/nats';

const registry = new JetStreamKvAgentCardRegistry({
  connection: nc,
  bucket: 'a2a-agent-cards',
  namespace: 'a2a',
});

const serving = await serveA2aAhpOverNats({
  runtime,
  connection: nc,
  namespace: 'a2a',
  registry,
});

await serving.ready();
```

This is a convenience composer. It still returns the generated A2A agents,
subjects, and underlying `NatsA2AServer` instances so embedding code can inspect
or close them.

Without the composer, use the transport-neutral agents directly with
`@wyrd-company/a2a-nats`:

```typescript
import { NatsA2AServer, a2aNatsAgentSubject } from '@wyrd-company/a2a-nats';

for (const agent of agents) {
  const subject = a2aNatsAgentSubject({ namespace: 'a2a', agentId: agent.id });
  const server = new NatsA2AServer({
    connection: nc,
    subject,
    requestHandler: agent.requestHandler,
  });

  await server.ready();
}
```

You can still create one explicit handler when needed:

```typescript
import { A2aAhpRequestHandler } from '@wyrd-company/a2a-ahp';

const requestHandler = new A2aAhpRequestHandler({
  runtime,
  route: {
    provider: 'codex',
    model: { id: 'gpt-5-codex' },
  },
  agentCard: {
    name: 'Codex via AHP',
    url: 'https://agents.example/a2a/codex',
  },
});

void requestHandler;
```

Expose status tools manually through HTTPS Streamable HTTP MCP:

```typescript
import {
  StatusToolService,
  createStatusHttpsServer,
  statusToolDefinitions,
} from '@wyrd-company/a2a-ahp';
import { readFileSync } from 'node:fs';

const statusTools = statusToolDefinitions();

const service = new StatusToolService({
  projector: requestHandler.projector,
  contextResolver: {
    resolve: () => {
      // Replace this with trusted AHP active-client forwarding context.
      return undefined;
    },
  },
});

const server = createStatusHttpsServer({
  service,
  tls: {
    key: readFileSync('localhost.key'),
    cert: readFileSync('localhost.crt'),
  },
});

server.listen(8443);
void statusTools;
```

## Package Layout

- `src/a2a/request-handler.ts` - A2A request handler implementation
- `src/a2a/adapter-factory.ts` - AHP provider/model discovery, filtering, and
  AgentCard derivation
- `src/ahp/runtime.ts` - AHP client runtime facade
- `src/nats.ts` - optional NATS serving composer
- `src/projection/task-projector.ts` - A2A task projection and correlation store
- `src/mcp/status-server.ts` - MCP status tool service and HTTPS server helper
- `src/mappers/a2a-to-ahp.ts` - A2A message to AHP message mapping
- `src/mappers/ahp-to-a2a.ts` - AHP projection helpers

## Development

```bash
npm run typecheck
npm test
npm run build
npm run verify
```

`npm run verify` runs typecheck, tests, and build.

The test suite uses a fake AHP runtime for adapter-level acceptance coverage,
plus focused integration tests against the local `ahp-server` in-memory
transport and `a2a-nats` request/reply server.
