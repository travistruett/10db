import { describe, expect, it } from 'vitest';
import type { Git } from '../git';
import { readRepoText } from './repo-text';

type ReadingGit = Pick<Git, 'survey' | 'commitAt' | 'fileAt'>;

function gitWith(files: Record<string, string | { kind: string }>): ReadingGit {
  return {
    survey: () => Promise.resolve({ files: Object.keys(files), commits: [] }),
    commitAt: () => Promise.resolve('abc123'),
    fileAt: (_repo, _rev, path, maxBytes) => {
      const value = files[path];
      if (value === undefined) return Promise.resolve({ kind: 'missing' });
      if (typeof value !== 'string')
        return Promise.resolve({ kind: 'not_regular', mode: '120000' });
      if (value.length > maxBytes)
        return Promise.resolve({ kind: 'too_large', bytes: value.length });
      return Promise.resolve({ kind: 'file', text: value });
    },
  };
}

describe('reading a repository as data', () => {
  it('reads the agents files, makefiles, compose files and development docs, line by line', async () => {
    const text = await readRepoText(
      gitWith({
        Makefile: 'a:\n\techo\n',
        'amps/AGENTS.md': '# amps\nrun make migration\n',
        'docker-compose.yml': 'services:\n  backend: {}\n',
        'docs/development/local-docker.md': 'make backend-lock\n',
        'src/main.py': 'print(1)\n',
        'amps/dev_export.py': 'x',
        'scripts/release.sh': 'x',
      }),
      '/repo',
    );
    expect(text?.commit).toBe('abc123');
    expect(text?.files.map((f) => f.path).sort()).toEqual([
      'Makefile',
      'amps/AGENTS.md',
      'docker-compose.yml',
      'docs/development/local-docker.md',
    ]);
    expect(text?.files.find((f) => f.path === 'amps/AGENTS.md')?.lines).toEqual([
      '# amps',
      'run make migration',
    ]);
    expect(text?.scripts).toEqual(['amps/dev_export.py', 'scripts/release.sh']);
    expect(text?.tracked).toContain('src/main.py');
  });

  it('skips a link, an oversize file and a missing one, and says how many', async () => {
    const text = await readRepoText(
      gitWith({
        'AGENTS.md': { kind: 'link' },
        Makefile: 'x'.repeat(100 * 1024),
        'docs/README.md': 'hello\n',
      }),
      '/repo',
    );
    expect(text?.files.map((f) => f.path)).toEqual(['docs/README.md']);
    expect(text?.skipped).toBe(2);
  });

  it('cuts long lines and long files, so a hostile file cannot fill the prompt', async () => {
    const text = await readRepoText(
      gitWith({
        Makefile: `${'y'.repeat(5000)}\n${Array.from({ length: 2000 }, (_, i) => `l${String(i)}`).join('\n')}`,
      }),
      '/repo',
    );
    const lines = text?.files[0]?.lines ?? [];
    expect(lines[0]?.length).toBeLessThan(400);
    expect(lines.length).toBeLessThanOrEqual(400);
  });

  it('answers null for an empty repository or one git will not read', async () => {
    expect(await readRepoText(gitWith({}), '/repo')).toBeNull();
    const refused = {
      survey: () => Promise.resolve({ refused: 'not_a_repository', message: 'no' }),
    } as unknown as ReadingGit;
    expect(await readRepoText(refused, '/repo')).toBeNull();
  });
});
