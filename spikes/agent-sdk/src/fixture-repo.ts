// Creates a throwaway git repo with one commit, so probes never touch a real checkout.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeFixtureRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'tendb-spike-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# spike fixture\n');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  git('add', 'README.md', ...Object.keys(files));
  git('-c', 'user.name=10db spike', '-c', 'user.email=spike@10db.invalid', 'commit', '-m', 'fixture');
  return dir;
}
