export { A2aAhpRequestHandler } from './a2a/request-handler.js';
export type { A2aAhpRequestHandlerOptions, AhpSessionRoute } from './a2a/request-handler.js';
export {
  createA2aAhpAdapterInstances,
  createA2aAhpAgents,
  idForProviderModel,
  pathForProviderModel,
} from './a2a/adapter-factory.js';
export type {
  A2aAhpAdapterFactoryOptions,
  A2aAhpAdapterInstance,
  A2aAhpAgent,
  ProviderModelFilter,
  ProviderModelPolicy,
} from './a2a/adapter-factory.js';

export { AhpClientRuntime } from './ahp/runtime.js';
export type {
  AhpAgentInfo,
  AhpModelInfo,
  AhpRuntime,
  AhpRuntimeEvent,
  AhpRuntimeOptions,
  AhpSessionSubscription,
  CreateSessionOptions,
  TurnDispatch,
} from './ahp/runtime.js';

export { TaskProjector, sessionUriForTask } from './projection/task-projector.js';
export type {
  ArtifactInput,
  CreateTaskOptions,
  InputRequestInput,
  StatusUpdateInput,
  TaskCorrelation,
  TaskRecord,
} from './projection/task-projector.js';

export {
  StatusToolService,
  createStatusHttpsServer,
  createStatusMcpServer,
  postStatusSchema,
  publishArtifactSchema,
  requestInputSchema,
  setActivitySchema,
  statusToolDefinitions,
} from './mcp/status-server.js';
export type {
  ExplicitCorrelation,
  ExplicitCorrelationResolver,
  PostStatusInput,
  PublishArtifactInput,
  RequestInputInput,
  SetActivityInput,
  StatusHttpsServerOptions,
  StatusToolServiceOptions,
  ToolContextResolver,
  TrustedToolContext,
} from './mcp/status-server.js';
