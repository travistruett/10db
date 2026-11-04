import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './workspace';

export const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
export const DMG_NAME = '10db_0.1.0_aarch64.dmg';

/** Counts calls to a stub in `$STUB_STATE/<name>` and leaves the count in `$n`. */
const count = (name: string): string =>
  `n=$(( $(cat "$STUB_STATE/${name}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_STATE/${name}"`;

/**
 * BSD pgrep and pkill leave out the caller and its ancestors unless given -a, so a script started
 * by the app cannot see it without that flag. Stubs answer "no match" there (STUB_APP_IS_ANCESTOR).
 */
const MISSES_ANCESTOR = [
  'if [ -n "${STUB_APP_IS_ANCESTOR:-}" ]; then',
  '  ancestors=""; for arg in "$@"; do case "$arg" in -*a*) ancestors=1 ;; esac; done',
  '  [ -n "$ancestors" ] || exit 1',
  'fi',
];

/**
 * Hands over to the real tool for the tests of the real one (STUB_REAL_APP_ROOT). Only its flags
 * pass through: the pattern is replaced by one that matches only the app in that test's folder, so
 * the test can never signal or wait for a real 10db running on this Mac.
 */
const realTool = (path: string, pattern: string): readonly string[] => [
  'if [ -n "${STUB_REAL_APP_ROOT:-}" ]; then',
  '  flags=(); for arg in "$@"; do case "$arg" in -*) flags+=("$arg") ;; esac; done',
  `  exec ${path} "\${flags[@]}" "$STUB_REAL_APP_ROOT/${pattern}"`,
  'fi',
];

/** Stands for the window of a 10db: starts the daemon on a pipe, whose stdin ends with the window. */
const FAKE_WINDOW = [
  '#!/bin/bash',
  'mkfifo "$STUB_STATE/daemon-stdin"',
  '"$(dirname "$0")/tendb-node" "$@" < "$STUB_STATE/daemon-stdin" &',
  'exec 3> "$STUB_STATE/daemon-stdin"',
  // Stays until the script is done, whatever it decides, unless a signal ends it first.
  'until [ -e "$STUB_WINDOW_UNTIL" ]; do sleep 0.05; done',
  '',
].join('\n');

/**
 * Stands for the daemon: starts the install script as its child, as the self-update does, and
 * exits when the window's end of its stdin closes.
 */
const FAKE_DAEMON = [
  '#!/bin/bash',
  'pids=()',
  '[ -z "${STUB_DAEMON_GIVES_PIDS:-}" ] || pids=(--quit-pid "$$" --quit-pid "$PPID")',
  '/bin/bash "$STUB_INSTALL_SCRIPT" "$@" ${pids[@]+"${pids[@]}"} < /dev/null &',
  'cat > /dev/null',
  '',
].join('\n');

/**
 * Stand-ins for the tools install-app.sh and rollback-app.sh drive. They are child processes this
 * repo doesn't own and that reach GitHub, the disk images subsystem, Launch Services or a real
 * running 10db, so every one is replaced; each logs its arguments to `$STUB_LOG` as one line. The
 * stand-in ditto and unzip keep a "zip" as a tar file, which every CI image can read. The
 * *_INTERRUPTS switches send SIGINT to the script that ran the stub, as a Ctrl-C would.
 */
const STUBS: Record<string, readonly string[]> = {
  gh: [
    'if [ -n "${STUB_GH_OFFLINE:-}" ]; then echo "error connecting to api.github.com" >&2; exit 1; fi',
    'case "$*" in',
    "  'api repos/{owner}/{repo}/commits/'*)",
    '    [ -n "$STUB_HEAD_SHA" ] || { echo "gh: No commit found for SHA: x (HTTP 422)" >&2; exit 1; }',
    '    echo "$STUB_HEAD_SHA" ;;',
    // The ref's newest commits, newest first, one per line.
    '  \'api repos/{owner}/{repo}/commits?\'*) for sha in ${STUB_COMMITS:-$STUB_HEAD_SHA}; do echo "$sha"; done ;;',
    "  'api repos/{owner}/{repo}/actions/runs/'*/artifacts*)",
    '    id="${2#repos/\\{owner\\}/\\{repo\\}/actions/runs/}"; id="${id%%/*}"',
    '    case " ${STUB_EXPIRED_RUNS:-} " in *" $id "*) echo 0 ;; *) echo "${STUB_ARTIFACT_LIVE:-1}" ;; esac ;;',
    // Successful runs, newest first, as "<run id> <commit>": STUB_SUCCESS_RUN built the head, then STUB_RUNS.
    "  'run list '*'--status success'*)",
    '    [ -z "$STUB_SUCCESS_RUN" ] || echo "$STUB_SUCCESS_RUN $STUB_HEAD_SHA"',
    // STUB_RUNS_AFTER_CANCEL: finished builds that appear once a run has been reported cancelled.
    '    for run in ${STUB_RUNS:-} $([ ! -f "$STUB_STATE/cancelled" ] || echo ${STUB_RUNS_AFTER_CANCEL:-}); do echo "${run/@/ }"; done ;;',
    // The run of the head still under way; STUB_ACTIVE_RUN_AFTER_CANCEL replaces it once a run has been reported cancelled.
    "  'run list '*'--json databaseId,status '*)",
    '    if [ -f "$STUB_STATE/cancelled" ]; then active="${STUB_ACTIVE_RUN_AFTER_CANCEL:-}"; else active="${STUB_ACTIVE_RUN:-}"; fi',
    '    [ -z "$active" ] || echo "$active" ;;',
    // Each dispatch starts the next run id: 101, 102, ...
    "  'run list '*'--event workflow_dispatch'*)",
    '    for ((i = $(cat "$STUB_STATE/dispatched" 2>/dev/null || echo 0); i > 0; i--)); do echo $((100 + i)); done; echo 100 ;;',
    `  'workflow run '*) ${count('dispatched')} ;;`,
    // The jobs of a run that started: STUB_STARTED_RUNS lists the run ids with a job that began; others have none.
    "  'run view '*'--json jobs'*)",
    '    case " ${STUB_STARTED_RUNS:-} " in *" $3 "*) echo 1 ;; *) echo 0 ;; esac ;;',
    // Runs of the workflow on the ref, for telling a replaced run from one cancelled by hand: once a run
    // has been reported cancelled, STUB_NEWER_RUNS (ids of runs created after it) show beside the cancelled ones.
    "  'run list '*'--branch '*)",
    '    if [ -f "$STUB_STATE/cancelled" ]; then for id in ${STUB_CANCELLED_RUNS:-} ${STUB_NEWER_RUNS:-}; do echo "$id"; done; fi ;;',
    "  'run view '*)",
    `    ${count('view')}`,
    '    if [ "$n" -le "${STUB_VIEW_FAILS:-0}" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi',
    // STUB_CANCELLED_RUNS: run ids that end cancelled, as when a newer run in the concurrency group replaces them.
    '    case " ${STUB_CANCELLED_RUNS:-} " in *" $3 "*)',
    '      touch "$STUB_STATE/cancelled"',
    '      printf \'completed\\ncancelled\\n%s\\n\' "$STUB_HEAD_SHA"; exit 0 ;;',
    '    esac',
    '    printf \'%s\\n%s\\n%s\\n\' "${STUB_RUN_STATUS:-completed}" "${STUB_RUN_CONCLUSION-success}" "$STUB_HEAD_SHA" ;;',
    "  'run download '*)",
    '    while [ "$#" -gt 0 ]; do [ "$1" = --dir ] && dir="$2"; shift; done',
    '    mkdir -p "$dir" && cp -R "$STUB_ARTIFACT/." "$dir" ;;',
    '  *) echo "gh stub: unexpected $*" >&2; exit 3 ;;',
    'esac',
  ],
  pgrep: [
    ...realTool('/usr/bin/pgrep', '10db\\.app/Contents/MacOS/'),
    count('pgrep'),
    ...MISSES_ANCESTOR,
    'if [ -n "${STUB_RUNNING:-}" ] && [ "$n" -ge "${STUB_RUNNING_FROM_CALL:-1}" ] \\',
    '  && [ "$n" -le "${STUB_RUNNING_UNTIL_CALL:-999999}" ]; then',
    '  echo "$STUB_RUNNING"',
    '  exit 0',
    'fi',
    'exit 1',
  ],
  sqlite3: [
    '[ -z "${STUB_SQLITE_FAILS:-}" ] || { echo "Error: disk I/O error" >&2; exit 1; }',
    '[ -z "${STUB_SQLITE_INTERRUPTS:-}" ] || { kill -INT "$PPID"; exit 0; }',
    'case "$2" in',
    '  ".backup \'"*"\'") target=${2#".backup \'"}; cp "$1" "${target%"\'"}" ;;',
    '  *) echo "sqlite3 stub: unexpected $*" >&2; exit 3 ;;',
    'esac',
  ],
  hdiutil: [
    'case "$1" in',
    '  attach) [ -z "${STUB_ATTACH_FAILS:-}" ] || exit 1',
    '    while [ "$#" -gt 0 ]; do [ "$1" = -mountpoint ] && mount="$2"; shift; done',
    '    cp -R "$STUB_DMG_CONTENTS/." "$mount" ;;',
    '  detach) [ -z "${STUB_DETACH_INTERRUPTS:-}" ] || kill -INT "$PPID"',
    '    [ -z "${STUB_DETACH_FAILS:-}" ] || exit 16 ;;',
    '  *) exit 3 ;;',
    'esac',
  ],
  ditto: [
    'case "$1" in',
    // ditto -c -k --keepParent <bundle> <zip>
    '  -c) [ -z "${STUB_ZIP_FAILS:-}" ] || exit 1',
    '    if [ -n "${STUB_ZIP_CORRUPT:-}" ]; then echo junk > "$5"; exit 0; fi',
    '    tar -cf "$5" -C "$(dirname "$4")" "$(basename "$4")" ;;',
    // ditto -x -k <zip> <dir>
    '  -x) [ -z "${STUB_UNPACK_FAILS:-}" ] || exit 1',
    '    mkdir -p "$4" && tar -xf "$3" -C "$4" ;;',
    // ditto <bundle> <bundle>: a partial copy on failure, the stuck one with a folder rm -rf can't empty.
    '  *) if [ -n "${STUB_DITTO_FAILS:-}" ]; then',
    '      mkdir -p "$2/Contents/locked" && touch "$2/Contents/locked/file"',
    '      [ "$STUB_DITTO_FAILS" != stuck ] || chmod 555 "$2/Contents/locked"',
    '      exit 1',
    '    fi',
    '    cp -R "$1" "$2"',
    '    [ -z "${STUB_DITTO_INTERRUPTS:-}" ] || kill -INT "$PPID" ;;',
    'esac',
  ],
  unzip: [
    'case "$1" in',
    '  -tq) tar -tf "$2" > /dev/null 2>&1 ;;',
    '  -Z1) tar -tf "$2" ;;',
    '  *) exit 3 ;;',
    'esac',
  ],
  lsregister: ['[ -z "${STUB_LSREGISTER_FAILS:-}" ] || exit 1'],
  // A clock that moves a second on every call, so two reads of it in one run differ.
  date: [
    'if [ -n "${STUB_CLOCK:-}" ] && [ "$*" = "-u +%Y%m%dT%H%M%SZ" ]; then',
    `  ${count('date')}`,
    '  printf \'20261029T1200%02dZ\\n\' "$n"',
    '  exit 0',
    'fi',
    'exec /bin/date "$@"',
  ],
  // Fails the first STUB_MV_UNPACK_FAILS moves of a bundle out of an unpack folder, and with
  // STUB_MV_NEXT_FAILS the move of a finished stage into place.
  mv: [
    'case "$1" in',
    '  */.unpack.*)',
    '    if [ -n "${STUB_MV_UNPACK_FAILS:-}" ]; then',
    `      ${count('mv-unpack')}`,
    '      [ "$n" -gt "$STUB_MV_UNPACK_FAILS" ] || exit 1',
    '    fi ;;',
    '  *.next) [ -z "${STUB_MV_NEXT_FAILS:-}" ] || exit 1 ;;',
    'esac',
    'exec /bin/mv "$@"',
  ],
  // With STUB_CP_DMG_FAILS, a DMG copied somewhere runs out of room part way, as on a full disk.
  cp: [
    'if [ -n "${STUB_CP_DMG_FAILS:-}" ]; then',
    '  case "$1" in',
    '    *.dmg) echo partial > "$2/$(basename "$1")"; exit 1 ;;',
    '  esac',
    'fi',
    'exec /bin/cp "$@"',
  ],
  xattr: ['exit 0'],
  // Asks the running app to quit and starts it again. A quit request through osascript (what ⌘Q does)
  // can end the pids in STUB_QUIT_KILLS, and a signal those in STUB_SIGNAL_KILLS, as an app that quits
  // would. macOS's pkill reads the signal only as its first argument: `pkill -a -TERM` is a usage error.
  pkill: [
    ...realTool('/usr/bin/pkill', '10db\\.app/Contents/MacOS/tendb-desktop'),
    'case "$1" in -[A-Z]*) ;; *) echo "pkill: illegal option" >&2; exit 2 ;; esac',
    ...MISSES_ANCESTOR,
    '[ -z "${STUB_SIGNAL_KILLS:-}" ] || kill $STUB_SIGNAL_KILLS',
  ],
  osascript: [
    '[ -z "${STUB_OSASCRIPT_FAILS:-}" ] || { echo "execution error: Not authorized to send Apple events (-1743)" >&2; exit 1; }',
    '[ -z "${STUB_QUIT_KILLS:-}" ] || kill $STUB_QUIT_KILLS',
  ],
  open: ['[ -z "${STUB_OPEN_FAILS:-}" ] || exit 1'],
};

export interface InstalledAppSandbox {
  readonly root: string;
  readonly applications: string;
  readonly dataDir: string;
  /** Where the zipped previous app is kept: `10db-previous` beside the data directory. */
  readonly previousDir: string;
  readonly lsregister: string;
  /** Runs a script under scripts/release/ with the stubs first on PATH. */
  run(
    script: string,
    args: readonly string[],
    env?: Record<string, string>,
  ): { status: number | null; stdout: string; stderr: string };
  /**
   * Runs a script under scripts/release/ as a real child of a running app: a process named as the
   * window starts one named as the daemon, which starts the script, and pgrep and pkill are the real
   * ones, narrowed to this app. Returns when the script is done and the window (held by
   * `windowUntil`, a file the script writes when it ends) has gone.
   */
  runUnderApp(
    script: string,
    args: readonly string[],
    options: { windowUntil: string; daemonGivesPids: boolean; env?: Record<string, string> },
  ): { stdout: string; stderr: string };
  /** One line per stub call, `<tool> <args>`. */
  calls(): string[];
  /** The marker file inside an app bundle, or null when the bundle has none. */
  marker(appPath: string): string | null;
  /** Every entry of a directory, sorted; empty when it does not exist. */
  list(dir: string): string[];
  writeApp(path: string, marker: string): void;
  /** Writes `<previousDir>/<name>` holding one bundle named `top` with this marker. */
  writeZip(name: string, top: string, marker: string, options?: { infoPlist?: boolean }): void;
  /** The marker of the bundle `top` inside `<previousDir>/<name>`. */
  zipMarker(name: string, top?: string): string;
  /** Writes a database backup folder `10db-backup-<suffix>` last changed `ageSeconds` ago. */
  writeBackup(suffix: string, ageSeconds: number): void;
  /** Replaces the apps inside the DMG with these names. */
  setDmgApps(names: readonly string[]): void;
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
  const previousDir = join(support, '10db-previous');
  const artifact = join(root, 'artifact');
  const dmgContents = join(root, 'dmg-contents');
  const scratch = join(root, 'scratch');
  const log = join(state, 'calls.log');
  for (const dir of [bin, state, applications, dataDir, artifact, dmgContents, scratch]) {
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
    writeFileSync(join(path, 'Contents', 'Info.plist'), '<plist/>');
    writeFileSync(join(path, 'Contents', 'marker'), marker);
  };
  writeApp(join(applications, '10db.app'), 'old build');
  writeApp(join(dmgContents, '10db.app'), 'new build');
  writeFileSync(join(dataDir, '10db.sqlite'), 'the database');
  const dmg = 'disk image bytes';
  writeFileSync(join(artifact, DMG_NAME), dmg);
  const sum = createHash('sha256').update(dmg).digest('hex');
  writeFileSync(join(artifact, 'SHA256SUMS'), `${sum}  ${DMG_NAME}\n`);

  const tar = (args: readonly string[]): string => {
    const result = spawnSync('tar', args, { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`tar ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };

  const scriptEnv = (env: Record<string, string>): Record<string, string> => ({
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    TMPDIR: root,
    TENDB_INSTALL_APPLICATIONS_DIR: applications,
    TENDB_INSTALL_DATA_DIR: dataDir,
    TENDB_INSTALL_LSREGISTER: join(bin, 'lsregister'),
    TENDB_INSTALL_POLL_SECONDS: '0',
    STUB_LOG: log,
    STUB_STATE: state,
    STUB_HEAD_SHA: HEAD_SHA,
    STUB_SUCCESS_RUN: '42',
    STUB_ARTIFACT: artifact,
    STUB_DMG_CONTENTS: dmgContents,
    ...env,
  });

  return {
    root,
    applications,
    dataDir,
    previousDir,
    lsregister: join(bin, 'lsregister'),
    run(script, args, env = {}) {
      const result = spawnSync('/bin/bash', [join(repoRoot, 'scripts/release', script), ...args], {
        cwd: root,
        encoding: 'utf8',
        env: scriptEnv(env),
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    runUnderApp(script, args, { windowUntil, daemonGivesPids, env = {} }) {
      const running = join(root, 'running');
      const macos = join(running, '10db.app', 'Contents', 'MacOS');
      mkdirSync(macos, { recursive: true });
      writeFileSync(join(macos, 'tendb-desktop'), FAKE_WINDOW, { mode: 0o755 });
      writeFileSync(join(macos, 'tendb-node'), FAKE_DAEMON, { mode: 0o755 });
      // Returns once the script's output closes as well, so after the script, not with the window.
      const result = spawnSync(join(macos, 'tendb-desktop'), args, {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        env: scriptEnv({
          STUB_REAL_APP_ROOT: running.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          STUB_INSTALL_SCRIPT: join(repoRoot, 'scripts/release', script),
          STUB_WINDOW_UNTIL: windowUntil,
          ...(daemonGivesPids ? { STUB_DAEMON_GIVES_PIDS: '1' } : {}),
          ...env,
        }),
      });
      return { stdout: result.stdout, stderr: result.stderr };
    },
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    marker(appPath) {
      const file = join(appPath, 'Contents', 'marker');
      return existsSync(file) ? readFileSync(file, 'utf8') : null;
    },
    list: (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []),
    writeApp,
    writeZip(name, top, marker, { infoPlist = true } = {}) {
      const staging = mkdtempSync(join(scratch, 'zip-'));
      writeApp(join(staging, top), marker);
      if (!infoPlist) rmSync(join(staging, top, 'Contents', 'Info.plist'));
      mkdirSync(previousDir, { recursive: true });
      tar(['-cf', join(previousDir, name), '-C', staging, top]);
    },
    zipMarker: (name, top = '10db.app') =>
      tar(['-xOf', join(previousDir, name), `${top}/Contents/marker`]),
    writeBackup(suffix, ageSeconds) {
      const dir = join(support, `10db-backup-${suffix}`);
      mkdirSync(dir);
      writeFileSync(join(dir, '10db.sqlite'), 'backup');
      const when = Date.now() / 1000 - ageSeconds;
      utimesSync(dir, when, when);
    },
    setDmgApps(names) {
      rmSync(dmgContents, { recursive: true, force: true });
      mkdirSync(dmgContents);
      for (const name of names) writeApp(join(dmgContents, name), 'new build');
    },
    corruptChecksum() {
      writeFileSync(join(artifact, 'SHA256SUMS'), `${'0'.repeat(64)}  ${DMG_NAME}\n`);
    },
    remove() {
      spawnSync('chmod', ['-R', 'u+w', root]);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
