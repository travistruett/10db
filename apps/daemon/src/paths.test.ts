import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../test/fixtures';
import { sandboxRuntimeFor, SandboxRuntimeError } from './paths';

let dir: TempDir;
beforeEach(() => {
  dir = tempDir('paths');
});
afterEach(() => {
  dir.cleanup();
});

describe('sandboxRuntimeFor', () => {
  it("runs a bundle's own srt.mjs with this node", () => {
    writeFileSync(join(dir.path, 'srt.mjs'), '');
    expect(sandboxRuntimeFor(join(dir.path, 'daemon.mjs'))).toEqual({
      node: process.execPath,
      cli: join(dir.path, 'srt.mjs'),
    });
  });

  it('refuses a bundle without its srt.mjs, rather than look in node_modules', () => {
    // A node_modules above the bundle holds an srt it must never use.
    const above = join(dir.path, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist');
    mkdirSync(above, { recursive: true });
    writeFileSync(join(above, 'cli.js'), '');
    const bundle = join(dir.path, 'app');
    mkdirSync(bundle);
    expect(() => sandboxRuntimeFor(join(bundle, 'daemon.mjs'))).toThrow(SandboxRuntimeError);
  });

  it("uses the dependency's command line when run from source", () => {
    const runtime = sandboxRuntimeFor(import.meta.filename);
    expect(runtime.node).toBe(process.execPath);
    expect(runtime.cli).toMatch(/@anthropic-ai\/sandbox-runtime\/dist\/cli\.js$/);
  });
});
