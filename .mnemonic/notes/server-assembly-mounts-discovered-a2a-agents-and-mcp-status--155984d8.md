---
title: Server assembly mounts discovered A2A agents and MCP status tools
tags:
  - a2a
  - ahp
  - adapter
  - server
lifecycle: permanent
createdAt: '2026-06-11T01:47:03.070Z'
updatedAt: '2026-06-11T01:47:03.070Z'
role: decision
alwaysLoad: false
project: github-com-wyrd-company-a2a-ahp
projectName: a2a-ahp
memoryVersion: 1
---
`a2a-ahp` server shape now centers on `createA2aAhpServer`.

Decision: provide an Express-based server assembly that discovers AHP provider/model pairs, creates derived A2A adapter instances, mounts one A2A JSON-RPC endpoint and AgentCard route per provider/model, exposes a catalog route, and optionally mounts Streamable HTTP MCP status tools on the same app.

Default route shape:

- `GET /a2a` returns the generated adapter catalog.
- `POST /a2a/:provider/:model` handles A2A JSON-RPC and SSE streaming through the A2A SDK Express middleware.
- `GET /a2a/:provider/:model/.well-known/agent-card.json` serves the derived AgentCard.
- `ALL /mcp` is mounted when MCP status tools are configured.

Implementation note: the server uses one shared `TaskProjector` by default across all generated handlers so MCP status tool calls resolved by trusted AHP session context can update any projected A2A task. `listen` supports HTTP or HTTPS via optional TLS options; MCP should be served through HTTPS directly or behind a trusted TLS terminator.

Verification: `npm run verify` passed on 2026-06-11 with 19 node:test tests, including server catalog, AgentCard route, JSON-RPC routing, provider/model createSession routing, and MCP service mounting.
