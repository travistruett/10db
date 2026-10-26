import { globSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

describe('docs/architecture', () => {
  it('numbers decisions from 1 with no gaps or repeats', () => {
    // \s* tolerates column padding, in case the table is ever formatted.
    const numbers = [
      ...readRepoFile('docs/architecture/decisions.md').matchAll(/^\|\s*(\d+)\s*\|/gm),
    ].map((m) => Number(m[1]));
    expect(numbers.length).toBeGreaterThanOrEqual(20);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
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
