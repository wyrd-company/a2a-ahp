---
title: A2A provider and model selection maps to adapter instances
tags:
  - a2a
  - ahp
  - adapter
  - routing
lifecycle: permanent
createdAt: '2026-06-11T01:30:54.027Z'
updatedAt: '2026-06-11T01:30:54.027Z'
role: decision
alwaysLoad: false
project: github-com-wyrd-company-a2a-ahp
projectName: a2a-ahp
memoryVersion: 1
---
A2A provider/model selection for `a2a-ahp` is represented by separate adapter instances/endpoints, not by per-task A2A payload fields.

Decision: run one A2A adapter instance per externally selectable AHP provider/model pair. Each instance exposes its own AgentCard and creates AHP sessions with the configured `provider` and `model`.

Rationale: AHP root state is provider/model aware, but A2A AgentCard describes an agent endpoint's identity, capabilities, skills, transports, and auth. A2A does not provide a standard task-level model catalog or provider/model selection field. Using one A2A endpoint per provider/model keeps A2A semantics clean and avoids overloading skills or custom metadata for core routing.

Implementation note: `AhpRuntimeOptions` now supports `model?: ModelSelection`; `AhpClientRuntime.createSession` forwards both configured `provider` and `model` to AHP `createSession`. README documents this as the routing contract.
