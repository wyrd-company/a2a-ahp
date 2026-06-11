import type { AgentCard } from '@a2a-js/sdk';
import {
  NATS_TRANSPORT_PROTOCOL_NAME,
  NatsA2AServer,
  a2aNatsAgentSubject,
  type NatsConnectionLike,
} from '@wyrd-company/a2a-nats';

import {
  createA2aAhpAgents,
  idForProviderModel,
  type A2aAhpAdapterFactoryOptions,
  type A2aAhpAgent,
} from './a2a/adapter-factory.js';
import type { AhpAgentInfo, AhpModelInfo } from './ahp/runtime.js';
import type { AhpSessionRoute } from './a2a/request-handler.js';

export interface AgentCardPublisher {
  publish(options: { readonly agentId: string; readonly card: AgentCard }): Promise<unknown>;
}

export interface ServeA2aAhpOverNatsOptions
  extends Omit<A2aAhpAdapterFactoryOptions, 'baseUrl' | 'agentCardUrl' | 'agentCardOverrides'> {
  readonly connection: NatsConnectionLike;
  readonly namespace?: string;
  readonly queue?: string;
  readonly registry?: AgentCardPublisher;
  readonly agentCardOverrides?:
    | Partial<AgentCard>
    | ((route: AhpSessionRoute, agent: AhpAgentInfo, model: AhpModelInfo) => Partial<AgentCard>);
}

export interface A2aAhpNatsAgent {
  readonly agent: A2aAhpAgent;
  readonly subject: string;
  readonly server: NatsA2AServer;
}

export interface A2aAhpNatsServing {
  readonly agents: readonly A2aAhpNatsAgent[];
  ready(): Promise<void>;
  close(): void;
}

export async function serveA2aAhpOverNats(options: ServeA2aAhpOverNatsOptions): Promise<A2aAhpNatsServing> {
  const namespace = options.namespace ?? 'a2a';
  const agents = await createA2aAhpAgents({
    runtime: options.runtime,
    policy: options.policy,
    projectorFactory: options.projectorFactory,
    agentCardUrl: (route, _ahpAgent, model) => natsAgentUrl(namespace, idForProviderModel(route.provider, model.id)),
    agentCardOverrides: (route, ahpAgent, model) =>
      natsAgentCardOverrides(namespace, route, ahpAgent, model, options.agentCardOverrides),
  });

  const servingAgents = agents.map(agent => ({
    agent,
    subject: a2aNatsAgentSubject({ namespace, agentId: agent.id }),
    server: new NatsA2AServer({
      connection: options.connection,
      subject: a2aNatsAgentSubject({ namespace, agentId: agent.id }),
      requestHandler: agent.requestHandler as never,
      queue: options.queue,
    }),
  }));

  if (options.registry) {
    await Promise.all(
      servingAgents.map(({ agent }) =>
        options.registry!.publish({
          agentId: agent.id,
          card: agent.agentCard,
        })
      )
    );
  }

  return {
    agents: servingAgents,
    async ready(): Promise<void> {
      await Promise.all(servingAgents.map(agent => agent.server.ready()));
    },
    close(): void {
      for (const agent of servingAgents) agent.server.close();
    },
  };
}

export function natsAgentUrl(namespace: string, agentId: string): string {
  return `nats://${a2aNatsAgentSubject({ namespace, agentId })}`;
}

function natsAgentCardOverrides(
  namespace: string,
  route: AhpSessionRoute,
  ahpAgent: AhpAgentInfo,
  model: AhpModelInfo,
  overrides:
    | Partial<AgentCard>
    | ((route: AhpSessionRoute, agent: AhpAgentInfo, model: AhpModelInfo) => Partial<AgentCard>)
    | undefined,
): Partial<AgentCard> {
  const resolved = typeof overrides === 'function' ? overrides(route, ahpAgent, model) : (overrides ?? {});
  const agentId = idForProviderModel(route.provider, model.id);
  const url = natsAgentUrl(namespace, agentId);
  const additionalInterfaces = [
    ...(resolved.additionalInterfaces?.filter(item => item.transport !== NATS_TRANSPORT_PROTOCOL_NAME) ?? []),
    {
      transport: NATS_TRANSPORT_PROTOCOL_NAME,
      url,
    },
  ];

  return {
    ...resolved,
    url,
    preferredTransport: NATS_TRANSPORT_PROTOCOL_NAME,
    additionalInterfaces,
  };
}
