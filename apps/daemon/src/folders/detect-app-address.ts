import { posix } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { equalOrUnder } from '../git';

// Workbench setup: where the builder's dev server answers, from what is running now and from the
// repository's files at the commit its caller trusts (origin's base). Nothing of the repository runs.

/** A TCP port a process on this Mac listens on, as `lsof` lists it. */
export interface Listener {
  readonly port: number;
  /** The address it is bound to as `lsof -n` prints it: `127.0.0.1`, `*`, `[::1]`, `[::]`. */
  readonly host: string;
  /** The process's working directory, links resolved; null when it could not be read. */
  readonly cwd: string | null;
  readonly command: string;
}

/** One place the app may answer, and where that was found, in one line. */
export interface AddressCandidate {
  readonly url: string;
  readonly source: string;
  /** Said in the repository, listening now, or a framework's default port guessed. */
  readonly kind: CandidateKind;
  /** What the builder should know about it, such as that it is https. */
  readonly note?: string;
}

export const CandidateKind = { Stated: 'stated', Listener: 'listener', Guess: 'guess' } as const;
export type CandidateKind = (typeof CandidateKind)[keyof typeof CandidateKind];

/** Said of an https address: the pinned browser checks its certificate. */
export const HTTPS_NOTE = 'https: pictures need a trusted certificate';

/** The hosts an app address may name: this Mac's loopback, by the names that need no resolver. */
const APP_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

export interface AppAddressInput {
  /** The repository's top level, links resolved, as `lsof` reports a working directory. */
  readonly repoPath: string;
  /** The texts of the files `appAddressFiles` named, by path; a file left out was not readable. */
  readonly texts: ReadonlyMap<string, string>;
  readonly listeners: readonly Listener[];
  /** The package folder of the app's pages (`''` for the root); null when none is known. */
  readonly uiUnit: string | null;
  /** The daemon's own port, which is never the app's; null when not yet known. */
  readonly daemonPort: number | null;
}

/** How many candidates are probed: the first of them that answers is the app. */
export const PROBED = 3;

export const NOTHING_ANSWERED = 'Nothing answered there just now: start your dev server';

/** The compose service names that serve the app to a browser, most likely first. */
const APP_SERVICES = ['proxy', 'nginx', 'caddy', 'web', 'app', 'frontend'] as const;

/** Compose file names, base files before the overrides that extend them. */
const COMPOSE_NAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
  'compose.override.yaml',
  'compose.override.yml',
  'docker-compose.override.yaml',
  'docker-compose.override.yml',
];

const TAURI_CONFIG = /(?:^|\/)src-tauri\/tauri\.conf\.json$/;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const ENV_EXAMPLE = /(?:^|\/)\.env\.example$/;
const VITE_CONFIG = /^vite\.config\.(?:ts|mts|cts|js|mjs|cjs)$/;

/** Hosts a listener may be bound to and still answer on `localhost`. */
const LOOPBACK_BINDS = new Set(['*', '0.0.0.0', '[::]', '[::1]', '::1', '::', 'localhost']);

/** Variable names whose value is the app's own origin: `APP_URL`, `NEXT_PUBLIC_APP_ORIGIN` and the like. */
const ORIGIN_VALUE =
  /(?<![\w])([A-Z][A-Z0-9_]*?(?:APP_ORIGIN|APP_URL|BASE_URL)|APP_ORIGIN|APP_URL|BASE_URL)\s*[:=]\s*["']?([^\s"'#,}]+)/g;

const depth = (path: string): number => path.split('/').length;

/** Under a folder whose name starts with a dot (`.devcontainer/`, but not the root's own `.github/`). */
const inDotFolder = (path: string): boolean =>
  path
    .split('/')
    .slice(0, -1)
    .some((part) => part.startsWith('.'));

function composeFiles(files: readonly string[]): string[] {
  return files
    .filter((f) => COMPOSE_NAMES.includes(posix.basename(f)) && !inDotFolder(f))
    .sort(
      (a, b) =>
        depth(a) - depth(b) ||
        COMPOSE_NAMES.indexOf(posix.basename(a)) - COMPOSE_NAMES.indexOf(posix.basename(b)) ||
        a.localeCompare(b),
    );
}

const inUnit = (unit: string, name: string): string => (unit === '' ? name : `${unit}/${name}`);

/**
 * The tracked files the app address is read from, in the order they are read: compose files,
 * Tauri configs, workflows, `.env.example` files, and the UI unit's Vite config and `package.json`.
 */
export function appAddressFiles(files: readonly string[], uiUnit: string | null): string[] {
  const vite =
    uiUnit === null
      ? []
      : files.filter(
          (f) =>
            posix.dirname(f) === (uiUnit === '' ? '.' : uiUnit) &&
            VITE_CONFIG.test(posix.basename(f)),
        );
  const pkg = uiUnit === null ? [] : files.filter((f) => f === inUnit(uiUnit, 'package.json'));
  return [
    ...composeFiles(files),
    ...files.filter((f) => TAURI_CONFIG.test(f)),
    ...files.filter((f) => WORKFLOW.test(f)),
    ...files.filter((f) => ENV_EXAMPLE.test(f) && !inDotFolder(f)),
    ...vite,
    ...pkg,
  ];
}

/** `raw` as the origin of a loopback http address, or null when it is not one. */
function loopbackOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && APP_HOSTS.includes(url.hostname)
    ? url.origin
    : null;
}

const onPort = (port: number): string | null =>
  Number.isInteger(port) && port > 0 && port < 65536
    ? loopbackOrigin(`http://localhost:${String(port)}`)
    : null;

// Compose files are read from the repository: a boundary, so their shape is checked.
const PortNumber = z.union([z.int(), z.string()]);
const ComposePort = z.union([
  z.string(),
  z.number(),
  z.looseObject({
    published: PortNumber.optional(),
    host_ip: z.string().optional(),
    protocol: z.string().optional(),
  }),
]);
const ComposeFile = z.looseObject({
  services: z.record(
    z.string(),
    z.looseObject({ ports: z.array(ComposePort).optional() }).nullable(),
  ),
});

/** A compose `${VAR:-default}` with its default; any other variable leaves the value unknown. */
function withDefaults(value: string): string | null {
  const done = value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}$]*)\}/g, '$1');
  return done.includes('$') ? null : done;
}

const hostReached = (ip: string | undefined): boolean =>
  ip === undefined ||
  ip === '' ||
  ip === '0.0.0.0' ||
  ip === '::' ||
  ip === '127.0.0.1' ||
  ip === '::1' ||
  ip === 'localhost';

/** The host port a compose `ports` entry publishes on this Mac's loopback, or null. */
function publishedPort(entry: z.infer<typeof ComposePort>): number | null {
  if (typeof entry === 'number') return null;
  if (typeof entry === 'object') {
    if (entry.protocol !== undefined && entry.protocol !== 'tcp') return null;
    if (!hostReached(entry.host_ip)) return null;
    const published = entry.published === undefined ? null : withDefaults(String(entry.published));
    return published !== null && /^\d+$/.test(published) ? Number(published) : null;
  }
  const text = withDefaults(entry.trim());
  if (text === null) return null;
  const [spec = '', protocol = 'tcp'] = text.split('/');
  if (protocol !== 'tcp') return null;
  // `[ip:]host:container`; an IPv6 host ip is bracketed.
  const match = /^(?:(\[[^\]]*\]|[^:]+):)?(\d+):\d+$/.exec(spec);
  if (match === null) return null;
  const ip = match[1]?.replace(/^\[|\]$/g, '');
  return hostReached(ip) ? Number(match[2]) : null;
}

function composeCandidates(text: string): { service: string; port: number }[] {
  let raw: unknown;
  try {
    raw = parseYaml(text, { merge: true });
  } catch {
    return [];
  }
  const parsed = ComposeFile.safeParse(raw);
  if (!parsed.success) return [];
  const found: { service: string; port: number }[] = [];
  for (const service of APP_SERVICES) {
    const ports = parsed.data.services[service]?.ports ?? [];
    for (const entry of ports) {
      const port = publishedPort(entry);
      if (port !== null) found.push({ service, port });
    }
  }
  return found;
}

const TauriConfig = z.looseObject({ build: z.looseObject({ devUrl: z.string() }) });

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const PackageJson = z.looseObject({
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

/** The text inside the braces that open at `open`, or the rest of the text when they never close. */
function braced(text: string, open: number): string {
  let level = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') level++;
    else if (text[i] === '}' && --level === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** `server.port` as a number literal in a Vite config, or null. */
function vitePort(text: string): number | null {
  const server = /\bserver\s*:\s*\{/.exec(text);
  if (server === null) return null;
  const body = braced(text, server.index + server[0].length - 1);
  // Only the server object's own `port`, not one of an object nested in it (`hmr: { port }`).
  let flat = body;
  for (let open = flat.indexOf('{'); open !== -1; open = flat.indexOf('{')) {
    flat = flat.slice(0, open) + flat.slice(open + braced(flat, open).length + 2);
  }
  const port = /\bport\s*:\s*(\d{2,5})\b/.exec(flat);
  return port === null ? null : Number(port[1]);
}

const devScriptPort = (script: string): number | null => {
  const match = /(?:^|\s)(?:--port[=\s]|-p\s+)(\d{2,5})\b/.exec(script);
  return match === null ? null : Number(match[1]);
};

const relative = (repo: string, path: string): string =>
  path === repo ? 'the repository' : path.slice(repo.length + 1);

/**
 * Where the app may answer, most likely first, each a loopback origin once with where it was found:
 * a compose app service's published port; a Tauri `devUrl`; an app origin variable in a workflow,
 * `.env.example` or compose file; a server listening now whose working directory is in the
 * repository; then the UI unit's Vite `server.port`, its dev script's `--port`, and its framework's
 * default. The daemon's own port is never one. Pure.
 */
export function appAddressCandidates(input: AppAddressInput): AddressCandidate[] {
  const found: AddressCandidate[] = [];
  const add = (
    url: string | null,
    source: string,
    kind: CandidateKind = CandidateKind.Stated,
  ): void => {
    if (url === null || found.some((c) => c.url === url)) return;
    if (input.daemonPort !== null && new URL(url).port === String(input.daemonPort)) return;
    found.push({ url, source, kind, ...(url.startsWith('https:') ? { note: HTTPS_NOTE } : {}) });
  };
  const text = (path: string): string | undefined => input.texts.get(path);
  const paths = [...input.texts.keys()];

  const composes = composeFiles(paths);
  const published = composes.flatMap((path) =>
    composeCandidates(text(path) ?? '').map((c) => ({ ...c, path })),
  );
  for (const service of APP_SERVICES) {
    for (const c of published.filter((p) => p.service === service))
      add(onPort(c.port), `from ${c.path}: ${c.service} publishes ${String(c.port)}`);
  }

  for (const path of paths.filter((p) => TAURI_CONFIG.test(p))) {
    const parsed = TauriConfig.safeParse(jsonOf(text(path) ?? ''));
    if (parsed.success) add(loopbackOrigin(parsed.data.build.devUrl), `from ${path}: devUrl`);
  }

  const originFiles = [
    ...paths.filter((p) => WORKFLOW.test(p)),
    ...paths.filter((p) => ENV_EXAMPLE.test(p)),
    ...composes,
  ];
  for (const path of originFiles) {
    for (const match of (text(path) ?? '').matchAll(ORIGIN_VALUE)) {
      add(loopbackOrigin(match[2] ?? ''), `from ${path}: ${match[1] ?? ''}`);
    }
  }

  // A server running now comes after what the repository says, since any tool can listen in a
  // checkout (a static preview, a docs server), and before the guesses.
  for (const l of input.listeners) {
    if (l.cwd === null || !equalOrUnder(l.cwd, input.repoPath)) continue;
    if (!LOOPBACK_BINDS.has(l.host) && !l.host.startsWith('127.')) continue;
    add(
      onPort(l.port),
      `listening now: ${l.command} in ${relative(input.repoPath, l.cwd)} on port ${String(l.port)}`,
      CandidateKind.Listener,
    );
  }

  if (input.uiUnit !== null) {
    const unit = input.uiUnit;
    for (const path of paths.filter(
      (p) => posix.dirname(p) === (unit === '' ? '.' : unit) && VITE_CONFIG.test(posix.basename(p)),
    )) {
      const port = vitePort(text(path) ?? '');
      if (port !== null) add(onPort(port), `from ${path}: server.port`);
    }
    const pkgPath = inUnit(unit, 'package.json');
    const pkg = PackageJson.safeParse(jsonOf(text(pkgPath) ?? ''));
    if (pkg.success) {
      const dev = pkg.data.scripts?.['dev'];
      const port = dev === undefined ? null : devScriptPort(dev);
      if (port !== null) add(onPort(port), `from ${pkgPath}: the dev script`);
      const deps = { ...pkg.data.dependencies, ...pkg.data.devDependencies };
      if ('next' in deps) add(onPort(3000), "Next.js's default port", CandidateKind.Guess);
      if ('vite' in deps) add(onPort(5173), "Vite's default port", CandidateKind.Guess);
    }
  }
  return found;
}

/**
 * The candidates to probe: the first `PROBED`, with the last slot given to the first server listening
 * in the checkout when one is listed and none of the others is one.
 */
export function probedCandidates(candidates: readonly AddressCandidate[]): AddressCandidate[] {
  const top = candidates.slice(0, PROBED);
  const listener = candidates.find((c) => c.kind === CandidateKind.Listener);
  if (listener === undefined || top.includes(listener) || top.length < PROBED) return top;
  return [...top.slice(0, PROBED - 1), listener];
}

const withNote = (candidate: AddressCandidate, note: string | undefined): AddressCandidate => {
  const notes = [candidate.note, note].filter((n): n is string => n !== undefined);
  return { ...candidate, ...(notes.length === 0 ? {} : { note: notes.join('; ') }) };
};

/**
 * The app address to suggest from the probed candidates whose url `answered` holds: the first stated
 * one that answered; only when the repository states no address, a server listening in the checkout
 * that answered, then a framework's default that did; else the first candidate with a note to start
 * the dev server. Neither a listener nor a guess beats a stated address, even one that did not answer:
 * any tool (a docs server, a browser helper) can listen in a checkout, and anything can hold port
 * 3000, while the app is down. Null with no candidate.
 */
export function chooseAppAddress(
  candidates: readonly AddressCandidate[],
  answered: ReadonlySet<string>,
): AddressCandidate | null {
  const live = probedCandidates(candidates).filter((c) => answered.has(c.url));
  const stated = candidates.some((c) => c.kind === CandidateKind.Stated);
  const chosen =
    live.find((c) => c.kind === CandidateKind.Stated) ??
    (stated
      ? undefined
      : (live.find((c) => c.kind === CandidateKind.Listener) ??
        live.find((c) => c.kind === CandidateKind.Guess)));
  if (chosen !== undefined) return withNote(chosen, undefined);
  const first = candidates[0];
  return first === undefined ? null : withNote(first, NOTHING_ANSWERED);
}
