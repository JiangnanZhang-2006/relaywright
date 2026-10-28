import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { publicError } from './redact.js';
import type { ChatMessage, Model, ModelCallRecord, OpenAITool, ToolCallRecord } from './types.js';

export const MAX_MODEL_CALLS = 40;
export const MAX_TOKENS = 600_000;
export const MAX_RUN_MS = 15 * 60 * 1000;
export const TOOL_TIMEOUT_MS = 240_000;

export interface ConversationResult {
  outcome: 'done' | 'limit' | 'error';
  error?: string;
  answer: string;
  modelCalls: ModelCallRecord[];
  toolCalls: ToolCallRecord[];
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  wallMs: number;
  tools: string[];
}

export async function runConversation(options: {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  model: Model;
  system: string;
  user: string;
  secret?: string;
}): Promise<ConversationResult> {
  const started = Date.now();
  const stderr: Buffer[] = [];
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args,
    env: options.env,
    cwd: options.cwd,
    stderr: 'pipe',
  });
  const stream = transport.stderr;
  if (stream) {
    stream.on('data', (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const size = stderr.reduce((sum, part) => sum + part.length, 0);
      while (size > 8_000 && stderr.length > 1) stderr.shift();
    });
  }
  const client = new Client({ name: 'relaywright-bench', version: '0.1.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = listed.tools.map(toOpenAI);
    const instructions = client.getInstructions()?.trim();
    const messages: ChatMessage[] = [
      { role: 'system', content: instructions ? `${options.system}\n\n${instructions}` : options.system },
      { role: 'user', content: options.user },
    ];
    const modelCalls: ModelCallRecord[] = [];
    const toolCalls: ToolCallRecord[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let cacheHitTokens = 0;
    let answer = '';
    let outcome: ConversationResult['outcome'] = 'done';
    let error: string | undefined;
    for (;;) {
      const elapsed = Date.now() - started;
      if (modelCalls.length >= MAX_MODEL_CALLS || elapsed >= MAX_RUN_MS || promptTokens + completionTokens >= MAX_TOKENS) {
        outcome = 'limit';
        break;
      }
      const callStarted = Date.now();
      let turn;
      try {
        turn = await options.model.complete(messages, tools);
      } catch (err) {
        outcome = 'error';
        error = publicError(err, options.secret);
        break;
      }
      const prompt = turn.usage.prompt_tokens;
      const completion = turn.usage.completion_tokens;
      const cacheHit = turn.usage.prompt_cache_hit_tokens;
      modelCalls.push({ prompt_tokens: prompt, completion_tokens: completion, prompt_cache_hit_tokens: cacheHit, ms: Date.now() - callStarted });
      promptTokens += prompt;
      completionTokens += completion;
      cacheHitTokens += cacheHit;
      if (turn.toolCalls.length === 0) {
        answer = turn.content ?? '';
        outcome = 'done';
        break;
      }
      messages.push({
        role: 'assistant',
        content: turn.content,
        tool_calls: turn.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      });
      for (const call of turn.toolCalls) {
        const toolStarted = Date.now();
        let text = '';
        let isError = false;
        try {
          const result: unknown = await client.callTool({ name: call.name, arguments: call.arguments }, undefined, {
            timeout: TOOL_TIMEOUT_MS,
            maxTotalTimeout: TOOL_TIMEOUT_MS,
          });
          const read = readToolResult(result);
          text = read.text;
          isError = read.isError;
        } catch (err) {
          text = publicError(err, options.secret);
          isError = true;
        }
        toolCalls.push({ name: call.name, ms: Date.now() - toolStarted, resultChars: text.length, isError });
        messages.push({ role: 'tool', tool_call_id: call.id, content: text, isError });
      }
    }
    return {
      outcome,
      ...(error ? { error } : {}),
      answer,
      modelCalls,
      toolCalls,
      promptTokens,
      completionTokens,
      cacheHitTokens,
      wallMs: Date.now() - started,
      tools: tools.map((tool) => tool.function.name),
    };
  } catch (err) {
    const tail = Buffer.concat(stderr).toString('utf8').trim();
    const message = publicError(err, options.secret);
    throw new Error(tail ? `${message}\n${publicError(tail, options.secret)}` : message);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function toOpenAI(tool: { name: string; description?: string; inputSchema?: unknown }): OpenAITool {
  const parameters =
    tool.inputSchema && typeof tool.inputSchema === 'object'
      ? (tool.inputSchema as Record<string, unknown>)
      : { type: 'object', properties: {} };
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters,
    },
  };
}

function readToolResult(result: unknown): { text: string; isError: boolean } {
  const record = result && typeof result === 'object' ? (result as { content?: unknown; isError?: boolean }) : {};
  const parts: string[] = [];
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      if (!item || typeof item !== 'object') continue;
      const block = item as { type?: string; text?: string };
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      else if (block.type === 'image') parts.push('[image omitted]');
      else if (block.type) parts.push(`[${block.type} omitted]`);
    }
  }
  return { text: parts.join('\n'), isError: record.isError === true };
}
