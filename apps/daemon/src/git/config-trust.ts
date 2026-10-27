/**
 * Which config keys the daemon's fetch and push accept from a file a lane could have written: the
 * checkout's local and worktree config, and any file in the checkout or its git dirs. It is an
 * allowlist: a key that names a program or redirects git (`core.sshCommand`, `url.*.insteadOf`,
 * `credential.*`, `http.proxy`, an include) is refused because it is not listed, and so is every key
 * git adds later. Global and system config are the builder's own and are not judged.
 *
 * It is defense in depth, not the boundary: lanes can't write the checkout's git dir at all, and
 * every other daemon git call is plumbing that reads no such key.
 */

/** Keys with no subsection, as `git config --list` prints them: section and key lowercase. */
const PLAIN_KEYS: ReadonlySet<string> = new Set([
  'core.repositoryformatversion',
  'core.filemode',
  'core.bare',
  'core.logallrefupdates',
  'core.ignorecase',
  'core.precomposeunicode',
  'core.symlinks',
  'core.autocrlf',
  'core.eol',
  'core.safecrlf',
  'core.checkstat',
  'core.trustctime',
  'core.untrackedcache',
  'core.splitindex',
  'core.sharedrepository',
  'core.commitgraph',
  'core.hookspath',
  'core.fsmonitor',
  'core.fsmonitorhookversion',
  'extensions.worktreeconfig',
  'extensions.objectformat',
  'extensions.refstorage',
  'user.name',
  'user.email',
  'user.signingkey',
  'commit.gpgsign',
  'tag.gpgsign',
  'gpg.format',
  'lfs.repositoryformatversion',
  'gc.auto',
  'gc.autodetach',
  'maintenance.auto',
  'receive.autogc',
  'fetch.prune',
  'push.default',
  'push.autosetupremote',
  'pull.rebase',
  'pull.ff',
  'init.defaultbranch',
  'rerere.enabled',
]);

/** Keys under a named subsection (`remote.<name>.url`); `any` accepts every key of the section. */
const SUBSECTION_KEYS: Readonly<Record<string, ReadonlySet<string> | 'any'>> = {
  remote: new Set([
    'url',
    'pushurl',
    'fetch',
    'push',
    'tagopt',
    'prune',
    'mirror',
    'skipdefaultupdate',
    'skipfetchall',
    // gh records which remote is the base repository here.
    'gh-resolved',
  ]),
  // Upstream tracking, descriptions and editor notes such as VS Code's `vscode-merge-base`.
  branch: 'any',
  submodule: new Set(['url', 'active', 'branch']),
  // git-lfs records, per endpoint, the auth mode it found and whether the server checks locks.
  lfs: new Set(['access', 'locksverify']),
};

/** True when the daemon's fetch or push may run with `name` set in a lane-writable file. */
export function isTrustedKey(name: string): boolean {
  const first = name.indexOf('.');
  const last = name.lastIndexOf('.');
  if (first <= 0 || last === name.length - 1) return false;
  const section = name.slice(0, first).toLowerCase();
  const key = name.slice(last + 1).toLowerCase();
  if (first === last) return PLAIN_KEYS.has(`${section}.${key}`);
  const keys = SUBSECTION_KEYS[section];
  return keys === 'any' || (keys?.has(key) ?? false);
}

/** One entry of `git config --list --show-scope --show-origin -z`. */
export interface ConfigEntry {
  readonly scope: string;
  readonly origin: string;
  readonly name: string;
  /** Null for a key written with no `=`, which git reads as true. */
  readonly value: string | null;
}

/**
 * Parses `--show-scope --show-origin -z` output: scope, origin and `name\nvalue` (or a bare name),
 * each NUL-ended.
 */
export function parseScopedConfig(text: string): ConfigEntry[] {
  const fields = text.split('\0');
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const pair = fields[i + 2] ?? '';
    const newline = pair.indexOf('\n');
    entries.push({
      scope: fields[i] ?? '',
      origin: fields[i + 1] ?? '',
      name: newline === -1 ? pair : pair.slice(0, newline),
      value: newline === -1 ? null : pair.slice(newline + 1),
    });
  }
  return entries;
}

/** Parses `--name-only -z` output: one NUL-ended name per entry. */
export function parseConfigNames(text: string): string[] {
  return text.split('\0').filter((name) => name !== '');
}
