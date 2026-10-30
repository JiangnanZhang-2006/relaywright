import { fileURLToPath } from 'node:url';
export const name = 'relaywright';
/** Cordis service the MCP bridge reads when it registers tools. */
export const inject = ['tools'];
const TOOL_CALL_TIMEOUT_MS = 900_000;
/** Launch parameters for the in-package MCP bridge. The CLI path is beside the compiled plugin. */
export function mcpClientConfig(env = process.env, here = import.meta.url) {
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
export async function apply(ctx) {
    const specifier = '@deepseek-ai/dsh-mcp-client';
    const client = (await import(specifier));
    await client.apply(ctx, mcpClientConfig());
}
//# sourceMappingURL=plugin.js.map