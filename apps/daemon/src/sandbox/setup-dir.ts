import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { foldPathCase } from '../guard';
import { carriedEntries, wrapPlugin } from './plugin-wrapper';
import { isSandboxPath, SandboxProfileError } from './profile';
import { isEqualOrUnder } from './protected-reads';
import type { SetupInput } from './setup-input';
import { linkWithRewrites, pluginChanges, skillChanges, type Rewrite } from './setup-definitions';
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
  /**
   * The `.env*` files and folders under the reads, and the real paths of `.env*` links: the profile, the
   * file tools' rules and the file-access judge keep each closed, a folder with its tree, inside an opened
   * folder.
   */
  readonly secretFiles: readonly string[];
}

export const EMPTY_SETUP: SessionSetup = {
  pluginDirs: [],
  skillRoots: [],
  reads: [],
  loaded: { skills: [], plugins: [] },
  leftOut: [],
  secretFiles: [],
};

type Skill = SetupInput['skills'][number];

/** A plugin the refusal kept, with the real path of its install folder. */
export interface KeptPlugin {
  readonly id: string;
  readonly path: string;
  readonly real: string;
  /** Its definitions re-emitted without the keys 10db strips, or left out; relative to `real`. */
  readonly rewrites: readonly Rewrite[];
}

/** How a session's setup is judged, from the project's access (`lane-sandbox.ts` builds it). */
export interface SetupJudge {
  /** Null when a real path may open read-only to the session, else why not (`setupReadRefusal`). */
  refuse(real: string): string | null;
  /** Whether closing a real path would close what the session needs (`holdsSessionGround`). */
  holdsSessionGround(real: string): boolean;
  /** Whether a project copy's checkout file, by its path under the checkout, is a checkout secret. */
  isCheckoutSecret(source: string): boolean;
}

export interface KeptSetup {
  readonly keptSkills: Skill[];
  /** Each kept skill's re-emitted `SKILL.md`, by name, when it held a key 10db strips. */
  readonly skillRewrites: ReadonlyMap<string, readonly Rewrite[]>;
  readonly keptPlugins: KeptPlugin[];
  /** The project's copies but those whose checkout file is a secret. */
  readonly keptProjectFiles: SetupInput['projectFiles'];
  /** The folders to open, collapsed. */
  readonly reads: string[];
  /** The `.env*` files and folders under the reads, and the real paths of `.env*` links: denied inside them. */
  readonly secretFiles: string[];
  readonly leftOut: LeftOut[];
}

const SECRET_FILE_PREFIX = foldPathCase('.env');
const GIT_DIR = '.git';
const UNWALKED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', GIT_DIR]);
const GONE = 'its folder is gone; Claude Code may have updated it';
/**
 * The plugin names 10db's own setup takes, compared in lower case: a plugin named so would load its skills
 * under the namespace of the builder's skills, the project's or 10db's harness.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set(['yours', 'project', '10db-harness']);
const RESERVED = "its name is one 10db's own setup uses";
const NEEDED_GROUND =
  'a .env link in it leads to a folder the session needs, which 10db would have to close';
const TOO_MANY = 'it holds more files than 10db reads to strip hooks and pre-approved tools';
const UNNAMEABLE =
  "a path in it holds a character the sandbox profile can't take ([ ] * ? { } \\ or a line break)";

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

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
 * The real path of every link inside a `.env*` folder, at any depth: what it leads to is a secret too,
 * though the folder itself is denied whole. Never enters a link, so a folder link can't loop it, and
 * skips a folder it can't list, which the folder's own deny already closes.
 */
function linkTargetsIn(folder: string): string[] {
  const targets: string[] = [];
  const pending = [folder];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const real = realOrNull(path);
        if (real !== null) targets.push(real);
      } else if (entry.isDirectory()) pending.push(path);
    }
  }
  return targets;
}

/**
 * Every `.env*` file or folder and every `.git` under `root` (and the real path of a `.env*` link, and of
 * every link inside a `.env*` folder), not entering links, `.env*` folders, `node_modules` or `.git`; or
 * the first folder that can't be listed, since it could hide one.
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
      // A `.env*` folder is a secret as a whole: it is denied, not walked.
      if (foldPathCase(entry.name).startsWith(SECRET_FILE_PREFIX)) {
        secrets.push(path);
        const real = entry.isSymbolicLink() ? realOrNull(path) : null;
        if (real !== null) secrets.push(real);
        if (entry.isDirectory()) secrets.push(...linkTargetsIn(path));
      } else if (foldPathCase(entry.name) === GIT_DIR && !entry.isSymbolicLink()) {
        // A skill cloned into the folder keeps its remote's URL, which can carry a token, in `.git`.
        secrets.push(path);
      } else if (entry.isDirectory() && !UNWALKED_DIRECTORIES.has(entry.name)) {
        pending.push(path);
      }
    }
  }
  return { secrets };
}

/**
 * Why a read can't open as it stands, a skill or plugin taking the blame for what lies in it: the reads'
 * secrets when every read can be listed and named, else the first path that stops it. The profile refuses
 * a path holding a glob character or a line break, so a read or secret it couldn't name would refuse the
 * session; `at` is the read itself for a secret that lies elsewhere (a `.env*` link's target).
 */
function firstBlocked(
  reads: readonly string[],
  judge: SetupJudge,
): { secretFiles: string[] } | { at: string; why: (where: string) => string } {
  const secretFiles: string[] = [];
  const blame = (secret: string, read: string): string =>
    isEqualOrUnder(secret, read) ? secret : read;
  for (const read of reads) {
    if (!isSandboxPath(read)) return { at: read, why: () => UNNAMEABLE };
    const walked = walkSecrets(read);
    if ('unlistable' in walked)
      return { at: walked.unlistable, why: (where) => `a folder in it can't be listed: ${where}` };
    const odd = walked.secrets.find((secret) => !isSandboxPath(secret));
    if (odd !== undefined) return { at: blame(odd, read), why: () => UNNAMEABLE };
    // A secret that is or holds the home, a checkout or a sandbox root can't be closed.
    const wide = walked.secrets.find((secret) => judge.holdsSessionGround(secret));
    if (wide !== undefined) return { at: blame(wide, read), why: () => NEEDED_GROUND };
    secretFiles.push(...walked.secrets);
  }
  return { secretFiles: [...new Set(secretFiles)].sort() };
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
 * Null when no kept skill or plugin has the name yet, as the file system folds it (each is one folder in
 * the setup dir, so `Review` and `review` would collide), and takes it; else why the second is left out.
 */
function taken(names: Map<string, string>, name: string, kind: 'skill' | 'plugin'): string | null {
  const first = names.get(foldPathCase(name));
  if (first !== undefined) return `a ${kind} named ${first} is already loaded`;
  names.set(foldPathCase(name), name);
  return null;
}

/**
 * What of a session's setup the refusal keeps, and the folders to open for it. Reads the file system and
 * writes nothing; the Settings preview and `createSetupDir` share it. A kept skill or plugin holding a
 * folder that can't be listed is left out, and never fails the session.
 */
export function keepSetup(input: SetupInput, judge: SetupJudge, home: string): KeptSetup {
  const refuse = (real: string): string | null => judge.refuse(real);
  const leftOut: LeftOut[] = [];
  // A copy is read before the sandbox lists the checkout's secrets: a `.env` link may lead to a skill's file.
  const keptProjectFiles = input.projectFiles.filter((file) => {
    if (!judge.isCheckoutSecret(file.source)) return true;
    leftOut.push({ what: file.source, why: 'a secrets file is never copied' });
    return false;
  });
  const skillNames = new Map<string, string>();
  const pluginNames = new Map<string, string>();
  const skillRewrites = new Map<string, readonly Rewrite[]>();
  // What each skill's or plugin's definitions lost, told only for those still kept at the end.
  const notes = new Map<string, LeftOut[]>();
  const skills: { skill: Skill; folder: string; fileDir: string }[] = [];
  for (const skill of input.skills) {
    const what = shown(skill.path, home);
    const folder = realOrNull(skill.path);
    if (folder === null) {
      leftOut.push({ what, why: 'it leads nowhere' });
      continue;
    }
    const fileDir = dirname(skill.skillFile);
    const why = refuse(folder) ?? refuse(fileDir) ?? taken(skillNames, skill.name, 'skill');
    if (why !== null) {
      leftOut.push({ what, why });
      continue;
    }
    const changes = skillChanges(folder);
    const unread = changes.notes.find((_, i) => changes.rewrites[i]?.text === null);
    if (unread !== undefined) leftOut.push({ what, why: unread.why });
    else {
      skills.push({ skill, folder, fileDir });
      skillRewrites.set(skill.name, changes.rewrites);
      notes.set(
        skill.name,
        changes.notes.map((note) => ({ what, why: note.why })),
      );
    }
  }
  const plugins: KeptPlugin[] = [];
  for (const plugin of input.plugins) {
    const real = existsSync(plugin.path) ? realOrNull(plugin.path) : null;
    if (real === null) {
      leftOut.push({ what: plugin.id, why: GONE });
      continue;
    }
    const why =
      refuse(real) ??
      (RESERVED_NAMES.has(pluginName(plugin.id).toLowerCase()) ? RESERVED : null) ??
      taken(pluginNames, pluginName(plugin.id), 'plugin');
    if (why !== null) {
      leftOut.push({ what: plugin.id, why });
      continue;
    }
    const changes = isFolder(real) ? pluginChanges(real, carriedEntries(real)) : null;
    if (changes === null) {
      leftOut.push({ what: plugin.id, why: TOO_MANY });
      continue;
    }
    plugins.push({ ...plugin, real, rewrites: changes.rewrites });
    notes.set(
      plugin.id,
      changes.notes.map((note) => ({ what: `${plugin.id}: ${note.where}`, why: note.why })),
    );
  }
  const roots = setupReadRoots(home)
    .filter((root) => !root.endsWith(`${sep}plugins`))
    .flatMap((root) => {
      const state = rootState(root, refuse);
      return state === null ? [] : [state];
    });
  // A folder that can't be listed leaves its skill or plugin out, and opens its root folder by folder.
  for (;;) {
    // A root opens whole only for a kept skill in it: with none, nothing in it is the session's to read.
    const whole = roots.filter(
      (root) =>
        root.whole &&
        skills.some(
          ({ folder, fileDir }) =>
            isEqualOrUnder(folder, root.real) || isEqualOrUnder(fileDir, root.real),
        ),
    );
    const reads = collapseReads([
      ...whole.map((root) => root.real),
      ...plugins.map((plugin) => plugin.real),
      ...skills.flatMap(({ folder, fileDir }) =>
        [folder, fileDir].filter((path) => !whole.some((root) => isEqualOrUnder(path, root.real))),
      ),
    ]);
    const blocked = firstBlocked(reads, judge);
    if (!('at' in blocked))
      return {
        keptSkills: skills.map(({ skill }) => skill),
        skillRewrites,
        keptPlugins: plugins,
        keptProjectFiles,
        reads,
        secretFiles: blocked.secretFiles,
        leftOut: [
          ...leftOut,
          ...[...skills.map(({ skill }) => skill.name), ...plugins.map((p) => p.id)].flatMap(
            (key) => notes.get(key) ?? [],
          ),
        ],
      };
    const { at, why } = blocked;
    for (const root of roots) if (isEqualOrUnder(at, root.real)) root.whole = false;
    const skill = skills.findIndex(
      ({ folder, fileDir }) => isEqualOrUnder(at, folder) || isEqualOrUnder(at, fileDir),
    );
    const owner = skills[skill];
    if (owner !== undefined) {
      const base = isEqualOrUnder(at, owner.folder) ? owner.folder : owner.fileDir;
      leftOut.push({ what: shown(owner.skill.path, home), why: why(relative(base, at) || '.') });
      skills.splice(skill, 1);
      continue;
    }
    const plugin = plugins.findIndex((p) => isEqualOrUnder(at, p.real));
    const kept = plugins[plugin];
    if (kept !== undefined) {
      leftOut.push({ what: kept.id, why: why(relative(kept.real, at) || '.') });
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
  judge: SetupJudge,
  home: string,
): { setup: SessionSetup; remove(): void } {
  const kept = keepSetup(input, judge, home);
  const dir = join(filesRoot, `10db-setup-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { mode: 0o700 });
  const remove = (): void => {
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    chmodSync(dir, 0o700);
    const pluginDirs: string[] = [];
    const skillRoots: string[] = [];
    const leftOut = [...kept.leftOut];
    // A folder removed or changed since `keepSetup` read it leaves its own item out, never the session.
    const changed = (what: string, error: unknown): void => {
      const code = error instanceof Error && 'code' in error ? String(error.code) : String(error);
      leftOut.push({ what, why: `it changed while the session started: ${code}` });
    };
    const linked: string[] = [];
    if (kept.keptSkills.length > 0) {
      const yours = join(dir, 'yours');
      writeManifest(yours, 'yours');
      makeDir(join(yours, 'skills'));
      for (const skill of kept.keptSkills) {
        try {
          linkWithRewrites(
            realpathSync.native(skill.path),
            join(yours, 'skills', skill.name),
            '',
            kept.skillRewrites.get(skill.name) ?? [],
          );
          linked.push(skill.name);
        } catch (error) {
          changed(shown(skill.path, home), error);
        }
      }
      pluginDirs.push(yours);
      skillRoots.push(join(yours, 'skills'));
    }
    if (kept.keptProjectFiles.length > 0) {
      const project = join(dir, 'project');
      writeProject(project, kept.keptProjectFiles);
      pluginDirs.push(project);
      if (kept.keptProjectFiles.some((f) => f.relative.startsWith(`skills${sep}`)))
        skillRoots.push(join(project, 'skills'));
    }
    const wrapped: string[] = [];
    for (const plugin of kept.keptPlugins) {
      const name = pluginName(plugin.id);
      const wrapper = join(dir, 'plugins', name);
      let notes: LeftOut[];
      let skills: string | null;
      try {
        makeDir(wrapper);
        notes = wrapPlugin(plugin.real, wrapper, plugin.rewrites).leftOut;
        const inPlugin = join(plugin.real, 'skills');
        skills = existsSync(inPlugin) && lstatSync(inPlugin).isDirectory() ? inPlugin : null;
      } catch (error) {
        rmSync(wrapper, { recursive: true, force: true });
        changed(plugin.id, error);
        continue;
      }
      leftOut.push(...notes);
      pluginDirs.push(wrapper);
      wrapped.push(plugin.id);
      if (skills !== null) skillRoots.push(skills);
    }
    return {
      setup: {
        pluginDirs,
        skillRoots,
        reads: [dir, ...kept.reads],
        loaded: { skills: linked, plugins: wrapped },
        leftOut,
        secretFiles: kept.secretFiles,
      },
      remove,
    };
  } catch (error) {
    remove();
    // The setup dir itself or the project's copies could not be written: the session is refused with why.
    const code = error instanceof Error && 'code' in error ? String(error.code) : String(error);
    throw new SandboxProfileError('setup', `the session's setup dir could not be written: ${code}`);
  }
}
