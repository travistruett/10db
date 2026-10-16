// Resolves the user's installed claude binary; the SDK is pointed at it instead of any bundled copy.
import { execFileSync } from 'node:child_process';
import { buildChildEnv } from './env.ts';

function resolve(): { path: string; version: string } {
  const path = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  const version = execFileSync(path, ['--version'], { encoding: 'utf8', env: buildChildEnv() }).trim();
  return { path, version };
}

export const CLAUDE = resolve();
