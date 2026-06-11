import type { AgentCard, AgentSkill } from '@a2a-js/sdk';

import { A2aAhpRequestHandler, type AhpSessionRoute } from './request-handler.js';
import type { AhpAgentInfo, AhpModelInfo, AhpRuntime } from '../ahp/runtime.js';
import { TaskProjector } from '../projection/task-projector.js';

export interface ProviderModelFilter {
  readonly provider: string;
  readonly model?: string;
}

export interface ProviderModelPolicy {
  readonly allow?: readonly ProviderModelFilter[];
  readonly deny?: readonly ProviderModelFilter[];
}

export interface A2aAhpAdapterFactoryOptions {
  readonly runtime: AhpRuntime;
  readonly baseUrl?: string;
  readonly agentCardUrl?: (route: AhpSessionRoute, agent: AhpAgentInfo, model: AhpModelInfo, path: string) => string;
  readonly policy?: ProviderModelPolicy;
  readonly projectorFactory?: (route: AhpSessionRoute) => TaskProjector;
  readonly agentCardOverrides?: Partial<AgentCard> | ((route: AhpSessionRoute, agent: AhpAgentInfo, model: AhpModelInfo) => Partial<AgentCard>);
}

export interface A2aAhpAgent {
  readonly id: string;
  readonly provider: string;
  readonly model: AhpModelInfo;
  readonly route: AhpSessionRoute;
  /**
   * Stable HTTP path suggestion for transports that address agents by URL path.
   * Other transports can ignore this and use `id`, `provider`, and `model.id`
   * to derive their own addressing scheme.
   */
  readonly path: string;
  readonly agentCard: AgentCard;
  readonly requestHandler: A2aAhpRequestHandler;
}

export type A2aAhpAdapterInstance = A2aAhpAgent;

export async function createA2aAhpAgents(
  options: A2aAhpAdapterFactoryOptions,
): Promise<readonly A2aAhpAgent[]> {
  const agents = await options.runtime.listAgents();
  const instances: A2aAhpAgent[] = [];

  for (const agent of agents) {
    for (const model of agent.models) {
      if (!isAllowed({ provider: agent.provider, model: model.id }, options.policy)) continue;

      const route: AhpSessionRoute = {
        provider: agent.provider,
        model: { id: model.id },
      };
      const path = pathForProviderModel(agent.provider, model.id);
      const agentCard = deriveAgentCard({
        agent,
        model,
        url: resolveAgentCardUrl(options, route, agent, model, path),
        overrides: resolveOverrides(options.agentCardOverrides, route, agent, model),
      });
      const handler = new A2aAhpRequestHandler({
        runtime: options.runtime,
        projector: options.projectorFactory?.(route) ?? new TaskProjector(),
        route,
        agentCard,
      });

      instances.push({
        id: idForProviderModel(agent.provider, model.id),
        provider: agent.provider,
        model,
        route,
        path,
        agentCard,
        requestHandler: handler,
      });
    }
  }

  return instances;
}

export async function createA2aAhpAdapterInstances(
  options: A2aAhpAdapterFactoryOptions,
): Promise<readonly A2aAhpAdapterInstance[]> {
  return createA2aAhpAgents(options);
}

export function idForProviderModel(provider: string, modelId: string): string {
  return `${slug(provider)}-${slug(modelId)}`;
}

export function pathForProviderModel(provider: string, modelId: string): string {
  return `/a2a/${slug(provider)}/${slug(modelId)}`;
}

function deriveAgentCard(options: {
  readonly agent: AhpAgentInfo;
  readonly model: AhpModelInfo;
  readonly url: string;
  readonly overrides?: Partial<AgentCard>;
}): AgentCard {
  const skill = skillForProviderModel(options.agent, options.model);
  const base: AgentCard = {
    protocolVersion: '0.3.0',
    name: `${options.agent.displayName} - ${options.model.name}`,
    description: options.agent.description,
    url: options.url,
    preferredTransport: 'JSONRPC',
    version: '0.1.0',
    provider: {
      organization: options.agent.displayName,
      url: options.url,
    },
    capabilities: {
      streaming: true,
      stateTransitionHistory: true,
      pushNotifications: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [skill],
  };
  return {
    ...base,
    ...options.overrides,
    skills: options.overrides?.skills ?? base.skills,
  };
}

function skillForProviderModel(agent: AhpAgentInfo, model: AhpModelInfo): AgentSkill {
  return {
    id: `ahp-${slug(agent.provider)}-${slug(model.id)}`,
    name: `${agent.displayName} ${model.name}`,
    description: `Routes tasks to AHP provider ${agent.provider} using model ${model.id}.`,
    tags: ['a2a', 'ahp', agent.provider, model.id],
  };
}

function isAllowed(candidate: Required<ProviderModelFilter>, policy: ProviderModelPolicy | undefined): boolean {
  if (policy?.allow?.length && !policy.allow.some(filter => matches(filter, candidate))) return false;
  if (policy?.deny?.some(filter => matches(filter, candidate))) return false;
  return true;
}

function matches(filter: ProviderModelFilter, candidate: Required<ProviderModelFilter>): boolean {
  if (filter.provider !== candidate.provider) return false;
  return filter.model === undefined || filter.model === candidate.model;
}

function resolveOverrides(
  overrides: A2aAhpAdapterFactoryOptions['agentCardOverrides'],
  route: AhpSessionRoute,
  agent: AhpAgentInfo,
  model: AhpModelInfo,
): Partial<AgentCard> | undefined {
  return typeof overrides === 'function' ? overrides(route, agent, model) : overrides;
}

function resolveAgentCardUrl(
  options: A2aAhpAdapterFactoryOptions,
  route: AhpSessionRoute,
  agent: AhpAgentInfo,
  model: AhpModelInfo,
  path: string,
): string {
  if (options.agentCardUrl) return options.agentCardUrl(route, agent, model, path);
  if (options.baseUrl) return `${options.baseUrl.replace(/\/+$/, '')}${path}`;
  return `urn:a2a-ahp:${idForProviderModel(agent.provider, model.id)}`;
}

function slug(value: string): string {
  const slugged = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slugged || 'default';
}
