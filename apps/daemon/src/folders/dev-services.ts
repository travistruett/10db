import { posix } from 'node:path';
import type { ProjectDto } from '@10db/contracts';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Git } from '../git';
import { composeFiles } from './detect-app-address';

/** The project's compose services, as the judge is told them: every name one compose accepts. */
export interface ComposeServices {
  /** The compose files read, base files before the overrides that extend them. */
  readonly files: readonly string[];
  /** The compose project, from `name:` or the base file's folder; null when neither gives a valid one. */
  readonly project: string | null;
  readonly services: readonly string[];
  /** The `container_name`s the services set, which replace `<project>-<service>-<n>`. */
  readonly containerNames: readonly string[];
}

/** The most services named: a longer list tells the judge no more. */
export const MAX_SERVICES = 30;
/** The most compose files read, and how deep in the repository one may be. */
export const MAX_COMPOSE_FILES = 8;
export const MAX_COMPOSE_DEPTH = 3;
export const MAX_COMPOSE_BYTES = 256 * 1024;

// Compose's own rules: a name it would refuse can't be one of the project's services.
const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

// Compose files are read from the repository: a boundary, so their shape is checked.
const ComposeFile = z.looseObject({
  name: z.string().optional(),
  services: z.record(
    z.string(),
    z.looseObject({ container_name: z.string().optional() }).nullable(),
  ),
});

function parsed(text: string): z.infer<typeof ComposeFile> | null {
  try {
    return ComposeFile.safeParse(parseYaml(text, { merge: true })).data ?? null;
  } catch {
    return null;
  }
}

/** The project compose names when the file sets none: its folder's name, lower-cased; none at the root. */
function folderProject(path: string): string | null {
  const dir = posix.dirname(path);
  return dir === '.' ? null : posix.basename(dir).toLowerCase();
}

/**
 * The services the compose files define, merged as compose merges a base and its overrides: unique and
 * sorted. A file that isn't valid YAML or compose is skipped, and a name compose would refuse is dropped;
 * null when no service is left. `texts` is in the order `composeFiles` reads them.
 */
export function composeServices(texts: ReadonlyMap<string, string>): ComposeServices | null {
  const files: string[] = [];
  const services = new Set<string>();
  const containers = new Set<string>();
  let project: string | null | undefined;
  for (const [path, text] of texts) {
    const file = parsed(text);
    if (file === null) continue;
    files.push(path);
    project ??= file.name ?? folderProject(path);
    for (const [name, service] of Object.entries(file.services)) {
      if (SERVICE_NAME.test(name)) services.add(name);
      const container = service?.container_name;
      if (container !== undefined && SERVICE_NAME.test(container)) containers.add(container);
    }
  }
  if (services.size === 0) return null;
  return {
    files,
    project: project != null && PROJECT_NAME.test(project) ? project : null,
    services: [...services].sort().slice(0, MAX_SERVICES),
    containerNames: [...containers].sort().slice(0, MAX_SERVICES),
  };
}

/**
 * The compose services tracked at `refs/remotes/origin/<base>`, never the working tree: a lane can write
 * that, and its own edit must not change what the judge treats as local. Null with no such branch, no
 * compose file, or anything git can't read. Never throws.
 */
export async function readComposeServices(
  git: Pick<Git, 'remoteTrackingCommit' | 'filesAt' | 'fileAt'>,
  project: Pick<ProjectDto, 'repoPath' | 'baseBranch'>,
): Promise<ComposeServices | null> {
  try {
    const commit = await git.remoteTrackingCommit(project.repoPath, project.baseBranch);
    if (commit === null) return null;
    const paths = composeFiles(await git.filesAt(project.repoPath, commit))
      .filter((p) => p.split('/').length <= MAX_COMPOSE_DEPTH)
      .slice(0, MAX_COMPOSE_FILES);
    const texts = new Map<string, string>();
    for (const path of paths) {
      const file = await git.fileAt(project.repoPath, commit, path, MAX_COMPOSE_BYTES);
      if (file.kind === 'file') texts.set(path, file.text);
    }
    return composeServices(texts);
  } catch {
    return null;
  }
}
