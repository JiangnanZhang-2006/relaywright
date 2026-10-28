import { redactSecrets } from './redact.js';
import type { ChatMessage, Model, ModelTurn, OpenAITool } from './types.js';

export interface LiveModelConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** DeepSeek thinking mode. The API ignores temperature in this mode, so none is sent. */
  thinking: boolean;
}

/** Live chat completions. The key is sent only as an Authorization header. */
export function liveModel(config: LiveModelConfig): Model {
  return {
    async complete(messages, tools): Promise<ModelTurn> {
      let response: Response;
      try {
        response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            ...(config.thinking ? { thinking: { type: 'enabled' } } : { temperature: 0 }),
            stream: false,
            messages: messages.map((message) => toApi(message)),
            tools,
          }),
        });
      } catch (err) {
        throw new Error(redactSecrets(err instanceof Error ? err.message : String(err), config.apiKey));
      }
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`chat/completions ${response.status}: ${redactSecrets(raw, config.apiKey).slice(0, 500)}`);
      }
      let json: unknown;
      try {
        json = JSON.parse(raw) as unknown;
      } catch {
        throw new Error('chat/completions returned non-JSON');
      }
      return parseCompletion(json, config.apiKey);
    },
  };
}

function toApi(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content ?? '' };
  }
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    };
  }
  return { role: message.role, content: message.content ?? '' };
}

function parseCompletion(json: unknown, secret: string): ModelTurn {
  const root = asRecord(json);
  const choice = Array.isArray(root.choices) ? asRecord(root.choices[0]) : {};
  const message = asRecord(choice.message);
  const usage = asRecord(root.usage);
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map((item, index) => parseToolCall(item, index, secret)) : [];
  const content = typeof message.content === 'string' ? message.content : null;
  return {
    content,
    ...(typeof message.reasoning_content === 'string' ? { reasoning: message.reasoning_content } : {}),
    ...(typeof root.model === 'string' ? { servedModel: root.model } : {}),
    toolCalls,
    usage: {
      prompt_tokens: numberField(usage.prompt_tokens),
      completion_tokens: numberField(usage.completion_tokens),
      prompt_cache_hit_tokens: numberField(usage.prompt_cache_hit_tokens),
    },
  };
}

function parseToolCall(item: unknown, index: number, secret: string): ModelTurn['toolCalls'][number] {
  const call = asRecord(item);
  const fn = asRecord(call.function);
  const name = typeof fn.name === 'string' ? fn.name : '';
  let args: Record<string, unknown> = {};
  if (typeof fn.arguments === 'string') {
    try {
      const parsed = JSON.parse(fn.arguments) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      args = { invalid_json: redactSecrets(fn.arguments, secret).slice(0, 500) };
    }
  } else if (fn.arguments && typeof fn.arguments === 'object' && !Array.isArray(fn.arguments)) {
    args = fn.arguments as Record<string, unknown>;
  }
  return { id: typeof call.id === 'string' ? call.id : `call_${index + 1}`, name, arguments: args };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export type { OpenAITool };
