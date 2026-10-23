import { execFileSync } from 'node:child_process';

export function head(repo: string): string {
  return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
}
