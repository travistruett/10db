import { constants, realpathSync, type Stats } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  FolderRefusalReason,
  type FolderInspectResult,
  type FolderInspection,
  type ProjectDto,
} from '@10db/contracts';
import { equalOrUnder, samePath, type Git } from '../git';
import { githubRepoOf } from '../github';
import { gateCandidates, type FolderFiles } from './gate-candidates';

/** A file bigger than this counts as absent: a gate is named by a small file. */
const MAX_FILE_BYTES = 256 * 1024;

const LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json'];

export interface InspectFolderDeps {
  readonly git: Git;
  /** Every registered project, for the already-a-project refusals. */
  readonly projects: readonly ProjectDto[];
  /** The data dir, the lane temp root and the worktree root: 10db's own places. */
  readonly protectedRoots: readonly string[];
}

const refuse = (reason: FolderRefusalReason, message: string): FolderInspectResult => ({
  ok: false,
  reason,
  message,
});

const REASON_BY_GIT = {
  not_a_repository: FolderRefusalReason.NotARepository,
  bare_repository: FolderRefusalReason.BareRepository,
  unreadable: FolderRefusalReason.Unreadable,
} as const;

const GIT_MESSAGES = {
  not_a_repository: "This folder isn't a git repository.",
  bare_repository: 'This is a bare repository; choose a checkout.',
} as const;

/** The real path of `path`, or its absolute form when it can't be resolved. */
function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The text of `name` in `dir`, or null when it is absent, is not a regular file (a link counts as
 * absent and is never followed), is over the size cap, or can't be read.
 */
async function readSmallFile(dir: string, name: string): Promise<string | null> {
  const path = join(dir, name);
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.size > MAX_FILE_BYTES) return null;
    // The file may be swapped for a link or a pipe after the lstat: never follow, never block.
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_FILE_BYTES) return null;
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return bytesRead > MAX_FILE_BYTES ? null : buffer.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function isRegularFile(dir: string, name: string): Promise<boolean> {
  try {
    return (await lstat(join(dir, name))).isFile();
  } catch {
    return false;
  }
}

async function readFolderFiles(root: string): Promise<FolderFiles> {
  const packageText = await readSmallFile(root, 'package.json');
  let packageJson: unknown = null;
  if (packageText !== null) {
    try {
      packageJson = JSON.parse(packageText);
    } catch {
      packageJson = null;
    }
  }
  const present = await Promise.all(LOCKFILES.map((name) => isRegularFile(root, name)));
  return {
    makefile: await readSmallFile(root, 'Makefile'),
    packageJson,
    lockfiles: LOCKFILES.filter((_, i) => present[i]),
    cargoToml: await isRegularFile(root, 'Cargo.toml'),
    goMod: await isRegularFile(root, 'go.mod'),
  };
}

/** `owner/name` of a github.com origin; a URL the parser can't read is not one. */
function githubOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return githubRepoOf(url);
  } catch {
    return null;
  }
}

/** The refusal a registered project gives `root`, if any. */
function projectRefusal(root: string, projects: readonly ProjectDto[]): FolderInspectResult | null {
  for (const project of projects) {
    const checkout = realOrResolved(project.repoPath);
    if (samePath(root, checkout))
      return refuse(FolderRefusalReason.AlreadyAProject, `${project.name} is already a project.`);
    if (equalOrUnder(root, checkout))
      return refuse(
        FolderRefusalReason.InsideAProject,
        `This folder is inside ${project.name}, which is already a project.`,
      );
    if (equalOrUnder(checkout, root))
      return refuse(
        FolderRefusalReason.InsideAProject,
        `This folder contains ${project.name}, which is already a project.`,
      );
  }
  return null;
}

/**
 * What a new project is prefilled from for the folder at `path`, or why the folder can't be one
 * (spec §9.1). Reads the folder and writes nothing; git answers on the unpinned path, so a refusal
 * of the repository is an answer here, never an Inbox card.
 */
export async function inspectFolder(
  deps: InspectFolderDeps,
  path: string,
): Promise<FolderInspectResult> {
  let kind: Stats;
  try {
    kind = await stat(path);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return refuse(FolderRefusalReason.NotFound, 'Nothing is at this path.');
    return refuse(FolderRefusalReason.Unreadable, 'This folder cannot be read.');
  }
  if (!kind.isDirectory())
    return refuse(FolderRefusalReason.NotADirectory, 'This is a file, not a folder.');

  const facts = await deps.git.inspect(path);
  if ('refused' in facts) {
    const message = facts.refused === 'unreadable' ? facts.message : GIT_MESSAGES[facts.refused];
    return refuse(REASON_BY_GIT[facts.refused], message);
  }

  const root = facts.root;
  if (deps.protectedRoots.some((p) => equalOrUnder(root, realOrResolved(p))))
    return refuse(
      FolderRefusalReason.ProtectedPath,
      '10db keeps its own files here; choose another folder.',
    );
  const projectRefused = projectRefusal(root, deps.projects);
  if (projectRefused) return projectRefused;

  const inspection: FolderInspection = {
    root,
    suggestedName: basename(root),
    branches: facts.branches.map((b) => ({ ...b })),
    defaultBranch: facts.defaultBranch,
    github: githubOf(facts.originFetchUrl),
    gateCandidates: gateCandidates(await readFolderFiles(root)),
  };
  return { ok: true, inspection };
}
