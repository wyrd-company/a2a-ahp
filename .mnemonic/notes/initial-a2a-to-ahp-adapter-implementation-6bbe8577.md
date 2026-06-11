---
title: Initial A2A-to-AHP adapter implementation
tags:
  - a2a
  - ahp
  - adapter
  - typescript
lifecycle: permanent
createdAt: '2026-06-10T15:03:11.657Z'
updatedAt: '2026-06-10T15:03:11.657Z'
role: summary
alwaysLoad: false
project: github-com-wyrd-company-a2a-ahp
projectName: a2a-ahp
memoryVersion: 1
---
Initial `a2a-ahp` implementation bootstraps a TypeScript package that exposes an A2A server-side request handler backed by an AHP client runtime facade.

Key shape:

- `A2aAhpRequestHandler` implements the A2A `A2ARequestHandler` interface and maps `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, and `tasks/resubscribe` onto AHP session create/subscribe/dispatch/cancel behavior.
- `TaskProjector` is the local source of A2A projection state and maps text-first AHP session actions (`session/responsePart`, `session/delta`, `session/turnComplete`, `session/error`, `session/inputRequested`, `session/turnCancelled`) into A2A task status/history/artifacts.
- `StatusToolService` exposes `post_status`, `request_input`, `publish_artifact`, and `set_activity` through a transport-independent core plus an HTTPS Streamable HTTP MCP wrapper. Tool schemas intentionally do not require caller-supplied task/session/context IDs; correlation is resolved through a trusted AHP forwarding context resolver, with an isolated fallback resolver for temporary explicit correlation.
- The first slice is text-first and deliberately does not implement push notifications or `complete_task`.

Verification on 2026-06-10: `npm ci && npm run verify && rm -rf dist node_modules` passed, including typecheck, 13 node:test tests, and build.
