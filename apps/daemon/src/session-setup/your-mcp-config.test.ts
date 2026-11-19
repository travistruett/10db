import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { readYourMcpConfig } from './your-mcp-config';

let root: TempDir;
let home: string;
let checkout: string;

beforeEach(() => {
  root = tempDir('your-mcp-config');
  const base = realpathSync(root.path);
  home = join(base, 'home');
  checkout = join(base, 'checkout');
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(checkout);
});

afterEach(() => {
  root.cleanup();
});

const read = (): ReturnType<typeof readYourMcpConfig> =>
  readYourMcpConfig({ home, laneWritable: [checkout], plugins: [] });

function claudeJson(content: unknown): void {
  writeFileSync(
    join(home, '.claude.json'),
    typeof content === 'string' ? content : JSON.stringify(content),
  );
}

describe('readYourMcpConfig', () => {
  it('${TOKEN} in an argument is refused, naming argument 2 and no text', () => {
    claudeJson({ mcpServers: { s: { command: 'npx', args: ['-y', '--key=${TOKEN}sk-canary'] } } });
    const refusal = read().entries[0]?.refusal ?? '';
    expect(refusal).toBe(
      'Its argument 2 uses ${…}, which would put a value on a command line. Set it in its env block instead.',
    );
    expect(refusal).not.toContain('sk-canary');
    expect(refusal).not.toContain('${TOKEN}');
  });
});
