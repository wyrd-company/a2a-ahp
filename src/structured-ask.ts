import type { Message } from '@a2a-js/sdk';

export const STRUCTURED_ASK_METADATA_KEY = 'https://wyrd.company/ahp/extensions/structured-ask/v1/ask';
export const STRUCTURED_ASK_ANSWER_METADATA_KEY = 'https://wyrd.company/ahp/extensions/structured-ask/v1/answer';

export interface StructuredAskOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface StructuredAsk {
  readonly prompt: string;
  readonly options?: readonly StructuredAskOption[];
  readonly allowFreeText: boolean;
  readonly role?: string;
}

export type StructuredAnswer =
  | { readonly optionId: string }
  | { readonly text: string };

export function normalizeStructuredAsk(input: {
  readonly prompt: string;
  readonly options?: readonly StructuredAskOption[];
  readonly allowFreeText?: boolean;
  readonly role?: string;
}): StructuredAsk {
  return {
    prompt: input.prompt,
    ...(input.options && input.options.length > 0 ? { options: input.options.map(option => ({ ...option })) } : {}),
    allowFreeText: input.allowFreeText ?? true,
    ...(input.role ? { role: input.role } : {}),
  };
}

export function structuredAnswerFromMessage(message: Message, fallbackText: string): StructuredAnswer {
  const metadataAnswer = parseStructuredAnswer(message.metadata?.[STRUCTURED_ASK_ANSWER_METADATA_KEY]);
  return metadataAnswer ?? { text: fallbackText };
}

export function renderStructuredAnswer(answer: StructuredAnswer): string {
  return 'optionId' in answer ? `Selected option: ${answer.optionId}` : answer.text;
}

function parseStructuredAnswer(value: unknown): StructuredAnswer | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.optionId === 'string') return { optionId: value.optionId };
  if (typeof value.text === 'string') return { text: value.text };
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
