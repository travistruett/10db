import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './workspace';

export const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
export const DMG_NAME = '10db_0.1.0_aarch64.dmg';

/**
 * Stand-ins for the tools install-app.sh and rollback-app.sh drive. They are child processes this
 * repo doesn't own and that reach GitHub, the disk images subsystem or a real running 10db, so
 * every one is replaced; each logs its arguments to `$STUB_LOG` as one line.
 */
const STUBS: Record<string, readonly string[]> = {
  gh: [
    'case "$*" in',
    '  \'api repos/{owner}/{repo}/commits/\'*) [ -n "$STUB_HEAD_SHA" ] || exit 1; echo "$STUB_HEAD_SHA" ;;',
    '  \'api repos/{owner}/{repo}/actions/runs/\'*/artifacts*) echo "${STUB_ARTIFACT_LIVE:-1}" ;;',
    '  \'run list \'*\'--status success\'*) [ -z "$STUB_SUCCESS_RUN" ] || echo "$STUB_SUCCESS_RUN" ;;',
    "  'run list '*'--event workflow_dispatch'*) [ ! -f \"$STUB_STATE/dispatched\" ] || echo 101; echo 100 ;;",
    '  \'workflow run \'*) touch "$STUB_STATE/dispatched" ;;',
    '  \'run view \'*) printf \'%s\\n%s\\n%s\\n\' "${STUB_RUN_STATUS:-completed}" "${STUB_RUN_CONCLUSION-success}" "$STUB_HEAD_SHA" ;;',
    "  'run download '*)",
    '    while [ "$#" -gt 0 ]; do [ "$1" = --dir ] && dir="$2"; shift; done',
    '    mkdir -p "$dir" && cp -R "$STUB_ARTIFACT/." "$dir" ;;',
    '  *) echo "gh stub: unexpected $*" >&2; exit 3 ;;',
    'esac',
  ],
  pgrep: ['[ -n "${STUB_RUNNING:-}" ] || exit 1', 'echo "$STUB_RUNNING"'],
  sqlite3: [
    'case "$2" in',
    '  ".backup \'"*"\'") target=${2#".backup \'"}; cp "$1" "${target%"\'"}" ;;',
    '  *) echo "sqlite3 stub: unexpected $*" >&2; exit 3 ;;',
    'esac',
  ],
  hdiutil: [
    'case "$1" in',
    '  attach) while [ "$#" -gt 0 ]; do [ "$1" = -mountpoint ] && mount="$2"; shift; done',
    '    cp -R "$STUB_DMG_CONTENTS/." "$mount" ;;',
    '  detach) ;;',
    '  *) exit 3 ;;',
    'esac',
  ],
  ditto: [
    '[ -z "${STUB_DITTO_FAILS:-}" ] || { mkdir -p "$2/Contents"; exit 1; }',
    'cp -R "$1" "$2"',
  ],
  xattr: ['exit 0'],
};

export interface InstalledAppSandbox {
  readonly root: string;
  readonly applications: string;
  readonly dataDir: string;
  /** Runs a script under scripts/release/ with the stubs first on PATH. */
  run(
    script: string,
    args: readonly string[],
    env?: Record<string, string>,
  ): { status: number | null; stdout: string; stderr: string };
  /** One line per stub call, `<tool> <args>`. */
  calls(): string[];
  /** The marker file inside an app bundle, or null when the bundle has none. */
  marker(appPath: string): string | null;
  /** Every entry of a directory, sorted. */
  list(dir: string): string[];
  writeApp(path: string, marker: string): void;
  /** Rewrites SHA256SUMS so it no longer matches the DMG. */
  corruptChecksum(): void;
  remove(): void;
}

export function installedAppSandbox(): InstalledAppSandbox {
  const root = mkdtempSync(join(tmpdir(), 'installed-app-'));
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  const applications = join(root, 'Applications');
  const support = join(root, 'Application Support');
  const dataDir = join(support, '10db');
  const artifact = join(root, 'artifact');
  const dmgContents = join(root, 'dmg-contents');
  const log = join(state, 'calls.log');
  for (const dir of [bin, state, applications, dataDir, artifact, dmgContents]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const [tool, body] of Object.entries(STUBS)) {
    writeFileSync(
      join(bin, tool),
      ['#!/bin/bash', `printf '%s\\n' "${tool} $*" >> "$STUB_LOG"`, ...body, ''].join('\n'),
      { mode: 0o755 },
    );
  }

  const writeApp = (path: string, marker: string): void => {
    mkdirSync(join(path, 'Contents'), { recursive: true });
    writeFileSync(join(path, 'Contents', 'marker'), marker);
  };
  writeApp(join(applications, '10db.app'), 'old build');
  writeApp(join(dmgContents, '10db.app'), 'new build');
  writeFileSync(join(dataDir, '10db.sqlite'), 'the database');
  const dmg = 'disk image bytes';
  writeFileSync(join(artifact, DMG_NAME), dmg);
  const sum = createHash('sha256').update(dmg).digest('hex');
  writeFileSync(join(artifact, 'SHA256SUMS'), `${sum}  ${DMG_NAME}\n`);

  return {
    root,
    applications,
    dataDir,
    run(script, args, env = {}) {
      const result = spawnSync('/bin/bash', [join(repoRoot, 'scripts/release', script), ...args], {
        cwd: root,
        encoding: 'utf8',
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: root,
          TMPDIR: root,
          TENDB_INSTALL_APPLICATIONS_DIR: applications,
          TENDB_INSTALL_DATA_DIR: dataDir,
          TENDB_INSTALL_POLL_SECONDS: '0',
          STUB_LOG: log,
          STUB_STATE: state,
          STUB_HEAD_SHA: HEAD_SHA,
          STUB_SUCCESS_RUN: '42',
          STUB_ARTIFACT: artifact,
          STUB_DMG_CONTENTS: dmgContents,
          ...env,
        },
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    marker(appPath) {
      const file = join(appPath, 'Contents', 'marker');
      return existsSync(file) ? readFileSync(file, 'utf8') : null;
    },
    list: (dir) => readdirSync(dir).sort(),
    writeApp,
    corruptChecksum() {
      writeFileSync(join(artifact, 'SHA256SUMS'), `${'0'.repeat(64)}  ${DMG_NAME}\n`);
    },
    remove() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
