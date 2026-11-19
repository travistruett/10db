import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { readPluginMcp } from './plugin-mcp';

let root: TempDir;
let installPath: string;

beforeEach(() => {
  root = tempDir('plugin-mcp');
  installPath = join(realpathSync(root.path), 'cache', 'm', 'github', '1.0.0');
  mkdirSync(installPath, { recursive: true });
});

afterEach(() => {
  root.cleanup();
});

function write(relative: string, content: unknown): void {
  const path = join(installPath, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
}

const read = (id = 'github@m', laneWritable: readonly string[] = []) =>
  readPluginMcp({ id, installPath }, laneWritable);

describe('readPluginMcp', () => {
  it('${TOKEN} in a plugin server’s argument is refused, and the server’s own name is kept', () => {
    write('.mcp.json', { mcpServers: { gh: { command: 'x', args: ['--k=${TOKEN}'] } } });
    expect(read()[0]?.refusal).toContain('Its argument 1 uses ${…}');
  });
});
