import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { TakeoverRefusedError } from './takeover-command';

// A terminal Claude Code asks a new config directory to finish its first-run screens and to trust the folder
// before it resumes anything. 10db's session already runs there with both settled, so the terminal gets them
// recorded the way Claude Code itself records them, once.

const CONFIG_FILE = '.claude.json';

const ProjectEntry = z.looseObject({ hasTrustDialogAccepted: z.boolean().optional() });
const ClaudeConfig = z.looseObject({
  hasCompletedOnboarding: z.boolean().optional(),
  projects: z.record(z.string(), ProjectEntry).optional(),
});
type ClaudeConfig = z.infer<typeof ClaudeConfig>;

/** The file's text, or null when there is none; a link or a directory in its place is refused. */
async function readConfigText(file: string): Promise<string | null> {
  const stat = await lstat(file).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat === null) return null;
  if (!stat.isFile())
    throw new TakeoverRefusedError(`${CONFIG_FILE} in the account's folder is not a plain file`);
  return readFile(file, 'utf8');
}

function parse(text: string | null): ClaudeConfig {
  if (text === null) return {};
  try {
    return ClaudeConfig.parse(JSON.parse(text));
  } catch {
    throw new TakeoverRefusedError(`${CONFIG_FILE} in the account's folder can't be read`);
  }
}

/** Whether the builder has already answered Claude Code's trust question for the folder, either way. */
const answered = (config: ClaudeConfig, folder: string): boolean =>
  config.projects?.[folder]?.hasTrustDialogAccepted !== undefined;

/** Whether Claude Code needs nothing more recorded for these folders. */
const marked = (config: ClaudeConfig, folders: readonly string[]): boolean =>
  config.hasCompletedOnboarding === true && folders.every((folder) => answered(config, folder));

/** `config` with onboarding done and each folder trusted, every other key kept. */
function withMarks(config: ClaudeConfig, folders: readonly string[]): ClaudeConfig {
  const projects = { ...config.projects };
  // A folder the builder declined stays declined: the terminal asks them again.
  for (const folder of folders)
    if (!answered(config, folder))
      projects[folder] = { ...projects[folder], hasTrustDialogAccepted: true };
  return { ...config, hasCompletedOnboarding: true, projects };
}

/**
 * Records the first-run and folder-trust marks in the account directory's `.claude.json`, for `cwd` and its real
 * path. A directory already marked is not rewritten. The file is read once and replaced through a temp file, so
 * a write another process makes between the read and the rename can be lost; that costs only a Claude Code
 * setting it rewrites on its next start.
 */
export async function markOnboarded(configDir: string, cwd: string): Promise<void> {
  const file = join(configDir, CONFIG_FILE);
  const folders = [...new Set([cwd, await realpath(cwd)])];
  const config = parse(await readConfigText(file));
  if (marked(config, folders)) return;
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(withMarks(config, folders), null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
