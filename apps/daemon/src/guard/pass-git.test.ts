import { describe, expect, it } from 'vitest';
import { passGitCall, type PassGitCall } from './pass-git';

const run = (argv: string[]): PassGitCall => ({ kind: 'run', argv, push: null });
const push = (argv: string[], remote: string, currentBranch = false): PassGitCall => ({
  kind: 'run',
  argv,
  push: { remote, currentBranch },
});
const REFUSE = 'refuse';

// In a pass the builder may let a commit, a push or a merge run on a card, as in Claude Code. 10db
// runs the call as written, outside the sandbox, so only a plain one-line call whose options read
// nothing outside the checkout is offered; a force push, a push to the default branch and another
// repository stay refused.
describe('passGitCall', () => {
  it.each<[string, string, PassGitCall | typeof REFUSE | null]>([
    ['a commit', "git commit -m 'Add the page'", run(['git', 'commit', '-m', 'Add the page'])],
    [
      'a commit of named paths',
      'git commit -m x -- a.ts b.ts',
      run(['git', 'commit', '-m', 'x', '--', 'a.ts', 'b.ts']),
    ],
    [
      'a commit of everything, clustered',
      "git commit -am 'Add it'",
      run(['git', 'commit', '-am', 'Add it']),
    ],
    ['a commit with its message attached', 'git commit -mAdd', run(['git', 'commit', '-mAdd'])],
    [
      'a commit with a long message option',
      'git commit --message=Add',
      run(['git', 'commit', '--message=Add']),
    ],
    [
      'an empty commit',
      'git commit --allow-empty -m x',
      run(['git', 'commit', '--allow-empty', '-m', 'x']),
    ],
    ['an amend', 'git commit --amend --no-edit', REFUSE],
    ['a commit message read from a file', 'git commit -F /etc/hosts', REFUSE],
    ['a commit message read from a file, long', 'git commit --file=/etc/hosts', REFUSE],
    ['a commit template', 'git commit --template=/etc/hosts', REFUSE],
    ['a commit reusing a message', 'git commit -C HEAD', REFUSE],
    ['a commit reusing a message, long', 'git commit --reuse-message=HEAD', REFUSE],
    ['a commit of paths read from a file', 'git commit --pathspec-from-file=/etc/hosts', REFUSE],
    ['a commit with a cluster holding a refused letter', 'git commit -aF /etc/hosts', REFUSE],
    [
      'a push of HEAD',
      'git push -u origin HEAD',
      push(['git', 'push', '-u', 'origin', 'HEAD'], 'origin', true),
    ],
    [
      'a push of head in lower case',
      'git push origin head',
      push(['git', 'push', 'origin', 'head'], 'origin', true),
    ],
    ['a push of @', 'git push origin @', push(['git', 'push', 'origin', '@'], 'origin', true)],
    [
      'a push of HEAD to a branch',
      'git push origin HEAD:feat/page',
      push(['git', 'push', 'origin', 'HEAD:feat/page'], 'origin'),
    ],
    [
      'a push of a branch',
      'git push origin feat/page',
      push(['git', 'push', 'origin', 'feat/page'], 'origin'),
    ],
    [
      'a push of a branch to its name',
      'git push origin feat/page:feat/page',
      push(['git', 'push', 'origin', 'feat/page:feat/page'], 'origin'),
    ],
    [
      'a push to refs/heads',
      'git push origin feat:refs/heads/feat',
      push(['git', 'push', 'origin', 'feat:refs/heads/feat'], 'origin'),
    ],
    // With no branch named, push.default decides, and `matching` would push main too.
    ['a bare push', 'git push', REFUSE],
    ['a push to origin', 'git push origin', REFUSE],
    ['a push to a URL', 'git push https://example.net/repo.git feat/page', REFUSE],
    ['a push to a path', 'git push ../elsewhere feat/page', REFUSE],
    ['a push to MAIN', 'git push origin feat:MAIN', REFUSE],
    ['a push of @ to main', 'git push origin @:main', REFUSE],
    ['a push of HEAD to main in another case', 'git push origin head:Main', REFUSE],
    ['a push to a ref path that is no branch', 'git push origin feat:refs/main', REFUSE],
    ['a push to heads/main', 'git push origin feat:heads/main', REFUSE],
    ['a push to a tag ref', 'git push origin feat:refs/tags/main', REFUSE],
    ['a push of a revision expression', 'git push origin HEAD~1:feat', REFUSE],
    ['a push with an option it does not offer', 'git push --signed origin feat', REFUSE],
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
    ['a push to another repository', 'git push --repo=other origin feat', REFUSE],
    ['a local merge', 'git merge feat/page', run(['git', 'merge', 'feat/page'])],
    [
      'a merge of a remote branch with a message',
      'git merge --no-ff -m x origin/feat',
      run(['git', 'merge', '--no-ff', '-m', 'x', 'origin/feat']),
    ],
    ['a merge with a strategy', 'git merge -s ours feat', REFUSE],
    ['a merge with a strategy, long', 'git merge --strategy=ours feat', REFUSE],
    ['a merge with a strategy option', 'git merge -X theirs feat', REFUSE],
    ['a merge message read from a file', 'git merge -F /etc/hosts feat', REFUSE],
    ['a merge of a revision expression', 'git merge HEAD@{1}', REFUSE],
    [
      'a pull request merge',
      'gh pr merge 12 --squash',
      run(['gh', 'pr', 'merge', '12', '--squash']),
    ],
    [
      'a pull request merge of the branch',
      'gh pr merge --squash -d',
      run(['gh', 'pr', 'merge', '--squash', '-d']),
    ],
    [
      'a pull request merge with a subject',
      "gh pr merge 12 -s -t 'Add it'",
      run(['gh', 'pr', 'merge', '12', '-s', '-t', 'Add it']),
    ],
    ['a pull request merge by URL', 'gh pr merge https://github.com/someone/else/pull/1', REFUSE],
    ['a pull request merge in another repository by name', 'gh pr merge someone/else#1', REFUSE],
    ['a pull request merge by branch', 'gh pr merge feat/page', REFUSE],
    ['a pull request merge whose body is a file', 'gh pr merge 12 --body-file /etc/hosts', REFUSE],
    ['a pull request merge whose body is a file, short', 'gh pr merge 12 -F /etc/hosts', REFUSE],
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
      push(['git', 'push', 'origin', 'master'], 'origin'),
    );
  });

  it('names a refused option plainly', () => {
    expect(passGitCall('git push --force origin feat', 'main')).toEqual({
      kind: 'refuse',
      reason: 'git push --force stays refused in a pass: it rewrites what the remote holds.',
    });
    expect(passGitCall('git commit --signoff -m x', 'main')).toEqual({
      kind: 'refuse',
      reason:
        'git commit --signoff is not offered in a pass: a call 10db runs for the builder carries only options that read nothing outside the checkout.',
    });
  });
});
