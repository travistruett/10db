import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isolatedGitEnvironment } from './fixtures';
import { manifestPaths, readManifest, readRepoFile, repoRoot } from './workspace';

/**
 * Every file git would track: tracked plus untracked-not-ignored. Unlike a glob, this includes
 * dot-directories such as `.claude/`, and it skips node_modules, target and scratch via .gitignore.
 */
function repoFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repoRoot, env: isolatedGitEnvironment(), encoding: 'utf8' },
  );
  return out
    .split('\0')
    .filter((path) => path !== '' && existsSync(resolve(repoRoot, path)))
    .sort();
}

function repoDirs(parent: string): string[] {
  const parentPath = resolve(repoRoot, parent);
  if (!existsSync(parentPath)) return [];
  return readdirSync(parentPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => `${parent}/${entry.name}`)
    .sort();
}

function filesIn(dir: string, extension: string): string[] {
  return repoFiles().filter(
    (path) =>
      path.startsWith(`${dir}/`) &&
      !path.slice(dir.length + 1).includes('/') &&
      path.endsWith(extension),
  );
}

describe('agent instruction files', () => {
  it('has no CLAUDE.md anywhere; AGENTS.md is the only instruction file', () => {
    expect(repoFiles().filter((path) => basename(path) === 'CLAUDE.md')).toEqual([]);
  });

  it('gives every app and package its own AGENTS.md', () => {
    const missing = [...repoDirs('apps'), ...repoDirs('packages')].filter(
      (dir) => !existsSync(resolve(repoRoot, dir, 'AGENTS.md')),
    );
    expect(missing).toEqual([]);
  });

  it('sets the Codex project doc limit high enough for the AGENTS.md chain', () => {
    expect(readRepoFile('.codex/config.toml')).toMatch(/^project_doc_max_bytes = 131072$/m);
  });
});

describe('subagents', () => {
  const claudeAgents = filesIn('.claude/agents', '.md');

  it('defines the four roles', () => {
    expect(claudeAgents.map((p) => basename(p, '.md'))).toEqual([
      'code-reviewer',
      'implementer',
      'plan-reviewer',
      'researcher',
    ]);
  });

  it.each(claudeAgents)('%s pins a model and opens its report with the model ID', (path) => {
    const body = readRepoFile(path);
    expect(body).toMatch(/^model: (opus|sonnet|haiku|fable)$/m);
    expect(body).toContain('The first line of your report is the model you are running on');
  });

  it('gives every Claude agent a thin Codex pointer to the same body', () => {
    const pointers = filesIn('.codex/agents', '.toml');
    expect(pointers.map((p) => basename(p, '.toml'))).toEqual(
      claudeAgents.map((p) => basename(p, '.md')),
    );
    for (const pointer of pointers) {
      const name = basename(pointer, '.toml');
      expect(readRepoFile(pointer)).toContain(`Read .claude/agents/${name}.md`);
    }
  });
});

describe('code layout', () => {
  it('never lets a package depend on an app', () => {
    const appNames = manifestPaths()
      .filter((p) => p.startsWith('apps/'))
      .map((p) => readManifest(p).name);
    const offenders = manifestPaths()
      .filter((p) => p.startsWith('packages/'))
      .flatMap((p) => {
        const m = readManifest(p);
        const deps = Object.keys({ ...m.dependencies, ...m.devDependencies });
        return deps.filter((d) => appNames.includes(d)).map((d) => `${m.name} -> ${d}`);
      });
    expect(offenders).toEqual([]);
  });

  it('has no grab-bag modules', () => {
    const grabBags = repoFiles().filter(
      (p) =>
        /^(apps|packages)\//.test(p) && /^(utils|helpers|misc|common)\.tsx?$/.test(basename(p)),
    );
    expect(grabBags).toEqual([]);
  });
});
