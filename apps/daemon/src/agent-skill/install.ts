import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AgentSkillLinkState, AgentSkillTool, type AgentSkillLink } from '@10db/contracts';
import { z } from 'zod';

const SKILL_NAME = '10db-task';

export class AgentSkillInstallError extends Error {
  override readonly name = 'AgentSkillInstallError';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Where 10db keeps its own copy of the skill. */
export function installedSkillDir(home: string): string {
  return join(home, '.10db', 'skills', SKILL_NAME);
}

/** The paths the skill is linked at, one per agent tool. */
export function skillLinkPaths(home: string): readonly { tool: AgentSkillTool; path: string }[] {
  return [
    { tool: AgentSkillTool.ClaudeCode, path: join(home, '.claude', 'skills', SKILL_NAME) },
    { tool: AgentSkillTool.Codex, path: join(home, '.agents', 'skills', SKILL_NAME) },
  ];
}

const VersionText = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{12}$/);

/** The version a skill folder's `VERSION` file holds; null when it is absent or not 12 hex digits. */
export function readSkillVersion(dir: string): string | null {
  try {
    const parsed = VersionText.safeParse(readFileSync(join(dir, 'VERSION'), 'utf8'));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

type PathKind =
  | { readonly kind: 'missing' }
  | { readonly kind: 'link'; readonly text: string }
  | { readonly kind: 'other' };

function kindOf(path: string): PathKind {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink() ? { kind: 'link', text: readlinkSync(path) } : { kind: 'other' };
  } catch {
    return { kind: 'missing' };
  }
}

/**
 * What a link path holds, judged by where a link resolves rather than by its text, so a relative link
 * to the installed copy counts as ours. A link to nothing is `dangling`: 10db may replace it.
 */
function judgeLink(
  path: string,
  home: string,
): { state: AgentSkillLinkState; target: string | null; dangling: boolean } {
  const found = kindOf(path);
  if (found.kind === 'missing')
    return { state: AgentSkillLinkState.Missing, target: null, dangling: false };
  if (found.kind === 'other')
    return { state: AgentSkillLinkState.InTheWay, target: null, dangling: false };
  const resolved = realOrNull(resolve(dirname(path), found.text));
  if (resolved === null)
    return { state: AgentSkillLinkState.Missing, target: null, dangling: true };
  if (resolved === realOrNull(installedSkillDir(home)))
    return { state: AgentSkillLinkState.Linked, target: null, dangling: false };
  return { state: AgentSkillLinkState.PointsElsewhere, target: found.text, dangling: false };
}

/** The installed copy's version and where each link stands; changes nothing. */
export function inspectAgentSkill(home: string): {
  installedVersion: string | null;
  links: AgentSkillLink[];
} {
  return {
    installedVersion: readSkillVersion(installedSkillDir(home)),
    links: skillLinkPaths(home).map(({ tool, path }) => {
      const { state, target } = judgeLink(path, home);
      return { tool, path, state, target };
    }),
  };
}

function linkOne(
  home: string,
  tool: AgentSkillTool,
  path: string,
): { link: AgentSkillLink; error: AgentSkillInstallError | null } {
  try {
    return { link: linkPath(home, tool, path), error: null };
  } catch (error) {
    const { state, target } = judgeLink(path, home);
    return {
      link: { tool, path, state, target },
      error: new AgentSkillInstallError(`${path}: ${describeError(error)}`),
    };
  }
}

function linkPath(home: string, tool: AgentSkillTool, path: string): AgentSkillLink {
  const judged = judgeLink(path, home);
  if (judged.state === AgentSkillLinkState.Missing) {
    if (judged.dangling) rmSync(path);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(installedSkillDir(home), path);
    return { tool, path, state: AgentSkillLinkState.Linked, target: null };
  }
  return { tool, path, state: judged.state, target: judged.target };
}

function copySkill(home: string, shippedDir: string, version: string): void {
  const dest = installedSkillDir(home);
  if (readSkillVersion(dest) === version) return;
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(shippedDir, dest, { recursive: true });
}

/**
 * Makes the installed copy match the shipped one and links it where nothing of the builder's is: a link
 * of theirs, or a real folder or file, is left as it is. A copy that cannot be written throws; a link that
 * cannot be made is returned as `error` after the other is tried.
 */
export function installAgentSkill(
  home: string,
  shippedDir: string,
): { installedVersion: string; links: AgentSkillLink[]; error: AgentSkillInstallError | null } {
  const version = readSkillVersion(shippedDir);
  if (version === null)
    throw new AgentSkillInstallError(`the shipped skill in ${shippedDir} has no valid VERSION`);
  try {
    copySkill(home, shippedDir, version);
  } catch (error) {
    throw new AgentSkillInstallError(describeError(error));
  }
  // Each link is tried even when the other failed; the first failure is kept.
  const results = skillLinkPaths(home).map(({ tool, path }) => linkOne(home, tool, path));
  return {
    installedVersion: version,
    links: results.map((r) => r.link),
    error: results.find((r) => r.error !== null)?.error ?? null,
  };
}
