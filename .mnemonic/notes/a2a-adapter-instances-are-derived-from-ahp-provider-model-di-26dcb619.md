---
title: A2A adapter instances are derived from AHP provider-model discovery
tags:
  - a2a
  - ahp
  - adapter
  - routing
lifecycle: permanent
createdAt: '2026-06-11T01:41:55.351Z'
updatedAt: '2026-06-11T01:41:55.351Z'
role: decision
alwaysLoad: false
project: github-com-wyrd-company-a2a-ahp
projectName: a2a-ahp
memoryVersion: 1
---
`a2a-ahp` now derives A2A adapter instances from AHP server provider/model discovery instead of requiring callers to wire each provider/model manually.

Decision refinement: the adapter should read AHP root `agents`/`models`, apply a provider/model allow/deny policy, derive one A2A AgentCard and handler per exposed provider/model pair, and route all tasks sent to that handler into AHP `createSession` with the selected provider/model.

Implementation note: `createA2aAhpAdapterInstances` returns instances with `path`, `agentCard`, `route`, and `handler`. `AhpRuntime.listAgents()` exposes the AHP catalog. `AhpClientRuntime` fills it from the `ahp-root://` initialize snapshot. `A2aAhpRequestHandler` accepts a route and forwards it as `provider`/`model` in `createSession`.

Verification: `npm run verify` passed on 2026-06-11 with 16 node:test tests, including factory filtering and provider/model routing tests.
