import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FileAccessContext } from './file-access';
import { programRunnable } from './program-reach';

let root: string;
let ctx: FileAccessContext;
let path: string;

function program(file: string): string {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, 0o755);
  return file;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), '10db-reach-')));
  const home = join(root, 'home');
  const checkout = join(root, 'work', 'repo');
  mkdirSync(checkout, { recursive: true });
  ctx = {
    checkout,
    home,
    protectedReads: [],
    readList: [join(root, 'tools')],
    configDir: join(home, '.claude'),
    providerSessionId: null,
    sandboxTemp: { roots: [join(root, 't')], own: join(root, 't', 'own') },
  };
  program(join(checkout, 'bin', 'mine'));
  program(join(root, 'tools', 'listed'));
  program(join(home, '.aside', 'bin', 'aside'));
  path = [join(root, 'tools'), join(home, '.aside', 'bin')].join(':');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// The AMP-56 skip offered Run these now for the Aside CLI, which a lane's sandbox can never read.
it('answers false only for a program outside what the lane reads', () => {
  expect(programRunnable('./bin/mine --x', path, ctx)).toBe(true);
  expect(programRunnable('listed run', path, ctx)).toBe(true);
  expect(programRunnable('FOO=1 aside open', path, ctx)).toBe(false);
  expect(programRunnable(join(root, 'home', '.aside', 'bin', 'aside'), '', ctx)).toBe(false);
  expect(programRunnable('nothing-here', path, ctx)).toBe(true);
  expect(programRunnable('cd /x && aside open', path, ctx)).toBe(true);
  expect(programRunnable('"aside" open', path, ctx)).toBe(true);
});
