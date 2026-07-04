import {
  Role,
  type Message,
  type Part,
  type SendMessageConfiguration,
  type SendMessageRequest,
  type StreamResponse,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskStatusUpdateEvent,
} from '@a2a-js/sdk';

export function userMessage(taskId: string, contextId: string, text: string, metadata?: Record<string, unknown>): Message {
  return {
    role: Role.ROLE_USER,
    messageId: `${taskId}-message`,
    taskId,
    contextId,
    parts: [textPart(text)],
    metadata,
    extensions: [],
    referenceTaskIds: [],
  };
}

export function sendMessageRequest(
  message: Message,
  configuration?: Partial<SendMessageConfiguration>,
  metadata?: Record<string, unknown>,
): SendMessageRequest {
  return {
    tenant: '',
    message,
    configuration: configuration ? sendMessageConfiguration(configuration) : undefined,
    metadata,
  };
}

export function sendMessageConfiguration(
  configuration: Partial<SendMessageConfiguration> = {},
): SendMessageConfiguration {
  return {
    acceptedOutputModes: configuration.acceptedOutputModes ?? [],
    taskPushNotificationConfig: configuration.taskPushNotificationConfig,
    historyLength: configuration.historyLength,
    returnImmediately: configuration.returnImmediately ?? false,
  };
}

export function cancelTaskRequest(id: string) {
  return { tenant: '', id, metadata: undefined };
}

export function textPart(text: string): Part {
  return {
    content: { $case: 'text', value: text },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  };
}

export function textFromMessage(message: Message | undefined): string {
  return textFromParts(message?.parts);
}

export function textFromParts(parts: readonly Part[] | undefined): string {
  return (parts ?? [])
    .filter(part => part.content?.$case === 'text')
    .map(part => part.content?.$case === 'text' ? part.content.value : '')
    .join('\n');
}

export function taskFromStream(response: StreamResponse): Task | undefined {
  return response.payload?.$case === 'task' ? response.payload.value : undefined;
}

export function statusFromStream(response: StreamResponse): TaskStatusUpdateEvent | undefined {
  return response.payload?.$case === 'statusUpdate' ? response.payload.value : undefined;
}

export function artifactFromStream(response: StreamResponse): TaskArtifactUpdateEvent | undefined {
  return response.payload?.$case === 'artifactUpdate' ? response.payload.value : undefined;
}
