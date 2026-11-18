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
  return (
    readdirSync(parentPath, { withFileTypes: true })
      // Hidden directories (such as an agent harness's untracked .claude) are not apps or packages.
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'),
      )
      .map((entry) => `${parent}/${entry.name}`)
      .sort()
  );
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

  // Codex joins the AGENTS.md files from the root down to its working directory and cuts the text at
  // project_doc_max_bytes, so a chain past it loses its end without a word.
  it('keeps every AGENTS.md chain within the Codex project doc limit', () => {
    const limit = Number(
      /^project_doc_max_bytes = (\d+)$/m.exec(readRepoFile('.codex/config.toml'))?.[1],
    );
    const docs = repoFiles().filter((path) => basename(path) === 'AGENTS.md');
    const chainBytes = (path: string): number =>
      docs
        .filter((doc) => doc === 'AGENTS.md' || path.startsWith(doc.slice(0, -'AGENTS.md'.length)))
        .reduce((sum, doc) => sum + Buffer.byteLength(readRepoFile(doc)), 0);
    expect(docs.filter((path) => chainBytes(path) > limit)).toEqual([]);
  });

  // An agent reads every AGENTS.md on its path before it starts, so a long one costs every session
  // in that directory. Rules stay here; catalogues and histories go to docs/architecture.
  it('keeps every AGENTS.md within its word budget', () => {
    const budget = 5000;
    const words = (path: string): number => readRepoFile(path).split(/\s+/).filter(Boolean).length;
    const over = repoFiles()
      .filter((path) => basename(path) === 'AGENTS.md')
      .filter((path) => words(path) > budget)
      .map((path) => `${path}: ${String(words(path))} words`);
    expect(over).toEqual([]);
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

// A unit test is added only for core behavior or an escaped bug, so no instruction an agent reads
// may ask for a test per behavior, state-table row, acceptance criterion or review finding.
describe('test guidance', () => {
  const guidance = repoFiles().filter(
    (path) =>
      path === 'AGENTS.md' ||
      path === 'apps/daemon/src/briefing/prompts.ts' ||
      /^\.claude\/(rules|agents)\/[^/]+\.md$/.test(path) ||
      /^packages\/harness\/plugin\/personas\/[^/]+\.md$/.test(path) ||
      /^packages\/harness\/plugin\/skills\/[^/]+\/SKILL\.md$/.test(path),
  );
  const text = (path: string): string => readRepoFile(path).replace(/\s+/g, ' ');

  it.each([
    ['a test per behavior', /one (red-first )?test per behaviou?r/i],
    [
      'a card listing its state-table rows and tests',
      /lists the state-table rows it covers and its tests/i,
    ],
    ['every state-table row', /every state-table row/i],
    ['a test for every acceptance criterion', /every acceptance criterion[^.]*has a test/i],
    ['a step and a test for every criterion', /every criterion needs a step and a test/i],
    ['tests that prove each criterion', /tests that prove each acceptance criterion/i],
    ['exhaustive cases', /exhaustive cases/i],
    ['count is not the cost', /count is not the cost/i],
    ['one row per case', /one row per case/i],
  ])('never asks for %s', (_name, phrasing) => {
    expect(guidance.filter((path) => phrasing.test(text(path)))).toEqual([]);
  });

  it('keeps testing.md short', () => {
    const words = readRepoFile('.claude/rules/testing.md').split(/\s+/).filter(Boolean).length;
    expect(words).toBeLessThan(650);
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
