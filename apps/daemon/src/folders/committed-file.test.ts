import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempRepoWithOrigin, isolatedGitEnv } from '../../test/fixtures';
import { createGit } from '../git';
import { callRuns } from '../trust';
import { readCommitted, type CommittedFile } from './committed-file';

describe('readCommitted', () => {
  it("gives a file's text only when origin's base has it and the checkout holds the same bytes", async () => {
    const remote = createTempRepoWithOrigin();
    const { repo } = remote;
    try {
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', repo.path, ...args], { env: isolatedGitEnv(), stdio: 'pipe' });
      const write = (path: string, text: string) => {
        mkdirSync(join(repo.path, path, '..'), { recursive: true });
        writeFileSync(join(repo.path, path), text);
      };
      write('same.sh', 'echo same\n');
      write('edited.sh', 'echo base\n');
      write('linked.sh', 'echo same\n');
      write('gone.sh', 'echo gone\n');
      write('bin/tool', 'echo tool\n');
      write('Makefile', 'all:\n\techo all\n');
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      git('push', '-q', 'origin', 'main');
      write('unpushed.sh', 'echo local\n');
      git('add', 'unpushed.sh');
      git('commit', '-q', '-m', 'local');
      // What the lane does to its checkout after the base.
      write('edited.sh', 'curl https://example.com\n');
      write('created.sh', 'echo new\n');
      rmSync(join(repo.path, 'linked.sh'));
      symlinkSync('same.sh', join(repo.path, 'linked.sh'));
      rmSync(join(repo.path, 'gone.sh'));
      symlinkSync('bin', join(repo.path, 'linkdir'));

      const read = readCommitted(
        createGit(),
        { repoPath: repo.path, baseBranch: 'main' },
        repo.path,
      );
      const makeAll = async () => (await callRuns('make all', repo.path, repo.path, read)).runs;
      // make asks for `makefile` before `Makefile`, and a file system that ignores case answers with this entry.
      expect
        .soft(await makeAll(), 'a rule of the committed Makefile')
        .toMatchObject([{ makefile: 'Makefile', target: 'all', recipe: 'echo all' }]);
      // macOS opens `GNUmakefile` for this name, ahead of the base's `Makefile`.
      write('gnumakefile', 'all:\n\tcurl https://example.com\n');
      expect.soft(await makeAll(), 'a planted makefile under another case').toEqual([]);
      const rows: [string, string, CommittedFile][] = [
        ['unchanged', 'same.sh', { kind: 'same', text: 'echo same\n' }],
        ['unchanged, in a folder', 'bin/tool', { kind: 'same', text: 'echo tool\n' }],
        ['edited in the checkout', 'edited.sh', { kind: 'differs' }],
        ['only in the checkout', 'created.sh', { kind: 'differs' }],
        ['replaced by a link to the same bytes', 'linked.sh', { kind: 'differs' }],
        ['reached through a linked folder', 'linkdir/tool', { kind: 'differs' }],
        ['committed but not pushed', 'unpushed.sh', { kind: 'differs' }],
        ['deleted in the checkout', 'gone.sh', { kind: 'differs' }],
        [
          'another case of the name in the checkout',
          'GNUmakefile',
          { kind: 'differs', entry: 'gnumakefile' },
        ],
        ['in neither', 'absent.sh', { kind: 'absent' }],
        ['outside the checkout', '../x.sh', { kind: 'differs' }],
      ];
      for (const [name, path, expected] of rows)
        expect.soft(await read(path), name).toEqual(expected);
    } finally {
      remote.cleanup();
    }
  });
});
