export type BenchTool = 'relaywright' | 'playwright';
export type RunKind = 'first' | 'repeat' | 'redesign';
export type RunOutcome = 'done' | 'limit' | 'error';

export interface ExportPost {
  year: string;
  term: string;
  layout: string;
}

export interface DuplicateExport extends ExportPost {
  count: number;
}

export interface RunScore {
  success: boolean;
  duplicates: DuplicateExport[];
  extra: ExportPost[];
  missing: Array<Pick<ExportPost, 'year' | 'term'>>;
  emptyReported: boolean;
  emptyExported: boolean;
}

export interface ModelCallRecord {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens: number;
  ms: number;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  ms: number;
  resultChars: number;
  isError: boolean;
  preview: string;
}

export interface BenchRun {
  tool: BenchTool;
  kind: RunKind;
  repeatIndex: number;
  url: string;
  success: boolean;
  outcome: RunOutcome;
  servedModel?: string;
  answer: string;
  modelCalls: number;
  toolCalls: number;
  calls: {
    model: ModelCallRecord[];
    tools: ToolCallRecord[];
  };
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  wallMs: number;
  exports: ExportPost[];
  direct: ExportPost[];
  duplicates: DuplicateExport[];
  extra: ExportPost[];
  missing: Array<Pick<ExportPost, 'year' | 'term'>>;
  emptyReported: boolean;
  emptyExported: boolean;
  tools: string[];
  error?: string;
}

export interface TokenRun {
  tool: string;
  kind: RunKind;
  promptTokens: number;
  completionTokens: number;
  success: boolean;
}

export interface ToolAggregate {
  tool: string;
  runs: number;
  firstTokens: number | null;
  medianRepeatTokens: number | null;
  redesignTokens: number | null;
  totalTokens: number;
  successRate: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Thinking-mode reasoning of an assistant turn; sent back while that turn's tool calls run. */
  reasoning_content?: string;
  tool_call_id?: string;
  isError?: boolean;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens: number;
}

export interface ModelTurn {
  content: string | null;
  reasoning?: string;
  /** Model name the API reports serving, which can differ from the requested alias. */
  servedModel?: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage: ModelUsage;
}

export interface Model {
  complete(messages: ChatMessage[], tools: OpenAITool[]): Promise<ModelTurn>;
}
