import { execFileSync } from 'node:child_process';
import { globSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isolatedGitEnvironment } from './fixtures';
import { readRepoFile, repoRoot } from './workspace';

/** Every note allowed in docs/architecture/research. A new note is read through before it joins. */
const PUBLIC_RESEARCH = [
  'external-research.md',
  'external-research-recheck.md',
  'gbrain-lessons.md',
  'm1-live-acceptance.md',
  'spikes-summary.md',
  'spike-01-runtime.md',
  'spike-02-context-usage.md',
  'spike-03-compaction.md',
  'spike-04-mcp-headers.md',
  'spike-05-questions-permissions.md',
  'spike-06-park-resume.md',
  'spike-07-usage-limits.md',
  'spike-08-sidecar.md',
  'spike-09-caffeinate.md',
  'spike-10-bg-daemon.md',
  'spike-11-tauri-first-window.md',
  'spike-12-accounts.md',
  'spike-13-sandbox.md',
  'spike-14-sandbox-policy.md',
];

/** The numbered log is closed: parallel branches collided on the next number. */
const LAST_NUMBERED_DECISION = 133;
const DECISION_FILE = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/**
 * A dot-entry is never a decision: Claude Code can leave an empty `.claude/.cc-writes` staging
 * directory beside a file it writes, and that must not fail the gate.
 */
function decisionFiles(dir = join(repoRoot, 'docs/architecture/decisions')): string[] {
  return readdirSync(dir).filter((name) => name !== 'README.md' && !name.startsWith('.'));
}

describe('decisionFiles', () => {
  it('skips README.md and every dot-entry, such as a stray .cc-writes directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'decision-files-'));
    try {
      writeFileSync(join(dir, 'README.md'), '');
      writeFileSync(join(dir, '2026-10-27-one.md'), '');
      mkdirSync(join(dir, '.cc-writes'));
      writeFileSync(join(dir, '.DS_Store'), '');
      expect(decisionFiles(dir)).toEqual(['2026-10-27-one.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Claude Code write-staging directories', () => {
  // The index only: an untracked leftover is the harness's, and must not fail a gate by itself.
  it('are never committed: no tracked path has a .cc-writes directory', () => {
    const paths = execFileSync('git', ['ls-files', '--cached', '-z'], {
      cwd: repoRoot,
      env: isolatedGitEnvironment(),
      encoding: 'utf8',
    })
      .split('\0')
      .filter((path) => path.split('/').includes('.cc-writes'));
    expect(paths).toEqual([]);
  });
});

describe('docs/architecture', () => {
  it('keeps the numbered decision log closed at 133, numbered from 1 with no gaps or repeats', () => {
    // \s* tolerates column padding, in case the table is ever formatted.
    const numbers = [
      ...readRepoFile('docs/architecture/decisions.md').matchAll(/^\|\s*(\d+)\s*\|/gm),
    ].map((m) => Number(m[1]));
    expect(
      numbers,
      'record a new decision as its own file in docs/architecture/decisions/',
    ).toEqual(Array.from({ length: LAST_NUMBERED_DECISION }, (_, i) => i + 1));
  });

  it('names each decision file by its date and a slug', () => {
    expect(decisionFiles().length).toBeGreaterThan(0);
    for (const name of decisionFiles()) {
      expect(name, `docs/architecture/decisions/${name}`).toMatch(DECISION_FILE);
    }
  });

  it('gives each decision file a title, its date, a Decision and a Why', () => {
    for (const name of decisionFiles()) {
      const path = `docs/architecture/decisions/${name}`;
      const text = readRepoFile(path);
      const date = DECISION_FILE.exec(name)?.[1];
      expect(text, path).toMatch(/^# \S/);
      expect(text, path).toContain(`- **Date:** ${date ?? 'a date in the file name'}\n`);
      expect(text, path).toMatch(/^## Decision\n[\s\S]+^## Why\n/m);
    }
  });

  it('cites only decision files that exist', () => {
    const docs = globSync(['**/*.md'], {
      cwd: repoRoot,
      exclude: (path) => /(^|\/)(node_modules|target|scratch|\.git)$/.test(path),
    });
    const existing = new Set(decisionFiles());
    for (const path of docs) {
      for (const match of readRepoFile(path).matchAll(/decisions\/(\d{4}-[a-z0-9-]+\.md)/g)) {
        const cited = match[1] ?? '';
        expect(existing.has(cited), `${path} cites decisions/${cited}`).toBe(true);
      }
    }
  });

  it('keeps the governance decisions G1-G11 in their own table', () => {
    const governance = [
      ...readRepoFile('docs/architecture/decisions.md').matchAll(/^\|\s*G(\d+)\s*\|/gm),
    ].map((m) => Number(m[1]));
    expect(governance).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
  });

  it('opens every numbered section with Status, Scope and Summary', () => {
    const sections = globSync('docs/architecture/[0-9][0-9]-*.md', { cwd: repoRoot });
    expect(sections.length).toBeGreaterThan(0);
    for (const path of sections) {
      const head = readRepoFile(path).split('\n').slice(0, 12).join('\n');
      expect(head, path).toMatch(/- \*\*Status:\*\*/);
      expect(head, path).toMatch(/- \*\*Scope:\*\*/);
      expect(head, path).toMatch(/- \*\*Summary:\*\*/);
    }
  });

  // A safety net, not proof that a note is safe to publish: a read-through before publishing and
  // gitleaks are the real checks. Notes about private repos stay outside the repo, so only the
  // listed public notes are allowed here.
  it('keeps only public notes in research, with no known private markers', () => {
    // readdirSync, not a glob, so a dotfile can't slip past the list.
    const research = readdirSync(join(repoRoot, 'docs/architecture/research'));
    expect([...research].sort()).toEqual([...PUBLIC_RESEARCH].sort());
    for (const name of research) {
      const text = readRepoFile(`docs/architecture/research/${name}`);
      expect(text, name).not.toMatch(/AWS_PROFILE=|sk-ant-|\/Users\/[a-z]/);
    }
  });
});
