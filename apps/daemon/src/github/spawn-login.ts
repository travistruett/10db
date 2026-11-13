import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ghEnvironment, type GhTools } from './gh';
import type { GhLoginChild, GhLoginSpawn } from './login';

/** The page opens in the app, so gh's own browser launch runs a command that does nothing. */
const NO_BROWSER = '/usr/bin/true';

/**
 * Runs the real `gh auth login --web` for a Sign In: stdin closed (nobody can answer a prompt), in an
 * empty directory of its own, in the environment every daemon gh gets, and with gh's own browser launch
 * turned off. The login lands in gh's own config, shared with the builder's terminal.
 */
export function spawnGhLogin(tools: Pick<GhTools, 'git'>): GhLoginSpawn {
  return (gh, loginEnv) => {
    const cwd = mkdtempSync(join(tmpdir(), '10db-gh-login-'));
    const rest = Object.fromEntries(
      Object.entries(ghEnvironment(tools, loginEnv)).filter(([name]) => name !== 'BROWSER'),
    );
    const child = spawn(
      gh,
      [
        'auth',
        'login',
        '--web',
        '--hostname',
        'github.com',
        '--git-protocol',
        'https',
        '--skip-ssh-key',
      ],
      { cwd, env: { ...rest, GH_BROWSER: NO_BROWSER }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exits: ((code: number | null) => void)[] = [];
    let ended = false;
    const end = (code: number | null): void => {
      if (ended) return;
      ended = true;
      rmSync(cwd, { recursive: true, force: true });
      for (const listener of exits) listener(code);
    };
    child.on('close', (code) => {
      end(code);
    });
    // A program that cannot start is an exit with no code, like a killed one.
    child.on('error', () => {
      end(null);
    });
    const result: GhLoginChild = {
      onOutput(listener) {
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          listener('stdout', chunk);
        });
        child.stderr.on('data', (chunk: string) => {
          listener('stderr', chunk);
        });
      },
      onExit(listener) {
        exits.push(listener);
      },
      kill(signal) {
        child.kill(signal);
      },
    };
    return result;
  };
}
