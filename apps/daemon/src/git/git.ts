import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, posix, sep } from 'node:path';
import { InvalidError } from '@10db/contracts';
import { resolveInRepo } from '../guard';
import { memoryPinStore, type CheckoutPin, type PinStore } from './checkout-pin';
import { checkoutIdentity, refusedCheckoutKeys, trustedValues } from './checkout-trust';
import { parseScopedConfig, type ConfigEntry } from './config-trust';
import { gitNetwork, type NetworkCall, type NetworkRun } from './network';
import { localRemotePath, parseRemoteUrl } from './remote-url';
import { GitError, runGit, type RunOptions } from './run';
import { GitTrustError, GitTrustFailure, type GitTrustDetail } from './trust-error';
import { embeddedRepository, GitMode, isGitComponent } from './worktree-files';

const OP_TRAILER = '10db-Op';
const OP_SEARCH_DEPTH = 200;
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/**
 * Config on every daemon git call beside `DAEMON_GIT_CONFIG`: no attributes file, git's own checks on
 * paths that would be `.git` on HFS+ or NTFS, and no submodule recursion.
 */
const NO_ATTRIBUTES: readonly string[] = [
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'core.protectHFS=true',
  '-c',
  'core.protectNTFS=true',
  '-c',
  'submodule.recurse=false',
];

export interface Git {
  /** The branch HEAD names; null when HEAD is detached. */
  currentBranch(repo: string): Promise<string | null>;
  /** The URL of remote `name`; null when the repository has no such remote. */
  remoteUrl(repo: string, name: string): Promise<string | null>;
  /** origin's push URL as pinned with the checkout, in its parsed form; null when none was pinned. */
  pinnedPushUrl(repo: string): Promise<string | null>;
  /** Updates `origin/<branch>` from origin's recorded fetch URL; the checkout is untouched. */
  fetch(repo: string, branch: string, net: NetworkCall): Promise<NetworkRun>;
  /** Creates `name` at `startPoint` and checks it out, with no upstream. */
  switchNewBranch(repo: string, name: string, startPoint: string): Promise<void>;
  /**
   * Pushes `branch` to the same name at origin's recorded push URL, never forced, and records it as
   * the branch's upstream. Resolves with how long the push ran and what it printed.
   */
  push(repo: string, branch: string, net: NetworkCall): Promise<NetworkRun>;
  head(repo: string): Promise<string>;
  /**
   * The repository's own git dir and its common dir, both absolute and real. They are the same
   * directory except in a linked worktree, whose common dir is the main repository's.
   */
  gitDirs(repo: string): Promise<{ gitDir: string; commonDir: string }>;
  /**
   * Paths whose worktree content differs from HEAD, and untracked paths git doesn't ignore, sorted.
   * With `only`, just those of `only`. Read without running git's status: no filter, fsmonitor or
   * submodule runs.
   */
  changedPaths(repo: string, only?: readonly string[]): Promise<string[]>;
  /** Committed and uncommitted changes since `base`, sorted and unique. */
  changedFilesSince(repo: string, base: string): Promise<string[]>;
  /** Commits on `tip` (HEAD unless named) since `base`, oldest first. */
  commitsSince(repo: string, base: string, tip?: string): Promise<string[]>;
  /** Filters the tree at `rev`, or the checkout's own attributes, ask for; empty when none. */
  filtersIn(repo: string, rev: string): Promise<{ path: string; filter: string }[]>;
  /**
   * Commits `paths` on `branch` without touching HEAD: the tree is the branch's tip with those
   * paths as the worktree has them, and the branch moves only if nothing moved it meanwhile.
   */
  commit(input: {
    repo: string;
    paths: readonly string[];
    message: string;
    opId: string;
    branch: string;
  }): Promise<{ sha: string; alreadyCommitted: boolean }>;
  /**
   * Pins `candidate`, the state a refusal card showed the builder, if the checkout still matches it;
   * otherwise refuses again with what it found. The builder's choice only.
   */
  retrust(repo: string, candidate: CheckoutPin): Promise<void>;
}

export interface GitOptions {
  /** Called with every refusal, so the builder hears of it whoever called. */
  onRefused?(error: GitTrustError): void;
  /** Where pins persist; the default lasts as long as this `Git`. */
  pins?: PinStore;
  /** The git to run for every call, as `resolveGit` found it; `git` on PATH otherwise. */
  bin?: string;
  /** Directories a lane can write besides the checkout, such as the lane temp root. */
  laneRoots?: readonly string[];
}

/** Lexical checks first, then the guard's symlink-aware check, so `link/x` can't commit outside the repo. */
function checkPaths(repo: string, paths: readonly string[]): string[] {
  return paths.map((p) => {
    const clean = normalize(p);
    const lexicallyBad =
      p === '' || isAbsolute(p) || clean === '.' || clean === '..' || clean.startsWith(`..${sep}`);
    if (lexicallyBad || !resolveInRepo(repo, clean).inside) {
      throw new InvalidError(
        `Path ${JSON.stringify(p)} must be relative and inside the repository`,
      );
    }
    return clean;
  });
}

/** `message` with the op trailer, joined to a trailer block the message already ends with. */
export function withOpTrailer(message: string, opId: string): string {
  const body = message.replace(/\s+$/, '');
  const paragraphs = body.split(/\n[ \t]*\n/);
  const last = paragraphs.at(-1) ?? '';
  const endsInTrailers =
    paragraphs.length > 1 && last.split('\n').every((line) => /^[A-Za-z0-9-]+: \S/.test(line));
  return `${body}${endsInTrailers ? '\n' : '\n\n'}${OP_TRAILER}: ${opId}\n`;
}

function isTrue(value: string | null | undefined): boolean {
  return value === null || ['true', 'yes', 'on', '1'].includes((value ?? '').toLowerCase());
}

/** `ls-tree -r -z` output as entries. */
function parseTree(out: string): { mode: string; oid: string; path: string }[] {
  return out
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf('\t');
      const [mode = '', , oid = ''] = record.slice(0, tab).split(' ');
      return { mode, oid, path: record.slice(tab + 1) };
    });
}

/** `filter=<name>` settings in one attributes file's text. */
function filtersInAttributes(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    for (const token of trimmed.split(/\s+/).slice(1)) {
      const match = /^filter=(.+)$/.exec(token);
      if (match?.[1]) names.push(match[1]);
    }
  }
  return names;
}

function readIfPresent(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * The daemon's git (lane sandbox spec D13). It never runs a filter, an attribute-selected driver,
 * fsmonitor, a hook or a submodule's git in the working tree: commits are plumbing over a private
 * index, changes are found by hashing files the daemon reads itself, every call passes
 * `DAEMON_GIT_CONFIG` and a cleaned environment, and the one checkout it makes (a batch's new
 * branch) reads no attributes from the tree. Every call first checks that the checkout's git dirs
 * are the ones pinned for it and that it borrows no objects. Fetch and push go only to the URLs
 * pinned with it, with the builder's own transport config.
 */
export function createGit(opts: GitOptions = {}): Git {
  const locks = new Map<string, Promise<unknown>>();
  const pins = opts.pins ?? memoryPinStore();
  const bin = opts.bin ?? 'git';

  function refusal(repo: string, detail: GitTrustDetail): GitTrustError {
    const error = new GitTrustError(repo, detail);
    opts.onRefused?.(error);
    return error;
  }

  /** Runs `fn` after every earlier locked call for the same checkout has settled. */
  function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(repo) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    locks.set(
      repo,
      next.catch(() => undefined),
    );
    return next;
  }

  /** Each checkout's empty tree, as an attribute source that gives git no attributes at all. */
  const emptyTrees = new Map<string, string>();
  async function emptyTree(repo: string, at: Readonly<Record<string, string>>): Promise<string> {
    const known = emptyTrees.get(repo);
    if (known) return known;
    const oid = (
      await runGit(repo, ['hash-object', '-t', 'tree', '--stdin'], { env: at, bin })
    ).trim();
    emptyTrees.set(repo, oid);
    return oid;
  }

  /**
   * Where git works for `repo`: once it is pinned, the pinned git dir and the checkout as its work
   * tree, so git never reads the checkout's `.git` gitfile again, which a lane could swap between two
   * calls. Before that, and when observing what the checkout is now, git finds its own way.
   */
  function locate(repo: string, observed: boolean): Record<string, string> {
    const pin = observed ? undefined : pins.get(repo);
    return pin ? { GIT_DIR: pin.gitDir, GIT_WORK_TREE: repo } : {};
  }

  /**
   * Every daemon git call reads no attributes, from the tree, the worktree or an attributes file, so
   * no filter, driver or line-ending conversion is selected whatever config names. Paths are checked
   * as git does on HFS+ and NTFS, and no submodule is recursed into.
   */
  async function git(
    repo: string,
    args: readonly string[],
    run: RunOptions = {},
    observed = false,
  ) {
    const at = locate(repo, observed);
    return runGit(repo, args, {
      ...run,
      bin,
      env: { ...at, GIT_ATTR_SOURCE: await emptyTree(repo, at), ...run.env },
      config: [...NO_ATTRIBUTES, ...(run.config ?? [])],
    });
  }

  async function readGitDirs(repo: string): Promise<{ gitDir: string; commonDir: string }> {
    // Without --path-format a common dir is printed relative to the working directory.
    const out = await git(
      repo,
      ['rev-parse', '--absolute-git-dir', '--path-format=absolute', '--git-common-dir'],
      {},
      true,
    );
    const [gitDir = '', commonDir = ''] = out.split('\n');
    if (!isAbsolute(gitDir) || !isAbsolute(commonDir)) {
      throw new GitError(['rev-parse'], 'git named no absolute git dirs', null);
    }
    return { gitDir: realpathSync(gitDir), commonDir: realpathSync(commonDir) };
  }

  /** origin's URL as git would use it, credentials and all; null when there is no origin. */
  async function originUrl(repo: string, push: boolean, observed = false): Promise<string | null> {
    try {
      const out = await git(
        repo,
        ['remote', 'get-url', ...(push ? ['--push'] : []), 'origin'],
        {},
        observed,
      );
      return out.trim();
    } catch (error) {
      if (error instanceof GitError && /no such remote/i.test(error.stderr)) return null;
      throw error;
    }
  }

  /**
   * origin's URL as pins hold it: the parsed form, or null when there is no origin or its URL is
   * one the daemon refuses (credentials in it, or anything that doesn't parse cleanly).
   */
  async function pinnableUrl(
    repo: string,
    push: boolean,
    observed = false,
  ): Promise<string | null> {
    const url = await originUrl(repo, push, observed);
    if (url === null) return null;
    const parsed = parseRemoteUrl(url);
    return parsed.ok ? parsed.url : null;
  }

  /** The checkout as it is now, in the shape of a pin. */
  async function observe(real: string): Promise<CheckoutPin> {
    const dirs = await readGitDirs(real);
    return {
      ...dirs,
      id: checkoutIdentity(dirs),
      fetchUrl: await pinnableUrl(real, false, true),
      pushUrl: await pinnableUrl(real, true, true),
    };
  }

  /** A refusal for a checkout that differs from `pin` in its git dirs or origin. */
  function mismatch(real: string, pin: CheckoutPin, now: CheckoutPin): GitTrustError {
    if (now.id !== pin.id || now.gitDir !== pin.gitDir || now.commonDir !== pin.commonDir)
      return refusal(real, {
        kind: GitTrustFailure.Moved,
        pinned: pin.gitDir,
        found: now.gitDir,
        candidate: now,
      });
    const direction = now.fetchUrl === pin.fetchUrl ? 'push' : 'fetch';
    return refusal(real, {
      kind: GitTrustFailure.Origin,
      direction,
      pinned: direction === 'fetch' ? pin.fetchUrl : pin.pushUrl,
      found: direction === 'fetch' ? now.fetchUrl : now.pushUrl,
      candidate: now,
    });
  }

  /**
   * The checkout's real path, git dirs and pin, after checking they match the pin (recorded now when
   * there is none), that the object store borrows from no other repository, and that no attributes
   * file sits in the git dirs, where the attribute source can't switch it off.
   */
  async function pinned(
    repo: string,
  ): Promise<{ real: string; dirs: { gitDir: string; commonDir: string }; pin: CheckoutPin }> {
    const real = realpathSync(repo);
    const dirs = await readGitDirs(real);
    const id = checkoutIdentity(dirs);
    let pin = pins.get(real);
    if (!pin) {
      pin = {
        ...dirs,
        id,
        fetchUrl: await pinnableUrl(real, false),
        pushUrl: await pinnableUrl(real, true),
      };
      pins.set(real, pin);
    } else if (pin.id !== id || pin.gitDir !== dirs.gitDir || pin.commonDir !== dirs.commonDir) {
      throw mismatch(real, pin, await observe(real));
    }
    for (const name of ['alternates', 'http-alternates']) {
      const file = join(dirs.commonDir, 'objects', 'info', name);
      if (readIfPresent(file).trim() !== '')
        throw refusal(real, { kind: GitTrustFailure.Alternates, file });
    }
    for (const dir of new Set([dirs.gitDir, dirs.commonDir])) {
      const file = join(dir, 'info', 'attributes');
      if (readIfPresent(file).trim() !== '')
        throw refusal(real, { kind: GitTrustFailure.Attributes, file });
    }
    return { real, dirs, pin };
  }

  async function configEntries(repo: string): Promise<ConfigEntry[]> {
    return parseScopedConfig(
      await git(repo, ['config', '--list', '--show-scope', '--show-origin', '-z']),
    );
  }

  async function currentBranch(repo: string): Promise<string | null> {
    try {
      const ref = (await git(repo, ['symbolic-ref', '-q', 'HEAD'])).trim();
      return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) return null;
      throw error;
    }
  }

  async function revParse(repo: string, rev: string): Promise<string | null> {
    try {
      const oid = (await git(repo, ['rev-parse', '--verify', '-q', rev])).trim();
      return OBJECT_ID.test(oid) ? oid : null;
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) return null;
      throw error;
    }
  }

  /** Runs `fn` with a private index file seeded from `tip` (empty when null), removed afterwards. */
  async function withPrivateIndex<T>(
    repo: string,
    tip: string | null,
    fn: (env: { GIT_INDEX_FILE: string; GIT_LITERAL_PATHSPECS: string }) => Promise<T>,
  ): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), '10db-index-'));
    const env = { GIT_INDEX_FILE: join(dir, 'index'), GIT_LITERAL_PATHSPECS: '1' };
    try {
      await git(repo, tip === null ? ['read-tree', '--empty'] : ['read-tree', tip], { env });
      return await fn(env);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function changedPaths(repo: string, only?: readonly string[]): Promise<string[]> {
    const { real } = await pinned(repo);
    if (only?.length === 0) return [];
    const tip = await revParse(real, 'HEAD^{commit}');
    // Against a private index seeded from HEAD, so the checkout's own index is never refreshed, and
    // with no attributes, so git compares bytes as they are.
    const out = await withPrivateIndex(real, tip, (env) =>
      git(
        real,
        [
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--ignore-submodules=all',
          '--no-renames',
          '--',
          ...(only ?? []),
        ],
        { env },
      ),
    );
    const paths = out
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(3));
    return [...new Set(paths)].sort();
  }

  async function findCommitByOp(repo: string, tip: string, opId: string): Promise<string | null> {
    const out = await git(repo, [
      'log',
      '--no-show-signature',
      '-n',
      String(OP_SEARCH_DEPTH),
      `--format=%H%x1f%(trailers:key=${OP_TRAILER},valueonly,separator=%x2c)%x1e`,
      tip,
    ]);
    for (const record of out.split('\x1e')) {
      const [sha, ops] = record.trim().split('\x1f');
      if (
        sha &&
        OBJECT_ID.test(sha) &&
        ops
          ?.split(',')
          .map((o) => o.trim())
          .includes(opId)
      ) {
        return sha;
      }
    }
    return null;
  }

  /** `-c` pins and flags that sign a commit only as the builder's own config says. */
  function signing(
    real: string,
    dirs: { gitDir: string; commonDir: string },
    entries: readonly ConfigEntry[],
  ): { config: string[]; flags: string[] } {
    const last = (key: string): string | null | undefined =>
      trustedValues(real, dirs, entries, key).at(-1);
    if (!isTrue(last('commit.gpgsign') ?? 'false')) return { config: [], flags: [] };
    // Every program signing could run comes from the builder's config or git's default, never
    // from a file a lane could have written.
    const pinnedKeys: [string, string][] = [
      ['gpg.format', last('gpg.format') ?? 'openpgp'],
      ['gpg.program', last('gpg.program') ?? 'gpg'],
      ['gpg.openpgp.program', last('gpg.openpgp.program') ?? last('gpg.program') ?? 'gpg'],
      ['gpg.x509.program', last('gpg.x509.program') ?? 'gpgsm'],
      ['gpg.ssh.program', last('gpg.ssh.program') ?? 'ssh-keygen'],
      ['gpg.ssh.defaultKeyCommand', last('gpg.ssh.defaultkeycommand') ?? 'false'],
    ];
    const key = last('user.signingkey');
    return {
      config: pinnedKeys.flatMap(([k, v]) => ['-c', `${k}=${v}`]),
      flags: [key ? `-S${key}` : '-S'],
    };
  }

  /**
   * Paths whose worktree attributes ask for a filter. The commit stores bytes as they are, which for
   * such a path (a Git LFS file, say) is not what the repository expects, so it is refused. Reading
   * attributes runs no program; this is the one call that reads them.
   */
  async function filteredPaths(
    real: string,
    paths: readonly string[],
  ): Promise<{ path: string; filter: string }[]> {
    if (paths.length === 0) return [];
    const out = await runGit(real, ['check-attr', '-z', '--stdin', 'filter'], {
      input: `${paths.join('\0')}\0`,
      env: { GIT_LITERAL_PATHSPECS: '1' },
      config: ['-c', 'core.attributesFile=/dev/null'],
    });
    const fields = out.split('\0');
    const found: { path: string; filter: string }[] = [];
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const value = fields[i + 2] ?? '';
      if (!['unspecified', 'unset'].includes(value))
        found.push({ path: fields[i] ?? '', filter: value });
    }
    return found;
  }

  async function filtersIn(repo: string, rev: string): Promise<{ path: string; filter: string }[]> {
    const { real } = await pinned(repo);
    const found: { path: string; filter: string }[] = [];
    const tip = await revParse(real, `${rev}^{commit}`);
    if (tip) {
      for (const entry of parseTree(await git(real, ['ls-tree', '-r', '-z', '--full-tree', tip]))) {
        if (posix.basename(entry.path) !== '.gitattributes' || entry.mode === GitMode.Gitlink)
          continue;
        const text = await git(real, ['cat-file', 'blob', entry.oid]);
        for (const filter of filtersInAttributes(text)) found.push({ path: entry.path, filter });
      }
    }
    return found;
  }

  /** The config a fetch or push runs with: the allowlist checked, transport programs pinned. */
  async function networkConfig(
    real: string,
    dirs: { gitDir: string; commonDir: string },
  ): Promise<string[]> {
    const entries = await configEntries(real);
    const keys = refusedCheckoutKeys(real, dirs, entries);
    if (keys.length > 0) throw refusal(real, { kind: GitTrustFailure.Config, keys });
    const trusted = (key: string) => trustedValues(real, dirs, entries, key);
    // Every helper the builder's own config names, URL-scoped ones (`gh auth setup-git`'s) included,
    // in git's order, each under its own key.
    const helpers = entries.filter(
      (entry) =>
        /^credential\.(.+\.)?helper$/i.test(entry.name) &&
        entry.value !== null &&
        trustedValues(real, dirs, [entry], entry.name).length > 0,
    );
    return [
      ...NO_ATTRIBUTES,
      // An empty helper resets the list, URL-scoped helpers included; then only the builder's own
      // helpers follow.
      '-c',
      'credential.helper=',
      ...helpers.flatMap((helper) => ['-c', `${helper.name}=${helper.value ?? ''}`]),
      '-c',
      `core.sshCommand=${trusted('core.sshcommand').at(-1) ?? 'ssh'}`,
      '-c',
      `core.askPass=${trusted('core.askpass').at(-1) ?? ''}`,
      '-c',
      'protocol.ext.allow=never',
    ];
  }

  /**
   * The pinned URL the network call uses, after checking origin's URL now parses cleanly, carries no
   * credentials and is the one pinned. The raw config string never reaches the network call.
   */
  async function pinnedUrl(
    real: string,
    pin: CheckoutPin,
    direction: 'fetch' | 'push',
  ): Promise<string> {
    const pinnedValue = direction === 'fetch' ? pin.fetchUrl : pin.pushUrl;
    const current = await originUrl(real, direction === 'push');
    const parsed = current === null ? null : parseRemoteUrl(current);
    if (parsed?.ok === false)
      throw refusal(real, { kind: GitTrustFailure.Remote, direction, why: parsed.why });
    const found = parsed?.url ?? null;
    if (pinnedValue === null || found !== pinnedValue)
      throw refusal(real, {
        kind: GitTrustFailure.Origin,
        direction,
        pinned: pinnedValue,
        found,
        candidate: await observe(real),
      });
    const local = localRemotePath(pinnedValue);
    if (local !== null) {
      const where = existsSync(local) ? realpathSync(local) : local;
      if (
        [real, ...(opts.laneRoots ?? [])].some(
          (root) => where === root || where.startsWith(root + sep),
        )
      )
        throw refusal(real, {
          kind: GitTrustFailure.Remote,
          direction,
          why: "is inside the checkout or a lane's temp dir, where a lane could write its hooks",
        });
    }
    return pinnedValue;
  }

  /**
   * Creates `name` at `startPoint` and checks it out: `update-ref` makes the branch only if it is
   * new, and `read-tree -m -u` moves the clean checkout to it. Git checks every path it writes and
   * writes nothing beyond a link; with no attributes, no filter runs, and `read-tree` runs no hook.
   */
  async function switchCheckout(real: string, name: string, startPoint: string): Promise<void> {
    const target = await revParse(real, `${startPoint}^{commit}`);
    if (target === null) throw new InvalidError(`${startPoint} names no commit`);
    if ((await changedPaths(real)).length > 0)
      throw new InvalidError(
        `${real} has uncommitted changes; 10db switches only a clean checkout`,
      );
    const from = await revParse(real, 'HEAD^{commit}');
    const ref = `refs/heads/${name}`;
    try {
      // The zero old value creates the branch only if it doesn't exist yet.
      await git(real, ['update-ref', '--no-deref', ref, target, '0'.repeat(target.length)]);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      throw new InvalidError(`A branch named ${name} already exists, or the name is not valid`);
    }
    try {
      await git(real, ['read-tree', '-m', '-u', ...(from ? [from] : []), target]);
    } catch (error) {
      await git(real, ['update-ref', '-d', ref, target]).catch(() => undefined);
      if (!(error instanceof GitError)) throw error;
      throw new InvalidError(`10db could not check out ${startPoint}: ${error.message}`);
    }
    await git(real, ['symbolic-ref', 'HEAD', ref]);
  }

  /** The index entries a commit covers, from a private index after `git add`; refused if unsafe. */
  async function stage(
    real: string,
    env: { GIT_INDEX_FILE: string; GIT_LITERAL_PATHSPECS: string },
    named: readonly string[],
    tip: string,
  ): Promise<string[]> {
    for (const name of named) {
      const embedded = embeddedRepository(real, name);
      if (embedded !== null)
        throw refusal(real, { kind: GitTrustFailure.Embedded, path: embedded });
    }
    try {
      await git(real, ['add', '-A', '--', ...named], { env });
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      if (/pathspec .* did not match/i.test(error.stderr))
        throw new InvalidError(
          `No file or change at ${named.join(', ')}: a path must exist or have been deleted since the last commit`,
        );
      throw new InvalidError(`10db could not stage ${named.join(', ')}: ${error.message}`);
    }
    const changed = (
      await git(real, ['diff-index', '--cached', '--name-only', '-z', '--no-renames', tip], { env })
    )
      .split('\0')
      .filter(Boolean);
    // Nothing staged: `ls-files` with no path would list the whole index, submodules and all.
    if (changed.length === 0) return [];
    // What this commit changes may not be a submodule or name a git dir; submodules already in the
    // tree stay as they are.
    for (const record of (await git(real, ['ls-files', '-s', '-z', '--', ...changed], { env }))
      .split('\0')
      .filter(Boolean)) {
      const [mode = ''] = record.split(' ');
      const path = record.slice(record.indexOf('\t') + 1);
      if (mode === GitMode.Gitlink || path.split('/').some(isGitComponent))
        throw refusal(real, { kind: GitTrustFailure.Embedded, path });
    }
    return changed;
  }

  async function commit(input: {
    repo: string;
    paths: readonly string[];
    message: string;
    opId: string;
    branch: string;
  }): Promise<{ sha: string; alreadyCommitted: boolean }> {
    const named = checkPaths(input.repo, input.paths);
    const { real, dirs } = await pinned(input.repo);
    return withRepoLock(real, async () => {
      const ref = `refs/heads/${input.branch}`;
      try {
        const target = (await git(real, ['symbolic-ref', '-q', ref])).trim();
        if (target !== '')
          throw refusal(real, { kind: GitTrustFailure.Ref, ref, reason: 'symbolic' });
      } catch (error) {
        if (!(error instanceof GitError && error.exitCode === 1)) throw error;
      }
      const tip = await revParse(real, `${ref}^{commit}`);
      if (tip === null) throw new InvalidError(`Branch ${input.branch} does not exist`);
      const head = await currentBranch(real);
      if (head !== input.branch)
        throw refusal(real, {
          kind: GitTrustFailure.Branch,
          expected: input.branch,
          found: head,
          committed: false,
        });
      const existing = await findCommitByOp(real, tip, input.opId);
      if (existing) return { sha: existing, alreadyCommitted: true };
      const tree = await withPrivateIndex(real, tip, async (env) => {
        const changed = await stage(real, env, named, tip);
        const filtered = await filteredPaths(real, changed);
        if (filtered.length > 0)
          throw refusal(real, { kind: GitTrustFailure.Filter, paths: filtered });
        return (await git(real, ['write-tree'], { env })).trim();
      });
      if (tree === (await revParse(real, `${tip}^{tree}`)))
        throw new InvalidError(`Nothing to commit in ${named.join(', ')}`);
      const sign = signing(real, dirs, await configEntries(real));
      const sha = (
        await git(real, ['commit-tree', ...sign.flags, tree, '-p', tip], {
          input: withOpTrailer(input.message, input.opId),
          config: sign.config,
        })
      ).trim();
      try {
        // Compare and swap on the branch itself, never through HEAD or a symbolic ref.
        await git(real, ['update-ref', '--no-deref', '-m', `10db: ${input.opId}`, ref, sha, tip]);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        throw refusal(real, { kind: GitTrustFailure.Ref, ref, reason: 'raced' });
      }
      if ((await currentBranch(real)) === input.branch) {
        // The checkout's own index follows the commit, so the builder's git status shows the
        // committed paths as committed. Another git holding index.lock just leaves it stale.
        await git(real, ['reset', '-q', sha, '--', ...named], {
          env: { GIT_LITERAL_PATHSPECS: '1' },
        }).catch(() => undefined);
      } else {
        refusal(real, {
          kind: GitTrustFailure.Branch,
          expected: input.branch,
          found: await currentBranch(real),
          committed: true,
        });
      }
      return { sha, alreadyCommitted: false };
    });
  }

  return {
    async currentBranch(repo) {
      const { real } = await pinned(repo);
      return currentBranch(real);
    },
    async remoteUrl(repo, name) {
      const { real } = await pinned(repo);
      try {
        return (await git(real, ['remote', 'get-url', name])).trim();
      } catch (error) {
        if (error instanceof GitError && /no such remote/i.test(error.stderr)) return null;
        throw error;
      }
    },
    async pinnedPushUrl(repo) {
      return (await pinned(repo)).pin.pushUrl;
    },
    async fetch(repo, branch, net) {
      const { real, dirs, pin } = await pinned(repo);
      const config = await networkConfig(real, dirs);
      const url = await pinnedUrl(real, pin, 'fetch');
      return gitNetwork(
        real,
        config,
        [
          'fetch',
          '--no-tags',
          '--no-recurse-submodules',
          '--',
          url,
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ],
        net,
        { bin, env: locate(real, false) },
      );
    },
    async switchNewBranch(repo, name, startPoint) {
      const { real } = await pinned(repo);
      await withRepoLock(real, () => switchCheckout(real, name, startPoint));
    },
    async push(repo, branch, net) {
      const { real, dirs, pin } = await pinned(repo);
      const filters = await filtersIn(real, `refs/heads/${branch}`);
      if (filters.length > 0) throw refusal(real, { kind: GitTrustFailure.Filter, paths: filters });
      const config = await networkConfig(real, dirs);
      const url = await pinnedUrl(real, pin, 'push');
      const sha = await revParse(real, `refs/heads/${branch}^{commit}`);
      if (sha === null) throw new InvalidError(`Branch ${branch} does not exist`);
      const run = await gitNetwork(
        real,
        config,
        ['push', '--recurse-submodules=no', '--', url, `refs/heads/${branch}:refs/heads/${branch}`],
        net,
        { bin, env: locate(real, false) },
      );
      // What `push -u origin` records, written by the daemon since the push named a URL.
      await git(real, ['update-ref', `refs/remotes/origin/${branch}`, sha]);
      await git(real, ['config', `branch.${branch}.remote`, 'origin']);
      await git(real, ['config', `branch.${branch}.merge`, `refs/heads/${branch}`]);
      return run;
    },
    async head(repo) {
      const { real } = await pinned(repo);
      const sha = await revParse(real, 'HEAD^{commit}');
      if (sha === null) throw new GitError(['rev-parse', 'HEAD'], 'HEAD names no commit', null);
      return sha;
    },
    async gitDirs(repo) {
      return (await pinned(repo)).dirs;
    },
    changedPaths,
    async changedFilesSince(repo, base) {
      const working = await changedPaths(repo);
      const real = realpathSync(repo);
      const committed = (
        await git(real, ['diff-tree', '-r', '--name-only', '--no-renames', '-z', base, 'HEAD'])
      )
        .split('\0')
        .filter(Boolean);
      return [...new Set([...committed, ...working])].sort();
    },
    async commitsSince(repo, base, tip = 'HEAD') {
      const { real } = await pinned(repo);
      return (await git(real, ['rev-list', '--reverse', `${base}..${tip}`]))
        .split('\n')
        .filter(Boolean);
    },
    filtersIn,
    commit,
    async retrust(repo, candidate) {
      const real = realpathSync(repo);
      const now = await observe(real);
      const same =
        now.id === candidate.id &&
        now.gitDir === candidate.gitDir &&
        now.commonDir === candidate.commonDir &&
        now.fetchUrl === candidate.fetchUrl &&
        now.pushUrl === candidate.pushUrl;
      if (!same) throw mismatch(real, candidate, now);
      pins.set(real, candidate);
    },
  };
}
