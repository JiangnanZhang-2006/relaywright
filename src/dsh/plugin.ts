import { fileURLToPath } from 'node:url';

export const name = 'relaywright';

/** Cordis service the MCP bridge reads when it registers tools. */
export const inject = ['tools'];

const TOOL_CALL_TIMEOUT_MS = 900_000;

export interface McpClientConfig {
  transport: 'stdio';
  serverName: 'relaywright';
  command: string;
  args: string[];
  toolCallTimeoutMs: number;
  env?: { DEEPSEEK_API_KEY: string };
}

/** Launch parameters for the in-package MCP bridge. The CLI path is beside the compiled plugin. */
export function mcpClientConfig(env: NodeJS.ProcessEnv = process.env, here = import.meta.url): McpClientConfig {
  const cli = fileURLToPath(new URL('../cli/index.js', here));
  const key = env.DEEPSEEK_API_KEY?.trim();
  return {
    transport: 'stdio',
    serverName: 'relaywright',
    command: process.execPath,
    args: [cli, 'mcp'],
    toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
    ...(key ? { env: { DEEPSEEK_API_KEY: key } } : {}),
  };
}

type McpConnect = (ctx: object, config: McpClientConfig) => Promise<void>;

export async function apply(ctx: object): Promise<void> {
  const specifier: string = '@deepseek-ai/dsh-mcp-client';
  const client = (await import(specifier)) as { apply: McpConnect };
  await client.apply(ctx, mcpClientConfig());
}
