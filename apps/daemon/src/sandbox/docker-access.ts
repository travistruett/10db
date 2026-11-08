import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isSandboxPath } from './profile';

/**
 * What a project's Docker switch opens for its gate and lanes. Docker can mount any host folder into
 * a container, so a command with the socket reaches outside the sandbox; the builder turns it on per
 * project (or 10db does, and says so), and nothing here is read for a project with it off.
 */
export interface DockerAccess {
  /** The engine sockets a command may connect to, each spelled as written and by its real path. */
  readonly sockets: readonly string[];
  /** What the CLI and its compose plugin read: exact files and dirs, never `~/.docker` whole. */
  readonly reads: readonly string[];
}

/** Where Docker Desktop, Colima, OrbStack and Rancher Desktop put the engine's socket. */
function knownSockets(home: string): string[] {
  return [
    '/var/run/docker.sock',
    join(home, '.docker', 'run', 'docker.sock'),
    join(home, '.colima', 'default', 'docker.sock'),
    join(home, '.orbstack', 'run', 'docker.sock'),
    join(home, '.rd', 'docker.sock'),
  ];
}

/** The path of a `unix://` `DOCKER_HOST`; null for any other host. */
function hostSocket(env: Readonly<Record<string, string>>): string | null {
  const match = /^unix:\/\/(\/.+)$/.exec(env['DOCKER_HOST'] ?? '');
  return match?.[1] ?? null;
}

function withRealPath(path: string): string[] {
  try {
    const real = realpathSync(path);
    return real === path ? [path] : [path, real];
  } catch {
    return [path];
  }
}

/**
 * The sockets and reads for a project with Docker on. `config.json` is opened as the one file: the
 * CLI reads it to find the engine's context and plugins, and anything else in `~/.docker` stays shut.
 * Docker already reaches the whole host, so the file adds nothing the socket does not.
 */
export function dockerAccess(home: string, env: Readonly<Record<string, string>>): DockerAccess {
  const named = hostSocket(env);
  const sockets = [...knownSockets(home), ...(named === null ? [] : [named])]
    .flatMap(withRealPath)
    .filter(isSandboxPath);
  const docker = join(home, '.docker');
  const reads = [
    '/Applications/Docker.app',
    '/usr/local/lib/docker',
    join(docker, 'config.json'),
    join(docker, 'cli-plugins'),
    join(docker, 'contexts'),
  ].flatMap(withRealPath);
  return { sockets: [...new Set(sockets)], reads: [...new Set(reads.filter(isSandboxPath))] };
}

/** The names a Docker command reads to find its engine and compose project. */
const DOCKER_NAMES: ReadonlySet<string> = new Set(['DOCKER_HOST', 'DOCKER_CONTEXT']);
const DOCKER_PREFIX = 'COMPOSE_';
// A name that reads like a credential stays out even under these.
const SECRET_LOOKING = /TOKEN|AUTH|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|COOKIE|SESSION/i;

/**
 * The names in `env` a sandboxed command with Docker on may inherit beyond the usual allowlist.
 * `DOCKER_CONFIG` is left out: it names a directory the CLI would read and run plugins from.
 */
export function dockerEnvNames(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env).filter(
    (name) =>
      !SECRET_LOOKING.test(name) && (DOCKER_NAMES.has(name) || name.startsWith(DOCKER_PREFIX)),
  );
}
