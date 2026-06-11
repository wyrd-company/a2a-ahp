import { createServer, type Server as HttpsServer, type ServerOptions } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import type { TaskArtifactUpdateEvent, TaskState, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { ToolDefinition, URI } from '@microsoft/agent-host-protocol';

import type { TaskProjector } from '../projection/task-projector.js';

export interface TrustedToolContext {
  readonly sessionUri: URI;
  readonly turnId?: string;
  readonly toolCallId?: string;
  readonly activeClientId?: string;
}

export interface ToolContextResolver {
  resolve(): Promise<TrustedToolContext | undefined> | TrustedToolContext | undefined;
}

export interface ExplicitCorrelation {
  readonly sessionUri: URI;
  readonly turnId?: string;
}

export interface ExplicitCorrelationResolver {
  resolve(input: unknown): Promise<ExplicitCorrelation | undefined> | ExplicitCorrelation | undefined;
}

export interface StatusToolServiceOptions {
  readonly projector: TaskProjector;
  readonly contextResolver: ToolContextResolver;
  readonly fallbackCorrelationResolver?: ExplicitCorrelationResolver;
}

export class StatusToolService {
  private readonly projector: TaskProjector;
  private readonly contextResolver: ToolContextResolver;
  private readonly fallbackCorrelationResolver?: ExplicitCorrelationResolver;

  constructor(options: StatusToolServiceOptions) {
    this.projector = options.projector;
    this.contextResolver = options.contextResolver;
    this.fallbackCorrelationResolver = options.fallbackCorrelationResolver;
  }

  async postStatus(input: PostStatusInput): Promise<TaskStatusUpdateEvent> {
    const context = await this.requireContext(input);
    return this.projector.updateStatus({
      sessionUri: context.sessionUri,
      turnId: context.turnId,
      state: input.state,
      text: input.message,
      activity: input.activity,
    });
  }

  async requestInput(input: RequestInputInput): Promise<TaskStatusUpdateEvent> {
    const context = await this.requireContext(input);
    return this.projector.requestInput({
      sessionUri: context.sessionUri,
      turnId: context.turnId,
      prompt: input.prompt,
    });
  }

  async publishArtifact(input: PublishArtifactInput): Promise<TaskArtifactUpdateEvent> {
    const context = await this.requireContext(input);
    return this.projector.publishArtifact({
      sessionUri: context.sessionUri,
      turnId: context.turnId,
      artifactId: input.artifactId,
      name: input.name,
      description: input.description,
      text: input.text,
      metadata: input.metadata,
    });
  }

  async setActivity(input: SetActivityInput): Promise<TaskStatusUpdateEvent> {
    const context = await this.requireContext(input);
    return this.projector.updateStatus({
      sessionUri: context.sessionUri,
      turnId: context.turnId,
      activity: input.activity,
    });
  }

  private async requireContext(input: unknown): Promise<TrustedToolContext> {
    const trusted = await this.contextResolver.resolve();
    if (trusted) return trusted;

    const explicit = await this.fallbackCorrelationResolver?.resolve(input);
    if (explicit) return explicit;

    throw new Error('Trusted AHP forwarding context is required for status tool calls');
  }
}

export const postStatusSchema = z.object({
  state: z.enum([
    'submitted',
    'working',
    'input-required',
    'completed',
    'canceled',
    'failed',
    'rejected',
    'auth-required',
    'unknown',
  ]).optional(),
  message: z.string().optional(),
  activity: z.string().optional(),
});

export const requestInputSchema = z.object({
  prompt: z.string(),
});

export const publishArtifactSchema = z.object({
  artifactId: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  text: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const setActivitySchema = z.object({
  activity: z.string().optional(),
});

export type PostStatusInput = z.infer<typeof postStatusSchema> & { readonly state?: TaskState };
export type RequestInputInput = z.infer<typeof requestInputSchema>;
export type PublishArtifactInput = z.infer<typeof publishArtifactSchema>;
export type SetActivityInput = z.infer<typeof setActivitySchema>;

export function statusToolDefinitions(): ToolDefinition[] {
  return [
    toolDefinition('post_status', 'Post Status', 'Update the visible A2A task status or message.'),
    toolDefinition('request_input', 'Request Input', 'Move the visible A2A task to input-required.'),
    toolDefinition('publish_artifact', 'Publish Artifact', 'Publish a text artifact to the visible A2A task.'),
    toolDefinition('set_activity', 'Set Activity', 'Update the visible A2A task activity text.'),
  ];
}

export function createStatusMcpServer(service: StatusToolService): McpServer {
  const server = new McpServer({
    name: 'a2a-ahp-status-tools',
    version: '0.1.0',
  });

  server.registerTool(
    'post_status',
    {
      description: 'Update the visible A2A task status or message.',
      inputSchema: postStatusSchema.shape,
    },
    async input => toolResult(await service.postStatus(input)),
  );

  server.registerTool(
    'request_input',
    {
      description: 'Move the visible A2A task to input-required.',
      inputSchema: requestInputSchema.shape,
    },
    async input => toolResult(await service.requestInput(input)),
  );

  server.registerTool(
    'publish_artifact',
    {
      description: 'Publish a text artifact to the visible A2A task.',
      inputSchema: publishArtifactSchema.shape,
    },
    async input => toolResult(await service.publishArtifact(input)),
  );

  server.registerTool(
    'set_activity',
    {
      description: 'Update the visible A2A task activity text.',
      inputSchema: setActivitySchema.shape,
    },
    async input => toolResult(await service.setActivity(input)),
  );

  return server;
}

export interface StatusHttpsServerOptions {
  readonly tls: ServerOptions;
  readonly service: StatusToolService;
  readonly path?: string;
}

export function createStatusHttpsServer(options: StatusHttpsServerOptions): HttpsServer {
  const path = options.path ?? '/mcp';
  const mcpServer = createStatusMcpServer(options.service);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  void mcpServer.connect(transport);

  return createServer(options.tls, async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== path) {
      res.writeHead(404);
      res.end();
      return;
    }

    await transport.handleRequest(req, res);
  });
}

function toolDefinition(name: string, title: string, description: string): ToolDefinition {
  return {
    name,
    title,
    description,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  };
}

function toolResult(event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(event),
      },
    ],
  };
}
