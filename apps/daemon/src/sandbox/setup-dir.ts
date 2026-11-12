import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { foldPathCase } from '../guard';
import { wrapPlugin } from './plugin-wrapper';
import { isEqualOrUnder } from './protected-reads';
import type { SetupInput } from './setup-input';
import { collapseReads, setupReadRoots } from './setup-reads';

interface LeftOut {
  readonly what: string;
  readonly why: string;
}

/** What a session's setup brought along, as the lane sandbox kept it. */
export interface SessionSetup {
  /** Plugin dirs for Claude: `yours`, `project`, then each plugin's wrapper; never an install path. */
  readonly pluginDirs: readonly string[];
  /** Skill folders' roots for Codex. */
  readonly skillRoots: readonly string[];
  /** What the session's profile opens read-only: the setup dir and the kept folders, collapsed. */
  readonly reads: readonly string[];
  readonly loaded: { readonly skills: readonly string[]; readonly plugins: readonly string[] };
  readonly leftOut: readonly LeftOut[];
}

export const EMPTY_SETUP: SessionSetup = {
  pluginDirs: [],
  skillRoots: [],
  reads: [],
  loaded: { skills: [], plugins: [] },
  leftOut: [],
};

type Skill = SetupInput['skills'][number];

/** A plugin the refusal kept, with the real path of its install folder. */
export interface KeptPlugin {
  readonly id: string;
  readonly path: string;
  readonly real: string;
}

export interface KeptSetup {
  readonly keptSkills: Skill[];
  readonly keptPlugins: KeptPlugin[];
  /** The folders to open, collapsed. */
  readonly reads: string[];
  /** The `.env*` files under the reads, and the real paths of `.env*` links: denied inside them. */
  readonly secretFiles: string[];
  readonly leftOut: LeftOut[];
}

const SECRET_FILE_PREFIX = foldPathCase('.env');
const UNWALKED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', '.git']);
const GONE = 'its folder is gone; Claude Code may have updated it';

function realOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/** `~/…` for a path in the home, the path itself elsewhere. */
function shown(path: string, home: string): string {
  return isEqualOrUnder(path, home) && path !== home ? `~/${relative(home, path)}` : path;
}

/**
 * Every `.env*` file under `root` (and the real path of a `.env*` link), not entering links,
 * `node_modules` or `.git`; or the first folder that can't be listed, since it could hide one.
 */
function walkSecrets(root: string): { secrets: string[] } | { unlistable: string } {
  const secrets: string[] = [];
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      return { unlistable: dir };
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!UNWALKED_DIRECTORIES.has(entry.name)) pending.push(path);
      } else if (foldPathCase(entry.name).startsWith(SECRET_FILE_PREFIX)) {
        secrets.push(path);
        const real = entry.isSymbolicLink() ? realOrNull(path) : null;
        if (real !== null) secrets.push(real);
      }
    }
  }
  return { secrets };
}

/** One skill root's real path, and whether a real directory directly in it was refused. */
function rootState(
  root: string,
  refuse: (real: string) => string | null,
): { real: string; whole: boolean } | null {
  const real = realOrNull(root);
  if (real === null) return null;
  if (refuse(real) !== null) return { real, whole: false };
  let entries: Dirent[];
  try {
    entries = readdirSync(real, { withFileTypes: true });
  } catch {
    return { real, whole: false };
  }
  // A link is judged by the kernel at its real path, which stays closed; only a real folder counts.
  const whole = entries.every(
    (entry) => !entry.isDirectory() || refuse(join(real, entry.name)) === null,
  );
  return { real, whole };
}

/**
 * What of a session's setup the refusal keeps, and the folders to open for it. Reads the file system and
 * writes nothing; the Settings preview and `createSetupDir` share it. A kept skill or plugin holding a
 * folder that can't be listed is left out, and never fails the session.
 */
export function keepSetup(
  input: SetupInput,
  refuse: (real: string) => string | null,
  home: string,
): KeptSetup {
  const leftOut: LeftOut[] = [];
  const skills: { skill: Skill; folder: string; fileDir: string }[] = [];
  for (const skill of input.skills) {
    const what = shown(skill.path, home);
    const folder = realOrNull(skill.path);
    if (folder === null) {
      leftOut.push({ what, why: 'it leads nowhere' });
      continue;
    }
    const fileDir = dirname(skill.skillFile);
    const why = refuse(folder) ?? refuse(fileDir);
    if (why !== null) leftOut.push({ what, why });
    else skills.push({ skill, folder, fileDir });
  }
  const plugins: KeptPlugin[] = [];
  for (const plugin of input.plugins) {
    const real = existsSync(plugin.path) ? realOrNull(plugin.path) : null;
    if (real === null) {
      leftOut.push({ what: plugin.id, why: GONE });
      continue;
    }
    const why = refuse(real);
    if (why !== null) leftOut.push({ what: plugin.id, why });
    else plugins.push({ ...plugin, real });
  }
  const roots = setupReadRoots(home)
    .filter((root) => !root.endsWith(`${sep}plugins`))
    .flatMap((root) => {
      const state = rootState(root, refuse);
      return state === null ? [] : [state];
    });
  // A folder that can't be listed leaves its skill or plugin out, and opens its root folder by folder.
  for (;;) {
    const reads = collapseReads([
      ...roots.flatMap((root) => (root.whole ? [root.real] : [])),
      ...plugins.map((plugin) => plugin.real),
      ...skills.flatMap(({ folder, fileDir }) =>
        [folder, fileDir].filter(
          (path) => !roots.some((root) => root.whole && isEqualOrUnder(path, root.real)),
        ),
      ),
    ]);
    let blocked: string | null = null;
    const secretFiles: string[] = [];
    for (const read of reads) {
      const walked = walkSecrets(read);
      if ('unlistable' in walked) {
        blocked = walked.unlistable;
        break;
      }
      secretFiles.push(...walked.secrets);
    }
    if (blocked === null)
      return {
        keptSkills: skills.map(({ skill }) => skill),
        keptPlugins: plugins,
        reads,
        secretFiles: [...new Set(secretFiles)].sort(),
        leftOut,
      };
    const at = blocked;
    for (const root of roots) if (isEqualOrUnder(at, root.real)) root.whole = false;
    const skill = skills.findIndex(
      ({ folder, fileDir }) => isEqualOrUnder(at, folder) || isEqualOrUnder(at, fileDir),
    );
    const owner = skills[skill];
    if (owner !== undefined) {
      const base = isEqualOrUnder(at, owner.folder) ? owner.folder : owner.fileDir;
      leftOut.push({
        what: shown(owner.skill.path, home),
        why: `a folder in it can't be listed: ${relative(base, at) || '.'}`,
      });
      skills.splice(skill, 1);
      continue;
    }
    const plugin = plugins.findIndex((p) => isEqualOrUnder(at, p.real));
    const kept = plugins[plugin];
    if (kept !== undefined) {
      leftOut.push({
        what: kept.id,
        why: `a folder in it can't be listed: ${relative(kept.real, at) || '.'}`,
      });
      plugins.splice(plugin, 1);
    }
    // Otherwise the folder lies in a root that now opens folder by folder, which leaves it closed.
  }
}

/** A plugin's name from its id, `name@marketplace`; its wrapper's folder and its skills' prefix. */
function pluginName(id: string): string {
  const at = id.lastIndexOf('@');
  const name = at > 0 ? id.slice(0, at) : id;
  // A name is one folder: anything else is not a name Claude Code would give.
  return /^[\w.-]+$/.test(name) && name !== '.' && name !== '..' ? name : 'plugin';
}

function makeDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writeManifest(pluginDir: string, name: string): void {
  makeDir(join(pluginDir, '.claude-plugin'));
  writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }), {
    mode: 0o600,
  });
}

/** A copied file's place under `project/`, which must stay inside it. */
function projectPath(project: string, relativePath: string): string {
  const clean = normalize(relativePath);
  if (isAbsolute(clean) || clean === '..' || clean.startsWith(`..${sep}`))
    throw new Error(`a project file's path leads out of the setup dir: ${relativePath}`);
  return join(project, clean);
}

function writeProject(project: string, files: SetupInput['projectFiles']): void {
  writeManifest(project, 'project');
  for (const file of files) {
    const path = projectPath(project, file.relative);
    const parent = dirname(path);
    for (let dir = parent; dir !== project && !existsSync(dir); dir = dirname(dir)) makeDir(dir);
    makeDir(parent);
    writeFileSync(path, file.content, { mode: file.mode & 0o700 });
    chmodSync(path, file.mode & 0o700);
  }
}

/**
 * Makes a session's setup dir in the files root, which no lane can write, and names the `.env*` files
 * under its reads for the profile to deny: `yours/` links the kept skill
 * folders, `project/` holds the project's cleaned copies, and `plugins/<name>/` wraps each kept plugin.
 */
export function createSetupDir(
  filesRoot: string,
  input: SetupInput,
  refuse: (real: string) => string | null,
  home: string,
): { setup: SessionSetup; secretFiles: readonly string[]; remove(): void } {
  const kept = keepSetup(input, refuse, home);
  const dir = join(filesRoot, `10db-setup-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { mode: 0o700 });
  const remove = (): void => {
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    chmodSync(dir, 0o700);
    const pluginDirs: string[] = [];
    const skillRoots: string[] = [];
    if (kept.keptSkills.length > 0) {
      const yours = join(dir, 'yours');
      writeManifest(yours, 'yours');
      makeDir(join(yours, 'skills'));
      for (const skill of kept.keptSkills)
        symlinkSync(realpathSync.native(skill.path), join(yours, 'skills', skill.name));
      pluginDirs.push(yours);
      skillRoots.push(join(yours, 'skills'));
    }
    if (input.projectFiles.length > 0) {
      const project = join(dir, 'project');
      writeProject(project, input.projectFiles);
      pluginDirs.push(project);
      if (input.projectFiles.some((f) => f.relative.startsWith(`skills${sep}`)))
        skillRoots.push(join(project, 'skills'));
    }
    const leftOut = [...kept.leftOut];
    const named = new Set<string>();
    const wrapped: string[] = [];
    for (const plugin of kept.keptPlugins) {
      const name = pluginName(plugin.id);
      if (named.has(name)) {
        leftOut.push({ what: plugin.id, why: `a plugin named ${name} is already loaded` });
        continue;
      }
      named.add(name);
      const wrapper = join(dir, 'plugins', name);
      makeDir(wrapper);
      leftOut.push(...wrapPlugin(plugin.real, wrapper).leftOut);
      pluginDirs.push(wrapper);
      wrapped.push(plugin.id);
      const skills = join(plugin.real, 'skills');
      if (existsSync(skills) && lstatSync(skills).isDirectory()) skillRoots.push(skills);
    }
    return {
      setup: {
        pluginDirs,
        skillRoots,
        reads: [dir, ...kept.reads],
        loaded: {
          skills: kept.keptSkills.map((skill) => skill.name),
          plugins: wrapped,
        },
        leftOut,
      },
      secretFiles: kept.secretFiles,
      remove,
    };
  } catch (error) {
    remove();
    throw error;
  }
}
