---
title: A2A-AHP core remains transport-neutral
tags:
  - a2a
  - ahp
  - adapter
  - transport
lifecycle: permanent
createdAt: '2026-06-11T01:57:24.608Z'
updatedAt: '2026-06-11T01:57:24.608Z'
role: decision
alwaysLoad: false
project: github-com-wyrd-company-a2a-ahp
projectName: a2a-ahp
memoryVersion: 1
---
`a2a-ahp` core should remain transport-neutral and should not own an Express-centered server abstraction.

Decision: the adapter's core product is generated A2A agents, each with an AgentCard and an `A2ARequestHandler`. A2A transports mount those handlers. Existing transports include `@a2a-js/sdk/server/express` for HTTP and `@wyrd-company/a2a-nats` for NATS request/reply.

Correction: the earlier `createA2aAhpServer` Express assembly was removed from the package. The canonical API is now `createA2aAhpAgents`, which discovers AHP provider/model pairs, applies allow/deny filters, derives AgentCards, and returns transport-neutral agents. `baseUrl` is optional and `agentCardUrl` can generate transport-specific URLs such as `nats://...`.

Rationale: `a2a-js` already defines the server-side contract as `A2ARequestHandler`; Express and NATS are delivery mechanisms. Coupling this adapter package to Express would make NATS support awkward and duplicate responsibilities already handled by A2A transport bindings.

Verification: `npm run verify` passed on 2026-06-11 with 17 node:test tests after removing the Express server module and dependency.
