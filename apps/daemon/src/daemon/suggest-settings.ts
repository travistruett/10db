import { realpathSync } from 'node:fs';
import {
  AreaRole,
  SettingField,
  type BranchNote,
  type ProjectDto,
  type SettingSuggestion,
} from '@10db/contracts';
import {
  appAddressCandidates,
  appAddressFiles,
  askWithin,
  CHANGED_CHECK_NOTE,
  changedCheckFor,
  chooseAppAddress,
  devLoginAnswer,
  devLoginEvidence,
  devLoginPrompt,
  devLoginScriptFiles,
  findDevLogins,
  NAMING_MS,
  oneLine,
  PROBED,
  uiUnitOf,
  type AreaNamer,
  type DevLogin,
} from '../folders';
import type { Git } from '../git';
import { callsDocker, MAX_DOCKER_SCAN_BYTES, type ReadRepoFile } from './docker-need';
import type { ListenerReader } from './listening-ports';
import type { AddressProbe } from './loopback-probe';

// Workbench setup (plan §3): the settings 10db suggests for pictures and turn checks, and the note
// on the base branch's unpushed commits. Every file is read from `origin/<base>`'s commit in git's
// object store, never HEAD or the checkout, which a lane can write; besides that, one look at what
// listens on this Mac and one probe of each likely address. Nothing of the repository runs.

/** Shown with the Allow Docker suggestion, as Settings › General says it. */
export const DOCKER_NOTE =
  'Docker can mount any host folder into a container, so a gate or task with Docker can reach outside the sandbox.';

/** The most of one repository file read. */
const MAX_FILE_BYTES = 256 * 1024;
/** The most `package.json` files read to find the UI package and its dev login scripts. */
const MAX_PACKAGE_FILES = 50;
/** The most scripts, Makefiles and workflows read for a dev login's invocation lines. */
const MAX_SCRIPT_FILES = 200;

export interface SuggestSettingsDeps {
  readonly git: Git;
  readonly listeners: ListenerReader;
  readonly probe: AddressProbe;
  /** Writes the dev login command; null leaves it unsuggested. */
  readonly asker: AreaNamer | null;
  /** Overrides `NAMING_MS`. */
  readonly askMs?: number;
  readonly daemonPort: () => number | null;
}

export type SettingsProject = Pick<
  ProjectDto,
  | 'repoPath'
  | 'baseBranch'
  | 'gateCommand'
  | 'appUrl'
  | 'devLoginCommand'
  | 'changedCheckCommand'
  | 'sandboxDocker'
  | 'sandboxDockerOptOut'
  | 'areas'
>;

export interface SuggestedSettings {
  readonly settings: SettingSuggestion[];
  readonly branch: BranchNote | null;
}

type Reader = (path: string) => Promise<string | null>;

const depth = (path: string): number => path.split('/').length;

/** The texts of `paths` that could be read, by path, in the order given. */
async function readAll(read: Reader, paths: readonly string[]): Promise<Map<string, string>> {
  const texts = await Promise.all(paths.map(read));
  const found = new Map<string, string>();
  paths.forEach((path, i) => {
    const text = texts[i];
    if (typeof text === 'string') found.set(path, text);
  });
  return found;
}

function realOrSame(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

async function appAddress(
  deps: SuggestSettingsDeps,
  repoPath: string,
  files: readonly string[],
  read: Reader,
  uiUnit: string | null,
  signal: AbortSignal | undefined,
): Promise<SettingSuggestion | null> {
  const listeners = await deps.listeners().catch(() => []);
  const candidates = appAddressCandidates({
    repoPath: realOrSame(repoPath),
    texts: await readAll(read, appAddressFiles(files, uiUnit)),
    listeners,
    uiUnit,
    daemonPort: deps.daemonPort(),
  });
  const answered = await Promise.all(
    candidates.slice(0, PROBED).map((c) => deps.probe(c.url, signal).catch(() => false)),
  );
  const chosen = chooseAppAddress(candidates, answered);
  if (chosen === null) return null;
  return {
    field: SettingField.AppUrl,
    value: chosen.url,
    source: oneLine(chosen.source),
    ...(chosen.note === undefined ? {} : { note: chosen.note }),
  };
}

/** Where the dev login suggestion was found: the first script that runs it, or its package script. */
function devLoginSource(found: readonly DevLogin[], scripts: ReadonlyMap<string, string>): string {
  const runner = [...scripts.keys()].find(
    (path) => devLoginEvidence(found, new Map([[path, scripts.get(path) ?? '']])) !== '',
  );
  if (runner !== undefined)
    return `from ${runner}, which runs ${found.map((f) => f.name).join(', ')}`;
  const script = found.find((f) => f.script !== undefined);
  return script === undefined
    ? 'from the repository'
    : `from ${script.path}: the ${script.name} script`;
}

async function devLogin(
  deps: SuggestSettingsDeps,
  files: readonly string[],
  packages: ReadonlyMap<string, string>,
  read: Reader,
  signal: AbortSignal | undefined,
): Promise<SettingSuggestion | null> {
  if (deps.asker === null) return null;
  const found = findDevLogins(files, packages);
  if (found.length === 0) return null;
  const scripts = await readAll(read, devLoginScriptFiles(files).slice(0, MAX_SCRIPT_FILES));
  const evidence = devLoginEvidence(found, scripts);
  if (evidence === '') return null;
  const text = await askWithin(
    deps.asker,
    devLoginPrompt(found, evidence),
    deps.askMs ?? NAMING_MS,
    signal,
  );
  const command = text === null ? null : devLoginAnswer(text, found);
  if (command === null) return null;
  return {
    field: SettingField.DevLoginCommand,
    value: command,
    source: oneLine(devLoginSource(found, scripts)),
  };
}

/** A reader of the committed base, as the gate's own Docker check reads it (`gateCallsDocker`). */
function baseReader(git: Git, project: SettingsProject): ReadRepoFile {
  const ref = `origin/${project.baseBranch}`;
  return async (path) => {
    try {
      const file = await git.fileAt(project.repoPath, ref, path, MAX_DOCKER_SCAN_BYTES);
      return file.kind === 'file' ? file.text : null;
    } catch {
      return null;
    }
  };
}

/**
 * Allow Docker, when the switch is off and the builder has not turned it off, and the gate command
 * (the builder's own) or the turn check (built from origin's scripts, never by a model) calls docker,
 * read as `callsDocker` reads a gate: its Makefiles and scripts from `origin/<base>` only. The dev
 * login command never counts: a model wrote it.
 */
async function docker(
  git: Git,
  project: SettingsProject,
  checkCommand: string | null,
): Promise<SettingSuggestion | null> {
  if (project.sandboxDocker || project.sandboxDockerOptOut) return null;
  const read = baseReader(git, project);
  const commands: [string, string | null][] = [
    ['the gate command', project.gateCommand],
    ['the check after each turn', checkCommand],
  ];
  for (const [what, command] of commands) {
    if (command === null) continue;
    if (await callsDocker(command, read).catch(() => false))
      return {
        field: SettingField.SandboxDocker,
        value: true,
        source: `${what} runs docker`,
        note: DOCKER_NOTE,
      };
  }
  return null;
}

/** The base branch's commits `origin/<base>` (at `tracking`) lacks, when there are any. */
async function branchNote(
  git: Git,
  project: SettingsProject,
  tracking: string,
): Promise<BranchNote | null> {
  const branch = project.baseBranch;
  const tip = await git.branchTip(project.repoPath, branch);
  if (tip === null) return null;
  const ahead = await git.countCommits(project.repoPath, tracking, tip);
  return ahead > 0 ? { branch, ahead, command: `git push origin ${branch}` } : null;
}

const settingOf = (row: SettingSuggestion | null, field: SettingField): string | null =>
  row !== null && row.field === field && typeof row.value === 'string' ? row.value : null;

/**
 * What the Workbench setup suggests besides areas: the settings the project lacks, in the order the
 * screen lists them (app address, dev login, turn check, Allow Docker), and the branch note. A
 * setting the project has is never suggested. Files are read from `origin/<base>`'s commit; with no
 * such ref they are read from HEAD, and then no dev login is suggested, since a model would write it
 * from lines a lane may have committed. The UI package is the one holding `pageGlobs` (the proposed
 * pages) and the project's page areas. A part that fails is left out; the rest stands.
 */
export async function suggestSettings(
  deps: SuggestSettingsDeps,
  project: SettingsProject,
  pageGlobs: readonly (readonly string[])[],
  signal?: AbortSignal,
): Promise<SuggestedSettings> {
  const tracking = await deps.git
    .trackingTip(project.repoPath, project.baseBranch)
    .catch(() => null);
  const branch =
    tracking === null ? null : await branchNote(deps.git, project, tracking).catch(() => null);
  // One commit for every read, so they cannot span a branch that moves.
  const rev = tracking ?? (await deps.git.commitAt(project.repoPath, 'HEAD').catch(() => null));
  if (rev === null) return { settings: [], branch };
  const files = await deps.git.filesAt(project.repoPath, rev).catch(() => []);
  if (files.length === 0) return { settings: [], branch };
  const read: Reader = async (path) => {
    try {
      const file = await deps.git.fileAt(project.repoPath, rev, path, MAX_FILE_BYTES);
      return file.kind === 'file' ? file.text : null;
    } catch {
      return null;
    }
  };

  const packageFiles = files
    .filter((f) => f === 'package.json' || f.endsWith('/package.json'))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
    .slice(0, MAX_PACKAGE_FILES);
  const packages = await readAll(read, packageFiles);
  const pages = [
    ...pageGlobs,
    ...project.areas.filter((a) => a.role === AreaRole.Page).map((a) => a.globs),
  ];
  const uiUnit = uiUnitOf(files, pages, packages);

  const [address, login] = await Promise.all([
    project.appUrl === null
      ? appAddress(deps, project.repoPath, files, read, uiUnit, signal).catch(() => null)
      : null,
    project.devLoginCommand === null && tracking !== null
      ? devLogin(deps, files, packages, read, signal).catch(() => null)
      : null,
  ]);
  const found =
    project.changedCheckCommand === null && uiUnit !== null
      ? changedCheckFor(
          uiUnit,
          packages.get(uiUnit === '' ? 'package.json' : `${uiUnit}/package.json`) ?? '',
          files,
        )
      : null;
  const check: SettingSuggestion | null =
    found === null
      ? null
      : {
          field: SettingField.ChangedCheckCommand,
          value: found.command,
          source: oneLine(found.source),
          note: CHANGED_CHECK_NOTE,
        };
  const dockerRow = await docker(
    deps.git,
    project,
    settingOf(check, SettingField.ChangedCheckCommand) ?? project.changedCheckCommand,
  );
  const settings = [address, login, check, dockerRow].filter(
    (s): s is SettingSuggestion => s !== null,
  );
  return { settings, branch };
}
