import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { programRunnable } from './program-reach';

let root: string;
let checkout: string;
let reads: string[];
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
  checkout = join(root, 'work', 'repo');
  mkdirSync(checkout, { recursive: true });
  // The lane profile's reads: the checkout, a listed tool dir and a toolchain (mise-style) dir.
  reads = [checkout, join(root, 'tools'), join(home, '.local', 'share', 'mise')];
  program(join(checkout, 'bin', 'mine'));
  program(join(root, 'tools', 'listed'));
  program(join(home, '.aside', 'bin', 'aside'));
  program(join(home, '.local', 'share', 'mise', 'shims', 'pnpm'));
  path = [
    join(root, 'tools'),
    join(home, '.aside', 'bin'),
    join(home, '.local', 'share', 'mise', 'shims'),
  ].join(':');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// The AMP-56 skip offered Run these now for the Aside CLI, which a lane's sandbox can never read.
it('answers false only for a program outside what the lane reads', () => {
  expect(programRunnable('./bin/mine --x', path, reads, checkout)).toBe(true);
  expect(programRunnable('pnpm publish', path, reads, checkout)).toBe(true);
  expect(programRunnable('listed run', path, reads, checkout)).toBe(true);
  expect(programRunnable('FOO=1 aside open', path, reads, checkout)).toBe(false);
  expect(programRunnable(join(root, 'home', '.aside', 'bin', 'aside'), '', reads, checkout)).toBe(
    false,
  );
  expect(programRunnable('nothing-here', path, reads, checkout)).toBe(true);
  expect(programRunnable('cd /x && aside open', path, reads, checkout)).toBe(true);
  expect(programRunnable('"aside" open', path, reads, checkout)).toBe(true);
});
