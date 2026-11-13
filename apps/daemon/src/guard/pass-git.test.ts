import { describe, expect, it } from 'vitest';
import { passGitCall, type PassGitCall } from './pass-git';

const run = (argv: string[], pushesCurrentBranch = false): PassGitCall => ({
  kind: 'run',
  argv,
  pushesCurrentBranch,
});
const REFUSE = 'refuse';

// In a pass the builder may let a commit, a push or a merge run on a card, as in Claude Code. 10db
// runs the call as written, so only a plain one-line call is offered; a force push, a push to the
// default branch and another repository stay refused.
describe('passGitCall', () => {
  it.each<[string, string, PassGitCall | typeof REFUSE | null]>([
    ['a commit', "git commit -m 'Add the page'", run(['git', 'commit', '-m', 'Add the page'])],
    [
      'a commit of named paths',
      'git commit -m x -- a.ts b.ts',
      run(['git', 'commit', '-m', 'x', '--', 'a.ts', 'b.ts']),
    ],
    ['an amend', 'git commit --amend --no-edit', run(['git', 'commit', '--amend', '--no-edit'])],
    // With no branch named, push.default decides, and `matching` would push main too.
    ['a bare push', 'git push', REFUSE],
    ['a push to origin', 'git push origin', REFUSE],
    ['a push to a URL', 'git push https://example.net/repo.git feat/page', REFUSE],
    ['a push to a path', 'git push ../elsewhere feat/page', REFUSE],
    ['a push to MAIN', 'git push origin feat:MAIN', REFUSE],
    [
      'a push of HEAD',
      'git push -u origin HEAD',
      run(['git', 'push', '-u', 'origin', 'HEAD'], true),
    ],
    [
      'a push of a branch',
      'git push origin feat/page',
      run(['git', 'push', 'origin', 'feat/page']),
    ],
    [
      'a push of a branch to its name',
      'git push origin feat/page:feat/page',
      run(['git', 'push', 'origin', 'feat/page:feat/page']),
    ],
    ['a local merge', 'git merge feat/page', run(['git', 'merge', 'feat/page'])],
    [
      'a pull request merge',
      'gh pr merge 12 --squash',
      run(['gh', 'pr', 'merge', '12', '--squash']),
    ],
    ['a force push', 'git push --force origin feat/page', REFUSE],
    ['a force push, short', 'git push -f origin feat/page', REFUSE],
    ['a force push in a cluster', 'git push -uf origin feat/page', REFUSE],
    ['a force push with lease', 'git push --force-with-lease origin feat/page', REFUSE],
    [
      'a force push with lease and a value',
      'git push --force-with-lease=feat/page origin feat/page',
      REFUSE,
    ],
    ['a force refspec', 'git push origin +feat/page', REFUSE],
    ['a mirror push', 'git push --mirror origin', REFUSE],
    ['a push of every branch', 'git push --all origin', REFUSE],
    ['a delete', 'git push origin --delete feat/page', REFUSE],
    ['a delete refspec', 'git push origin :feat/page', REFUSE],
    ['a push to the default branch', 'git push origin main', REFUSE],
    ['a push of HEAD to the default branch', 'git push origin HEAD:main', REFUSE],
    ['a push to the default branch by ref', 'git push origin feat:refs/heads/main', REFUSE],
    ['a push that runs a program on the remote', 'git push --receive-pack=x origin feat', REFUSE],
    ['a push to another repository', 'git push --repo=other feat', REFUSE],
    ['an admin merge', 'gh pr merge 12 --admin', REFUSE],
    ['a merge in another repository', 'gh pr merge 12 -R someone/else', REFUSE],
    ['a merge in another repository, flag attached', 'gh pr merge 12 -Rsomeone/else', REFUSE],
    ['a merge in another repository, before the group', 'gh -R someone/else pr merge 12', REFUSE],
    ['a commit in another directory', 'git -C ../other commit -m x', REFUSE],
    ['a commit with a config option', 'git -c core.hooksPath=/tmp commit -m x', REFUSE],
    ['a commit through a path', '/usr/bin/git commit -m x', REFUSE],
    ['a commit through command', 'command git commit -m x', REFUSE],
    ['a commit through env', 'env GIT_DIR=x git commit -m x', REFUSE],
    ['a commit after another command', 'git add a.ts && git commit -m x', REFUSE],
    ['a commit in the background', 'git commit -m x &', REFUSE],
    // The guard's own rules refuse a script a shell reads.
    ['a commit fed to a shell', "echo 'git commit -m x' | sh", null],
    ['a commit whose message is a substitution', 'git commit -m "$(cat msg)"', REFUSE],
    ['a commit whose message holds a variable', 'git commit -m "$MSG"', REFUSE],
    ['a commit that redirects its output', 'git commit -m x > log', REFUSE],
    ['a status', 'git status', null],
    ['a log', 'git log --oneline', null],
    ['a checkout', 'git checkout main', null],
    ['a pull request view', 'gh pr view 12', null],
    ['a test run', 'pnpm test', null],
    ['a line with no git', 'ls && pwd', null],
    ['a log piped into a search for merges', 'git log --oneline | grep merge', null],
    ['a status beside a commit message file', 'git status && cat commit.txt', null],
  ])('%s', (_name, command, expected) => {
    const call = passGitCall(command, 'main');
    if (expected === REFUSE) expect(call?.kind).toBe('refuse');
    else expect(call).toEqual(expected);
  });

  it('refuses a push to main and to the project’s own default branch', () => {
    expect(passGitCall('git push origin trunk', 'trunk')?.kind).toBe('refuse');
    expect(passGitCall('git push origin main', 'trunk')?.kind).toBe('refuse');
    expect(passGitCall('git push origin master', 'trunk')).toEqual(
      run(['git', 'push', 'origin', 'master']),
    );
  });
});
