/** Copy the parent environment for child processes. The API-key variable is skipped, not read. */
export function childEnv(home: string, parent: NodeJS.ProcessEnv, apiKeyEnv: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of Object.keys(parent)) {
    if (key === 'DEEPSEEK_API_KEY' || key === apiKeyEnv) continue;
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  env.RELAYWRIGHT_HOME = home;
  env.RELAYWRIGHT_HEADLESS = '1';
  env.RELAYWRIGHT_NOTIFY = '0';
  return env;
}
