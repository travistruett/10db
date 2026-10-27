/**
 * Runs a project's gate command under the gate sandbox, as the daemon does at a lane's green run and
 * at ship, so a project's gate can be checked before 10db runs it. macOS only.
 *
 *   pnpm --filter @10db/daemon exec tsx scripts/sandboxed-gate.ts <checkout> [options] [-- <command>]
 *
 * Options: `--loopback` (the project's "Let lane commands use localhost"), `--host <name>` (an
 * allowed host, repeatable), `--read <path>` (a path on the project's read list, repeatable), `--log <path>` (default: in the temp dir). The command defaults to `make gate`. The env is this
 * process's own; the sandbox keeps only its allowlisted names, as it does with the login env.
 */
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createGit, resolveGit } from '../src/git';
import { silentLogger } from '../src/log';
import { resolveSandboxRuntime } from '../src/paths';
import { createGateSandbox } from '../src/sandbox';
import { createGateRunner } from '../src/verify';

const args = process.argv.slice(2);
const split = args.indexOf('--');
const options = split === -1 ? args : args.slice(0, split);
const command = split === -1 ? 'make gate' : args.slice(split + 1).join(' ');
const [target] = options;
if (target === undefined || target.startsWith('--')) {
  process.stderr.write(
    'usage: sandboxed-gate.ts <checkout> [--loopback] [--host <name>]... [--read <path>]... [-- <command>]\n',
  );
  process.exit(2);
}
const checkout = resolve(target);
const valuesOf = (flag: string): string[] =>
  options.flatMap((option, i) => (option === flag ? [options[i + 1] ?? ''] : []));
const hosts = valuesOf('--host');
const reads = valuesOf('--read').map((path) => resolve(path));
const logAt = options.indexOf('--log');
const logPath = resolve(
  logAt === -1 ? join(tmpdir(), '10db-sandboxed-gate.log') : (options[logAt + 1] ?? ''),
);
const env = Object.fromEntries(
  Object.entries(process.env).flatMap(([name, value]) =>
    value === undefined ? [] : [[name, value]],
  ),
);
const git = createGit({ bin: await resolveGit(), checkouts: () => [checkout] });
const gate = createGateRunner({
  sandbox: createGateSandbox({
    home: homedir(),
    dataDir: join(homedir(), 'Library', 'Application Support', '10db'),
    loginConfigDir: env['CLAUDE_CONFIG_DIR'] ?? null,
    gitDirs: (repo) => git.gitDirs(repo),
    runtime: resolveSandboxRuntime(),
  }),
  logger: silentLogger,
});
const result = await gate.run({
  project: { repoPath: checkout, sandboxLoopback: options.includes('--loopback') },
  command,
  logPath,
  timeoutMs: 3_600_000,
  env,
  rules: [
    ...hosts.map((pattern) => ({ toolName: 'SandboxNetworkAccess', pattern })),
    ...reads.map((pattern) => ({ toolName: 'Read', pattern })),
  ],
  checkouts: [checkout],
});
process.stdout.write(
  `${result.tail.slice(-1500)}\nexit ${String(result.exitCode)} in ${String(Math.round(result.durationMs / 1000))} s; log: ${result.logPath}\n`,
);
process.exit(result.exitCode === 0 ? 0 : 1);
