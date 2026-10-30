import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mcpClientConfig } from '../src/dsh/plugin.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('dsh bundle', () => {
  it('ships a bundle patch that inserts relaywright', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      main?: string;
      files?: string[];
      scripts?: { prepare?: string; build?: string };
      dsh?: { bundle?: { patch?: string } };
    };
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml');
    expect(pkg.main).toBe('./dist/dsh/plugin.js');
    expect(pkg.scripts?.prepare).toBeUndefined();
    expect(pkg.scripts?.build).toBe('tsc');
    expect(pkg.files).toContain('cordis.patch.yml');
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
    expect(patch).toContain('id: relaywright');
    expect(patch).toContain('name: relaywright');
    expect(patch).not.toContain('dsh-mcp-client');
  });

  it('points the MCP bridge at this package', () => {
    const here = pathToFileURL(join(root, 'dist', 'dsh', 'plugin.js')).href;
    const config = mcpClientConfig({ DEEPSEEK_API_KEY: 'present' }, here);
    expect(config).toEqual({
      transport: 'stdio',
      serverName: 'relaywright',
      command: process.execPath,
      args: [join(root, 'dist', 'cli', 'index.js'), 'mcp'],
      toolCallTimeoutMs: 900_000,
      env: { DEEPSEEK_API_KEY: 'present' },
    });
    expect(mcpClientConfig({ DEEPSEEK_API_KEY: '   ' }, here).env).toBeUndefined();
    expect(mcpClientConfig({}, here).env).toBeUndefined();
  });
});
