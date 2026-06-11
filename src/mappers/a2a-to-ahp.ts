import type { Message as A2aMessage, Part } from '@a2a-js/sdk';
import type { Message as AhpMessage } from '@microsoft/agent-host-protocol';

export function a2aMessageToAhpMessage(message: A2aMessage): AhpMessage {
  return {
    text: textFromA2aParts(message.parts),
    origin: { kind: 'user' as AhpMessage['origin']['kind'] },
  };
}

export function textFromA2aParts(parts: readonly Part[] | undefined): string {
  if (!parts) return '';
  return parts
    .filter(part => part.kind === 'text')
    .map(part => part.text)
    .join('\n');
}
